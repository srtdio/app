// The caller's capability in the active workspace, read through the same
// public.proc_capability check the write procs run. Kept out of
// workspace-context.tsx so surfaces that only mock useWorkspace still load.
//
// One read per (user, workspace, capability) per session: a settled answer is
// cached, and callers that ask while the read runs (two buttons on one screen,
// the shell and a page) join the one in-flight rpc instead of each firing one.

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { logger } from '@/lib/logger';
import { SIGNOUT_EVENT } from '@/lib/events';
import { useSession } from '@/lib/session-context';
import { useWorkspace } from '@/lib/workspace-context';

// Keyed by user, workspace and capability: one person's permissions are never
// served to another person who signs in on the same device.
const capabilityCache = new Map<string, boolean>();
// The read running for a key; every caller that asks meanwhile joins it.
const inflight = new Map<string, Promise<boolean | null>>();

// Bumped on every clear: a read that left before a clear never writes after it.
let cacheEpoch = 0;

/** The cache key, or null when there is no user or no workspace (no read then). */
export function capabilityKey(
  userId: string | null,
  workspaceId: string | null,
  capability: string,
): string | null {
  if (userId === null || userId === '' || workspaceId === null) return null;
  return JSON.stringify([userId, workspaceId, capability]);
}

/** Drop every cached capability (signout; tests). */
export function clearCapabilityCache(): void {
  capabilityCache.clear();
  inflight.clear();
  cacheEpoch += 1;
}

// Signout clears the cache at once, before the next person signs in.
if (typeof window !== 'undefined') {
  window.addEventListener(SIGNOUT_EVENT, clearCapabilityCache);
}

/**
 * The caller's answer for one capability: the cached one, the running read,
 * or a new proc_capability rpc. Resolves null on a failed read (never cached,
 * so the next ask retries). Never rejects.
 */
export function readWorkspaceCapability(
  userId: string,
  workspaceId: string,
  capability: string,
): Promise<boolean | null> {
  const key = capabilityKey(userId, workspaceId, capability);
  if (key === null) return Promise.resolve(null);
  const hit = capabilityCache.get(key);
  if (hit !== undefined) return Promise.resolve(hit);
  const running = inflight.get(key);
  if (running !== undefined) return running;
  const epoch = cacheEpoch;
  // No trace id: proc_capability is a read-only STABLE check without one.
  const args = { p_workspace_id: workspaceId, p_capability: capability };
  const read: Promise<boolean | null> = Promise.resolve(supabase.rpc('proc_capability', args))
    .then(
      ({ data, error }) => {
        if (error) return null;
        const allowed = data === true;
        // A signout since the read left: the answer is not kept.
        if (epoch === cacheEpoch) capabilityCache.set(key, allowed);
        return allowed;
      },
      (err: unknown) => {
        logger.error('capability read failed', { capability, error: String(err) });
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
 * Whether the caller holds a capability in the active workspace, via the same
 * public.proc_capability check the write procs run (workspace_role_permissions
 * joined to the caller's active membership). null until it resolves, with no
 * signed-in user, and on a failed read (not cached, so the next mount retries);
 * callers treat null as "not allowed" so an action never flashes in for a role
 * that lacks it. Cached per user, workspace and capability until signout;
 * concurrent callers share one rpc.
 */
export function useWorkspaceCapability(capability: string): boolean | null {
  const { workspaceId } = useWorkspace();
  const userId = useSessionUserId();
  const key = capabilityKey(userId, workspaceId, capability);
  const cached = key === null ? undefined : capabilityCache.get(key);
  const [state, setState] = useState<{ key: string; allowed: boolean } | null>(null);

  useEffect(() => {
    if (workspaceId === null || userId === null || key === null || cached !== undefined) return;
    let cancelled = false;
    const epoch = cacheEpoch;
    void readWorkspaceCapability(userId, workspaceId, capability).then((allowed) => {
      // A switch of user or workspace cancels this read (the key changed), and
      // a signout since it left bumps the epoch: neither result is kept. A
      // failed read (null) leaves the action hidden.
      if (cancelled || allowed === null || epoch !== cacheEpoch) return;
      setState({ key, allowed });
    });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, userId, key, cached, capability]);

  if (key === null) return null;
  if (cached !== undefined) return cached;
  // state carries the key it was read for: user A's answer never shows for user B.
  if (state !== null && state.key === key) return state.allowed;
  return null;
}
