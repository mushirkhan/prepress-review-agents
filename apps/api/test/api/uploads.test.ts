import { describe, expect, it } from 'vitest';
import { sniffImageType, UploadError, validateUpload } from '../../src/uploads.js';
import { makeImage } from '../helpers/images.js';

describe('validateUpload', () => {
  it('identifies images by content, not by file name', async () => {
    expect(sniffImageType(await makeImage({ widthMm: 10, heightMm: 10 }))).toBe('jpeg');
    expect(sniffImageType(await makeImage({ widthMm: 10, heightMm: 10, format: 'png' }))).toBe('png');
    expect(sniffImageType(Buffer.from('GIF89a...'))).toBeUndefined();
  });

  it.each([
    ['empty', Buffer.alloc(0), 'EMPTY_FILE', 400],
    ['too large', Buffer.alloc(300_000, 0xff), 'FILE_TOO_LARGE', 413],
    ['a PDF', Buffer.from('%PDF-1.7 ...'), 'UNSUPPORTED_FILE_TYPE', 415],
    ['a JPEG header with garbage after it', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), 'UNREADABLE_IMAGE', 422],
  ])('rejects %s', async (_label, buf, code, status) => {
    const e = await validateUpload(buf, 204_800).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(UploadError);
    expect(e).toMatchObject({ code, status });
  });

  it('accepts a valid JPEG', async () => {
    await expect(validateUpload(await makeImage({ widthMm: 91, heightMm: 61 }), 204_800)).resolves.toEqual({ type: 'jpeg' });
  });
});
