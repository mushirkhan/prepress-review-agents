import { Agent } from '@mastra/core/agent';
import { type AgentId, type AgentIssue, collectIssues, type JobContext, toRequestContext } from './context.js';
import {
  fallbackReport,
  IP_INSTRUCTIONS,
  ORCHESTRATOR_INSTRUCTIONS,
  orchestratorBrief,
  PREFLIGHT_INSTRUCTIONS,
  REPORT_INSTRUCTIONS,
  reportBrief,
  specialistBrief,
} from './instructions.js';
import { coverageIssues, type Decision, decideVerdict, parseProposedVerdict, type Verdict } from './policy.js';
import { ipTools } from './tools/ip.js';
import { preflightTools } from './tools/preflight.js';
import { reportTools } from './tools/report.js';
import type { TraceEvent } from './trace.js';

type ModelConfig = ConstructorParameters<typeof Agent>[0]['model'];

export interface ReviewModels {
  /** Plans and delegates (Nova Lite in production). */
  orchestrator: ModelConfig;
  /** Runs the specialist agents (Nova Micro in production). */
  specialist: ModelConfig;
}

/** Hard limits that keep every agent inside its budget. */
export interface ReviewLimits {
  orchestratorSteps: number;
  preflightSteps: number;
  ipSteps: number;
  reportSteps: number;
  /** Delegations allowed per specialist (1 retry after a failure). */
  maxAttemptsPerAgent: number;
  runTimeoutMs: number;
}

export const DEFAULT_LIMITS: ReviewLimits = {
  orchestratorSteps: 8,
  preflightSteps: 8,
  ipSteps: 7,
  reportSteps: 3,
  maxAttemptsPerAgent: 2,
  runTimeoutMs: 120_000,
};

export interface ReviewResult {
  jobId: string;
  status: 'completed' | 'failed';
  verdict: Verdict;
  reasons: string[];
  issues: AgentIssue[];
  /** What the orchestrator model suggested; recorded to measure agreement. */
  proposedVerdict?: Verdict | undefined;
  summaries: Partial<Record<AgentId, string>>;
  reportPath?: string | undefined;
  violations: JobContext['state']['violations'];
  usage: { inputTokens: number; outputTokens: number };
  durationMs: number;
  error?: string | undefined;
  trace: TraceEvent[];
}

/** Which tools each agent may call. Anything else is a boundary violation. */
export const ALLOWED_TOOLS: Record<AgentId, readonly string[]> = {
  orchestrator: ['agent-preflight', 'agent-ip', 'agent-report'],
  'preflight-agent': Object.keys(preflightTools),
  'ip-agent': Object.keys(ipTools),
  'report-agent': Object.keys(reportTools),
};

const SPECIALISTS: Record<string, AgentId> = {
  'preflight-agent': 'preflight-agent',
  'ip-agent': 'ip-agent',
  'report-agent': 'report-agent',
};

interface StepLike {
  text?: string;
  toolCalls?: { toolName?: string; payload?: { toolName?: string } }[];
  usage?: { inputTokens?: number; outputTokens?: number };
}

/**
 * Called after every model step of every agent: accounts tokens, records the
 * step, and records any attempt to call a tool outside the agent's allowlist.
 * (Mastra already refuses unknown tools; this makes each attempt visible in
 * the trace and countable in the evaluation.)
 */
function stepGuard(job: JobContext, agent: AgentId) {
  return (step: StepLike) => {
    const names = (step.toolCalls ?? []).map((c) => c.payload?.toolName ?? c.toolName ?? 'unknown');
    job.state.usage.inputTokens += step.usage?.inputTokens ?? 0;
    job.state.usage.outputTokens += step.usage?.outputTokens ?? 0;
    job.trace.record('agent.step', agent, {
      toolCalls: names,
      text: step.text?.slice(0, 500) || undefined,
      usage: step.usage,
    });
    for (const name of names) {
      if (!ALLOWED_TOOLS[agent].includes(name)) {
        const reason = `${agent} is not allowed to call ${name}`;
        job.state.violations.push({ agent, attempted: name, reason });
        job.trace.record('guardrail.blocked', agent, { attempted: name, allowed: ALLOWED_TOOLS[agent], reason });
      }
    }
  };
}

