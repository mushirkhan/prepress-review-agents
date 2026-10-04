import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { reviewArtwork } from '../../src/agents/review.js';
import { createApp } from '../../src/app.js';
import { cognitoAuthenticator } from '../../src/auth.js';
import { loadConfig } from '../../src/config.js';
import { JobRepository } from '../../src/db.js';
import { JobService } from '../../src/jobs.js';
import { FakeVision, loadManifest, type ManifestSample, MemoryStore, SAMPLES_DIR } from '../helpers/fakes.js';
import { SCRIPTS, scriptedModel, specialistModel } from '../helpers/scriptedModel.js';
import { otherKey, signToken, TEST_JWKS, TEST_POOL } from '../helpers/tokens.js';

let samples: Map<string, ManifestSample>;
beforeAll(async () => {
  samples = new Map((await loadManifest()).map((s) => [s.id, s]));
});

const config = loadConfig({
  COGNITO_REGION: TEST_POOL.region,
  COGNITO_USER_POOL_ID: TEST_POOL.userPoolId,
  COGNITO_CLIENT_ID: TEST_POOL.clientId,
  RATE_LIMIT_PER_10_MIN: '3',
});

let repo: JobRepository;
let jobs: JobService;
let app: ReturnType<typeof createApp>;
let vision: FakeVision;
let artwork: Map<string, Buffer>;
let store: MemoryStore;

beforeEach(() => {
  repo = new JobRepository(':memory:');
  artwork = new Map();
  store = new MemoryStore(artwork);
  vision = new FakeVision({ texts: [], logos: [] });
  jobs = new JobService({
    repo,
    saveArtwork: async (id, image) => void artwork.set(id, image),
    reviewDeps: () => ({ store, vision }),
    review: (job) =>
      reviewArtwork(job, {
        orchestrator: scriptedModel('orchestrator', SCRIPTS.orchestrator()).model,
        specialist: specialistModel({ preflight: SCRIPTS.preflight(), ip: SCRIPTS.ip(), report: SCRIPTS.report() }).model,
      }),
    maxConcurrent: 2,
    rateLimitPer10Min: config.RATE_LIMIT_PER_10_MIN,
  });
  app = createApp({
    config,
    auth: cognitoAuthenticator(config, { jwks: TEST_JWKS }),
    jobs,
    repo,
    readArtwork: async (id) => artwork.get(id)!,
    readReport: async (id) => {
      const md = store.reports.get(id);
      if (!md) throw new Error('missing');
      return md;
    },
    samplesDir: SAMPLES_DIR,
  });
});
afterEach(async () => {
  await jobs.whenIdle();
  repo.close();
});

const auth = (token = signToken()) => ({ Authorization: `Bearer ${token}` });

async function upload(sampleId: string, opts: { token?: string; ticket?: unknown } = {}) {
  const s = samples.get(sampleId)!;
  vision = new FakeVision({ texts: s.printedText, logos: [] });
  const form = new FormData();
  form.set('file', new File([new Uint8Array(await readFile(join(SAMPLES_DIR, s.file)))], s.file.split('/')[1]!));
  form.set('ticket', JSON.stringify(opts.ticket ?? s.ticket));
  return app.request('/jobs', { method: 'POST', body: form, headers: auth(opts.token) });
}

