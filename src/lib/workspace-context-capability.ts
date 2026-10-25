// The caller's capability in the active workspace, read through the same
// public.proc_capability check the write procs run. Kept out of
// workspace-context.tsx so surfaces that only mock useWorkspace still load.

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { logger } from '@/lib/logger';
import { SIGNOUT_EVENT } from '@/lib/events';
import { useSession } from '@/lib/session-context';
import { useWorkspace } from '@/lib/workspace-context';

// Keyed by user, workspace and capability: one person's permissions are never
// served to another person who signs in on the same device.
const capabilityCache = new Map<string, boolean>();

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
  cacheEpoch += 1;
}

// Signout clears the cache at once, before the next person signs in.
if (typeof window !== 'undefined') {
  window.addEventListener(SIGNOUT_EVENT, clearCapabilityCache);
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
 * that lacks it. Cached per user, workspace and capability until signout.
 */
export function useWorkspaceCapability(capability: string): boolean | null {
  const { workspaceId } = useWorkspace();
  const userId = useSessionUserId();
  const key = capabilityKey(userId, workspaceId, capability);
  const cached = key === null ? undefined : capabilityCache.get(key);
  const [state, setState] = useState<{ key: string; allowed: boolean } | null>(null);

  useEffect(() => {
    if (workspaceId === null || key === null || cached !== undefined) return;
    let cancelled = false;
    const epoch = cacheEpoch;
    // No trace id: proc_capability is a read-only STABLE check without one.
    const args = { p_workspace_id: workspaceId, p_capability: capability };
    void Promise.resolve(supabase.rpc('proc_capability', args)).then(
      ({ data, error }) => {
        // A switch of user or workspace cancels this read (the key changed), and
        // a signout since it left bumps the epoch: neither result is kept.
        if (cancelled || error || epoch !== cacheEpoch) return;
        const allowed = data === true;
        capabilityCache.set(key, allowed);
        setState({ key, allowed });
      },
      (err: unknown) => {
        logger.error('capability read failed', { capability, error: String(err) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [workspaceId, key, cached, capability]);

  if (key === null) return null;
  if (cached !== undefined) return cached;
  // state carries the key it was read for: user A's answer never shows for user B.
  if (state !== null && state.key === key) return state.allowed;
  return null;
}
