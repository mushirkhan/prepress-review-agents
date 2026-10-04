import type { Job, Verdict } from '../types';

export const VERDICT_TEXT: Record<Verdict, { label: string; hint: string }> = {
  APPROVE: { label: 'Approved', hint: 'Ready to print.' },
  REJECT: { label: 'Rejected', hint: 'Not OK to produce. See the findings below.' },
  NEEDS_HUMAN_REVIEW: { label: 'Needs a person', hint: 'A reviewer must look at this job before printing.' },
};

export function VerdictChip({ verdict }: { verdict?: Verdict | undefined }) {
  if (!verdict) return <span className="chip chip-muted">—</span>;
  return <span className={`chip verdict-${verdict}`}>{VERDICT_TEXT[verdict].label}</span>;
}

export function StatusChip({ job }: { job: Pick<Job, 'status' | 'verdict'> }) {
  if (job.status === 'queued') return <span className="chip chip-muted">Queued</span>;
  if (job.status === 'running') return <span className="chip chip-running">Reviewing…</span>;
  return <VerdictChip verdict={job.verdict} />;
}

export function VerdictBanner({ job }: { job: Job }) {
  if (!job.verdict) return null;
  const v = VERDICT_TEXT[job.verdict];
  return (
    <section className={`banner verdict-${job.verdict}`} aria-live="polite">
      <div>
        <div className="banner-label">{v.label}</div>
        <div className="banner-hint">{job.status === 'failed' ? 'The review could not finish, so it fails safe: a person must check this job.' : v.hint}</div>
      </div>
      {job.reasons?.length ? (
        <ul className="banner-reasons">
          {job.reasons.slice(0, 4).map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
