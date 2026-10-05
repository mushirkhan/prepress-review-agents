export type Verdict = 'APPROVE' | 'REJECT' | 'NEEDS_HUMAN_REVIEW';
export type Severity = 'CRITICAL' | 'WARNING' | 'INFO';

export interface Issue {
  code: string;
  severity: Severity;
  message: string;
  agent: string;
  data?: Record<string, unknown>;
}

export interface Ticket {
  jobName: string;
  trimWidthMm: number;
  trimHeightMm: number;
  bleedMm: number;
  minDpi: number;
  colorMode: 'CMYK' | 'RGB';
  barcode?: string;
  licenceReference?: string;
}

export interface Job {
  id: string;
  createdAt: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  fileName: string;
  bytes: number;
  ticket: Ticket;
  verdict?: Verdict;
  reasons?: string[];
  issues?: Issue[];
  proposedVerdict?: Verdict;
  summaries?: Record<string, string>;
  violations?: { agent: string; attempted: string; reason: string }[];
  usage?: { inputTokens: number; outputTokens: number };
  durationMs?: number;
  error?: string;
}

export interface TraceEvent {
  seq: number;
  t: number;
  type: string;
  agent: string;
  data: Record<string, unknown>;
}

export interface Sample {
  id: string;
  category: 'approve' | 'reject' | 'needs-human' | 'invalid';
  description: string;
  file: string;
  bytes: number;
  ticket: Partial<Ticket> & { jobName: string; trimWidthMm: number; trimHeightMm: number };
  expected: { verdict?: Verdict; issueCodes?: string[]; httpStatus?: number; error?: string };
}

/** The signed-in user's review allowance for the current UTC day. */
export interface Usage {
  limit: number;
  used: number;
  remaining: number;
  resetsAt: string;
}
