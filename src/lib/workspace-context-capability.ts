// The caller's capabilities in the active workspace, read through
// public.capabilities_for_workspace (the same workspace_role_permissions rows
// joined to the caller's active membership that the write procs check). Kept
// out of workspace-context.tsx so surfaces that only mock useWorkspace still load.
//
// One read per (user, workspace) per session, in memory only (never persisted):
// every capability check on every screen answers from that one set, and
// callers that ask while the read runs (two buttons on one screen, the shell
// and a page) join the one in-flight rpc instead of each firing one. A
// capability the set does not name is not allowed. A failed read is never
// cached, so the next ask retries.

import { mark } from '@/lib/perf-marks';
import { useEffect, useState } from 'react';
import type { Database } from '@srtdio/schemas';
import { withTraceHeader } from '@srtdio/rpc';
import { supabase } from '@/lib/supabase';
import { logger } from '@/lib/logger';
import { SIGNOUT_EVENT } from '@/lib/events';
import { generateTraceId } from '@/lib/trace';
import { useSession } from '@/lib/session-context';
import { useWorkspace } from '@/lib/workspace-context';

type Functions = Database['public']['Functions'];

/** The capabilities the caller holds in one workspace (allowed ones only). */
export type CapabilitySet = ReadonlySet<string>;

// Keyed by user and workspace: one person's permissions are never served to
// another person who signs in on the same device.
const capabilityCache = new Map<string, CapabilitySet>();
// The read running for a key; every caller that asks meanwhile joins it.
const inflight = new Map<string, Promise<CapabilitySet | null>>();

// Bumped on every clear: a read that left before a clear never writes after it.
let cacheEpoch = 0;

/** The per-workspace cache key, or null when there is no user or no workspace (no read then). */
export function workspaceCapabilitiesKey(
  userId: string | null,
  workspaceId: string | null,
): string | null {
  if (userId === null || userId === '' || workspaceId === null) return null;
  return JSON.stringify([userId, workspaceId]);
}

/** One capability's identity for a user and workspace, or null with no user or workspace. */
export function capabilityKey(
  userId: string | null,
  workspaceId: string | null,
  capability: string,
): string | null {
  if (workspaceCapabilitiesKey(userId, workspaceId) === null) return null;
  return JSON.stringify([userId, workspaceId, capability]);
}

/** Drop every cached capability set (signout; tests). */
export function clearCapabilityCache(): void {
  capabilityCache.clear();
  inflight.clear();
  cacheEpoch += 1;
}

/**
 * Drop one capability from one user's cached set in one workspace, leaving every
 * other capability as read (the set holds allowed ones only, so it then reads as
 * not allowed). Used when the server refuses what the cache allowed
 * (group_create's group_limit_reached for 'group.create_more'). No read.
 */
export function dropCachedCapability(
  userId: string,
  workspaceId: string,
  capability: string,
): void {
  const key = workspaceCapabilitiesKey(userId, workspaceId);
  if (key === null) return;
  const hit = capabilityCache.get(key);
  if (hit === undefined || !hit.has(capability)) return;
  const next = new Set(hit);
  next.delete(capability);
  capabilityCache.set(key, next);
}

// Signout clears the cache at once, before the next person signs in.
if (typeof window !== 'undefined') {
  window.addEventListener(SIGNOUT_EVENT, clearCapabilityCache);
}

/** The allowed capabilities in the proc's rows; a missing or not-allowed one is absent. */
export function mapCapabilityRows(data: unknown): CapabilitySet {
  const allowed = new Set<string>();
  if (!Array.isArray(data)) return allowed;
  for (const row of data as unknown[]) {
    if (typeof row !== 'object' || row === null) continue;
    const rec = row as { capability?: unknown; allowed?: unknown };
    if (typeof rec.capability === 'string' && rec.allowed === true) allowed.add(rec.capability);
  }
  return allowed;
}

