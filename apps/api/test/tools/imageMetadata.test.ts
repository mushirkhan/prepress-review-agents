import { describe, expect, it } from 'vitest';
import { readImageMetadata, UnreadableImageError } from '../../src/tools/preflight/imageMetadata.js';
import { makeImage } from '../helpers/images.js';

describe('readImageMetadata', () => {
  it('reads size, DPI and CMYK colour space from a JPEG', async () => {
    const meta = await readImageMetadata(await makeImage({ widthMm: 91, heightMm: 61, cmyk: true }));
    expect(meta).toMatchObject({ format: 'jpeg', widthPx: 1075, heightPx: 720, dpi: 300, colorSpace: 'cmyk' });
  });

  it('reports sRGB for an RGB file', async () => {
    const meta = await readImageMetadata(await makeImage({ widthMm: 91, heightMm: 61 }));
    expect(meta.colorSpace).toBe('srgb');
  });

  // A PNG without a pHYs chunk has no resolution at all. (A JPEG without one
  // still carries the JFIF default of 72 DPI, which the DPI check then flags.)
  it('returns dpi null when the file declares no resolution', async () => {
    const meta = await readImageMetadata(await makeImage({ widthMm: 50, heightMm: 50, dpi: null, format: 'png' }));
    expect(meta.dpi).toBeNull();
  });

  it('rejects an empty file', async () => {
    await expect(readImageMetadata(Buffer.alloc(0))).rejects.toBeInstanceOf(UnreadableImageError);
  });

  it('rejects a text file renamed to .jpg', async () => {
    await expect(readImageMetadata(Buffer.from('definitely not an image'))).rejects.toThrow(/not a recognised image/);
  });

  it('rejects a truncated JPEG', async () => {
    const good = await makeImage({ widthMm: 91, heightMm: 61 });
    const truncated = good.subarray(0, Math.floor(good.length / 2));
    await expect(readImageMetadata(truncated)).rejects.toThrow(/truncated or corrupt/);
  });
});