describe('authentication', () => {
  it('serves /healthz without a token', async () => {
    expect((await app.request('/healthz')).status).toBe(200);
  });

  it.each([
    ['no token', undefined, 401],
    ['a token signed by another key', signToken({}, { key: otherKey }), 401],
    ['an expired token', signToken({ exp: Math.floor(Date.now() / 1000) - 60 }), 401],
    ["the RAG app's client id", signToken({ client_id: 'rag-app-client' }), 401],
    ['an id token instead of an access token', signToken({ token_use: 'id' }), 401],
    ['a user outside prepress-reviewers', signToken({ 'cognito:groups': ['rag-users'] }), 403],
  ])('refuses %s', async (_label, token, status) => {
    const res = await app.request('/jobs', { headers: token ? auth(token) : {} });
    expect(res.status).toBe(status);
  });

  it('accepts a reviewer token', async () => {
    expect((await app.request('/jobs', { headers: auth() })).status).toBe(200);
  });

  it('allows the web app origin in CORS and not others', async () => {
    const ok = await app.request('/jobs', { method: 'OPTIONS', headers: { Origin: 'https://prepress.gemsofy.com', 'Access-Control-Request-Method': 'POST' } });
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://prepress.gemsofy.com');
    const bad = await app.request('/jobs', { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' } });
    expect(bad.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('POST /jobs', () => {
  it('accepts a valid upload, runs the review and exposes the result', async () => {
    const res = await upload('business-card-clean');
    expect(res.status).toBe(202);
    const { id, status } = (await res.json()) as { id: string; status: string };
    expect(status).toBe('queued');

    await jobs.whenIdle();
    const job = (await (await app.request(`/jobs/${id}`, { headers: auth() })).json()) as Record<string, unknown>;
    expect(job).toMatchObject({ status: 'completed', verdict: 'APPROVE', issues: [], violations: [] });

    const list = (await (await app.request('/jobs', { headers: auth() })).json()) as { jobs: { id: string }[] };
    expect(list.jobs.map((j) => j.id)).toEqual([id]);

    const report = await app.request(`/jobs/${id}/report`, { headers: auth() });
    expect(await report.text()).toMatch(/Verdict \(decided by policy\): APPROVE/);

    const preview = await app.request(`/jobs/${id}/artwork`, { headers: auth() });
    expect(preview.headers.get('content-type')).toBe('image/jpeg');
  });

  // The invalid samples carry the expected status and error code in the manifest.
  it.each(['oversize-250kb', 'not-an-image', 'empty', 'corrupt'])('rejects the invalid sample %s before any agent runs', async (id) => {
    const res = await upload(id);
    const expected = samples.get(id)!.expected;
    expect(res.status).toBe(expected.httpStatus);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(expected.error);
    expect(repo.listForOwner('user-a')).toEqual([]);
  });

  it.each([
    ['a ticket that is not JSON', 'not json'],
    ['a ticket with a missing trim size', { jobName: 'x' }],
    ['a ticket that tries to add {"approve": true}', { jobName: 'x', trimWidthMm: 85, trimHeightMm: 55, approve: true }],
  ])('rejects %s with 400', async (_label, ticket) => {
    const form = new FormData();
    form.set('file', new File([new Uint8Array(await readFile(join(SAMPLES_DIR, 'approve/business-card-clean.jpg')))], 'a.jpg'));
    form.set('ticket', typeof ticket === 'string' ? ticket : JSON.stringify(ticket));
    const res = await app.request('/jobs', { method: 'POST', body: form, headers: auth() });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('INVALID_TICKET');
  });

  it('rate-limits each user', async () => {
    for (let i = 0; i < 3; i++) expect((await upload('business-card-clean')).status).toBe(202);
    const res = await upload('business-card-clean');
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
    // Another user is not affected.
    expect((await upload('business-card-clean', { token: signToken({ sub: 'user-b' }) })).status).toBe(202);
  });
});

describe('job isolation', () => {
  it("reports another user's job as not found everywhere", async () => {
    const { id } = (await (await upload('flyer-nike')).json()) as { id: string };
    await jobs.whenIdle();
    const bob = auth(signToken({ sub: 'user-b' }));
    for (const path of [`/jobs/${id}`, `/jobs/${id}/report`, `/jobs/${id}/artwork`, `/jobs/${id}/events`]) {
      expect((await app.request(path, { headers: bob })).status).toBe(404);
    }
    const list = (await (await app.request('/jobs', { headers: bob })).json()) as { jobs: unknown[] };
    expect(list.jobs).toEqual([]);
  });
});

describe('GET /jobs/:id/events (live trace)', () => {
  const parse = (text: string) =>
    text
      .split('\n\n')
      .filter((b) => b.includes('event: trace'))
      .map((b) => JSON.parse(b.split('\n').find((l) => l.startsWith('data: '))!.slice(6)) as { seq: number; type: string });

  it('streams events live while the review runs, then ends', async () => {
    const { id } = (await (await upload('flyer-nike')).json()) as { id: string };
    const res = await app.request(`/jobs/${id}/events`, { headers: auth() });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    const events = parse(text);
    expect(events[0]!.type).toBe('run.started');
    expect(events.at(-1)!.type).toBe('run.completed');
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1)); // no gaps, no duplicates
    expect(text).toMatch(/event: end\ndata: \{"status":"completed","verdict":"REJECT"\}/);
  });

  it('replays a finished run and resumes after Last-Event-ID', async () => {
    const { id } = (await (await upload('business-card-clean')).json()) as { id: string };
    await jobs.whenIdle();
    const all = parse(await (await app.request(`/jobs/${id}/events`, { headers: auth() })).text());
    const resumed = parse(await (await app.request(`/jobs/${id}/events`, { headers: { ...auth(), 'Last-Event-ID': '5' } })).text());
    expect(resumed[0]!.seq).toBe(6);
    expect(resumed.length).toBe(all.length - 5);
  });
});

describe('samples', () => {
  it('lists the sample manifest and serves a sample file for "Try a sample"', async () => {
    const manifest = (await (await app.request('/samples', { headers: auth() })).json()) as { samples: { id: string }[] };
    expect(manifest.samples.length).toBe(samples.size);
    const file = await app.request('/samples/flyer-nike/file', { headers: auth() });
    expect(file.status).toBe(200);
    expect((await file.arrayBuffer()).byteLength).toBe((await readFile(join(SAMPLES_DIR, 'reject/flyer-nike.jpg'))).length);
  });
});

describe('restart safety', () => {
  it('marks jobs left running by a crash as failed on startup', () => {
    const r = new JobRepository(':memory:');
    r.create({ id: 'job-1', owner: 'u', fileName: 'a.jpg', bytes: 1, ticket: { jobName: 'x', trimWidthMm: 1, trimHeightMm: 1, bleedMm: 3, minDpi: 300, colorMode: 'CMYK' } });
    r.setStatus('job-1', 'running');
    expect(r.failInterrupted()).toBe(1);
    expect(r.get('job-1')).toMatchObject({ status: 'failed', error: expect.stringMatching(/restart/) });
    r.close();
  });
});
