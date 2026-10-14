import { Component, type ErrorInfo, type ReactNode } from 'react';
import HomePage from './HomePage';
import { reportError } from './sentry-lazy';

// Guest-path root for "/" (see src/main.tsx). Imports only React and the
// homepage: no router, Supabase, session context, app CSS or eager Sentry.

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

export function HomeEntry() {
  return (
    <HomeErrorBoundary>
      <HomePage />
    </HomeErrorBoundary>
  );
}