/**
 * The caller's capability set in one workspace: the cached one, the running
 * read, or one new capabilities_for_workspace rpc (explicit p_trace_id; the
 * actor is auth.uid() server side). Resolves null on a failed read (never
 * cached, so the next ask retries). Never rejects.
 */
export function readWorkspaceCapabilities(
  userId: string,
  workspaceId: string,
): Promise<CapabilitySet | null> {
  const key = workspaceCapabilitiesKey(userId, workspaceId);
  if (key === null) return Promise.resolve(null);
  const hit = capabilityCache.get(key);
  if (hit !== undefined) return Promise.resolve(hit);
  const running = inflight.get(key);
  if (running !== undefined) return running;
  mark('capabilities:start');
  const epoch = cacheEpoch;
  const args: Functions['capabilities_for_workspace']['Args'] = {
    p_trace_id: generateTraceId(),
    p_workspace_id: workspaceId,
  };
  const read: Promise<CapabilitySet | null> = Promise.resolve(
    withTraceHeader(supabase.rpc('capabilities_for_workspace', args), args.p_trace_id),
  )
    .then(
      ({ data, error }) => {
        if (error) {
          logger.warn('capability read failed', { error: error.message });
          return null;
        }
        const set = mapCapabilityRows(data);
        // A signout since the read left: the answer is not kept.
        if (epoch === cacheEpoch) capabilityCache.set(key, set);
        return set;
      },
      (err: unknown) => {
        logger.error('capability read failed', { error: String(err) });
        return null;
      },
    )
    .finally(() => {
      if (inflight.get(key) === read) inflight.delete(key);
    });
  inflight.set(key, read);
  return read;
}

/**
 * The caller's answer for one capability, from the workspace's one capability
 * read. Resolves null on a failed read (never cached). Never rejects.
 */
export function readWorkspaceCapability(
  userId: string,
  workspaceId: string,
  capability: string,
): Promise<boolean | null> {
  return readWorkspaceCapabilities(userId, workspaceId).then((set) =>
    set === null ? null : set.has(capability),
  );
}

/**
 * The signed-in user's id, or null with no session. Isolated component tests
 * render without a SessionProvider (useSession throws there): no provider means
 * no session, so nothing is read. Calls useSession through the module so test
 * mocks of '@/lib/session-context' keep working.
 */
function useSessionUserId(): string | null {
  try {
    return useSession().session?.user.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Whether the caller holds a capability in the active workspace, answered from
 * the workspace's one capabilities_for_workspace read. null until it resolves,
 * with no signed-in user, and on a failed read (not cached, so the next mount
 * retries); callers treat null as "not allowed" so an action never flashes in
 * for a role that lacks it. Cached per user and workspace until signout;
 * concurrent callers share one rpc.
 */
export function useWorkspaceCapability(capability: string): boolean | null {
  const { workspaceId } = useWorkspace();
  const userId = useSessionUserId();
  const key = workspaceCapabilitiesKey(userId, workspaceId);
  const cached = key === null ? undefined : capabilityCache.get(key);
  const [state, setState] = useState<{ key: string; set: CapabilitySet } | null>(null);

  useEffect(() => {
    if (workspaceId === null || userId === null || key === null || cached !== undefined) return;
    let cancelled = false;
    const epoch = cacheEpoch;
    void readWorkspaceCapabilities(userId, workspaceId).then((set) => {
      // A switch of user or workspace cancels this read (the key changed), and
      // a signout since it left bumps the epoch: neither result is kept. A
      // failed read (null) leaves the action hidden.
      if (cancelled || set === null || epoch !== cacheEpoch) return;
      setState({ key, set });
    });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, userId, key, cached]);

  if (key === null) return null;
  if (cached !== undefined) return cached.has(capability);
  // state carries the key it was read for: user A's answer never shows for user B.
  if (state !== null && state.key === key) return state.set.has(capability);
  return null;
}
