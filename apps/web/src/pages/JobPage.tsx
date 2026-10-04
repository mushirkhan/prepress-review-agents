import { useCallback, useEffect, useState } from 'react';
import Markdown from 'react-markdown';
import { Findings } from '../components/Findings';
import { Timeline } from '../components/Timeline';
import { StatusChip, VerdictBanner } from '../components/Verdict';
import { followEvents } from '../lib/sse';
import { useSession } from '../lib/session';
import type { Job, TraceEvent } from '../types';

export function JobPage({ id }: { id: string }) {
  const { api, getToken } = useSession();
  const [job, setJob] = useState<Job | null>(null);
  const [events, setEvents] = useState<TraceEvent[]>([]);
  const [report, setReport] = useState<string | null>(null);
  const [artwork, setArtwork] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const j = await api.getJob(id);
    setJob(j);
    if (j.status === 'completed' || j.status === 'failed') setReport(await api.report(id).catch(() => null));
    return j;
  }, [api, id]);

  useEffect(() => {
    setEvents([]);
    setReport(null);
    refresh().catch((e: Error) => setError(e.message));
    let url: string | undefined;
    api
      .artworkUrl(id)
      .then((u) => setArtwork((url = u)))
      .catch(() => setArtwork(null));
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [api, id, refresh]);

  // Live trace; replays the whole run for finished jobs.
  useEffect(() => {
    const ctrl = new AbortController();
    let ended = false;
    void followEvents(
      api.eventsUrl(id),
      getToken,
      {
        onEvent: (e) => {
          setEvents((prev) => (prev.length && prev[prev.length - 1]!.seq >= e.seq ? prev : [...prev, e]));
          if (e.type === 'delegation.started') setJob((j) => (j && j.status === 'queued' ? { ...j, status: 'running' } : j));
        },
        onEnd: () => {
          ended = true;
          void refresh();
        },
      },
      ctrl.signal,
    ).then(async () => {
      // Fallback if the stream could not be kept open: poll until the job finishes.
      while (!ended && !ctrl.signal.aborted) {
        const j = await refresh().catch(() => null);
        if (j && (j.status === 'completed' || j.status === 'failed')) break;
        await new Promise((r) => setTimeout(r, 3000));
      }
    });
    return () => ctrl.abort();
  }, [api, getToken, id, refresh]);

  if (error) return <div className="page"><p className="error">{error}</p></div>;
  if (!job) return <div className="page"><p className="muted">Loading…</p></div>;
  const live = job.status === 'queued' || job.status === 'running';
  const t = job.ticket;

  return (
    <div className="page">
      <header className="page-head job-head">
        <div>
          <a href="/history" className="back">
            ← All reviews
          </a>
          <h1>{t.jobName}</h1>
          <p className="muted">
            {job.fileName} · {(job.bytes / 1024).toFixed(0)} KB · {new Date(job.createdAt).toLocaleString()}
          </p>
        </div>
        <StatusChip job={job} />
      </header>

      <VerdictBanner job={job} />

      <div className="job-grid">
        <aside className="card job-side">
          {artwork ? <img className="artwork" src={artwork} alt="Uploaded artwork" /> : <div className="artwork artwork-empty">No preview</div>}
          <dl className="facts">
            <dt>Trim</dt>
            <dd>
              {t.trimWidthMm} × {t.trimHeightMm} mm + {t.bleedMm} mm bleed
            </dd>
            <dt>Minimum</dt>
            <dd>
              {t.minDpi} DPI · {t.colorMode}
            </dd>
            {t.barcode ? (
              <>
                <dt>Barcode</dt>
                <dd>
                  <code>{t.barcode}</code>
                </dd>
              </>
            ) : null}
            {t.licenceReference ? (
              <>
                <dt>Licence</dt>
                <dd>{t.licenceReference}</dd>
              </>
            ) : null}
            {job.usage ? (
              <>
                <dt>Model tokens</dt>
                <dd>
                  {job.usage.inputTokens.toLocaleString()} in · {job.usage.outputTokens.toLocaleString()} out
                </dd>
              </>
            ) : null}
            {job.durationMs ? (
              <>
                <dt>Time</dt>
                <dd>{(job.durationMs / 1000).toFixed(1)} s</dd>
              </>
            ) : null}
            {job.violations ? (
              <>
                <dt>Blocked tool calls</dt>
                <dd>{job.violations.length}</dd>
              </>
            ) : null}
          </dl>
        </aside>

        <section className="card">
          <h2>
            Agent activity {live ? <span className="live-dot" aria-label="live" /> : null}
          </h2>
          <Timeline events={events} live={live} />
        </section>
      </div>

      {job.issues ? (
        <section className="card">
          <h2>Findings</h2>
          <Findings issues={job.issues} />
        </section>
      ) : null}

      {report ? (
        <section className="card report">
          <h2>Report</h2>
          <Markdown>{report}</Markdown>
        </section>
      ) : null}
    </div>
  );
}
