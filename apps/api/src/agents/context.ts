import { RequestContext } from '@mastra/core/request-context';
import type { Issue } from '../domain/issues.js';
import type { JobTicket } from '../domain/ticket.js';
import type { Decision } from './policy.js';
import type { ImageMetadata } from '../tools/preflight/imageMetadata.js';
import type { ArtworkStore, Embedder, VisionReader, VisionResult } from './ports.js';
import { TraceRecorder } from './trace.js';

export type AgentId = 'orchestrator' | 'preflight-agent' | 'ip-agent' | 'report-agent';

export interface Violation {
  agent: AgentId;
  attempted: string;
  reason: string;
}

/**
 * Everything one review run knows. It travels to every agent and tool in
 * Mastra's request context, so tools read the job's file and ticket from
 * here, never from model-supplied arguments. That is how a model is kept
 * from pointing a tool at another job's artwork.
 */
export interface JobContext {
  jobId: string;
  ticket: JobTicket;
  trace: TraceRecorder;
  deps: { store: ArtworkStore; vision: VisionReader; embedder?: Embedder | undefined };
  state: {
    artwork?: Buffer;
    metadata?: ImageMetadata;
    vision?: VisionResult;
    /** Latest issues reported by each tool, keyed "agent:tool". */
    toolIssues: Map<string, { agent: AgentId; issues: Issue[] }>;
    /** Tools that completed successfully, per agent. */
    completedTools: Map<AgentId, Set<string>>;
    /** Delegations attempted and completed, per sub-agent. */
    delegations: Map<AgentId, { attempts: number; completed: boolean; summary?: string }>;
    violations: Violation[];
    reportPath?: string;
    /** Set once both checks finish, before the report is written. */
    decision?: Decision;
    usage: { inputTokens: number; outputTokens: number };
  };
}

const JOB_KEY = 'prepress.job';

export function createJobContext(input: Pick<JobContext, 'jobId' | 'ticket' | 'deps'>): JobContext {
  return {
    ...input,
    trace: new TraceRecorder(),
    state: {
      toolIssues: new Map(),
      completedTools: new Map(),
      delegations: new Map(),
      violations: [],
      usage: { inputTokens: 0, outputTokens: 0 },
    },
  };
}

export function toRequestContext(job: JobContext): RequestContext {
  const rc = new RequestContext();
  rc.set(JOB_KEY, job);
  return rc;
}

export function jobFrom(requestContext: { get(key: string): unknown } | undefined): JobContext {
  const job = requestContext?.get(JOB_KEY) as JobContext | undefined;
  if (!job) throw new Error('tool called outside a review run (no job context)');
  return job;
}

export interface AgentIssue extends Issue {
  agent: AgentId;
}

export function collectIssues(job: JobContext): AgentIssue[] {
  return [...job.state.toolIssues.values()].flatMap(({ agent, issues }) => issues.map((i) => ({ ...i, agent })));
}
