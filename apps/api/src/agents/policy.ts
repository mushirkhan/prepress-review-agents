import { issue, type Issue } from '../domain/issues.js';
import type { AgentId, JobContext } from './context.js';

export const VERDICTS = ['APPROVE', 'REJECT', 'NEEDS_HUMAN_REVIEW'] as const;
export type Verdict = (typeof VERDICTS)[number];

export interface Decision {
  verdict: Verdict;
  reasons: string[];
}

/**
 * The final verdict is decided by this function, not by a model. Models
 * choose which checks to run and explain the results; this rule turns the
 * structured findings into a verdict, and it fails closed:
 *
 *   any CRITICAL issue          -> REJECT
 *   otherwise any WARNING       -> NEEDS_HUMAN_REVIEW
 *     (licensed or ambiguous marks, injection attempts, incomplete checks,
 *      missing DPI information)
 *   otherwise                   -> APPROVE (INFO notes allowed)
 */
export function decideVerdict(issues: Issue[]): Decision {
  const critical = issues.filter((i) => i.severity === 'CRITICAL');
  if (critical.length) return { verdict: 'REJECT', reasons: critical.map((i) => i.message) };
  const warnings = issues.filter((i) => i.severity === 'WARNING');
  if (warnings.length) return { verdict: 'NEEDS_HUMAN_REVIEW', reasons: warnings.map((i) => i.message) };
  return { verdict: 'APPROVE', reasons: ['All checks passed.'] };
}

/** Checks the Preflight agent must complete for its result to count. */
export function requiredPreflightTools(job: JobContext): string[] {
  return ['check_image_dpi', 'check_bleed', 'check_color_space', ...(job.ticket.barcode ? ['validate_barcode'] : [])];
}

/** Checks the IP & Trademark agent must complete; logo search only when logos were seen. */
export function requiredIpTools(job: JobContext): string[] {
  const logos = job.state.vision?.logos.length ?? 0;
  return ['match_protected_marks', 'detect_injection', ...(logos > 0 && job.deps.embedder ? ['search_mark_descriptions'] : [])];
}

const LABEL: Record<AgentId, string> = {
  orchestrator: 'Orchestrator',
  'preflight-agent': 'Preflight',
  'ip-agent': 'IP & Trademark',
  'report-agent': 'Report',
};

/**
 * A check only counts if its agent actually ran the required tools
 * successfully. A model that skips a check, gives up, or hits an error
 * cannot produce a clean result by omission: the gap becomes a
 * CHECK_INCOMPLETE warning, which sends the job to a person.
 */
export function coverageIssues(job: JobContext): Issue[] {
  const required: [AgentId, string[]][] = [
    ['preflight-agent', requiredPreflightTools(job)],
    ['ip-agent', requiredIpTools(job)],
  ];
  return required.flatMap(([agent, tools]) => {
    const done = job.state.completedTools.get(agent) ?? new Set<string>();
    const missing = tools.filter((t) => !done.has(t));
    return missing.length
      ? [
          issue('CHECK_INCOMPLETE', 'WARNING', `${LABEL[agent]} checks did not complete (${missing.join(', ')}); a person must review this job.`, {
            agent,
            missing,
          }),
        ]
      : [];
  });
}

export function parseProposedVerdict(text: string | undefined): Verdict | undefined {
  const m = /PROPOSED VERDICT:\s*\**\s*(APPROVE|REJECT|NEEDS_HUMAN_REVIEW)/i.exec(text ?? '');
  return m ? (m[1]!.toUpperCase() as Verdict) : undefined;
}
