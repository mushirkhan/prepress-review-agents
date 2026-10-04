import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LocalArtworkStore } from '../src/adapters/localStore.js';
import { createJobContext } from '../src/agents/context.js';
import type { ArtworkStore, Embedder, VisionReader } from '../src/agents/ports.js';
import { type ReviewModels, reviewArtwork } from '../src/agents/review.js';
import { JobTicketSchema } from '../src/domain/ticket.js';
import { type CaseScore, type EvalSample, scoreCase } from './scoring.js';

export interface HarnessDeps {
  samplesDir: string;
  /** Folder holding artwork/ and reports/ for this run. */
  dataDir: string;
  store: ArtworkStore;
  vision: (sample: EvalSample) => VisionReader;
  embedder?: Embedder | undefined;
  /** Fresh models per case (scripted models in tests keep state). */
  models: (sample: EvalSample) => ReviewModels;
}

export interface HarnessOptions {
  repeat: number;
  concurrency: number;
  onCase?: (score: CaseScore) => void;
}

/**
 * Runs every sample through the whole review (agents, tools, MCP server,
 * policy, report) exactly as production does, and scores each run.
 */
export async function runEval(samples: EvalSample[], deps: HarnessDeps, opts: HarnessOptions): Promise<CaseScore[]> {
  const uploads = new LocalArtworkStore(deps.dataDir);
  const work = samples.flatMap((sample) => Array.from({ length: opts.repeat }, (_, i) => ({ sample, run: i + 1 })));
  const scores: CaseScore[] = [];

  const runOne = async ({ sample, run }: { sample: EvalSample; run: number }) => {
    const jobId = `eval-${sample.id}-${run}`;
    await uploads.saveArtwork(jobId, await readFile(join(deps.samplesDir, sample.file)));
    const job = createJobContext({
      jobId,
      ticket: JobTicketSchema.parse(sample.ticket),
      deps: { store: deps.store, vision: deps.vision(sample), embedder: deps.embedder },
    });
    const result = await reviewArtwork(job, deps.models(sample));
    const report = await readFile(join(deps.dataDir, 'reports', `${jobId}.md`), 'utf8').catch(() => undefined);
    const score = scoreCase(sample, run, result, report);
    scores.push(score);
    opts.onCase?.(score);
  };

  // A small worker pool: parallel enough to be quick, gentle on Bedrock quotas.
  const queue = [...work];
  await Promise.all(
    Array.from({ length: Math.max(1, opts.concurrency) }, async () => {
      for (let item = queue.shift(); item; item = queue.shift()) await runOne(item);
    }),
  );
  return scores.sort((a, b) => a.id.localeCompare(b.id) || a.run - b.run);
}
