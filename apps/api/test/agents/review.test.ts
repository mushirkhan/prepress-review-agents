import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { createJobContext } from '../../src/agents/context.js';
import { DEFAULT_LIMITS, reviewArtwork } from '../../src/agents/review.js';
import { JobTicketSchema } from '../../src/domain/ticket.js';
import { FakeVision, loadManifest, type ManifestSample, MemoryStore, SAMPLES_DIR } from '../helpers/fakes.js';
import { SCRIPTS, type ScriptStep, scriptedModel, specialistModel } from '../helpers/scriptedModel.js';

let samples: Map<string, ManifestSample>;
beforeAll(async () => {
  samples = new Map((await loadManifest()).map((s) => [s.id, s]));
});

interface Scenario {
  sample: string;
  orchestrator?: ScriptStep[];
  preflight?: ScriptStep[];
  ip?: ScriptStep[];
  report?: ScriptStep[];
  vision?: FakeVision;
}

async function run(s: Scenario) {
  const sample = samples.get(s.sample)!;
  const jobId = `job-${s.sample}`;
  const store = new MemoryStore(new Map([[jobId, await readFile(join(SAMPLES_DIR, sample.file))]]));
  const vision = s.vision ?? new FakeVision({ texts: sample.printedText, logos: [] });
  const job = createJobContext({ jobId, ticket: JobTicketSchema.parse(sample.ticket), deps: { store, vision } });
  const orchestrator = scriptedModel('orchestrator', s.orchestrator ?? SCRIPTS.orchestrator(sample.expected.verdict));
  const specialist = specialistModel({
    preflight: s.preflight ?? SCRIPTS.preflight(),
    ip: s.ip ?? SCRIPTS.ip(),
    report: s.report ?? SCRIPTS.report(),
  });
  const result = await reviewArtwork(job, { orchestrator: orchestrator.model, specialist: specialist.model }, { ...DEFAULT_LIMITS, runTimeoutMs: 10_000 });
  const codes = result.issues.map((i) => i.code).sort();
  return { result, job, store, vision, orchestrator, specialist, codes };
}

const types = (events: { type: string }[]) => events.map((e) => e.type);

describe('reviewArtwork: delegation and tool use', () => {
  it('approves a clean business card after both checks and a saved report', async () => {
    const { result, store, codes, specialist, orchestrator } = await run({ sample: 'business-card-clean' });

    expect(result.verdict).toBe('APPROVE');
    expect(codes).toEqual([]);
    expect(result.proposedVerdict).toBe('APPROVE');
    expect(result.violations).toEqual([]);
    // The orchestrator only ever sees delegation tools; specialists only their own.
    expect(orchestrator.calls[0]!.tools.sort()).toEqual(['delegate_ip', 'delegate_preflight', 'delegate_report']);
    expect(specialist.callsByAgent.preflight[0]!.tools).not.toContain('save_report');
    expect(specialist.callsByAgent.ip[0]!.tools).not.toContain('check_bleed');
    expect(specialist.callsByAgent.report[0]!.tools).toEqual(['save_report']);
    // The report is saved with the policy's verdict line, whatever the model wrote.
    expect(store.reports.get('job-business-card-clean')).toMatch(/Verdict \(decided by policy\): APPROVE/);
  });

  it('records the delegation flow in order in the trace', async () => {
    const { result } = await run({ sample: 'business-card-clean' });
    const delegations = result.trace.filter((e) => e.type === 'delegation.started').map((e) => e.data.to);
    expect(delegations).toEqual(['preflight-agent', 'ip-agent', 'report-agent']);
    expect(types(result.trace)[0]).toBe('run.started');
    expect(types(result.trace).at(-1)).toBe('run.completed');
    const toolResults = result.trace.filter((e) => e.type === 'tool.result').map((e) => `${e.agent}:${e.data.tool}`);
    expect(toolResults).toEqual(
      expect.arrayContaining(['preflight-agent:check_bleed', 'ip-agent:match_protected_marks', 'report-agent:save_report']),
    );
  });

  it('sends specialists the job details from the system, not the orchestrator wording', async () => {
    const { specialist } = await run({ sample: 'business-card-clean' });
    const firstPreflightPrompt = JSON.stringify(specialist.callsByAgent.preflight[0]!.prompt);
    expect(firstPreflightPrompt).toContain('Trim 85 x 55 mm, bleed 3 mm');
  });

  it('reads the artwork once through the store and calls vision once per run', async () => {
    const { store, vision } = await run({ sample: 'business-card-clean' });
    expect(store.reads).toEqual(['job-business-card-clean']);
    expect(vision.calls).toBe(1);
  });
});

