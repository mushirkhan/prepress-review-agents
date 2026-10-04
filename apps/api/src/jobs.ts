import { randomUUID } from 'node:crypto';
import { createJobContext, type JobContext } from './agents/context.js';
import type { ReviewResult } from './agents/review.js';
import type { TraceEvent } from './agents/trace.js';
import type { JobRecord, JobRepository } from './db.js';
import type { JobTicket } from './domain/ticket.js';

export interface JobServiceDeps {
  repo: JobRepository;
  /** Saves an uploaded file where the MCP artwork server can read it. */
  saveArtwork: (jobId: string, image: Buffer) => Promise<void>;
  /** Store, vision and embedder for a review. */
  reviewDeps: () => JobContext['deps'];
  /** Runs one review (reviewArtwork with the configured models). */
  review: (job: JobContext) => Promise<ReviewResult>;
  maxConcurrent: number;
  rateLimitPer10Min: number;
}

export class RateLimitError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super(`Too many reviews started. Try again in ${retryAfterSeconds} seconds.`);
  }
}

type Listener = (e: TraceEvent) => void;

/**
 * Accepts jobs and runs reviews in the background: limited concurrency (each
 * review makes several model calls), a per-user rate limit, every trace event
 * persisted as it happens, and live subscribers for the event stream.
 */
export class JobService {
  private readonly queue: string[] = [];
  private running = 0;
  private readonly live = new Map<string, Set<Listener>>();
  private readonly starts = new Map<string, number[]>();
  private readonly idle = new Set<() => void>();

  constructor(private readonly deps: JobServiceDeps) {
    const interrupted = deps.repo.failInterrupted();
    if (interrupted) console.warn(`marked ${interrupted} interrupted job(s) as failed`);
  }

  async submit(owner: string, file: { name: string; buffer: Buffer }, ticket: JobTicket): Promise<JobRecord> {
    this.checkRateLimit(owner);
    const id = randomUUID();
    await this.deps.saveArtwork(id, file.buffer);
    const record = this.deps.repo.create({ id, owner, fileName: file.name.slice(0, 200), bytes: file.buffer.length, ticket });
    this.live.set(id, new Set()); // queued jobs can already be watched
    this.queue.push(id);
    this.pump();
    return record;
  }

  /** Live events for a job that is queued or running; undefined if it is not active. */
  subscribe(jobId: string, listener: Listener): (() => void) | undefined {
    const set = this.live.get(jobId);
    if (!set) return undefined;
    set.add(listener);
    return () => set.delete(listener);
  }

  /** True while a job is queued or running in this process. */
  isActive(jobId: string): boolean {
    return this.live.has(jobId) || this.queue.includes(jobId);
  }

  /** Resolves when no job is queued or running (used by tests and shutdown). */
  whenIdle(): Promise<void> {
    if (this.running === 0 && this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idle.add(resolve));
  }

  private checkRateLimit(owner: string): void {
    const now = Date.now();
    const windowMs = 10 * 60 * 1000;
    const recent = (this.starts.get(owner) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= this.deps.rateLimitPer10Min) {
      throw new RateLimitError(Math.ceil((recent[0]! + windowMs - now) / 1000));
    }
    recent.push(now);
    this.starts.set(owner, recent);
  }

  private pump(): void {
    while (this.running < this.deps.maxConcurrent && this.queue.length) {
      const id = this.queue.shift()!;
      this.running += 1;
      void this.run(id).finally(() => {
        this.running -= 1;
        this.live.delete(id);
        this.pump();
        if (this.running === 0 && this.queue.length === 0) {
          for (const resolve of this.idle) resolve();
          this.idle.clear();
        }
      });
    }
  }

  private async run(id: string): Promise<void> {
    const record = this.deps.repo.get(id);
    if (!record) return;
    this.live.set(id, this.live.get(id) ?? new Set());
    this.deps.repo.setStatus(id, 'running');
    const job = createJobContext({ jobId: id, ticket: record.ticket, deps: this.deps.reviewDeps() });
    job.trace.subscribe((e) => {
      this.deps.repo.addEvent(id, e);
      for (const listen of this.live.get(id) ?? []) listen(e);
    });
    try {
      const result = await this.deps.review(job);
      this.deps.repo.finish(id, result);
    } catch (err) {
      // reviewArtwork already fails closed; this only catches bugs outside it.
      this.deps.repo.fail(id, err instanceof Error ? err.message : String(err));
    }
  }
}
