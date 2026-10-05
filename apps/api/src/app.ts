import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { streamSSE } from 'hono/streaming';
import sharp from 'sharp';
import type { TraceEvent } from './agents/trace.js';
import { AuthError, type Authenticator, type User } from './auth.js';
import type { AppConfig } from './config.js';
import type { JobRecord, JobRepository } from './db.js';
import { JobTicketSchema } from './domain/ticket.js';
import { DailyLimitError, type JobService } from './jobs.js';
import { UploadError, validateUpload } from './uploads.js';

export const APP_VERSION = process.env.APP_VERSION ?? 'dev';

export interface AppDeps {
  config: Pick<AppConfig, 'MAX_UPLOAD_BYTES' | 'CORS_ORIGINS'>;
  auth: Authenticator;
  jobs: JobService;
  repo: JobRepository;
  readArtwork: (jobId: string) => Promise<Buffer>;
  readReport: (jobId: string) => Promise<string>;
  samplesDir?: string | undefined;
}

type Env = { Variables: { user: User } };

const err = (c: Context, status: number, code: string, message: string, details?: unknown) =>
  c.json({ error: { code, message, ...(details ? { details } : {}) } }, status as never);

/** What a client sees of a job: never another user's data, never internal paths. */
function publicJob(j: JobRecord) {
  return {
    id: j.id,
    createdAt: j.createdAt,
    status: j.status,
    fileName: j.fileName,
    bytes: j.bytes,
    ticket: j.ticket,
    verdict: j.verdict,
    reasons: j.result?.reasons,
    issues: j.result?.issues,
    proposedVerdict: j.result?.proposedVerdict,
    summaries: j.result?.summaries,
    violations: j.result?.violations,
    usage: j.result?.usage,
    durationMs: j.result?.durationMs,
    error: j.error ?? j.result?.error,
  };
}

/**
 * Builds the HTTP API without starting a server, so tests call it in-process
 * with app.request(...). Health check only when no dependencies are given.
 */
