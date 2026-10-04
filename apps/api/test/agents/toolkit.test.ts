import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createJobContext, toRequestContext } from '../../src/agents/context.js';
import { jobTool } from '../../src/agents/toolkit.js';
import { issue } from '../../src/domain/issues.js';
import { JobTicketSchema } from '../../src/domain/ticket.js';
import { FakeVision, MemoryStore } from '../helpers/fakes.js';

const job = () =>
  createJobContext({
    jobId: 'job-1',
    ticket: JobTicketSchema.parse({ jobName: 'card', trimWidthMm: 85, trimHeightMm: 55 }),
    deps: { store: new MemoryStore(new Map()), vision: new FakeVision({ texts: [], logos: [] }) },
  });

// Call a tool the way Mastra does: (input, { requestContext }).
const call = (tool: { execute?: unknown }, input: unknown, j: ReturnType<typeof job>) =>
  (tool.execute as (i: unknown, c: unknown) => Promise<Record<string, unknown>>)(input, { requestContext: toRequestContext(j) });

describe('jobTool', () => {
  it('records the call, the result and the issues it found', async () => {
    const j = job();
    const tool = jobTool({
      id: 'demo',
      owner: 'preflight-agent',
      description: 'demo',
      input: z.object({}),
      run: async () => ({ result: { pass: false }, issues: [issue('LOW_RESOLUTION', 'CRITICAL', 'too low')] }),
    });
    const out = await call(tool, {}, j);
    expect(out).toMatchObject({ ok: true, pass: false, issues: [{ code: 'LOW_RESOLUTION' }] });
    expect(j.trace.events.map((e) => e.type)).toEqual(['tool.called', 'tool.result']);
    expect(j.state.completedTools.get('preflight-agent')).toEqual(new Set(['demo']));
    expect(j.state.toolIssues.get('preflight-agent:demo')!.issues[0]!.code).toBe('LOW_RESOLUTION');
  });

  it('returns errors as values and does not mark the tool complete', async () => {
    const j = job();
    const tool = jobTool({
      id: 'broken',
      owner: 'ip-agent',
      description: 'fails',
      input: z.object({}),
      run: async () => {
        throw new Error('upstream unavailable');
      },
    });
    expect(await call(tool, {}, j)).toEqual({ ok: false, error: 'upstream unavailable' });
    expect(j.trace.events.at(-1)).toMatchObject({ type: 'tool.error', data: { tool: 'broken' } });
    expect(j.state.completedTools.get('ip-agent')).toBeUndefined();
  });

  it('times out slow tools', async () => {
    const j = job();
    const tool = jobTool({
      id: 'slow',
      owner: 'ip-agent',
      description: 'slow',
      input: z.object({}),
      timeoutMs: 20,
      run: () => new Promise(() => {}),
    });
    expect(await call(tool, {}, j)).toEqual({ ok: false, error: 'slow timed out after 20 ms' });
  });

  it('refuses to run outside a review (no job context)', async () => {
    const tool = jobTool({ id: 'x', owner: 'ip-agent', description: 'x', input: z.object({}), run: async () => ({ result: {} }) });
    await expect((tool.execute as (i: unknown, c: unknown) => Promise<unknown>)({}, {})).rejects.toThrow(/no job context/);
  });
});
