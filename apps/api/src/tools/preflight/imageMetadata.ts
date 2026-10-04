import sharp, { type Metadata } from 'sharp';

export type ColorSpace = 'cmyk' | 'srgb' | 'grey' | 'other';

export interface ImageMetadata {
  format: 'jpeg' | 'png' | 'tiff';
  widthPx: number;
  heightPx: number;
  /** Declared resolution in pixels per inch, or null if the file has none. */
  dpi: number | null;
  colorSpace: ColorSpace;
  /** sharp's raw colour-space name, kept for the report. */
  rawColorSpace: string;
  hasIccProfile: boolean;
  bytes: number;
}

export class UnreadableImageError extends Error {
  constructor(reason: string) {
    super(`Unreadable image: ${reason}`);
    this.name = 'UnreadableImageError';
  }
}

const SUPPORTED = new Set(['jpeg', 'png', 'tiff']);
// Guards against "decompression bombs": tiny files that expand to huge images.
const MAX_PIXELS = 40_000_000;

function toColorSpace(space: string | undefined): ColorSpace {
  if (space === 'cmyk') return 'cmyk';
  if (space === 'srgb' || space === 'rgb' || space === 'rgb16' || space === 'scrgb') return 'srgb';
  if (space === 'b-w' || space === 'grey16') return 'grey';
  return 'other';
}

/**
 * Reads the print-relevant facts from an image file: pixel size, declared
 * DPI, colour space. Fully decodes the image once so truncated or corrupt
 * files are rejected here instead of producing half-true metadata.
 */
export async function readImageMetadata(buffer: Buffer): Promise<ImageMetadata> {
  if (buffer.length === 0) throw new UnreadableImageError('file is empty');

  let meta: Metadata;
  try {
    meta = await sharp(buffer, { limitInputPixels: MAX_PIXELS }).metadata();
  } catch {
    throw new UnreadableImageError('not a recognised image format');
  }
  if (!meta.format || !SUPPORTED.has(meta.format)) {
    throw new UnreadableImageError(`format "${meta.format ?? 'unknown'}" is not supported (use JPEG, PNG or TIFF)`);
  }
  if (!meta.width || !meta.height) throw new UnreadableImageError('image has no dimensions');

  try {
    // Decoding the whole image catches truncated and corrupt files.
    await sharp(buffer, { limitInputPixels: MAX_PIXELS, failOn: 'truncated' }).stats();
  } catch {
    throw new UnreadableImageError('image data is truncated or corrupt');
  }

  return {
    format: meta.format as ImageMetadata['format'],
    widthPx: meta.width,
    heightPx: meta.height,
    dpi: meta.density ? Math.round(meta.density) : null,
    colorSpace: toColorSpace(meta.space),
    rawColorSpace: meta.space ?? 'unknown',
    hasIccProfile: Boolean(meta.icc),
    bytes: buffer.length,
  };
}