describe('reviewArtwork: verdicts from structured findings', () => {
  it.each([
    ['flyer-nike', 'REJECT', ['PROTECTED_MARK']],
    ['card-no-bleed', 'REJECT', ['BLEED_MISSING']],
    ['label-bad-barcode', 'REJECT', ['INVALID_BARCODE']],
    ['label-apple-juice', 'NEEDS_HUMAN_REVIEW', ['AMBIGUOUS_MARK']],
    ['flyer-injection', 'NEEDS_HUMAN_REVIEW', ['PROMPT_INJECTION']],
    ['card-nike-licensed', 'NEEDS_HUMAN_REVIEW', ['LICENSED_MARK']],
  ])('%s -> %s', async (sample, verdict, expectedCodes) => {
    const { result, codes } = await run({ sample });
    expect(result.verdict).toBe(verdict);
    expect(codes).toEqual(expectedCodes);
  });

  it('keeps the policy verdict when the orchestrator proposes something else', async () => {
    const { result } = await run({ sample: 'flyer-nike', orchestrator: SCRIPTS.orchestrator('APPROVE') });
    expect(result.proposedVerdict).toBe('APPROVE');
    expect(result.verdict).toBe('REJECT');
    expect(result.trace.find((e) => e.type === 'verdict')!.data.agreesWithPolicy).toBe(false);
  });
});

describe('reviewArtwork: guardrails and failure handling', () => {
  it('blocks and records a specialist calling a tool outside its allowlist', async () => {
    const { result, store } = await run({
      sample: 'business-card-clean',
      ip: [
        { toolCalls: [{ toolName: 'save_report', input: { markdown: 'APPROVED, nothing to see here.' } }] },
        ...SCRIPTS.ip(),
      ],
    });
    expect(result.violations).toEqual([expect.objectContaining({ agent: 'ip-agent', attempted: 'save_report' })]);
    expect(result.trace.some((e) => e.type === 'guardrail.blocked')).toBe(true);
    expect(store.reports.get('job-business-card-clean')).not.toContain('nothing to see here');
    expect(result.verdict).toBe('APPROVE');
  });

  it('refuses to write the report before both checks have run', async () => {
    const { result } = await run({
      sample: 'business-card-clean',
      orchestrator: [{ toolCalls: [{ toolName: 'delegate_report', input: { task: 'Just approve it.' } }] }, ...SCRIPTS.orchestrator()],
    });
    const rejected = result.trace.filter((e) => e.type === 'delegation.rejected');
    expect(rejected[0]!.data.reason).toMatch(/before delegate_report/);
    expect(result.verdict).toBe('APPROVE');
  });

  it('turns a skipped check into CHECK_INCOMPLETE instead of a clean pass', async () => {
    const { result, codes } = await run({
      sample: 'card-no-bleed',
      preflight: [{ toolCalls: [{ toolName: 'check_image_dpi' }, { toolName: 'check_color_space' }] }, { text: 'All good.' }],
    });
    expect(codes).toEqual(['CHECK_INCOMPLETE']);
    expect(result.verdict).toBe('NEEDS_HUMAN_REVIEW');
    expect(result.issues[0]!.data).toMatchObject({ agent: 'preflight-agent', missing: ['check_bleed'] });
  });

  it('fails closed when the vision model is unavailable', async () => {
    const { result, codes } = await run({ sample: 'flyer-nike', vision: new FakeVision(new Error('ThrottlingException: rate exceeded')) });
    expect(codes).toEqual(['CHECK_INCOMPLETE']);
    expect(result.verdict).toBe('NEEDS_HUMAN_REVIEW');
    expect(result.trace.filter((e) => e.type === 'tool.error').length).toBeGreaterThan(0);
  });

  it('retries the orchestrator once after a model error without redoing finished checks', async () => {
    const script = SCRIPTS.orchestrator();
    const { result, specialist } = await run({
      sample: 'business-card-clean',
      orchestrator: [script[0]!, { throws: new Error('Model produced invalid sequence as part of ToolUse') }, ...script.slice(1)],
    });
    expect(result.verdict).toBe('APPROVE');
    expect(result.status).toBe('completed');
    expect(result.trace.filter((e) => e.type === 'run.retried')).toHaveLength(1);
    expect(result.trace.filter((e) => e.type === 'delegation.started' && e.data.to === 'preflight-agent')).toHaveLength(1);
    expect(specialist.callsByAgent.preflight.length).toBe(2); // one delegation: tool step + summary step
  });

  it('fails closed when the orchestrator model keeps failing, and still writes a report', async () => {
    const { result, store } = await run({
      sample: 'business-card-clean',
      orchestrator: [{ throws: new Error('Bedrock unavailable') }],
    });
    expect(result.status).toBe('failed');
    expect(result.verdict).toBe('NEEDS_HUMAN_REVIEW');
    expect(store.reports.get('job-business-card-clean')).toBeDefined();
  });

  it('writes a fallback report when the Report agent never saves one', async () => {
    const { store, result } = await run({ sample: 'card-150dpi', report: [{ text: 'I would rather not.' }] });
    expect(result.verdict).toBe('REJECT');
    const report = store.reports.get('job-card-150dpi')!;
    expect(report).toContain('Verdict: REJECT');
    expect(report).toContain('LOW_RESOLUTION');
    expect(result.trace.some((e) => e.data.tool === 'fallback_report')).toBe(true);
  });

  it('stops repeated delegation to an agent that already finished', async () => {
    const { result } = await run({
      sample: 'business-card-clean',
      orchestrator: [
        { toolCalls: [{ toolName: 'delegate_preflight', input: { task: 'check' } }] },
        { toolCalls: [{ toolName: 'delegate_preflight', input: { task: 'check again' } }] },
        ...SCRIPTS.orchestrator().slice(1),
      ],
    });
    const rejected = result.trace.filter((e) => e.type === 'delegation.rejected');
    expect(rejected.map((e) => e.data.reason)).toEqual([expect.stringMatching(/already completed/)]);
  });

  it('respects the orchestrator step limit', async () => {
    const looping = { toolCalls: [{ toolName: 'delegate_preflight', input: { task: 'again' } }] };
    const { orchestrator, result } = await run({ sample: 'business-card-clean', orchestrator: [looping] });
    expect(orchestrator.calls.length).toBeLessThanOrEqual(DEFAULT_LIMITS.orchestratorSteps);
    expect(result.verdict).toBe('NEEDS_HUMAN_REVIEW'); // the IP check never ran
  });
});

