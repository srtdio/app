// The viewer's side (agency or client) in a workspace, for chat surfaces that
// word things differently per side (the shared post card's "Waiting on you").
// The workspace context does not carry the role, so it is read once through
// fetchMemberRole (one RLS-scoped workspace_members SELECT) and cached per
// workspace and user for the session: every card in every thread shares the one
// in-flight read, so a thread of many cards costs a single role fetch.

import { useEffect, useState } from 'react';
import type { Client } from '@srtdio/rpc';
import { isAgencySide, isClient } from '@/components/pages/pcs/roles';
import { fetchMemberRole } from '@/lib/assets';
import { useSession } from '@/lib/session-context';
import { supabase } from '@/lib/supabase';
import { READ_TIMEOUT_MS } from '@/lib/chat-reads';

export { fetchMemberRole };

export type ViewerSide = 'agency' | 'client' | 'unknown';

/** Map a workspace role to its side; null or an unrecognised role is 'unknown'. */
export function sideForRole(role: string | null): ViewerSide {
  if (isClient(role)) return 'client';
  if (isAgencySide(role)) return 'agency';
  return 'unknown';
}

/** The agency side acts on the client's behalf (an approve adds the on-behalf line). */
export function actsOnBehalfOfClient(side: ViewerSide): boolean {
  return side === 'agency';
}

const resolved = new Map<string, ViewerSide>();
const inFlight = new Map<string, Promise<ViewerSide>>();

function cacheKey(workspaceId: string, userId: string): string {
  return `${workspaceId}:${userId}`;
}

/** A side already resolved this session, or undefined. Never fetches. */
export function peekViewerSide(workspaceId: string, userId: string): ViewerSide | undefined {
  return resolved.get(cacheKey(workspaceId, userId));
}

/**
 * Resolve the viewer's side once per (workspace, user) for the session; callers
 * that race share the in-flight read. A failed read ('unknown') is not cached,
 * so the next mount retries it. Never throws.
 */
export function resolveViewerSide(
  client: Client,
  workspaceId: string,
  userId: string,
): Promise<ViewerSide> {
  const key = cacheKey(workspaceId, userId);
  const hit = resolved.get(key);
  if (hit !== undefined) return Promise.resolve(hit);
  const pending = inFlight.get(key);
  if (pending !== undefined) return pending;
  // Bounded at 5s: a role read that never answers settles as 'unknown' (not
  // cached, so the next mount retries it) and never holds a card or the strip.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const next = Promise.race([
    fetchMemberRole(client, workspaceId, userId).then(sideForRole, () => 'unknown' as const),
    new Promise<ViewerSide>((resolve) => {
      timer = setTimeout(() => resolve('unknown'), READ_TIMEOUT_MS);
    }),
  ])
    .finally(() => clearTimeout(timer))
    .then((side) => {
      inFlight.delete(key);
      if (side !== 'unknown') resolved.set(key, side);
      return side;
    });
  inFlight.set(key, next);
  return next;
}

/** Forget every cached side (the open cache's clear: sign-out, user or workspace change; tests). */
export function resetViewerSideCache(): void {
  resolved.clear();
  inFlight.clear();
}

/**
 * The viewer's side in a workspace. `ready` is false until the role read has
 * settled (a cached side is ready on first render); callers hold their first
 * paint until then so the wording never flips. Without a workspace or session
 * the side is 'unknown' and ready.
 */
export function useViewerSide(workspaceId: string | null): { side: ViewerSide; ready: boolean } {
  const { session } = useSession();
  const userId = session?.user.id ?? null;
  const cached =
    workspaceId !== null && userId !== null ? peekViewerSide(workspaceId, userId) : undefined;
  const [state, setState] = useState<{ key: string; side: ViewerSide } | null>(null);
  const key = workspaceId !== null && userId !== null ? cacheKey(workspaceId, userId) : null;

  useEffect(() => {
    if (workspaceId === null || userId === null || cached !== undefined) return;
    let cancelled = false;
    void resolveViewerSide(supabase, workspaceId, userId).then((side) => {
      if (!cancelled) setState({ key: cacheKey(workspaceId, userId), side });
    });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, userId, cached]);

  if (key === null) return { side: 'unknown', ready: true };
  if (cached !== undefined) return { side: cached, ready: true };
  if (state !== null && state.key === key) return { side: state.side, ready: true };
  return { side: 'unknown', ready: false };
}
