// The caller's capability in the active workspace, read through the same
// public.proc_capability check the write procs run. Kept out of
// workspace-context.tsx so surfaces that only mock useWorkspace still load.

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { logger } from '@/lib/logger';
import { useWorkspace } from '@/lib/workspace-context';

const capabilityCache = new Map<string, boolean>();

/**
 * Whether the caller holds a capability in the active workspace, via the same
 * public.proc_capability check the write procs run (workspace_role_permissions
 * joined to the caller's active membership). null until it resolves, and on a
 * failed read (not cached, so the next mount retries); callers treat null as
 * "not allowed" so an action never flashes in for a role that lacks it. Cached
 * per workspace and capability for the session.
 */
export function useWorkspaceCapability(capability: string): boolean | null {
  const { workspaceId } = useWorkspace();
  const key = workspaceId === null ? null : `${workspaceId}:${capability}`;
  const cached = key === null ? undefined : capabilityCache.get(key);
  const [state, setState] = useState<{ key: string; allowed: boolean } | null>(null);

  useEffect(() => {
    if (workspaceId === null || key === null || cached !== undefined) return;
    let cancelled = false;
    // No trace id: proc_capability is a read-only STABLE check without one.
    const args = { p_workspace_id: workspaceId, p_capability: capability };
    void Promise.resolve(supabase.rpc('proc_capability', args)).then(
      ({ data, error }) => {
        if (cancelled || error) return;
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
  if (state !== null && state.key === key) return state.allowed;
  return null;
}