export function createApp(deps?: AppDeps): Hono<Env> {
  const app = new Hono<Env>();
  app.use('*', secureHeaders());

  // Liveness probe used by the deploy script and Docker healthcheck.
  app.get('/healthz', (c) => c.json({ status: 'ok', version: APP_VERSION }));
  if (!deps) return app;

  const origins = deps.config.CORS_ORIGINS.split(',').map((o) => o.trim());
  app.use('*', cors({ origin: origins, allowHeaders: ['Authorization', 'Content-Type', 'Last-Event-ID'], maxAge: 600 }));

  // Every route below needs a signed-in reviewer.
  app.use('*', async (c, next) => {
    if (c.req.method === 'OPTIONS') return next();
    try {
      c.set('user', await deps.auth(c.req.header('Authorization')));
    } catch (e) {
      if (e instanceof AuthError) return err(c, e.status, e.status === 401 ? 'UNAUTHENTICATED' : 'FORBIDDEN', e.message);
      throw e;
    }
    return next();
  });

  const ownJob = (c: Context<Env>): JobRecord | undefined => {
    const job = deps.repo.get(c.req.param('id') ?? '');
    // Another user's job is reported as not found, so ids cannot be probed.
    return job && job.owner === c.get('user').sub ? job : undefined;
  };

  app.post(
    '/jobs',
    // Rejects oversized requests before reading the body (multipart overhead allowed).
    bodyLimit({
      maxSize: deps.config.MAX_UPLOAD_BYTES + 32 * 1024,
      onError: (c) => err(c, 413, 'FILE_TOO_LARGE', `The limit is ${Math.floor(deps.config.MAX_UPLOAD_BYTES / 1024)} KB.`),
    }),
    async (c) => {
      const body = await c.req.parseBody().catch(() => undefined);
      const file = body?.file;
      if (!(file instanceof File)) return err(c, 400, 'MISSING_FILE', 'Attach the artwork as the "file" field.');

      let ticketInput: unknown;
      try {
        ticketInput = JSON.parse(String(body?.ticket ?? ''));
      } catch {
        return err(c, 400, 'INVALID_TICKET', 'The "ticket" field must be JSON.');
      }
      const ticket = JobTicketSchema.safeParse(ticketInput);
      if (!ticket.success) return err(c, 400, 'INVALID_TICKET', 'The job ticket is invalid.', ticket.error.issues);

      const buffer = Buffer.from(await file.arrayBuffer());
      try {
        await validateUpload(buffer, deps.config.MAX_UPLOAD_BYTES);
        const job = await deps.jobs.submit(c.get('user').sub, { name: file.name, buffer }, ticket.data);
        return c.json(publicJob(job), 202);
      } catch (e) {
        if (e instanceof UploadError) return err(c, e.status, e.code, e.message);
        if (e instanceof DailyLimitError) {
          c.header('Retry-After', String(e.retryAfterSeconds));
          return err(c, 429, 'DAILY_LIMIT_REACHED', e.message, e.usage);
        }
        throw e;
      }
    },
  );

  app.get('/usage', (c) => c.json(deps.jobs.usage(c.get('user').sub)));

  app.get('/jobs', (c) => c.json({ jobs: deps.repo.listForOwner(c.get('user').sub).map(publicJob) }));

  app.get('/jobs/:id', (c) => {
    const job = ownJob(c);
    return job ? c.json(publicJob(job)) : err(c, 404, 'NOT_FOUND', 'No such job.');
  });

  app.get('/jobs/:id/report', async (c) => {
    const job = ownJob(c);
    if (!job) return err(c, 404, 'NOT_FOUND', 'No such job.');
    const md = await deps.readReport(job.id).catch(() => undefined);
    return md === undefined ? err(c, 404, 'NOT_READY', 'The report is not available yet.') : c.text(md, 200, { 'Content-Type': 'text/markdown; charset=utf-8' });
  });

  // Browser-friendly preview: print files are often CMYK or TIFF, which browsers show wrongly.
  app.get('/jobs/:id/artwork', async (c) => {
    const job = ownJob(c);
    if (!job) return err(c, 404, 'NOT_FOUND', 'No such job.');
    const preview = await sharp(await deps.readArtwork(job.id))
      .toColourspace('srgb')
      .resize({ width: 900, height: 900, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();
    return c.body(new Uint8Array(preview), 200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=3600' });
  });

  /**
   * Live trace as Server-Sent Events: replays what already happened, then
   * streams new events until the run completes. Supports Last-Event-ID so a
   * dropped connection resumes without gaps.
   */
  app.get('/jobs/:id/events', (c) => {
    const job = ownJob(c);
    if (!job) return err(c, 404, 'NOT_FOUND', 'No such job.');
    const resumeFrom = Number(c.req.header('Last-Event-ID') ?? 0) || 0;

    return streamSSE(c, async (stream) => {
      let last = resumeFrom;
      const pending: TraceEvent[] = [];
      let wake: (() => void) | undefined;
      // Subscribe before replaying, so nothing falls between the two.
      const unsubscribe = deps.jobs.subscribe(job.id, (e) => {
        pending.push(e);
        wake?.();
      });
      stream.onAbort(() => unsubscribe?.());

      const send = async (e: TraceEvent) => {
        if (e.seq <= last) return false;
        last = e.seq;
        await stream.writeSSE({ id: String(e.seq), event: 'trace', data: JSON.stringify(e) });
        return e.type === 'run.completed';
      };

      for (const e of deps.repo.events(job.id, last)) if (await send(e)) break;
      while (unsubscribe && !stream.aborted) {
        let done = false;
        while (pending.length) done = (await send(pending.shift()!)) || done;
        if (done || !deps.jobs.isActive(job.id)) break;
        await new Promise<void>((resolve) => {
          wake = resolve;
          setTimeout(resolve, 15_000); // heartbeat keeps proxies from closing an idle stream
        });
        if (!pending.length) await stream.writeSSE({ event: 'ping', data: '' });
      }
      unsubscribe?.();
      // The result is saved just after the last event; give it a moment before reporting the status.
      for (let i = 0; i < 20 && deps.jobs.isActive(job.id); i++) await new Promise((r) => setTimeout(r, 100));
      // Anything recorded after the last live event (e.g. a run that ended between checks).
      for (const e of deps.repo.events(job.id, last)) await send(e);
      const final = deps.repo.get(job.id);
      await stream.writeSSE({ event: 'end', data: JSON.stringify({ status: final?.status, verdict: final?.verdict }) });
    });
  });

  app.get('/samples', async (c) => {
    if (!deps.samplesDir) return c.json({ samples: [] });
    const manifest = JSON.parse(await readFile(join(deps.samplesDir, 'manifest.json'), 'utf8')) as { samples: { id: string }[] };
    return c.json(manifest);
  });

  app.get('/samples/:id/file', async (c) => {
    if (!deps.samplesDir) return err(c, 404, 'NOT_FOUND', 'No samples configured.');
    const manifest = JSON.parse(await readFile(join(deps.samplesDir, 'manifest.json'), 'utf8')) as { samples: { id: string; file: string }[] };
    const sample = manifest.samples.find((s) => s.id === c.req.param('id'));
    if (!sample) return err(c, 404, 'NOT_FOUND', 'No such sample.');
    return c.body(new Uint8Array(await readFile(join(deps.samplesDir, sample.file))), 200, { 'Content-Type': 'application/octet-stream' });
  });

  app.onError((e, c) => {
    console.error(e);
    return err(c, 500, 'INTERNAL', 'Something went wrong on our side.');
  });

  return app;
}
