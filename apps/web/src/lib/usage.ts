import type { Usage } from '../types';

/** "05:30", the reset time in the viewer's own time zone. */
export const localResetTime = (u: Usage, locale?: string) =>
  new Date(u.resetsAt).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });

/** The allowance line shown above the Start review button. */
export function describeUsage(u: Usage, locale?: string): { text: string; exhausted: boolean } {
  const reset = `midnight UTC (${localResetTime(u, locale)} your time)`;
  if (u.remaining <= 0) {
    return { exhausted: true, text: `You have used all ${u.limit} reviews for today. You can start new reviews after ${reset}.` };
  }
  const left = u.remaining === 1 ? '1 review' : `${u.remaining} reviews`;
  return { exhausted: false, text: `${left} of ${u.limit} left today. The allowance resets at ${reset}.` };
}
