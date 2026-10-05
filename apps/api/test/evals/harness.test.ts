/**
 * Tests for the evaluation itself: it must pass a correct system and fail
 * a broken one. Runs the real harness offline (scripted models, the real
 * MCP filesystem server over stdio).
 */
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runEval } from '../../evals/harness.js';
import { type CaseScore, CHECKS, type EvalSample, summarize, toMarkdown } from '../../evals/scoring.js';
import { McpArtworkStore, McpFilesystem, stdioFilesystemServer } from '../../src/adapters/mcp.js';
import { FakeVision, loadManifest, SAMPLES_DIR } from '../helpers/fakes.js';
import { SCRIPTS, type ScriptStep, scriptedModel, specialistModel } from '../helpers/scriptedModel.js';

let samples: EvalSample[];
let store: McpArtworkStore;
let dataDir: string;

beforeAll(async () => {
  const wanted = ['business-card-clean', 'flyer-nike', 'card-no-bleed', 'label-apple-juice', 'flyer-injection'];
  samples = (await loadManifest()).filter((s) => wanted.includes(s.id));
  dataDir = await mkdtemp(join(tmpdir(), 'eval-test-'));
  const dirs = { artwork: join(dataDir, 'artwork'), reports: join(dataDir, 'reports') };
  await mkdir(dirs.artwork);
  await mkdir(dirs.reports);
  store = new McpArtworkStore(
    await new McpFilesystem('mcp-artwork', stdioFilesystemServer(dirs.artwork), ['read_media_file']).connect(),
    await new McpFilesystem('mcp-reports', stdioFilesystemServer(dirs.reports), ['write_file']).connect(),
    dirs,
  );
}, 30_000);
afterAll(async () => store?.close());

const report: ScriptStep[] = [
  {
    toolCalls: [
      {
        toolName: 'save_report',
        input: { markdown: '# Review\nFindings: bleed, trademark/brand, licence, injection attempt, resolution, CMYK colour, barcode.' },
      },
    ],
  },
  { text: 'Report saved.' },
];

function harness(opts: { vision?: (s: EvalSample) => FakeVision; preflight?: ScriptStep[] } = {}) {
  return {
    samplesDir: SAMPLES_DIR,
    dataDir,
    store,
    vision: opts.vision ?? ((s: EvalSample) => new FakeVision({ texts: s.printedText, logos: [] })),
    models: (s: EvalSample) => ({
      orchestrator: scriptedModel('o', SCRIPTS.orchestrator(s.expected.verdict)).model,
      specialist: specialistModel({ preflight: opts.preflight ?? SCRIPTS.preflight(), ip: SCRIPTS.ip(), report }).model,
    }),
  };
}

describe('evaluation harness', () => {
  it('passes every gate and behaviour check for a correct system', async () => {
    const scores = await runEval(samples, harness(), { repeat: 1, concurrency: 2 });
    const summary = summarize(scores);
    expect(summary.passed).toBe(true);
    expect(summary.verdictAccuracy).toBe(1);
    expect(summary.issuePrecision).toBe(1);
    expect(summary.issueRecall).toBe(1);
    for (const name of Object.keys(CHECKS)) expect(summary.passRates[name as keyof typeof CHECKS]).toBe(1);
    expect(toMarkdown(summary, scores, { date: 'today', models: 'scripted' })).toContain('**PASSED**');
  }, 60_000);

  it('fails the unsafe-approval gate when the vision model goes blind', async () => {
    const scores = await runEval(samples, harness({ vision: () => new FakeVision({ texts: [], logos: [] }) }), { repeat: 1, concurrency: 2 });
    const summary = summarize(scores);
    // Without the printed text, the NIKE flyer, the injection attempt and the
    // "apple juice" label (which needs a person) all look clean.
    expect(summary.unsafeApprovals).toBe(3);
    expect(summary.gates.find((g) => g.name === 'No unsafe approvals')!.passed).toBe(false);
    expect(summary.passed).toBe(false);
  }, 60_000);

  it('fails the coverage gate when an agent skips its checks', async () => {
    const lazy: ScriptStep[] = [{ toolCalls: [{ toolName: 'read_image_metadata' }] }, { text: 'Looks fine.' }];
    const scores = await runEval(samples, harness({ preflight: lazy }), { repeat: 1, concurrency: 2 });
    const summary = summarize(scores);
    expect(summary.passRates.coverage).toBe(0);
    expect(summary.gates.find((g) => g.name.startsWith('Checks completed'))!.passed).toBe(false);

    // The results say which checks were skipped and what the agent did instead.
    const card = scores.find((s) => s.id === 'business-card-clean')!;
    expect(card.diagnostics.missingTools).toEqual(['check_image_dpi', 'check_bleed', 'check_color_space']);
    expect(card.diagnostics.toolsCalled['preflight-agent']).toEqual(['read_image_metadata']);
    expect(card.diagnostics.visionTexts).toEqual(samples.find((s) => s.id === 'business-card-clean')!.printedText);
    const md = toMarkdown(summary, scores, { date: 'today', models: 'scripted' });
    expect(md).toContain('## Diagnostics for failed runs');
    expect(md).toContain('| business-card-clean | 1 | check_image_dpi, check_bleed, check_color_space |');
  }, 60_000);
});

describe('summarize', () => {
  const score = (id: string, run: number, verdict: string, expected = 'APPROVE'): CaseScore => ({
    id,
    run,
    expectedVerdict: expected,
    verdict,
    expectedCodes: [],
    codes: [],
    checks: Object.fromEntries(Object.keys(CHECKS).map((k) => [k, verdict === expected])) as CaseScore['checks'],
    tokens: 1000,
    durationMs: 1000,
    violations: 0,
    diagnostics: { missingTools: [], toolsCalled: {}, toolErrors: [] },
  });

  it('flags samples whose verdict changed between repeated runs', () => {
    const s = summarize([score('a', 1, 'APPROVE'), score('a', 2, 'NEEDS_HUMAN_REVIEW'), score('b', 1, 'APPROVE'), score('b', 2, 'APPROVE')]);
    expect(s.unstableSamples).toEqual(['a']);
    expect(s.runsPerSample).toBe(2);
  });

  it('counts false rejects separately from unsafe approvals', () => {
    const s = summarize([score('a', 1, 'REJECT'), score('b', 1, 'APPROVE', 'REJECT')]);
    expect(s.falseRejects).toBe(1);
    expect(s.unsafeApprovals).toBe(1);
  });
});
