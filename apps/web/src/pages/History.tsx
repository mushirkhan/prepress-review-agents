import { useEffect, useState } from 'react';
import { StatusChip } from '../components/Verdict';
import { navigate } from '../lib/router';
import { useSession } from '../lib/session';
import type { Job } from '../types';

export function History() {
  const { api } = useSession();
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.listJobs().then(setJobs).catch((e: Error) => setError(e.message));
  }, [api]);

  return (
    <div className="page">
      <header className="page-head">
        <h1>Your reviews</h1>
      </header>
      {error ? <p className="error">{error}</p> : null}
      {jobs && !jobs.length ? (
        <p className="muted">
          No reviews yet. <a href="/">Start one</a>.
        </p>
      ) : null}
      {jobs?.length ? (
        <div className="card table-wrap">
          <table>
            <thead>
              <tr>
                <th>Job</th>
                <th>File</th>
                <th>Submitted</th>
                <th>Result</th>
                <th>Issues</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.id} onClick={() => navigate(`/jobs/${j.id}`)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && navigate(`/jobs/${j.id}`)}>
                  <td>{j.ticket.jobName}</td>
                  <td>
                    <code>{j.fileName}</code>
                  </td>
                  <td>{new Date(j.createdAt).toLocaleString()}</td>
                  <td>
                    <StatusChip job={j} />
                  </td>
                  <td>{j.issues?.map((i) => i.code).join(', ') || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
