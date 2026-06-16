import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useSession } from '@/lib/session-context';

/**
 * Minimal centered loading state shown while the initial Supabase session
 * resolves, so neither guard flashes the wrong screen on first paint.
 */
function SessionLoading() {
  return (
    <div className="min-h-full w-full grid place-items-center bg-bg">
      <span className="text-sm text-fg-3">Loading</span>
    </div>
  );
}

/** App routes: require a session, otherwise redirect to /signin. */
export function RequireAuth() {
  const { session, loading } = useSession();
  const location = useLocation();
  if (loading) return <SessionLoading />;
  return session ? (
    <Outlet />
  ) : (
    <Navigate to="/signin" replace state={{ from: location.pathname + location.search }} />
  );
}

/** Auth routes: redirect to /pipeline when a session already exists. */
export function RequireGuest() {
  const { session, loading } = useSession();
  if (loading) return <SessionLoading />;
  return session ? <Navigate to="/pipeline" replace /> : <Outlet />;
}
