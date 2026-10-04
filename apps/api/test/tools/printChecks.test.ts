import { describe, expect, it } from 'vitest';
import { JobTicketSchema } from '../../src/domain/ticket.js';
import { readImageMetadata } from '../../src/tools/preflight/imageMetadata.js';
import { checkBleed, checkColorSpace, checkImageDpi, physicalSizeMm } from '../../src/tools/preflight/printChecks.js';
import { makeImage, type TestImage } from '../helpers/images.js';

// Business card: 85×55 mm trim, 3 mm bleed → 91×61 mm file.
const ticket = JobTicketSchema.parse({ jobName: 'card', trimWidthMm: 85, trimHeightMm: 55 });
const meta = async (o: TestImage) => readImageMetadata(await makeImage(o));
const codes = (issues: { code: string }[]) => issues.map((i) => i.code);

describe('checkBleed', () => {
  it('passes a file that is trim + bleed', async () => {
    const m = await meta({ widthMm: 91, heightMm: 61 });
    expect(physicalSizeMm(m)).toEqual({ widthMm: 91, heightMm: 61 });
    expect(checkBleed(m, ticket)).toEqual([]);
  });

  it('passes the same file rotated', async () => {
    expect(checkBleed(await meta({ widthMm: 61, heightMm: 91 }), ticket)).toEqual([]);
  });

  it('flags BLEED_MISSING when the file is exactly the trim size', async () => {
    expect(codes(checkBleed(await meta({ widthMm: 85, heightMm: 55 }), ticket))).toEqual(['BLEED_MISSING']);
  });

  it('flags SIZE_MISMATCH for an unrelated size', async () => {
    const [i] = checkBleed(await meta({ widthMm: 148, heightMm: 105 }), ticket);
    expect(i).toMatchObject({ code: 'SIZE_MISMATCH', severity: 'CRITICAL' });
  });
});

describe('checkImageDpi', () => {
  it('passes 300 DPI', async () => {
    expect(checkImageDpi(await meta({ widthMm: 91, heightMm: 61, dpi: 300 }), ticket)).toEqual([]);
  });

  it('flags LOW_RESOLUTION below the ticket minimum', async () => {
    const [i] = checkImageDpi(await meta({ widthMm: 91, heightMm: 61, dpi: 150 }), ticket);
    expect(i).toMatchObject({ code: 'LOW_RESOLUTION', severity: 'CRITICAL', data: { dpi: 150, minDpi: 300 } });
  });

  it('warns when the file declares no DPI', async () => {
    const [i] = checkImageDpi(await meta({ widthMm: 30, heightMm: 30, dpi: null, format: 'png' }), ticket);
    expect(i).toMatchObject({ code: 'NO_DPI_METADATA', severity: 'WARNING' });
  });
});

describe('checkColorSpace', () => {
  it('passes CMYK artwork on a CMYK job', async () => {
    expect(checkColorSpace(await meta({ widthMm: 91, heightMm: 61, cmyk: true }), ticket)).toEqual([]);
  });

  it('flags RGB artwork on a CMYK job as CRITICAL', async () => {
    const [i] = checkColorSpace(await meta({ widthMm: 91, heightMm: 61 }), ticket);
    expect(i).toMatchObject({ code: 'WRONG_COLOR_SPACE', severity: 'CRITICAL' });
  });

  it('only warns for CMYK artwork on an RGB job', async () => {
    const rgbJob = { ...ticket, colorMode: 'RGB' as const };
    const [i] = checkColorSpace(await meta({ widthMm: 91, heightMm: 61, cmyk: true }), rgbJob);
    expect(i?.severity).toBe('WARNING');
  });
});
