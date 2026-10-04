/**
 * Every check reports problems in the same structured shape, so the
 * orchestrator, the verdict policy, the report and the evals can all work
 * on codes rather than free text.
 */
export const ISSUE_CODES = [
  // Preflight
  'NO_DPI_METADATA',
  'LOW_RESOLUTION',
  'BLEED_MISSING',
  'SIZE_MISMATCH',
  'WRONG_COLOR_SPACE',
  'INVALID_BARCODE',
  // IP & trademark
  'PROTECTED_MARK',
  'AMBIGUOUS_MARK',
  'LICENSED_MARK',
  'PROMPT_INJECTION',
  // System
  'CHECK_INCOMPLETE',
] as const;

export type IssueCode = (typeof ISSUE_CODES)[number];

/**
 * CRITICAL blocks printing; WARNING needs a person to look; INFO is a note.
 */
export type Severity = 'CRITICAL' | 'WARNING' | 'INFO';

export interface Issue {
  code: IssueCode;
  severity: Severity;
  /** One sentence a reviewer can act on. */
  message: string;
  /** Measured values behind the finding, for the report and the evals. */
  data?: Record<string, unknown>;
}

export function issue(
  code: IssueCode,
  severity: Severity,
  message: string,
  data?: Record<string, unknown>,
): Issue {
  return data ? { code, severity, message, data } : { code, severity, message };
}
