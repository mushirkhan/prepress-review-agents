import { describe, expect, it } from 'vitest';
import { JobTicketSchema } from '../../src/domain/ticket.js';

const card = { jobName: 'Business card', trimWidthMm: 85, trimHeightMm: 55 };

describe('JobTicketSchema', () => {
  it('applies print defaults: 3 mm bleed, 300 DPI, CMYK', () => {
    expect(JobTicketSchema.parse(card)).toEqual({
      ...card,
      bleedMm: 3,
      minDpi: 300,
      colorMode: 'CMYK',
    });
  });

  it('accepts a valid 13-digit barcode and a licence reference', () => {
    const t = JobTicketSchema.parse({ ...card, barcode: '4006381333931', licenceReference: 'LIC-1' });
    expect(t.barcode).toBe('4006381333931');
  });

  it.each([
    ['missing trim size', { jobName: 'x' }],
    ['negative width', { ...card, trimWidthMm: -1 }],
    ['bleed over 10 mm', { ...card, bleedMm: 12 }],
    ['barcode with letters', { ...card, barcode: '40063813339AB' }],
    ['barcode too short', { ...card, barcode: '12345' }],
    ['unknown colour mode', { ...card, colorMode: 'LAB' }],
    ['unexpected field', { ...card, approve: true }],
  ])('rejects %s', (_label, input) => {
    expect(JobTicketSchema.safeParse(input).success).toBe(false);
  });
});
