import { validateEan13 } from '../../tools/preflight/ean13.js';
import { readImageMetadata, type ImageMetadata } from '../../tools/preflight/imageMetadata.js';
import { checkBleed, checkColorSpace, checkImageDpi, physicalSizeMm } from '../../tools/preflight/printChecks.js';
import type { JobContext } from '../context.js';
import { jobTool, noInput } from '../toolkit.js';

/** Loads the artwork through the store once per run and caches its metadata. */
export async function ensureMetadata(job: JobContext): Promise<ImageMetadata> {
  if (!job.state.metadata) {
    job.state.artwork ??= await job.deps.store.readArtwork(job.jobId);
    job.state.metadata = await readImageMetadata(job.state.artwork);
  }
  return job.state.metadata;
}

const owner = 'preflight-agent' as const;

export const readImageMetadataTool = jobTool({
  id: 'read_image_metadata',
  owner,
  description:
    "Reads the job's artwork file and returns its pixel size, declared DPI, physical size in mm and colour space. Call this first.",
  input: noInput,
  run: async (_input, job) => {
    const m = await ensureMetadata(job);
    return {
      result: {
        format: m.format,
        widthPx: m.widthPx,
        heightPx: m.heightPx,
        dpi: m.dpi,
        colorSpace: m.colorSpace,
        physicalSizeMm: physicalSizeMm(m),
        bytes: m.bytes,
      },
    };
  },
});

export const checkImageDpiTool = jobTool({
  id: 'check_image_dpi',
  owner,
  description: "Checks the artwork's resolution against the job's minimum DPI.",
  input: noInput,
  run: async (_input, job) => {
    const m = await ensureMetadata(job);
    const issues = checkImageDpi(m, job.ticket);
    return { result: { dpi: m.dpi, minDpi: job.ticket.minDpi, pass: issues.length === 0 }, issues };
  },
});

export const checkBleedTool = jobTool({
  id: 'check_bleed',
  owner,
  description: "Checks that the artwork measures the trim size plus bleed on every side, as the job ticket requires.",
  input: noInput,
  run: async (_input, job) => {
    const m = await ensureMetadata(job);
    const issues = checkBleed(m, job.ticket);
    return {
      result: {
        actualMm: physicalSizeMm(m),
        trimMm: { widthMm: job.ticket.trimWidthMm, heightMm: job.ticket.trimHeightMm },
        bleedMm: job.ticket.bleedMm,
        pass: issues.length === 0,
      },
      issues,
    };
  },
});

export const checkColorSpaceTool = jobTool({
  id: 'check_color_space',
  owner,
  description: "Checks the artwork's colour space against the job's colour mode (usually CMYK for print).",
  input: noInput,
  run: async (_input, job) => {
    const m = await ensureMetadata(job);
    const issues = checkColorSpace(m, job.ticket);
    return { result: { colorSpace: m.colorSpace, expected: job.ticket.colorMode, pass: issues.length === 0 }, issues };
  },
});

export const validateBarcodeTool = jobTool({
  id: 'validate_barcode',
  owner,
  description: "Validates the EAN-13 check digit of the barcode number on the job ticket. Call only if the ticket has a barcode.",
  input: noInput,
  run: async (_input, job) => {
    if (!job.ticket.barcode) return { result: { skipped: true, reason: 'ticket has no barcode' } };
    const r = validateEan13(job.ticket.barcode);
    return { result: { barcode: job.ticket.barcode, valid: r.valid, expectedCheckDigit: r.expectedCheckDigit }, issues: r.issues };
  },
});

export const preflightTools = {
  read_image_metadata: readImageMetadataTool,
  check_image_dpi: checkImageDpiTool,
  check_bleed: checkBleedTool,
  check_color_space: checkColorSpaceTool,
  validate_barcode: validateBarcodeTool,
};
