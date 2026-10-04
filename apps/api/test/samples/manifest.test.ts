/**
 * Keeps the committed samples honest: every file must exist, respect the
 * upload limit, and actually have the properties its manifest entry claims.
 * The deterministic checks are run on each sample and must report exactly
 * the expected issue codes. (Whether the agents reach the expected verdict
 * is measured by the evaluation, not here.)
 */
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { JobTicketSchema } from '../../src/domain/ticket.js';
import { detectInjection } from '../../src/tools/ip/injection.js';
import { matchProtectedMarks } from '../../src/tools/ip/protectedMarks.js';
import { validateEan13 } from '../../src/tools/preflight/ean13.js';
import { readImageMetadata } from '../../src/tools/preflight/imageMetadata.js';
import { checkBleed, checkColorSpace, checkImageDpi } from '../../src/tools/preflight/printChecks.js';

const SAMPLES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../samples');

interface ManifestSample {
  id: string;
  category: 'approve' | 'reject' | 'needs-human' | 'invalid';
  file: string;
  bytes: number;
  ticket: unknown;
  printedText: string[];
  expected: { verdict?: string; issueCodes?: string[]; httpStatus?: number; error?: string };
}

const manifest = JSON.parse(await readFile(join(SAMPLES_DIR, 'manifest.json'), 'utf8')) as {
  maxBytes: number;
  samples: ManifestSample[];
};
const images = manifest.samples.filter((s) => s.category !== 'invalid');
const invalid = manifest.samples.filter((s) => s.category === 'invalid');
const load = (s: ManifestSample) => readFile(join(SAMPLES_DIR, s.file));

describe('sample manifest', () => {
  it('covers every outcome', () => {
    const verdicts = new Set(images.map((s) => s.expected.verdict));
    expect(verdicts).toEqual(new Set(['APPROVE', 'REJECT', 'NEEDS_HUMAN_REVIEW']));
    expect(invalid.length).toBeGreaterThanOrEqual(4);
  });

  it.each(manifest.samples.map((s) => [s.id, s] as const))('%s: file matches the recorded size', async (_id, s) => {
    expect((await load(s)).length).toBe(s.bytes);
  });
});

describe.each(images.map((s) => [s.id, s] as const))('sample %s', (_id, s) => {
  it('is within the upload limit and has a valid ticket', async () => {
    expect(s.bytes).toBeLessThanOrEqual(manifest.maxBytes);
    expect(JobTicketSchema.safeParse(s.ticket).success).toBe(true);
  });

  it('produces exactly the expected issue codes from the deterministic checks', async () => {
    const ticket = JobTicketSchema.parse(s.ticket);
    const meta = await readImageMetadata(await load(s));
    const found = [
      ...checkImageDpi(meta, ticket),
      ...checkBleed(meta, ticket),
      ...checkColorSpace(meta, ticket),
      ...(ticket.barcode ? validateEan13(ticket.barcode).issues : []),
      ...matchProtectedMarks(s.printedText, { licenceReference: ticket.licenceReference }).issues,
      ...detectInjection(s.printedText).issues,
    ].map((i) => i.code);
    expect(found.sort()).toEqual([...(s.expected.issueCodes ?? [])].sort());
  });
});

describe('invalid samples', () => {
  it('oversize sample is a real image, just too big', async () => {
    const s = invalid.find((x) => x.id === 'oversize-250kb')!;
    expect(s.bytes).toBeGreaterThan(manifest.maxBytes);
    await expect(readImageMetadata(await load(s))).resolves.toMatchObject({ format: 'jpeg' });
  });

  it.each(['not-an-image', 'empty', 'corrupt'])('%s cannot be read as an image', async (id) => {
    const s = invalid.find((x) => x.id === id)!;
    await expect(readImageMetadata(await load(s))).rejects.toThrow(/Unreadable image/);
  });
});
