import sharp from 'sharp';

const MM_PER_INCH = 25.4;

export interface TestImage {
  widthMm: number;
  heightMm: number;
  dpi?: number | null; // null = no density metadata
  cmyk?: boolean;
  format?: 'jpeg' | 'png';
}

/** Makes a flat-colour image of an exact physical size, in memory. */
export async function makeImage(opts: TestImage): Promise<Buffer> {
  const dpi = opts.dpi === undefined ? 300 : opts.dpi;
  const pxPerMm = (dpi ?? 72) / MM_PER_INCH;
  let img = sharp({
    create: {
      width: Math.round(opts.widthMm * pxPerMm),
      height: Math.round(opts.heightMm * pxPerMm),
      channels: 3,
      background: { r: 30, g: 110, b: 160 },
    },
  });
  if (dpi !== null) img = img.withDensity(dpi);
  if (opts.format === 'png') return img.png().toBuffer();
  if (opts.cmyk) img = img.toColourspace('cmyk');
  return img.jpeg({ quality: 80 }).toBuffer();
}
