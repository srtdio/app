// Reads the signed-in user's own profile row for the onboarding gate. Mirrors the
// direct-query pattern in src/components/comments/commentProfiles.ts
// (supabase.from('users').select(...).eq('id', userId).maybeSingle()), selecting
// exactly the columns the gate and the form need. Loading, error and loaded are
// three distinct states so the gate can fail open on a transient error instead of
// mistaking it for "profile not loaded yet" or "profile complete".
//
// One module-level store backs every useCurrentProfile() caller, so the header
// (AppLayout) and Settings render the same snapshot and a refetch() from any of
// them updates all. At most one read is in flight; mounts and refetches share it
// (a refetch during a read queues exactly one follow-up so it sees fresh data).
// The store is keyed by the auth user id: a snapshot for another user is never
// returned, so one user's profile cannot paint for the next user on this device.
//
// Reads happen only on the first load for a user, an explicit refetch(), and
// Retry: mounting another consumer while a snapshot is loaded (or a read is in
// flight) for that user reads nothing. Each read carries an increasing sequence
// number and only the newest read's result is applied, so an older read that
// lands late (A to B to A) never overwrites a newer one. The store resets from
// the Supabase auth state change (the same source session-context uses), not
// from the sorted:signout request, so tapping Sign out never swaps the app for
// "Loading" and a failed sign-out cannot leave it stuck.
//
// On a cold open the row this device saved (src/lib/device-cache.ts, through
// the session reads) is the first snapshot (not loading), so the shell paints
// at once; the first read still runs and replaces it quietly.

import { mark } from '@/lib/perf-marks';
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { supabase } from '@/lib/supabase';
import type { AuthChangeEvent, Session } from '@supabase/supabase-js';
import { useSession } from '@/lib/session-context';
import { logger } from '@/lib/logger';
import { onSessionReadsHydrated, peekKept, primeRead, readKey } from '@/lib/session-read';

export interface CurrentProfile {
  display_name: string;
  designation: string | null;
  avatar_url: string | null;
  email_opt_in: boolean;
  profile_completed_at: string | null;
  username: string | null;
}

interface UseCurrentProfile {
  profile: CurrentProfile | null;
  loading: boolean;
  error: boolean;
  refetch: () => void;
}

interface ProfileSnapshot {
  userId: string | null;
  profile: CurrentProfile | null;
  loading: boolean;
  error: boolean;
}

/** No user, or a user whose row has not landed yet: hold in loading. */
const EMPTY: ProfileSnapshot = { userId: null, profile: null, loading: true, error: false };

let snapshot: ProfileSnapshot = EMPTY;
let inflight: Promise<void> | null = null;
let queued = false;
/** Sequence number of the newest read; only its result is applied. */
let latestSeq = 0;
const listeners = new Set<() => void>();
/** The user whose first read has settled (ok or failed); null before it. */
let readSettledFor: string | null = null;

/** The user-level session-read key of the profile row (saved on the device). */
export function profileReadKey(userId: string): string {
  return readKey(userId, '', 'shell:profile');
}

/** A snapshot for `userId` before any read: the saved row (not loading) when there is one. */
function firstSnapshot(userId: string): ProfileSnapshot {
  const saved = peekKept<CurrentProfile>(profileReadKey(userId));
  if (saved === undefined) return { ...EMPTY, userId };
  return { userId, profile: saved, loading: false, error: false };
}

function publish(next: ProfileSnapshot): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

function readProfile(userId: string): Promise<{ data: CurrentProfile | null; failed: boolean }> {
  mark('profile:start');
  return Promise.resolve(
    supabase
      .from('users')
      .select('display_name, designation, avatar_url, email_opt_in, profile_completed_at, username')
      .eq('id', userId)
      .maybeSingle(),
  ).then(
    ({ data, error: queryError }) => {
      mark('profile:end');
      if (queryError) {
        logger.error('useCurrentProfile load failed', { error: queryError.message });
      }
      if (queryError || data === null) return { data: null, failed: true };
      return { data: data as CurrentProfile, failed: false };
    },
    (thrown: unknown) => {
      mark('profile:end');
      logger.error('useCurrentProfile load failed', { error: String(thrown) });
      return { data: null, failed: true };
    },
  );
}

