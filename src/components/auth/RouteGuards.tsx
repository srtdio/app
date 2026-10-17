import { Navigate, Outlet, useLocation, useSearchParams } from 'react-router-dom';
import { resolveNext, withNext } from '@/components/auth/SignInPage';
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

/** Where a signed-out visit to an app route goes: /signin carrying it as ?next=. */
export function signInRedirect(location: { pathname: string; search: string }): string {
  return withNext('/signin', location.pathname + location.search);
}

/** Where a signed-in visit to an auth route goes: a safe ?next= or { from }, else /pipeline. */
export function guestDestination(queryNext: string | null, state: unknown): string {
  return resolveNext(queryNext, state) || '/pipeline';
}

/** App routes: require a session, otherwise redirect to /signin. */
export function RequireAuth() {
  const { session, loading } = useSession();
  const location = useLocation();
  if (loading) return <SessionLoading />;
  return session ? (
    <Outlet />
  ) : (
    <Navigate
      to={signInRedirect(location)}
      replace
      state={{ from: location.pathname + location.search }}
    />
  );
}

/** Auth routes: redirect to a safe ?next= (else /pipeline) when a session already exists. */
export function RequireGuest() {
  const { session, loading } = useSession();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  if (loading) return <SessionLoading />;
  const to = guestDestination(searchParams.get('next'), location.state);
  return session ? <Navigate to={to} replace /> : <Outlet />;
}
