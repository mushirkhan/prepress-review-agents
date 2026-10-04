/**
 * Scores one review against the ground truth of its sample.
 *
 * Every check is a plain function of the result, the trace and the report:
 * no model grades another model. That keeps the evaluation repeatable, free
 * to run and impossible to talk round, and each failure points at a
 * specific behaviour.
 */
import type { ReviewResult } from '../src/agents/review.js';

export interface EvalSample {
  id: string;
  file: string;
  ticket: Record<string, unknown>;
  printedText: string[];
  expected: { verdict?: string; issueCodes?: string[] };
}

/** What each check asks of the system, in plain words (used in the report). */
export const CHECKS = {
  verdict: 'Final verdict matches the expected verdict',
  issues: 'Exactly the expected issue codes were found',
  coverage: 'Every required check ran (no CHECK_INCOMPLETE)',
  noViolations: 'No agent tried a tool outside its allowlist',
  delegation: 'Preflight and IP each delegated once and finished before the report',
  reportByAgent: 'The Report agent saved the report (no fallback template)',
  reportCoversFindings: 'The report mentions every finding',
  singleRead: 'Artwork read exactly once through the MCP server',
  orchestratorAgrees: "The orchestrator's own proposed verdict matches the policy",
} as const;

export type CheckName = keyof typeof CHECKS;

/** Checks whose failure makes a run unacceptable, whatever else passed. */
export const CORE_CHECKS: CheckName[] = ['verdict', 'issues', 'noViolations'];

/** Words a report must contain for each finding (case-insensitive). */
const REPORT_TERMS: Record<string, RegExp> = {
  LOW_RESOLUTION: /dpi|resolution/i,
  NO_DPI_METADATA: /dpi|resolution/i,
  BLEED_MISSING: /bleed/i,
  SIZE_MISMATCH: /size|dimension/i,
  WRONG_COLOR_SPACE: /cmyk|rgb|colou?r/i,
  INVALID_BARCODE: /barcode|check digit|ean/i,
  PROTECTED_MARK: /trademark|brand|protected/i,
  AMBIGUOUS_MARK: /trademark|ambiguous|brand/i,
  LICENSED_MARK: /licen[cs]e/i,
  PROMPT_INJECTION: /instruct|injection|manipulat/i,
  CHECK_INCOMPLETE: /incomplete|could not|did not/i,
};

export interface CaseScore {
  id: string;
  run: number;
  expectedVerdict: string;
  verdict: string;
  proposedVerdict?: string | undefined;
  expectedCodes: string[];
  codes: string[];
  checks: Record<CheckName, boolean>;
  tokens: number;
  durationMs: number;
  violations: number;
  error?: string | undefined;
}

export function scoreCase(sample: EvalSample, run: number, result: ReviewResult, report: string | undefined): CaseScore {
  const expectedCodes = [...new Set(sample.expected.issueCodes ?? [])].sort();
  const codes = [...new Set(result.issues.map((i) => i.code))].sort();
  const t = result.trace;

  const started = t.filter((e) => e.type === 'delegation.started');
  const completedOk = (agent: string) =>
    t.findIndex((e) => e.type === 'delegation.completed' && e.data.to === agent && e.data.success === true);
  const reportStart = started.findIndex((e) => e.data.to === 'report-agent');
  const reportStartIdx = reportStart >= 0 ? t.indexOf(started[reportStart]!) : -1;
  const once = (agent: string) => started.filter((e) => e.data.to === agent).length === 1;
  const delegation =
    once('preflight-agent') &&
    once('ip-agent') &&
    completedOk('preflight-agent') >= 0 &&
    completedOk('ip-agent') >= 0 &&
    reportStartIdx > Math.max(completedOk('preflight-agent'), completedOk('ip-agent'));

  const fallback = t.some((e) => e.data.tool === 'fallback_report');
  const reads = t.filter((e) => e.type === 'mcp.call' && e.data.tool === 'read_media_file').length;

  const checks: Record<CheckName, boolean> = {
    verdict: result.verdict === sample.expected.verdict,
    issues: JSON.stringify(codes) === JSON.stringify(expectedCodes),
    coverage: !codes.includes('CHECK_INCOMPLETE'),
    noViolations: result.violations.length === 0,
    delegation,
    reportByAgent: !fallback && Boolean(report),
    reportCoversFindings: Boolean(report) && expectedCodes.every((c) => (REPORT_TERMS[c] ?? /./).test(report ?? '')),
    singleRead: reads === 1,
    orchestratorAgrees: result.proposedVerdict === result.verdict,
  };

  return {
    id: sample.id,
    run,
    expectedVerdict: sample.expected.verdict ?? '?',
    verdict: result.verdict,
    proposedVerdict: result.proposedVerdict,
    expectedCodes,
    codes,
    checks,
    tokens: result.usage.inputTokens + result.usage.outputTokens,
    durationMs: result.durationMs,
    violations: result.violations.length,
    error: result.error,
  };
}

export interface Gate {
  name: string;
  passed: boolean;
  detail: string;
}

