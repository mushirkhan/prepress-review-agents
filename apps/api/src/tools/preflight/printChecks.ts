import { type Issue, issue } from '../../domain/issues.js';
import type { JobTicket } from '../../domain/ticket.js';
import type { ImageMetadata } from './imageMetadata.js';

const MM_PER_INCH = 25.4;
/** Allowed difference between measured and expected size (~6 px at 300 DPI). */
export const SIZE_TOLERANCE_MM = 0.5;
/** Printers usually assume 72 DPI when a file declares none. */
export const FALLBACK_DPI = 72;

export interface SizeMm {
  widthMm: number;
  heightMm: number;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export function physicalSizeMm(meta: ImageMetadata): SizeMm {
  const dpi = meta.dpi ?? FALLBACK_DPI;
  return {
    widthMm: round1((meta.widthPx / dpi) * MM_PER_INCH),
    heightMm: round1((meta.heightPx / dpi) * MM_PER_INCH),
  };
}

/** True if the sizes match within tolerance, in either orientation. */
function sameSize(a: SizeMm, b: SizeMm): boolean {
  const close = (x: number, y: number) => Math.abs(x - y) <= SIZE_TOLERANCE_MM;
  return (
    (close(a.widthMm, b.widthMm) && close(a.heightMm, b.heightMm)) ||
    (close(a.widthMm, b.heightMm) && close(a.heightMm, b.widthMm))
  );
}

/** Resolution: is the declared DPI high enough for print? */
export function checkImageDpi(meta: ImageMetadata, ticket: JobTicket): Issue[] {
  if (meta.dpi === null) {
    return [
      issue(
        'NO_DPI_METADATA',
        'WARNING',
        `The file declares no resolution; printers will assume ${FALLBACK_DPI} DPI.`,
        { assumedDpi: FALLBACK_DPI },
      ),
    ];
  }
  if (meta.dpi < ticket.minDpi) {
    return [
      issue('LOW_RESOLUTION', 'CRITICAL', `Resolution is ${meta.dpi} DPI; this job needs at least ${ticket.minDpi} DPI.`, {
        dpi: meta.dpi,
        minDpi: ticket.minDpi,
      }),
    ];
  }
  return [];
}

/**
 * Size and bleed: the file should measure trim + bleed on every side.
 * A file that matches the trim size exactly has no bleed, so a thin white
 * edge can appear after cutting.
 */
export function checkBleed(meta: ImageMetadata, ticket: JobTicket): Issue[] {
  const actual = physicalSizeMm(meta);
  const trim = { widthMm: ticket.trimWidthMm, heightMm: ticket.trimHeightMm };
  const expected = { widthMm: trim.widthMm + 2 * ticket.bleedMm, heightMm: trim.heightMm + 2 * ticket.bleedMm };
  const data = { actual, expected, trim, bleedMm: ticket.bleedMm };

  if (sameSize(actual, expected)) return [];
  if (ticket.bleedMm > 0 && sameSize(actual, trim)) {
    return [
      issue(
        'BLEED_MISSING',
        'CRITICAL',
        `Artwork is exactly the trim size (${trim.widthMm}×${trim.heightMm} mm) with no ${ticket.bleedMm} mm bleed.`,
        data,
      ),
    ];
  }
  return [
    issue(
      'SIZE_MISMATCH',
      'CRITICAL',
      `Artwork measures ${actual.widthMm}×${actual.heightMm} mm; expected ${expected.widthMm}×${expected.heightMm} mm including bleed.`,
      data,
    ),
  ];
}

/** Colour space: CMYK jobs need CMYK artwork, or colours shift on press. */
export function checkColorSpace(meta: ImageMetadata, ticket: JobTicket): Issue[] {
  const data = { colorSpace: meta.colorSpace, expected: ticket.colorMode };
  if (ticket.colorMode === 'CMYK') {
    if (meta.colorSpace === 'cmyk') return [];
    if (meta.colorSpace === 'grey') {
      return [issue('WRONG_COLOR_SPACE', 'INFO', 'Artwork is greyscale; it will print with black ink only.', data)];
    }
    return [
      issue(
        'WRONG_COLOR_SPACE',
        'CRITICAL',
        `Artwork is ${meta.colorSpace.toUpperCase()}, but this job prints in CMYK; colours will shift.`,
        data,
      ),
    ];
  }
  if (meta.colorSpace === 'cmyk') {
    return [issue('WRONG_COLOR_SPACE', 'WARNING', 'Artwork is CMYK, but this job expects RGB.', data)];
  }
  return [];
}
