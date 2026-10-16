import { Component, useEffect, type ErrorInfo, type ReactNode } from 'react';
import { loadAdTags } from './ad-tags';
import DemoPage from './DemoPage';
import HomePage from './HomePage';
import { reportError } from './sentry-lazy';

// Home-bundle root (see src/main.tsx): "/" for a guest, and /demo for
// everyone. Imports only React and these pages: no router, Supabase,
// session context, app CSS or eager Sentry.

export { scheduleSentry } from './sentry-lazy';

interface BoundaryState {
  failed: boolean;
}

/** Reports render errors to the Sentry frontend project (loaded lazily). */
class HomeErrorBoundary extends Component<{ children: ReactNode }, BoundaryState> {
  override state: BoundaryState = { failed: false };

  static getDerivedStateFromError(): BoundaryState {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    reportError(error, { componentStack: info.componentStack ?? undefined, surface: 'home' });
  }

  override render() {
    if (this.state.failed) {
      return (
        <main className="home home-failed">
          <p>Something went wrong. Refresh to try again.</p>
        </main>
      );
    }
    return this.props.children;
  }
}

/** The page for a path: /demo, else the homepage. Pure. */
export function homePageFor(pathname: string): 'demo' | 'home' {
  if (pathname === '/demo') return 'demo';
  return 'home';
}

const PAGES = { home: HomePage, demo: DemoPage };

export function HomeEntry() {
  const Page = PAGES[homePageFor(window.location.pathname)];
  // After the first commit; loadAdTags then waits for idle and runs once.
  useEffect(loadAdTags, []);
  return (
    <HomeErrorBoundary>
      <Page />
    </HomeErrorBoundary>
  );
}
