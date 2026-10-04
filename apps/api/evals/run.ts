/**
 * Live evaluation against Amazon Bedrock and the real MCP filesystem server.
 *
 *   npm run eval -w @prepress/api                      # every sample once
 *   npm run eval -w @prepress/api -- --repeat 3        # measure stability
 *   npm run eval -w @prepress/api -- --only flyer-nike,card-adidaz
 *   npm run eval -w @prepress/api -- --publish         # also write evals/RESULTS.md
 *
 * Exits with code 1 if any gate fails, so CI can block on it. One full run
 * (13 reviews) costs a few cents with Nova Micro / Lite.
 */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { BedrockVision, createReviewModels, TitanEmbedder } from '../src/adapters/bedrock.js';
import { createMcpArtworkStore } from '../src/adapters/mcp.js';
import { loadConfig } from '../src/config.js';
import { loadManifest, SAMPLES_DIR } from '../test/helpers/fakes.js';
import { runEval } from './harness.js';
import { summarize, toMarkdown } from './scoring.js';

const { values } = parseArgs({
  options: {
    repeat: { type: 'string', default: '1' },
    concurrency: { type: 'string', default: '2' },
    only: { type: 'string' },
    publish: { type: 'boolean', default: false },
  },
});

const only = values.only?.split(',').map((s) => s.trim());
const samples = (await loadManifest()).filter((s) => s.category !== 'invalid' && (!only || only.includes(s.id)));
const dataDir = await mkdtemp(join(tmpdir(), 'prepress-eval-'));
const config = loadConfig({ ...process.env, DATA_DIR: dataDir });
const store = await createMcpArtworkStore(config);
const vision = new BedrockVision(config);
const models = createReviewModels(config);

console.log(`Evaluating ${samples.length} samples × ${values.repeat} run(s) against Bedrock (${config.AWS_REGION})\n`);
const scores = await runEval(
  samples,
  { samplesDir: SAMPLES_DIR, dataDir, store, vision: () => vision, embedder: new TitanEmbedder(config), models: () => models },
  {
    repeat: Number(values.repeat),
    concurrency: Number(values.concurrency),
    onCase: (s) => {
      const failed = Object.entries(s.checks).filter(([, ok]) => !ok).map(([n]) => n);
      console.log(
        `${s.verdict === s.expectedVerdict ? '✓' : '✗'} ${s.id.padEnd(22)} run ${s.run}  ${s.verdict.padEnd(19)} (expected ${s.expectedVerdict})  ` +
          `${(s.durationMs / 1000).toFixed(1)} s  ${s.tokens} tok${failed.length ? `  failed: ${failed.join(', ')}` : ''}`,
      );
    },
  },
);
await store.close();

const summary = summarize(scores);
const date = new Date().toISOString();
const md = toMarkdown(summary, scores, {
  date: date.slice(0, 16).replace('T', ' ') + ' UTC',
  models: `${config.BEDROCK_ORCHESTRATOR_MODEL} (orchestrator), ${config.BEDROCK_SPECIALIST_MODEL} (specialists), ${config.BEDROCK_VISION_MODEL} (vision)`,
});

const here = dirname(fileURLToPath(import.meta.url));
const resultsDir = join(here, 'results');
await mkdir(resultsDir, { recursive: true });
const stamp = date.replace(/[:.]/g, '-');
await writeFile(join(resultsDir, `${stamp}.json`), JSON.stringify({ summary, scores }, null, 2));
await writeFile(join(resultsDir, `${stamp}.md`), md);
if (values.publish) await writeFile(join(here, 'RESULTS.md'), md);

console.log(`\n${md}`);
console.log(`Saved to ${join('evals', 'results', `${stamp}.{json,md}`)}${values.publish ? ' and evals/RESULTS.md' : ''}`);
process.exit(summary.passed ? 0 : 1);