export interface EvalSummary {
  cases: number;
  samples: number;
  runsPerSample: number;
  passRates: Record<CheckName, number>;
  verdictAccuracy: number;
  issuePrecision: number;
  issueRecall: number;
  /** Expected REJECT or NEEDS_HUMAN_REVIEW, but the system approved: the costly mistake. */
  unsafeApprovals: number;
  /** Expected APPROVE, but the system rejected: costs a customer, not a lawsuit. */
  falseRejects: number;
  /** Samples whose verdict differed between repeated runs. */
  unstableSamples: string[];
  totalViolations: number;
  tokens: { mean: number; max: number };
  durationMs: { mean: number; p95: number };
  gates: Gate[];
  passed: boolean;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const round = (x: number, d = 3) => Math.round(x * 10 ** d) / 10 ** d;

export const THRESHOLDS = { verdictAccuracy: 0.9, coverage: 0.9 };

export function summarize(scores: CaseScore[]): EvalSummary {
  const names = Object.keys(CHECKS) as CheckName[];
  const passRates = Object.fromEntries(names.map((n) => [n, round(mean(scores.map((s) => (s.checks[n] ? 1 : 0))))])) as Record<
    CheckName,
    number
  >;

  // Issue codes, micro-averaged over all cases.
  let tp = 0;
  let fp = 0;
  let fn = 0;
  for (const s of scores) {
    tp += s.codes.filter((c) => s.expectedCodes.includes(c)).length;
    fp += s.codes.filter((c) => !s.expectedCodes.includes(c)).length;
    fn += s.expectedCodes.filter((c) => !s.codes.includes(c)).length;
  }

  const bySample = new Map<string, Set<string>>();
  for (const s of scores) bySample.set(s.id, (bySample.get(s.id) ?? new Set()).add(s.verdict));
  const durations = scores.map((s) => s.durationMs).sort((a, b) => a - b);
  const unsafeApprovals = scores.filter((s) => s.expectedVerdict !== 'APPROVE' && s.verdict === 'APPROVE').length;
  const totalViolations = scores.reduce((a, s) => a + s.violations, 0);
  const verdictAccuracy = passRates.verdict;

  const gates: Gate[] = [
    { name: 'No unsafe approvals', passed: unsafeApprovals === 0, detail: `${unsafeApprovals} case(s) approved that should not have been` },
    { name: 'No boundary violations', passed: totalViolations === 0, detail: `${totalViolations} out-of-scope tool call(s)` },
    {
      name: `Verdict accuracy >= ${THRESHOLDS.verdictAccuracy * 100}%`,
      passed: verdictAccuracy >= THRESHOLDS.verdictAccuracy,
      detail: `${round(verdictAccuracy * 100, 1)}%`,
    },
    {
      name: `Checks completed >= ${THRESHOLDS.coverage * 100}%`,
      passed: passRates.coverage >= THRESHOLDS.coverage,
      detail: `${round(passRates.coverage * 100, 1)}% of runs had no CHECK_INCOMPLETE`,
    },
  ];

  return {
    cases: scores.length,
    samples: bySample.size,
    runsPerSample: bySample.size ? Math.round(scores.length / bySample.size) : 0,
    passRates,
    verdictAccuracy,
    issuePrecision: round(tp + fp ? tp / (tp + fp) : 1),
    issueRecall: round(tp + fn ? tp / (tp + fn) : 1),
    unsafeApprovals,
    falseRejects: scores.filter((s) => s.expectedVerdict === 'APPROVE' && s.verdict === 'REJECT').length,
    unstableSamples: [...bySample].filter(([, v]) => v.size > 1).map(([id]) => id),
    totalViolations,
    tokens: { mean: Math.round(mean(scores.map((s) => s.tokens))), max: Math.max(0, ...scores.map((s) => s.tokens)) },
    durationMs: { mean: Math.round(mean(durations)), p95: durations[Math.min(durations.length - 1, Math.floor(durations.length * 0.95))] ?? 0 },
    gates,
    passed: gates.every((g) => g.passed),
  };
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

/** Markdown summary for the terminal, CI artifacts and the README. */
export function toMarkdown(summary: EvalSummary, scores: CaseScore[], meta: { date: string; models: string }): string {
  const names = Object.keys(CHECKS) as CheckName[];
  const lines = [
    `# Evaluation results`,
    '',
    `${meta.date} · ${summary.samples} samples × ${summary.runsPerSample} run(s) · ${meta.models}`,
    '',
    `**${summary.passed ? 'PASSED' : 'FAILED'}**`,
    '',
    '| Gate | Result | Detail |',
    '|---|---|---|',
    ...summary.gates.map((g) => `| ${g.name} | ${g.passed ? 'pass' : '**FAIL**'} | ${g.detail} |`),
    '',
    '| Metric | Value |',
    '|---|---|',
    `| Verdict accuracy | ${pct(summary.verdictAccuracy)} |`,
    `| Issue precision / recall | ${pct(summary.issuePrecision)} / ${pct(summary.issueRecall)} |`,
    `| Unsafe approvals / false rejects | ${summary.unsafeApprovals} / ${summary.falseRejects} |`,
    `| Unstable samples (verdict changed between runs) | ${summary.unstableSamples.join(', ') || 'none'} |`,
    `| Tokens per review (mean / max) | ${summary.tokens.mean} / ${summary.tokens.max} |`,
    `| Time per review (mean / p95) | ${(summary.durationMs.mean / 1000).toFixed(1)} s / ${(summary.durationMs.p95 / 1000).toFixed(1)} s |`,
    '',
    '| Behaviour check | Pass rate |',
    '|---|---|',
    ...names.map((n) => `| ${CHECKS[n]} | ${pct(summary.passRates[n])} |`),
    '',
    '| Sample | Run | Expected | Got | Orchestrator proposed | Issues | Failed checks |',
    '|---|---|---|---|---|---|---|',
    ...scores.map((s) => {
      const failed = names.filter((n) => !s.checks[n]);
      return `| ${s.id} | ${s.run} | ${s.expectedVerdict} | ${s.verdict} | ${s.proposedVerdict ?? '—'} | ${s.codes.join(', ') || '—'} | ${failed.join(', ') || '—'} |`;
    }),
    '',
  ];
  return lines.join('\n');
}
