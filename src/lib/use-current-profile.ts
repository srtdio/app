// Reads the signed-in user's own profile row for the onboarding gate. Mirrors the
// direct-query pattern in src/components/comments/commentProfiles.ts
// (supabase.from('users').select(...).eq('id', userId).maybeSingle()), selecting
// exactly the columns the gate and the form need. Loading, error and loaded are
// three distinct states so the gate can fail open on a transient error instead of
// mistaking it for "profile not loaded yet" or "profile complete".

import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useSession } from '@/lib/session-context';
import { logger } from '@/lib/logger';

interface CurrentProfile {
  display_name: string;
  designation: string | null;
  avatar_url: string | null;
  email_opt_in: boolean;
  profile_completed_at: string | null;
}

export interface UseCurrentProfile {
  profile: CurrentProfile | null;
  loading: boolean;
  error: boolean;
  refetch: () => void;
}

export function useCurrentProfile(): UseCurrentProfile {
  const { session } = useSession();
  const userId = session?.user.id ?? null;

  const [profile, setProfile] = useState<CurrentProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  // Bumped by refetch() to re-run the load effect (e.g. after onComplete).
  const [nonce, setNonce] = useState(0);

  const refetch = useCallback(() => {
    setNonce((n) => n + 1);
  }, []);

  useEffect(() => {
    if (userId === null) {
      // No session yet: hold in the loading state rather than reporting an error.
      setProfile(null);
      setLoading(true);
      setError(false);
      return;
    }

    let active = true;
    setLoading(true);
    setError(false);

    void supabase
      .from('users')
      .select('display_name, designation, avatar_url, email_opt_in, profile_completed_at')
      .eq('id', userId)
      .maybeSingle()
      .then(({ data, error: queryError }) => {
        if (!active) return;
        if (queryError || data === null) {
          if (queryError) {
            logger.error('useCurrentProfile load failed', { error: queryError.message });
          }
          setProfile(null);
          setError(true);
          setLoading(false);
          return;
        }
        setProfile(data);
        setError(false);
        setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [userId, nonce]);

  return { profile, loading, error, refetch };
}
