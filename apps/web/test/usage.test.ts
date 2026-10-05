import { describe, expect, it } from 'vitest';
import { describeUsage } from '../src/lib/usage';

const resetsAt = '2026-10-06T00:00:00.000Z';

describe('describeUsage', () => {
  it('shows how many reviews are left', () => {
    const u = describeUsage({ limit: 5, used: 2, remaining: 3, resetsAt }, 'en-GB');
    expect(u.exhausted).toBe(false);
    expect(u.text).toMatch(/^3 reviews of 5 left today\. The allowance resets at midnight UTC \(\d\d:\d\d your time\)\.$/);
  });

  it('uses the singular for the last review', () => {
    expect(describeUsage({ limit: 5, used: 4, remaining: 1, resetsAt }, 'en-GB').text).toMatch(/^1 review of 5 left today/);
  });

  it('explains when the allowance is used up', () => {
    const u = describeUsage({ limit: 5, used: 5, remaining: 0, resetsAt }, 'en-GB');
    expect(u.exhausted).toBe(true);
    expect(u.text).toMatch(/^You have used all 5 reviews for today\. You can start new reviews after midnight UTC/);
  });
});
