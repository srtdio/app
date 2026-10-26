import { lazy, Suspense } from 'react';
import { Navigate } from 'react-router-dom';
import { useSession } from '@/lib/session-context';

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
  const { session, loading } = useSession();
  const route = homeRouteFor({ loading, signedIn: Boolean(session) });
  if (route === 'loading') return <Blank />;
  if (route === 'app') return <Navigate to="/pipeline" replace />;
  return (
    <Suspense fallback={<Blank />}>
      <HomePage />
    </Suspense>
  );
}
