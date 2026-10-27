import { mark } from '@/lib/perf-marks';
import { useEffect } from 'react';
import { Navigate, Outlet, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { resolveNext, withNext } from '@/components/auth/SignInPage';
import { useSession } from '@/lib/session-context';

/**
 * Minimal centered loading state shown while the initial Supabase session
 * resolves, so neither guard flashes the wrong screen on first paint.
 */
export function SessionLoading() {
  return (
    <div className="min-h-full w-full grid place-items-center bg-bg">
      <span className="text-base text-fg-3">Loading</span>
    </div>
  );
}

const INVITE_ACCEPT_PREFIX = '/invite/accept/';

function isInviteAcceptPath(pathname: string): boolean {
  return pathname.startsWith(INVITE_ACCEPT_PREFIX) && pathname.length > INVITE_ACCEPT_PREFIX.length;
}

/**
 * Where a signed-out visit to an app route goes: /signin carrying it as ?next=.
 * An invite route keeps its hash too, so an Auth error (#error_code=...) still
 * reaches the invite page after sign-in.
 */
export function signInRedirect(location: {
  pathname: string;
  search: string;
  hash?: string;
}): string {
  const hash = isInviteAcceptPath(location.pathname) ? (location.hash ?? '') : '';
  return withNext('/signin', location.pathname + location.search + hash);
}

/**
 * An invite link the signed-out invitee may open: the email's tap-to-join link
 * (?th=) or a consumed verify link (#error_code=). The page itself signs the
 * invitee in on Join, or shows the expired view.
 */
export function isPublicInviteVisit(location: {
  pathname: string;
  search: string;
  hash: string;
}): boolean {
  if (!isInviteAcceptPath(location.pathname)) return false;
  const th = new URLSearchParams(location.search).get('th');
  if (th !== null && th.trim() !== '') return true;
  const hash = new URLSearchParams(location.hash.replace(/^#/, ''));
  return hash.has('error_code') || hash.has('error');
}

/** True when the invite page sent this visit to switch accounts (signing out is in flight). */
export function isAccountSwitch(state: unknown): boolean {
  return (
    typeof state === 'object' &&
    state !== null &&
    (state as { switchAccount?: unknown }).switchAccount === true
  );
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
  mark('guard:auth');
  if (session || isPublicInviteVisit(location)) return <Outlet />;
  return (
    <Navigate
      to={signInRedirect(location)}
      replace
      state={{ from: location.pathname + location.search }}
    />
  );
}

/**
 * Auth routes: redirect to a safe ?next= (else /pipeline) when a session already
 * exists. "Use a different account" lands here while its sign-out is still in
 * flight; that visit stays on sign in instead of bouncing back to the invite.
 */
export function RequireGuest() {
  const { session, loading } = useSession();
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const switching = isAccountSwitch(location.state);
  // Once the switch's sign-out lands, drop the marker so a later sign-in (in
  // this tab or another) redirects to ?next= as usual.
  useEffect(() => {
    if (switching && !loading && !session) {
      navigate(location.pathname + location.search, { replace: true, state: null });
    }
  }, [switching, loading, session, navigate, location.pathname, location.search]);
  if (loading) return <SessionLoading />;
  mark('guard:guest');
  if (!session || switching) return <Outlet />;
  const to = guestDestination(searchParams.get('next'), location.state);
  return <Navigate to={to} replace />;
}
