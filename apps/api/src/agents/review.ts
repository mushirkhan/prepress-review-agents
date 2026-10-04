import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { type AgentId, type AgentIssue, collectIssues, type JobContext, jobFrom, toRequestContext } from './context.js';
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
  /** Provider-specific settings applied to every model call (e.g. greedy decoding for Nova). */
  callSettings?: { modelSettings?: Record<string, unknown>; providerOptions?: Record<string, Record<string, unknown>> };
}

/** Hard limits that keep every agent inside its budget. */
export interface ReviewLimits {
  orchestratorSteps: number;
  preflightSteps: number;
  ipSteps: number;
  reportSteps: number;
  /** Delegations allowed per specialist (1 retry after a failure). */
  maxAttemptsPerAgent: number;
  /** Orchestrator runs allowed after a model error (completed checks are not redone). */
  orchestratorAttempts: number;
  runTimeoutMs: number;
}

export const DEFAULT_LIMITS: ReviewLimits = {
  orchestratorSteps: 8,
  preflightSteps: 8,
  ipSteps: 7,
  reportSteps: 3,
  maxAttemptsPerAgent: 2,
  orchestratorAttempts: 2,
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
  orchestrator: ['delegate_preflight', 'delegate_ip', 'delegate_report'],
  'preflight-agent': Object.keys(preflightTools),
  'ip-agent': Object.keys(ipTools),
  'report-agent': Object.keys(reportTools),
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

type CallSettings = NonNullable<ReviewModels['callSettings']>;

function specialist(job: JobContext, models: ReviewModels, id: AgentId, instructions: string, tools: Record<string, unknown>) {
  return new Agent({
    id,
    name: id,
    instructions,
    model: models.specialist,
    tools: tools as never,
    defaultOptions: { onStepFinish: stepGuard(job, id) as never },
  });
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
 * Guardrails applied before every delegation. Returns the brief the
 * specialist will actually receive, or a reason to refuse.
 */
function beforeDelegation(job: JobContext, agent: AgentId, task: string, limits: ReviewLimits): { prompt: string } | { reason: string } {
  const state = job.state.delegations.get(agent) ?? { attempts: 0, completed: false };
  if (state.completed && agent !== 'report-agent') return { reason: `${agent} has already completed; use its earlier answer.` };
  if (state.attempts >= limits.maxAttemptsPerAgent) return { reason: `${agent} has reached its attempt limit.` };

  // The specialist's brief comes from the job ticket, not from the orchestrator's wording.
  let prompt = specialistBrief(job, task);
  if (agent === 'report-agent') {
    const checksDone = (['preflight-agent', 'ip-agent'] as AgentId[]).every((a) => job.state.delegations.get(a)?.completed);
    if (!checksDone) return { reason: 'Run delegate_preflight and delegate_ip before delegate_report.' };
    if (job.state.reportPath) return { reason: 'The report has already been saved.' };
    const { decision, issues } = currentDecision(job);
    job.state.decision = decision;
    // The report brief is built from structured findings and the policy's verdict.
    prompt = reportBrief(job, decision, issues, summaries(job));
  }
  state.attempts += 1;
  job.state.delegations.set(agent, state);
  return { prompt };
}

/**
 * The orchestrator's only tools. Each one hands a task to one specialist
 * agent. The input schema is deliberately one short string: small models
 * call simple tools far more reliably.
 */
function delegateTool(key: string, agentId: AgentId, description: string, agent: Agent, maxSteps: number, limits: ReviewLimits, settings: CallSettings) {
  return createTool({
    id: `delegate_${key}`,
    description,
    inputSchema: z.object({ task: z.string().max(500).describe('A short instruction for the specialist') }),
    execute: async ({ task }, context) => {
      const job = jobFrom(context?.requestContext);
      const guard = beforeDelegation(job, agentId, task, limits);
      if ('reason' in guard) {
        job.trace.record('delegation.rejected', 'orchestrator', { to: agentId, reason: guard.reason, task });
        return { ok: false, rejected: true, reason: guard.reason };
      }
      const state = job.state.delegations.get(agentId)!;
      job.trace.record('delegation.started', 'orchestrator', { to: agentId, attempt: state.attempts, maxSteps, task });
      try {
        const res = await agent.generate(guard.prompt, {
          maxSteps,
          requestContext: context?.requestContext,
          abortSignal: context?.abortSignal,
          ...settings,
        } as never);
        state.completed = true;
        state.summary = ((res as { text?: string }).text ?? '').trim();
        job.trace.record('delegation.completed', 'orchestrator', { to: agentId, success: true, summary: state.summary.slice(0, 600) });
        return { ok: true, summary: state.summary || 'Done.' };
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        job.trace.record('delegation.completed', 'orchestrator', { to: agentId, success: false, error });
        return { ok: false, error: `${agentId} could not finish. You may retry it once.` };
      }
    },
  });
}

function buildAgents(job: JobContext, models: ReviewModels, limits: ReviewLimits) {
  const settings = models.callSettings ?? {};
  const preflight = specialist(job, models, 'preflight-agent', PREFLIGHT_INSTRUCTIONS, preflightTools);
  const ip = specialist(job, models, 'ip-agent', IP_INSTRUCTIONS, ipTools);
  const report = specialist(job, models, 'report-agent', REPORT_INSTRUCTIONS, reportTools);
  const orchestrator = new Agent({
    id: 'orchestrator',
    name: 'orchestrator',
    instructions: ORCHESTRATOR_INSTRUCTIONS,
    model: models.orchestrator,
    tools: {
      delegate_preflight: delegateTool(
        'preflight',
        'preflight-agent',
        'Hand the print-readiness checks (resolution, bleed, colour space, barcode) to the Preflight agent.',
        preflight,
        limits.preflightSteps,
        limits,
        settings,
      ),
      delegate_ip: delegateTool(
        'ip',
        'ip-agent',
        'Hand the brand, trademark and prompt-injection checks to the IP & Trademark agent.',
        ip,
        limits.ipSteps,
        limits,
        settings,
      ),
      delegate_report: delegateTool(
        'report',
        'report-agent',
        'Ask the Report agent to write and save the report. Only after both checks have finished.',
        report,
        limits.reportSteps,
        limits,
        settings,
      ),
    } as never,
  });
  return { orchestrator, report };
}

function progressNote(job: JobContext): string {
  const lines = [...job.state.delegations]
    .filter(([, d]) => d.completed)
    .map(([agent, d]) => `- ${agent} already finished: ${(d.summary ?? 'done').replace(/\s+/g, ' ').slice(0, 300)}`);
  return lines.length ? `\n\nProgress so far (do not repeat finished steps):\n${lines.join('\n')}` : '';
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
  const settings = models.callSettings ?? {};
  const { orchestrator, report } = buildAgents(job, models, limits);
  const deadline = AbortSignal.timeout(limits.runTimeoutMs);

  job.trace.record('run.started', 'orchestrator', { jobId: job.jobId, ticket: job.ticket });

  let orchestratorText: string | undefined;
  let error: string | undefined;
  for (let attempt = 1; attempt <= limits.orchestratorAttempts; attempt++) {
    try {
      const res = await orchestrator.generate(orchestratorBrief(job) + progressNote(job), {
        maxSteps: limits.orchestratorSteps,
        requestContext,
        abortSignal: deadline,
        onStepFinish: stepGuard(job, 'orchestrator') as never,
        ...settings,
      } as never);
      orchestratorText = (res as { text?: string }).text;
      error = undefined;
      break;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      const willRetry = attempt < limits.orchestratorAttempts && !deadline.aborted;
      job.trace.record(willRetry ? 'run.retried' : 'run.failed', 'orchestrator', { error, attempt });
      if (!willRetry) break;
    }
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
        ...settings,
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
