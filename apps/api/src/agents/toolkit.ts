import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { Issue } from '../domain/issues.js';
import { type AgentId, type JobContext, jobFrom } from './context.js';

export const DEFAULT_TOOL_TIMEOUT_MS = 30_000;

export interface ToolOutcome {
  /** Facts for the model to reason about (kept small: no image bytes). */
  result: Record<string, unknown>;
  /** Findings recorded by the runtime, independent of what the model says later. */
  issues?: Issue[];
}

interface JobToolSpec<I extends z.ZodTypeAny> {
  id: string;
  owner: AgentId;
  description: string;
  input: I;
  timeoutMs?: number;
  run: (input: z.infer<I>, job: JobContext) => Promise<ToolOutcome>;
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Wraps a domain function as a Mastra tool with the behaviour every tool in
 * this system shares:
 * - reads the job from the request context (no file paths from the model)
 * - records tool.called / tool.result / tool.error in the trace, with timing
 * - stores the issues it found, so the verdict never depends on the model
 *   repeating them correctly
 * - returns errors as values ({ ok: false, error }) so the agent can explain
 *   the failure instead of the run crashing
 * - enforces a timeout
 */
export function jobTool<I extends z.ZodTypeAny>(spec: JobToolSpec<I>) {
  return createTool({
    id: spec.id,
    description: spec.description,
    inputSchema: spec.input,
    execute: async (input, context) => {
      const job = jobFrom(context?.requestContext);
      const started = Date.now();
      job.trace.record('tool.called', spec.owner, { tool: spec.id, input });
      try {
        const outcome = await withTimeout(spec.run(input as z.infer<I>, job), spec.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS, spec.id);
        const issues = outcome.issues ?? [];
        job.state.toolIssues.set(`${spec.owner}:${spec.id}`, { agent: spec.owner, issues });
        const done = job.state.completedTools.get(spec.owner) ?? new Set<string>();
        done.add(spec.id);
        job.state.completedTools.set(spec.owner, done);
        job.trace.record('tool.result', spec.owner, {
          tool: spec.id,
          durationMs: Date.now() - started,
          result: outcome.result,
          issues: issues.map((i) => ({ code: i.code, severity: i.severity })),
        });
        return {
          ok: true,
          ...outcome.result,
          issues: issues.map((i) => ({ code: i.code, severity: i.severity, message: i.message })),
        };
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        job.trace.record('tool.error', spec.owner, { tool: spec.id, durationMs: Date.now() - started, error });
        return { ok: false, error };
      }
    },
  });
}

/**
 * For tools that take no arguments: everything comes from the job context.
 * Unknown keys a model might add are stripped, not trusted.
 */
export const noInput = z.object({});
