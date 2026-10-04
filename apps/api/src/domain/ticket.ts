import { z } from 'zod';

/**
 * The job ticket a reviewer submits with the artwork. It describes what the
 * printer was asked to produce, so the checks have something to compare
 * the file against.
 */
export const JobTicketSchema = z
  .object({
    jobName: z.string().trim().min(1).max(100),
    /** Finished (trimmed) size of the printed piece, in millimetres. */
    trimWidthMm: z.number().positive().max(1000),
    trimHeightMm: z.number().positive().max(1000),
    /** Extra artwork beyond the trim on every side, cut off after printing. */
    bleedMm: z.number().min(0).max(10).default(3),
    /** Minimum acceptable resolution in pixels per inch. */
    minDpi: z.number().int().min(72).max(1200).default(300),
    /** Colour space the press expects. */
    colorMode: z.enum(['CMYK', 'RGB']).default('CMYK'),
    /** EAN-13 barcode number printed on the piece, if any. */
    barcode: z
      .string()
      .regex(/^\d{13}$/, 'barcode must be exactly 13 digits')
      .optional(),
    /** Reference to a licence for any third-party marks (e.g. LIC-2026-0042). */
    licenceReference: z.string().trim().min(1).max(100).optional(),
  })
  .strict();

export type JobTicket = z.infer<typeof JobTicketSchema>;
export type JobTicketInput = z.input<typeof JobTicketSchema>;
