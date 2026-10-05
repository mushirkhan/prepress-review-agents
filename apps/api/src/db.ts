import { DatabaseSync } from 'node:sqlite';
import type { ReviewResult } from './agents/review.js';
import type { TraceEvent } from './agents/trace.js';
import type { JobTicket } from './domain/ticket.js';

export type JobStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface JobRecord {
  id: string;
  owner: string;
  createdAt: string;
  status: JobStatus;
  fileName: string;
  bytes: number;
  ticket: JobTicket;
  verdict?: string | undefined;
  result?: Omit<ReviewResult, 'trace'> | undefined;
  error?: string | undefined;
}

interface JobRow {
  id: string;
  owner: string;
  created_at: string;
  status: JobStatus;
  file_name: string;
  bytes: number;
  ticket_json: string;
  verdict: string | null;
  result_json: string | null;
  error: string | null;
}

const toRecord = (r: JobRow): JobRecord => ({
  id: r.id,
  owner: r.owner,
  createdAt: r.created_at,
  status: r.status,
  fileName: r.file_name,
  bytes: r.bytes,
  ticket: JSON.parse(r.ticket_json) as JobTicket,
  verdict: r.verdict ?? undefined,
  result: r.result_json ? (JSON.parse(r.result_json) as JobRecord['result']) : undefined,
  error: r.error ?? undefined,
});

/**
 * Jobs and their trace events in SQLite (Node's built-in driver, so there is
 * no native module to build). One file on the data volume; in production
 * this would move to Postgres.
 */
export class JobRepository {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        created_at TEXT NOT NULL,
        status TEXT NOT NULL,
        file_name TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        ticket_json TEXT NOT NULL,
        verdict TEXT,
        result_json TEXT,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS jobs_owner ON jobs(owner, created_at DESC);
      CREATE TABLE IF NOT EXISTS events (
        job_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        t INTEGER NOT NULL,
        type TEXT NOT NULL,
        agent TEXT NOT NULL,
        data_json TEXT NOT NULL,
        PRIMARY KEY (job_id, seq)
      );
    `);
  }

  create(job: Pick<JobRecord, 'id' | 'owner' | 'fileName' | 'bytes' | 'ticket'>, createdAt = new Date().toISOString()): JobRecord {
    this.db
      .prepare('INSERT INTO jobs (id, owner, created_at, status, file_name, bytes, ticket_json) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(job.id, job.owner, createdAt, 'queued', job.fileName, job.bytes, JSON.stringify(job.ticket));
    return { id: job.id, owner: job.owner, fileName: job.fileName, bytes: job.bytes, ticket: job.ticket, createdAt, status: 'queued' };
  }

  setStatus(id: string, status: JobStatus): void {
    this.db.prepare('UPDATE jobs SET status = ? WHERE id = ?').run(status, id);
  }

  finish(id: string, result: ReviewResult): void {
    const { trace: _trace, ...summary } = result;
    this.db
      .prepare('UPDATE jobs SET status = ?, verdict = ?, result_json = ?, error = ? WHERE id = ?')
      .run(result.status, result.verdict, JSON.stringify(summary), result.error ?? null, id);
  }

  fail(id: string, error: string): void {
    this.db.prepare('UPDATE jobs SET status = ?, error = ? WHERE id = ?').run('failed', error, id);
  }

  get(id: string): JobRecord | undefined {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined;
    return row ? toRecord(row) : undefined;
  }

  listForOwner(owner: string, limit = 50): JobRecord[] {
    return (this.db.prepare('SELECT * FROM jobs WHERE owner = ? ORDER BY created_at DESC LIMIT ?').all(owner, limit) as unknown as JobRow[]).map(toRecord);
  }

  /** Jobs the owner created at or after `sinceIso` (ISO timestamps sort as text). */
  countCreatedSince(owner: string, sinceIso: string): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM jobs WHERE owner = ? AND created_at >= ?').get(owner, sinceIso) as { n: number };
    return Number(row.n);
  }

  addEvent(jobId: string, e: TraceEvent): void {
    this.db
      .prepare('INSERT OR IGNORE INTO events (job_id, seq, t, type, agent, data_json) VALUES (?, ?, ?, ?, ?, ?)')
      .run(jobId, e.seq, e.t, e.type, e.agent, JSON.stringify(e.data));
  }

  events(jobId: string, afterSeq = 0): TraceEvent[] {
    const rows = this.db
      .prepare('SELECT seq, t, type, agent, data_json FROM events WHERE job_id = ? AND seq > ? ORDER BY seq')
      .all(jobId, afterSeq) as unknown as { seq: number; t: number; type: TraceEvent['type']; agent: string; data_json: string }[];
    return rows.map((r) => ({ seq: r.seq, t: r.t, type: r.type, agent: r.agent, data: JSON.parse(r.data_json) as Record<string, unknown> }));
  }

  /** Jobs left unfinished by a restart cannot be trusted: mark them failed (fail closed). */
  failInterrupted(): number {
    const res = this.db
      .prepare("UPDATE jobs SET status = 'failed', error = 'Interrupted by a server restart; please resubmit.' WHERE status IN ('queued', 'running')")
      .run();
    return Number(res.changes);
  }

  close(): void {
    this.db.close();
  }
}
