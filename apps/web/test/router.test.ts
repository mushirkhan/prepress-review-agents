import { describe, expect, it } from 'vitest';
import { parseRoute } from '../src/lib/router';

describe('parseRoute', () => {
  it.each([
    ['/', { name: 'new' }],
    ['/history', { name: 'history' }],
    ['/auth/callback', { name: 'callback' }],
    ['/jobs/0b6de74e-0175-443b-ba36-7393bf38f372', { name: 'job', id: '0b6de74e-0175-443b-ba36-7393bf38f372' }],
    ['/jobs/../../etc', { name: 'new' }],
  ])('%s', (path, route) => expect(parseRoute(path)).toEqual(route));
});