function buildAgents(job: JobContext, models: ReviewModels) {
  const specialist = (id: AgentId, description: string, instructions: string, tools: Record<string, unknown>) =>
    new Agent({
      id,
      name: id,
      description,
      instructions,
      model: models.specialist,
      tools: tools as never,
      defaultOptions: { onStepFinish: stepGuard(job, id) as never },
    });

  const preflight = specialist(
    'preflight-agent',
    'Checks print-readiness of the artwork: resolution, bleed, colour space and barcode check digit.',
    PREFLIGHT_INSTRUCTIONS,
    preflightTools,
  );
  const ip = specialist(
    'ip-agent',
    'Checks the artwork for protected brand names, slogans and logos, and for text that tries to manipulate the review.',
    IP_INSTRUCTIONS,
    ipTools,
  );
  const report = specialist(
    'report-agent',
    'Writes and saves the final review report once the checks are done.',
    REPORT_INSTRUCTIONS,
    reportTools,
  );
  const orchestrator = new Agent({
    id: 'orchestrator',
    name: 'orchestrator',
    instructions: ORCHESTRATOR_INSTRUCTIONS,
    model: models.orchestrator,
    agents: { preflight, ip, report },
  });
  return { orchestrator, report };
}

function currentDecision(job: JobContext): { decision: Decision; issues: AgentIssue[] } {
  const issues = [
    ...collectIssues(job),
    ...coverageIssues(job).map((i) => ({ ...i, agent: 'orchestrator' as AgentId })),
  ];
  return { decision: decideVerdict(issues), issues };
}

function summaries(job: JobContext): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [agent, d] of job.state.delegations) if (d.summary) out[agent] = d.summary;
  return out;
}

/**
 * Runs one artwork review: the orchestrator delegates to the specialists,
 * the policy decides the verdict from their structured findings, and the
 * Report agent writes it up. Failures never produce APPROVE: any error or
 * gap ends as NEEDS_HUMAN_REVIEW (or REJECT if a critical issue was found).
 */
