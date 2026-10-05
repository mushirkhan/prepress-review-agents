import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { BedrockVision, createReviewModels, TitanEmbedder } from './adapters/bedrock.js';
import { LocalArtworkStore } from './adapters/localStore.js';
import { createMcpArtworkStore } from './adapters/mcp.js';
import { reviewArtwork } from './agents/review.js';
import { createApp } from './app.js';
import { cognitoAuthenticator, devAuthenticator } from './auth.js';
import { loadConfig } from './config.js';
import { JobRepository } from './db.js';
import { JobService } from './jobs.js';

const config = loadConfig();
const dataDir = resolve(config.DATA_DIR);
await mkdir(join(dataDir, 'db'), { recursive: true });

// Uploads are written by the API itself; agents read them back only through
// the external MCP filesystem server (read-only), and write reports through it.
const uploads = new LocalArtworkStore(dataDir);
const mcpStore = await createMcpArtworkStore(config);
const models = createReviewModels(config);
const vision = new BedrockVision(config);
const embedder = new TitanEmbedder(config);
const repo = new JobRepository(join(dataDir, 'db', 'prepress.sqlite'));

const jobs = new JobService({
  repo,
  saveArtwork: (id, image) => uploads.saveArtwork(id, image),
  reviewDeps: () => ({ store: mcpStore, vision, embedder }),
  review: (job) => reviewArtwork(job, models),
  maxConcurrent: config.MAX_CONCURRENT_JOBS,
  dailyLimit: config.DAILY_REVIEW_LIMIT,
});

const defaultSamples = resolve(dirname(fileURLToPath(import.meta.url)), '../../../samples');
const app = createApp({
  config,
  auth: config.AUTH_MODE === 'dev' ? devAuthenticator : cognitoAuthenticator(config),
  jobs,
  repo,
  readArtwork: (id) => uploads.readArtwork(id),
  readReport: (id) => readFile(join(dataDir, 'reports', `${id}.md`), 'utf8'),
  samplesDir: config.SAMPLES_DIR ?? defaultSamples,
});

const server = serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  console.log(`api listening on :${info.port} (auth: ${config.AUTH_MODE})`);
});

const shutdown = async () => {
  server.close();
  await jobs.whenIdle();
  await mcpStore.close();
  repo.close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
