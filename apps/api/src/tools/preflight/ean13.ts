import { type Issue, issue } from '../../domain/issues.js';

/**
 * Computes the EAN-13 check digit for the first 12 digits.
 * Digits in odd positions (1st, 3rd, ...) weigh 1, even positions weigh 3.
 */
export function ean13CheckDigit(first12: string): number {
  if (!/^\d{12}$/.test(first12)) throw new Error('expected exactly 12 digits');
  const sum = [...first12].reduce((acc, ch, i) => acc + Number(ch) * (i % 2 === 0 ? 1 : 3), 0);
  return (10 - (sum % 10)) % 10;
}

export interface Ean13Result {
  valid: boolean;
  expectedCheckDigit?: number;
  issues: Issue[];
}

/** Validates a 13-digit EAN barcode number. A wrong check digit will not scan at retail. */
export function validateEan13(code: string): Ean13Result {
  if (!/^\d{13}$/.test(code)) {
    return {
      valid: false,
      issues: [issue('INVALID_BARCODE', 'CRITICAL', `Barcode "${code}" is not 13 digits.`, { code })],
    };
  }
  const expected = ean13CheckDigit(code.slice(0, 12));
  const actual = Number(code[12]);
  if (expected !== actual) {
    return {
      valid: false,
      expectedCheckDigit: expected,
      issues: [
        issue(
          'INVALID_BARCODE',
          'CRITICAL',
          `Barcode ${code} has check digit ${actual}, but it should be ${expected}; it will not scan.`,
          { code, actual, expected },
        ),
      ],
    };
  }
  return { valid: true, expectedCheckDigit: expected, issues: [] };
}