export async function reviewArtwork(job: JobContext, models: ReviewModels, limits: ReviewLimits = DEFAULT_LIMITS): Promise<ReviewResult> {
  const started = Date.now();
  const requestContext = toRequestContext(job);
  const { orchestrator, report } = buildAgents(job, models);
  const stepsFor: Record<AgentId, number> = {
    orchestrator: limits.orchestratorSteps,
    'preflight-agent': limits.preflightSteps,
    'ip-agent': limits.ipSteps,
    'report-agent': limits.reportSteps,
  };

  job.trace.record('run.started', 'orchestrator', { jobId: job.jobId, ticket: job.ticket });

  const delegation = {
    onDelegationStart: async (ctx: { primitiveId: string; prompt: string }) => {
      const agent = SPECIALISTS[ctx.primitiveId];
      const reject = (reason: string) => {
        job.trace.record('delegation.rejected', 'orchestrator', { to: ctx.primitiveId, reason, prompt: ctx.prompt });
        return { proceed: false, rejectionReason: reason };
      };
      if (!agent) return reject(`Unknown specialist ${ctx.primitiveId}.`);

      const state = job.state.delegations.get(agent) ?? { attempts: 0, completed: false };
      if (state.completed && agent !== 'report-agent') return reject(`${agent} has already completed; use its earlier answer.`);
      if (state.attempts >= limits.maxAttemptsPerAgent) return reject(`${agent} has reached its attempt limit.`);

      let prompt = specialistBrief(job, ctx.prompt);
      if (agent === 'report-agent') {
        const checksDone = ['preflight-agent', 'ip-agent'].every((a) => job.state.delegations.get(a as AgentId)?.completed);
        if (!checksDone) return reject('Run agent-preflight and agent-ip before agent-report.');
        if (job.state.reportPath) return reject('The report has already been saved.');
        const { decision, issues } = currentDecision(job);
        job.state.decision = decision;
        // The report brief is built from structured findings, not from the orchestrator's wording.
        prompt = reportBrief(job, decision, issues, summaries(job));
      }

      state.attempts += 1;
      job.state.delegations.set(agent, state);
      job.trace.record('delegation.started', 'orchestrator', {
        to: agent,
        attempt: state.attempts,
        maxSteps: stepsFor[agent],
        orchestratorPrompt: ctx.prompt,
      });
      return { proceed: true, modifiedPrompt: prompt, modifiedMaxSteps: stepsFor[agent] };
    },

    onDelegationComplete: async (ctx: { primitiveId: string; success: boolean; result?: { text?: string } }) => {
      const agent = SPECIALISTS[ctx.primitiveId];
      if (!agent) return;
      const state = job.state.delegations.get(agent) ?? { attempts: 1, completed: false };
      state.completed = ctx.success;
      if (ctx.result?.text) state.summary = ctx.result.text.trim();
      job.state.delegations.set(agent, state);
      job.trace.record('delegation.completed', 'orchestrator', {
        to: agent,
        success: ctx.success,
        summary: state.summary?.slice(0, 600),
      });
      if (!ctx.success) return { resultText: `${agent} could not finish. Do not retry more than once.` };
      return undefined;
    },
  };

  let orchestratorText: string | undefined;
  let error: string | undefined;
  try {
    const res = await orchestrator.generate(orchestratorBrief(job), {
      maxSteps: limits.orchestratorSteps,
      requestContext,
      abortSignal: AbortSignal.timeout(limits.runTimeoutMs),
      onStepFinish: stepGuard(job, 'orchestrator') as never,
      delegation,
    } as never);
    orchestratorText = (res as { text?: string }).text;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    job.trace.record('run.failed', 'orchestrator', { error });
  }

  // The verdict comes from the structured findings plus a coverage check.
  const { decision, issues } = currentDecision(job);
  job.state.decision = decision;
  const proposedVerdict = parseProposedVerdict(orchestratorText);
  job.trace.record('verdict', 'orchestrator', {
    verdict: decision.verdict,
    reasons: decision.reasons,
    proposedVerdict,
    agreesWithPolicy: proposedVerdict ? proposedVerdict === decision.verdict : undefined,
  });

  // Every job gets a report: the Report agent if the orchestrator didn't call it, then a template.
  if (!job.state.reportPath) {
    try {
      await report.generate(reportBrief(job, decision, issues, summaries(job)), {
        maxSteps: limits.reportSteps,
        requestContext,
        abortSignal: AbortSignal.timeout(30_000),
      } as never);
    } catch {
      // fall through to the template
    }
  }
  if (!job.state.reportPath) {
    job.state.reportPath = await job.deps.store.saveReport(job.jobId, fallbackReport(job, decision, issues));
    job.trace.record('tool.result', 'runtime', { tool: 'fallback_report', result: { path: job.state.reportPath } });
  }

  const result: ReviewResult = {
    jobId: job.jobId,
    status: error ? 'failed' : 'completed',
    verdict: decision.verdict,
    reasons: decision.reasons,
    issues,
    proposedVerdict,
    summaries: Object.fromEntries([...job.state.delegations].filter(([, d]) => d.summary).map(([a, d]) => [a, d.summary!])),
    reportPath: job.state.reportPath,
    violations: job.state.violations,
    usage: job.state.usage,
    durationMs: Date.now() - started,
    error,
    trace: job.trace.events,
  };
  job.trace.record('run.completed', 'orchestrator', {
    verdict: result.verdict,
    status: result.status,
    durationMs: result.durationMs,
    usage: result.usage,
  });
  return result;
}
