import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ArtworkStore } from '../agents/ports.js';

const JOB_ID = /^[a-z0-9-]{4,64}$/;

/**
 * Artwork and reports on the local disk. The file name is always derived
 * from the job id, which is validated, so no caller can reach a path
 * outside the two folders.
 */
export class LocalArtworkStore implements ArtworkStore {
  constructor(private readonly dataDir: string) {}

  private path(kind: 'artwork' | 'reports', jobId: string, ext: string): string {
    if (!JOB_ID.test(jobId)) throw new Error(`invalid job id "${jobId}"`);
    return join(this.dataDir, kind, `${jobId}.${ext}`);
  }

  async saveArtwork(jobId: string, image: Buffer): Promise<void> {
    await mkdir(join(this.dataDir, 'artwork'), { recursive: true });
    await writeFile(this.path('artwork', jobId, 'img'), image);
  }

  async readArtwork(jobId: string): Promise<Buffer> {
    return readFile(this.path('artwork', jobId, 'img'));
  }

  async saveReport(jobId: string, markdown: string): Promise<string> {
    await mkdir(join(this.dataDir, 'reports'), { recursive: true });
    const path = this.path('reports', jobId, 'md');
    await writeFile(path, markdown);
    return `reports/${jobId}.md`;
  }
}
