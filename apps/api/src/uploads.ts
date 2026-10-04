import { readImageMetadata, UnreadableImageError } from './tools/preflight/imageMetadata.js';

export type UploadErrorCode = 'EMPTY_FILE' | 'FILE_TOO_LARGE' | 'UNSUPPORTED_FILE_TYPE' | 'UNREADABLE_IMAGE';

export class UploadError extends Error {
  constructor(
    readonly code: UploadErrorCode,
    readonly status: 400 | 413 | 415 | 422,
    message: string,
  ) {
    super(message);
    this.name = 'UploadError';
  }
}

/** File signatures ("magic bytes"): the content decides the type, not the file name. */
const SIGNATURES: { type: 'jpeg' | 'png' | 'tiff'; bytes: number[] }[] = [
  { type: 'jpeg', bytes: [0xff, 0xd8, 0xff] },
  { type: 'png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { type: 'tiff', bytes: [0x49, 0x49, 0x2a, 0x00] },
  { type: 'tiff', bytes: [0x4d, 0x4d, 0x00, 0x2a] },
];

export function sniffImageType(buf: Buffer): 'jpeg' | 'png' | 'tiff' | undefined {
  return SIGNATURES.find((s) => s.bytes.every((b, i) => buf[i] === b))?.type;
}

/**
 * Checks an upload before any agent sees it, cheapest check first:
 * empty -> too large -> wrong type (by content) -> undecodable.
 * Bad input never costs a model call.
 */
export async function validateUpload(buf: Buffer, maxBytes: number): Promise<{ type: 'jpeg' | 'png' | 'tiff' }> {
  if (buf.length === 0) throw new UploadError('EMPTY_FILE', 400, 'The file is empty.');
  if (buf.length > maxBytes) {
    throw new UploadError('FILE_TOO_LARGE', 413, `The file is ${Math.ceil(buf.length / 1024)} KB; the limit is ${Math.floor(maxBytes / 1024)} KB.`);
  }
  const type = sniffImageType(buf);
  if (!type) throw new UploadError('UNSUPPORTED_FILE_TYPE', 415, 'Only JPEG, PNG and TIFF images are accepted.');
  try {
    await readImageMetadata(buf);
  } catch (err) {
    const reason = err instanceof UnreadableImageError ? err.message : 'the image could not be decoded';
    throw new UploadError('UNREADABLE_IMAGE', 422, `${reason}.`);
  }
  return { type };
}
