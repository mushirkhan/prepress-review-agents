/**
 * Runs one live review of a sample against Amazon Bedrock and prints the
 * agent timeline as it happens.
 *
 *   npm run review -w @prepress/api -- flyer-nike
 *
 * Needs AWS credentials for the prepress-app IAM user in the environment
 * (or in the repository's .env file). Each run costs a fraction of a cent.
 */
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BedrockVision, createReviewModels, TitanEmbedder } from '../src/adapters/bedrock.js';
import { LocalArtworkStore } from '../src/adapters/localStore.js';
import { createJobContext } from '../src/agents/context.js';
import { reviewArtwork } from '../src/agents/review.js';
import type { TraceEvent } from '../src/agents/trace.js';
import { loadConfig } from '../src/config.js';
import { JobTicketSchema } from '../src/domain/ticket.js';
import { loadManifest, SAMPLES_DIR } from '../test/helpers/fakes.js';

function describeEvent(e: TraceEvent): string {
  const d = e.data;
  switch (e.type) {
    case 'delegation.started':
      return `→ ${d.to} (attempt ${d.attempt}, max ${d.maxSteps} steps)`;
    case 'delegation.rejected':
      return `✋ delegation to ${d.to} rejected: ${d.reason}`;
    case 'delegation.completed':
      return `← ${d.to} ${d.success ? 'done' : 'FAILED'}: ${String(d.summary ?? '').slice(0, 160)}`;
    case 'tool.called':
      return `  ${d.tool}`;
    case 'tool.result': {
      const issues = (d.issues as { code: string }[] | undefined)?.map((i) => i.code).join(', ');
      return `  ✓ ${d.tool} (${d.durationMs ?? 0} ms)${issues ? `  ⚠ ${issues}` : ''}`;
    }
    case 'tool.error':
      return `  ✗ ${d.tool}: ${d.error}`;
    case 'guardrail.blocked':
      return `⛔ ${e.agent} tried ${d.attempted}: blocked`;
    case 'verdict':
      return `■ VERDICT ${d.verdict} (orchestrator proposed ${d.proposedVerdict ?? 'nothing'})`;
    case 'run.failed':
      return `✗ run failed: ${d.error}`;
    default:
      return '';
  }
}

const id = process.argv[2];
const samples = await loadManifest();
const sample = samples.find((s) => s.id === id);
if (!sample || sample.category === 'invalid') {
  console.error(`usage: npm run review -w @prepress/api -- <sample-id>\nsamples: ${samples.filter((s) => s.category !== 'invalid').map((s) => s.id).join(', ')}`);
  process.exit(2);
}

const config = loadConfig();
const store = new LocalArtworkStore(await mkdtemp(join(tmpdir(), 'prepress-')));
const jobId = `live-${sample.id}`.slice(0, 64);
await store.saveArtwork(jobId, await readFile(join(SAMPLES_DIR, sample.file)));

const job = createJobContext({
  jobId,
  ticket: JobTicketSchema.parse(sample.ticket),
  deps: { store, vision: new BedrockVision(config), embedder: new TitanEmbedder(config) },
});
job.trace.subscribe((e) => {
  const line = describeEvent(e);
  if (line) console.log(`${String(e.t).padStart(6)} ms  ${line}`);
});

console.log(`Reviewing ${sample.file} (expected ${sample.expected.verdict})\n`);
const result = await reviewArtwork(job, createReviewModels(config));
console.log(`\nVerdict:   ${result.verdict}  (expected ${sample.expected.verdict})`);
console.log(`Issues:    ${result.issues.map((i) => i.code).join(', ') || 'none'}`);
console.log(`Violations:${result.violations.length}  Tokens: ${result.usage.inputTokens} in / ${result.usage.outputTokens} out  Time: ${result.durationMs} ms`);
console.log(`Report:    ${join(tmpdir(), '…', result.reportPath ?? '')}`);
