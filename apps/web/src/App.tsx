import type { MouseEvent } from 'react';
import { navigate, useRoute } from './lib/router';
import { SessionProvider, useSession } from './lib/session';
import { History } from './pages/History';
import { JobPage } from './pages/JobPage';
import { NewReview } from './pages/NewReview';

function SignIn({ start, error }: { start: () => void; error?: string | undefined }) {
  return (
    <main className="signin">
      <div className="signin-card">
        <div className="mark" aria-hidden>
          <span />
          <span />
          <span />
        </div>
        <h1>Prepress Review</h1>
        <p>Multi-agent preflight and trademark checks for print artwork. Sign in with your reviewer account.</p>
        {error ? <p className="error">{error}</p> : null}
        <button className="primary" onClick={start}>
          Sign in
        </button>
      </div>
    </main>
  );
}

function Shell() {
  const route = useRoute();
  const { userName, signOut } = useSession();
  return (
    <>
      <header className="topbar">
        <a href="/" className="brand">
          <span className="mark mark-small" aria-hidden>
            <span />
            <span />
            <span />
          </span>
          Prepress Review
        </a>
        <nav>
          <a href="/" aria-current={route.name === 'new' ? 'page' : undefined}>
            New review
          </a>
          <a href="/history" aria-current={route.name === 'history' ? 'page' : undefined}>
            History
          </a>
        </nav>
        <div className="user">
          <span>{userName}</span>
          <button className="link" onClick={signOut}>
            Sign out
          </button>
        </div>
      </header>
      <main>
        {route.name === 'job' ? <JobPage id={route.id} /> : route.name === 'history' ? <History /> : <NewReview />}
      </main>
    </>
  );
}

export function App() {
  // Same-origin links navigate in place instead of reloading the page.
  const onClick = (e: MouseEvent) => {
    const a = (e.target as HTMLElement).closest('a');
    if (!a || a.target || e.metaKey || e.ctrlKey || a.origin !== window.location.origin) return;
    e.preventDefault();
    navigate(a.pathname);
  };
  return (
    <div onClick={onClick}>
      <SessionProvider signIn={(start, error) => <SignIn start={start} error={error} />}>
        <Shell />
      </SessionProvider>
    </div>
  );
}
