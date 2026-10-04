import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';

describe('GET /healthz', () => {
  it('reports the service as healthy', async () => {
    const res = await createApp().request('/healthz');

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ok' });
  });

  it('returns 404 for unknown routes', async () => {
    const res = await createApp().request('/does-not-exist');
    expect(res.status).toBe(404);
  });
});
