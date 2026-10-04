import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ArtworkStore, VisionReader, VisionResult } from '../../src/agents/ports.js';

export const SAMPLES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../samples');

export interface ManifestSample {
  id: string;
  category: string;
  file: string;
  ticket: Record<string, unknown>;
  printedText: string[];
  expected: { verdict?: string; issueCodes?: string[]; httpStatus?: number; error?: string };
}

export async function loadManifest(): Promise<ManifestSample[]> {
  return (JSON.parse(await readFile(join(SAMPLES_DIR, 'manifest.json'), 'utf8')) as { samples: ManifestSample[] }).samples;
}

/** In-memory store: artwork by job id, reports captured for assertions. */
export class MemoryStore implements ArtworkStore {
  readonly reports = new Map<string, string>();
  readonly reads: string[] = [];
  constructor(private readonly artwork: Map<string, Buffer>) {}

  async readArtwork(jobId: string): Promise<Buffer> {
    this.reads.push(jobId);
    await new Promise((r) => setTimeout(r, 5)); // behave like real I/O
    const buf = this.artwork.get(jobId);
    if (!buf) throw new Error(`no artwork for job ${jobId}`);
    return buf;
  }

  async saveReport(jobId: string, markdown: string): Promise<string> {
    this.reports.set(jobId, markdown);
    return `reports/${jobId}.md`;
  }
}

/** Vision fake that "sees" the given text; counts calls to prove caching. */
export class FakeVision implements VisionReader {
  calls = 0;
  constructor(private readonly result: VisionResult | Error) {}
  async describe(): Promise<VisionResult> {
    this.calls += 1;
    await new Promise((r) => setTimeout(r, 5));
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }
}
