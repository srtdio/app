import { mark } from '@/lib/perf-marks';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import type { AuthChangeEvent, Session, SupabaseClient } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import { SIGNOUT_EVENT } from '@/lib/events';
import { logger } from '@/lib/logger';
import { noteAuthToken } from '@/lib/chat/bounded-window';
import { noteAuthUser } from '@/lib/session-read';
import { storedSessionUserId } from '@/lib/device-cache';

/**
 * How long the boot getSession may take while this device holds a stored
 * session before the guards show "Couldn't load. Try again." instead of the
 * loader. Above REQUEST_TIMEOUT_MS (10 s) so a single timed-out refresh lands
 * first.
 */
export const SESSION_WAIT_MS = 12_000;

/**
 * Whether a settled getSession is a failure to read, not a sign-out: no
 * session, an error, and supabase-js still holds the stored session (a
 * timeout or network failure keeps it; a dead refresh token removes it and
 * fires SIGNED_OUT). A failure never routes to /signin.
 */
export function sessionReadFailed(
  session: Session | null,
  error: unknown,
  storedUserId: string | null,
): boolean {
  return session === null && error !== null && error !== undefined && storedUserId !== null;
}

/**
 * Whether an onAuthStateChange event is left to getSession: INITIAL_SESSION
 * with no session while the stored one is still there is the same failed
 * read, never a sign-out.
 */
export function deferAuthEvent(
  event: AuthChangeEvent,
  nextSession: Session | null,
  storedUserId: () => string | null,
): boolean {
  return event === 'INITIAL_SESSION' && nextSession === null && storedUserId() !== null;
}

/**
 * Decide the next session from an onAuthStateChange event. A null `nextSession`
 * is only authoritative on an explicit SIGNED_OUT or on the INITIAL_SESSION at
 * boot; a transient null from a refresh hiccup (e.g. TOKEN_REFRESHED) leaves the
 * current session in place so auto-refresh can recover without flashing /signin.
 */
export function resolveSession(
  event: AuthChangeEvent,
  nextSession: Session | null,
  current: Session | null,
): Session | null {
  if (event === 'SIGNED_OUT') return null;
  if (nextSession) return nextSession;
  if (event === 'INITIAL_SESSION') return null;
  return current;
}

/**
 * End the GoTrue session for this device only. Scope is always 'local' so a
 * sign-out here never revokes the user's sessions on other devices, matching
 * src/server/auth/session.ts. The resulting SIGNED_OUT event is what clears the
 * provider state and routes to /signin; this only asks GoTrue to sign out.
 */
export async function performSignout(client: SupabaseClient): Promise<void> {
  const { error } = await client.auth.signOut({ scope: 'local' });
  if (error) {
    logger.error('signOut failed', { error: error.message });
  }
}

/**
 * Resolved auth state for the route guards. `loading` is true only until the
 * initial getSession() settles; after that onAuthStateChange keeps `session`
 * current. Guards render a loading state while `loading` so signed-in users
 * never see a flash of /signin on first paint. `failed`: the read failed or
 * hung past SESSION_WAIT_MS with a stored session; guards show Try again,
 * which calls `retry` (a second failure reloads the page).
 */
interface SessionContextValue {
  session: Session | null;
  loading: boolean;
  failed: boolean;
  retry: () => void;
}

/** A read aborted because the tab is closing or navigating away: harmless, never logged. Pure. */
export function isClosingTabAbort(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { name, message } = error as { name?: unknown; message?: unknown };
  return (
    name === 'AbortError' &&
    typeof message === 'string' &&
    message.includes('browsing context is going away')
  );
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const retryRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    let active = true;
    // Each read's number: only the newest read's answer lands (a late answer
    // from a read Try again replaced is dropped).
    let generation = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const read = (onFail: () => void): void => {
      generation += 1;
      const mine = generation;
      let settled = false;
      clearTimeout(timer);
      // The ceiling only ends a wait that already exists: no stored session
      // never waits on the network, so it never hits it.
      timer = setTimeout(() => {
        if (!active || mine !== generation || settled) return;
        if (storedSessionUserId() !== null) onFail();
      }, SESSION_WAIT_MS);
      supabase.auth
        .getSession()
        .then(({ data, error }) => {
          settled = true;
          if (!active || mine !== generation) return;
          clearTimeout(timer);
          if (sessionReadFailed(data.session, error, storedSessionUserId())) {
            if (!isClosingTabAbort(error)) {
              logger.error('getSession failed', { error: String(error) });
            }
            onFail();
            return;
          }
          mark('session:resolved');
          noteAuthUser('INITIAL_SESSION', data.session?.user.id ?? null);
          setSession(data.session);
          setFailed(false);
          setLoading(false);
        })
        .catch((error: unknown) => {
          settled = true;
          if (!active || mine !== generation) return;
          clearTimeout(timer);
          if (!isClosingTabAbort(error)) {
            logger.error('getSession failed', { error: String(error) });
          }
          if (storedSessionUserId() !== null) {
            onFail();
            return;
          }
          setSession(null);
          setLoading(false);
        });
    };

    read(() => setFailed(true));
    retryRef.current = () => {
      setFailed(false);
      read(() => window.location.reload());
    };

    const { data: subscription } = supabase.auth.onAuthStateChange((event, nextSession) => {
      mark(`auth:event:${event}`);
      noteAuthToken(event, nextSession?.access_token);
      if (deferAuthEvent(event, nextSession, () => storedSessionUserId())) return;
      // Before any consumer renders: a different user (account switch) or a
      // sign-out from any path wipes the kept and device-saved screens.
      noteAuthUser(event, nextSession?.user.id ?? null);
      setSession((current) => resolveSession(event, nextSession, current));
      if (nextSession !== null || event === 'SIGNED_OUT') setFailed(false);
      setLoading(false);
    });

    const handleSignout = () => {
      void performSignout(supabase);
    };
    window.addEventListener(SIGNOUT_EVENT, handleSignout);

    return () => {
      active = false;
      clearTimeout(timer);
      subscription.subscription.unsubscribe();
      window.removeEventListener(SIGNOUT_EVENT, handleSignout);
    };
  }, []);

  const retry = useCallback(() => retryRef.current(), []);
  const value = useMemo<SessionContextValue>(
    () => ({ session, loading, failed, retry }),
    [session, loading, failed, retry],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) {
    throw new Error('useSession must be used within a SessionProvider');
  }
  return ctx;
}
