import { lazy, Suspense } from 'react';
import { Navigate } from 'react-router-dom';
import { useSession } from '@/lib/session-context';
import { LoadFailed, SessionLoading } from '@/components/auth/RouteGuards';

// Lazy so the app bundle never carries the homepage, its styles or its fonts.
const HomePage = lazy(() => import('./HomePage'));

type HomeRoute = 'loading' | 'app' | 'home';

/** Pure: what / shows for a given session state. */
export function homeRouteFor(state: { loading: boolean; signedIn: boolean }): HomeRoute {
  if (state.loading) return 'loading';
  return state.signedIn ? 'app' : 'home';
}

/** Blank light canvas while the session or the lazy chunk resolves, so no flash. */
function Blank() {
  return <div className="min-h-full w-full bg-panel" />;
}

/** / for everyone: signed-in users go to the app, guests see the homepage. */
export function HomeGate() {
  const { session, loading, failed, retry } = useSession();
  if (failed) return <LoadFailed onRetry={retry} />;
  const route = homeRouteFor({ loading, signedIn: Boolean(session) });
  // The app boots on / only with a stored session or an auth callback; the
  // canvas there is the app's (--bg), so the wait is the app's one loader
  // (same element and colour as every other boot wait), not the homepage's
  // panel-coloured blank.
  if (route === 'loading') return <SessionLoading />;
  if (route === 'app') return <Navigate to="/pipeline" replace />;
  return (
    <Suspense fallback={<Blank />}>
      <HomePage />
    </Suspense>
  );
}