function startRead(userId: string): Promise<void> {
  latestSeq += 1;
  const seq = latestSeq;
  const run = readProfile(userId).then(({ data, failed }) => {
    // A newer read started, or the user changed (or signed out) mid-read: drop
    // the stale result.
    if (seq !== latestSeq || snapshot.userId !== userId) return;
    readSettledFor = userId;
    if (failed) {
      // Keep the last good row; flag the failure the same way as before.
      publish({ userId, profile: snapshot.profile, loading: false, error: true });
    } else {
      if (data !== null) primeRead(profileReadKey(userId), data);
      publish({ userId, profile: data, loading: false, error: false });
    }
  });
  const tracked = run.finally(() => {
    if (inflight !== tracked) return;
    inflight = null;
    if (queued && snapshot.userId === userId) {
      queued = false;
      inflight = startRead(userId);
    }
    queued = false;
  });
  return tracked;
}

/** Drop everything held for the previous user. Synchronous. */
export function resetProfileStore(userId: string | null = null): void {
  inflight = null;
  queued = false;
  latestSeq += 1;
  readSettledFor = null;
  const next = userId === null ? EMPTY : firstSnapshot(userId);
  if (!next.loading) mark('device-cache:profile');
  publish(next);
}

/**
 * Make sure a read for `userId` is running or has run. A different user resets
 * the store first. Without `force` (a mount) nothing is read when the snapshot
 * for this user has already settled or a read is in flight. `force` (refetch,
 * Retry) queues one follow-up read when one is already in flight, so a read
 * started before a write never wins.
 */
export function loadProfile(userId: string, force = false): Promise<void> {
  if (snapshot.userId !== userId) resetProfileStore(userId);
  if (inflight !== null) {
    if (force) queued = true;
    return inflight;
  }
  // A saved row is shown without a read having settled: the first read still runs.
  if (!force && readSettledFor === userId) return Promise.resolve();
  inflight = startRead(userId);
  return inflight;
}

export function getProfileSnapshot(): ProfileSnapshot {
  return snapshot;
}

/**
 * Whether an auth event ends the held snapshot: an explicit sign-out, or a
 * session for a different user. A transient null session (refresh hiccup) keeps
 * it, matching resolveSession in session-context. Pure.
 */
export function authEndsSnapshot(
  event: AuthChangeEvent,
  session: Session | null,
  heldUserId: string | null,
): boolean {
  if (heldUserId === null) return false;
  if (event === 'SIGNED_OUT') return true;
  return session !== null && session.user.id !== heldUserId;
}

function onAuthChange(event: AuthChangeEvent, session: Session | null): void {
  if (!authEndsSnapshot(event, session, snapshot.userId)) return;
  // Reset without notifying. Every consumer re-renders from this same auth event
  // through useSession, and profileViewFor already hides a snapshot held for
  // another user, so a notify here would only add a render with the old session
  // and an empty store: a "Loading" frame on sign-out.
  inflight = null;
  queued = false;
  latestSeq += 1;
  readSettledFor = null;
  snapshot = EMPTY;
}

// The device cache seeded after the store was set up (a slow hydrate): show
// the saved row while the first read is still on its way.
onSessionReadsHydrated(() => {
  const { userId } = snapshot;
  if (userId === null || !snapshot.loading || readSettledFor === userId) return;
  const next = firstSnapshot(userId);
  if (!next.loading) publish(next);
});

let authSubscription: { unsubscribe: () => void } | null = null;

export function subscribeProfile(listener: () => void): () => void {
  if (listeners.size === 0 && authSubscription === null) {
    authSubscription = supabase.auth.onAuthStateChange(onAuthChange).data.subscription;
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && authSubscription !== null) {
      authSubscription.unsubscribe();
      authSubscription = null;
    }
  };
}

/**
 * What a caller signed in as `userId` may see. A snapshot held for any other
 * user renders as loading, so the switch is clean on the very first render,
 * before any effect has reset the store. Pure.
 */
export function profileViewFor(snap: ProfileSnapshot, userId: string | null): ProfileSnapshot {
  if (userId === null || snap.userId !== userId) return { ...EMPTY, userId };
  return snap;
}

export function useCurrentProfile(): UseCurrentProfile {
  const { session } = useSession();
  const userId = session?.user.id ?? null;

  const snap = useSyncExternalStore(subscribeProfile, getProfileSnapshot, getProfileSnapshot);

  useEffect(() => {
    if (userId === null) {
      // No session yet (or signed out): clear any previous user's row.
      if (getProfileSnapshot().userId !== null) resetProfileStore(null);
      return;
    }
    void loadProfile(userId);
  }, [userId]);

  const refetch = useCallback(() => {
    if (userId !== null) void loadProfile(userId, true);
  }, [userId]);

  // Before the store has switched to this user (its effect runs after this
  // render), the row this device saved for them already paints.
  const view =
    userId !== null && snap.userId !== userId
      ? firstSnapshot(userId)
      : profileViewFor(snap, userId);
  return { profile: view.profile, loading: view.loading, error: view.error, refetch };
}
