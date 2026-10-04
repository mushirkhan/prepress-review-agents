import { Hono } from 'hono';

export const APP_VERSION = process.env.APP_VERSION ?? 'dev';

/**
 * Builds the HTTP app without starting a server, so tests can call it
 * directly with app.request(...) and no network.
 */
export function createApp(): Hono {
  const app = new Hono();

  // Liveness probe used by the deploy script and Docker healthcheck.
  app.get('/healthz', (c) => c.json({ status: 'ok', version: APP_VERSION }));

  return app;
}