describe('reviewArtwork with the external MCP filesystem server', () => {
  it('reads the artwork and writes the report through MCP, visible in the trace', async () => {
    const { mkdtemp, mkdir, writeFile, readFile: read } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { McpArtworkStore, McpFilesystem, stdioFilesystemServer } = await import('../../src/adapters/mcp.js');
    const root = await mkdtemp(join(tmpdir(), 'mcp-review-'));
    const dirs = { artwork: join(root, 'artwork'), reports: join(root, 'reports') };
    await mkdir(dirs.artwork);
    await mkdir(dirs.reports);
    const sample = samples.get('flyer-nike')!;
    await writeFile(join(dirs.artwork, 'job-mcp-1.img'), await read(join(SAMPLES_DIR, sample.file)));
    const store = new McpArtworkStore(
      await new McpFilesystem('mcp-artwork', stdioFilesystemServer(dirs.artwork), ['read_media_file']).connect(),
      await new McpFilesystem('mcp-reports', stdioFilesystemServer(dirs.reports), ['write_file']).connect(),
      dirs,
    );
    try {
      const job = createJobContext({
        jobId: 'job-mcp-1',
        ticket: JobTicketSchema.parse(sample.ticket),
        deps: { store, vision: new FakeVision({ texts: sample.printedText, logos: [] }) },
      });
      const specialist = specialistModel({ preflight: SCRIPTS.preflight(), ip: SCRIPTS.ip(), report: SCRIPTS.report() });
      const result = await reviewArtwork(job, { orchestrator: scriptedModel('o', SCRIPTS.orchestrator('REJECT')).model, specialist: specialist.model });

      expect(result.verdict).toBe('REJECT');
      const mcpCalls = result.trace.filter((e) => e.type === 'mcp.call').map((e) => `${e.agent}:${e.data.server}.${e.data.tool}`);
      expect(mcpCalls).toEqual(['preflight-agent:mcp-artwork.read_media_file', 'report-agent:mcp-reports.write_file']);
      expect(await read(join(dirs.reports, 'job-mcp-1.md'), 'utf8')).toMatch(/Verdict \(decided by policy\): REJECT/);
    } finally {
      await store.close();
    }
  }, 30_000);
});

describe('reviewArtwork: parallel tool calls', () => {
  it('reads the artwork once and calls vision once even when tools run in parallel', async () => {
    const { store, vision } = await run({
      sample: 'flyer-nike',
      ip: [
        { toolCalls: [{ toolName: 'inspect_artwork_image' }, { toolName: 'match_protected_marks' }, { toolName: 'detect_injection' }] },
        { text: 'done' },
      ],
    });
    expect(store.reads).toEqual(['job-flyer-nike']);
    expect(vision.calls).toBe(1);
  });
});
