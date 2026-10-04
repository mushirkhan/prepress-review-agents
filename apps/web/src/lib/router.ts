import { useEffect, useState } from 'react';

/**
 * Minimal client-side routing for four paths; nginx serves index.html for
 * every path, and this hook picks the page.
 */
export type Route = { name: 'new' } | { name: 'history' } | { name: 'job'; id: string } | { name: 'callback' };

export function parseRoute(pathname: string): Route {
  const job = /^\/jobs\/([0-9a-f-]{36})$/.exec(pathname);
  if (job) return { name: 'job', id: job[1]! };
  if (pathname === '/history') return { name: 'history' };
  if (pathname === '/auth/callback') return { name: 'callback' };
  return { name: 'new' };
}

export function navigate(path: string): void {
  window.history.pushState(null, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(window.location.pathname));
  useEffect(() => {
    const update = () => setRoute(parseRoute(window.location.pathname));
    window.addEventListener('popstate', update);
    return () => window.removeEventListener('popstate', update);
  }, []);
  return route;
}
