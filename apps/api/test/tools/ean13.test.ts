import { describe, expect, it } from 'vitest';
import { ean13CheckDigit, validateEan13 } from '../../src/tools/preflight/ean13.js';

describe('EAN-13', () => {
  // Real-world codes with known check digits.
  it.each([
    ['400638133393', 1],
    ['501234567890', 0],
    ['978030640615', 7], // ISBN-13 978-0-306-40615-7
  ])('computes the check digit of %s as %i', (first12, digit) => {
    expect(ean13CheckDigit(first12)).toBe(digit);
  });

  it('accepts a valid code', () => {
    expect(validateEan13('4006381333931')).toEqual({ valid: true, expectedCheckDigit: 1, issues: [] });
  });

  it('rejects a wrong check digit and says what it should be', () => {
    const r = validateEan13('4006381333932');
    expect(r.valid).toBe(false);
    expect(r.issues[0]).toMatchObject({ code: 'INVALID_BARCODE', severity: 'CRITICAL', data: { expected: 1, actual: 2 } });
  });

  it.each(['', '123', '40063813339AB', '40063813339311'])('rejects malformed input %j', (code) => {
    expect(validateEan13(code).issues[0]?.code).toBe('INVALID_BARCODE');
  });
});
