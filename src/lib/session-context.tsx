import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { AuthChangeEvent, Session, SupabaseClient } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import { SIGNOUT_EVENT } from '@/lib/events';
import { logger } from '@/lib/logger';

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
 * never see a flash of /signin on first paint.
 */
interface SessionContextValue {
  session: Session | null;
  loading: boolean;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;

    supabase.auth
      .getSession()
      .then(({ data }) => {
        if (!active) return;
        setSession(data.session);
        setLoading(false);
      })
      .catch((error: unknown) => {
        if (!active) return;
        logger.error('getSession failed', { error: String(error) });
        setSession(null);
        setLoading(false);
      });

    const { data: subscription } = supabase.auth.onAuthStateChange((event, nextSession) => {
      setSession((current) => resolveSession(event, nextSession, current));
      setLoading(false);
    });

    const handleSignout = () => {
      void performSignout(supabase);
    };
    window.addEventListener(SIGNOUT_EVENT, handleSignout);

    return () => {
      active = false;
      subscription.subscription.unsubscribe();
      window.removeEventListener(SIGNOUT_EVENT, handleSignout);
    };
  }, []);

  const value = useMemo<SessionContextValue>(() => ({ session, loading }), [session, loading]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) {
    throw new Error('useSession must be used within a SessionProvider');
  }
  return ctx;
}
