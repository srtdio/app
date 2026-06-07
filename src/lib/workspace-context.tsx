import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { listWorkspaces } from '@srtdio/workspace';
import type { Database } from '@srtdio/schemas';
import { supabase } from '@/lib/supabase';
import { useSession } from '@/lib/session-context';
import { logger } from '@/lib/logger';

/** A workspace row, as returned by the RLS-scoped listWorkspaces select. */
export type WorkspaceRow = Database['public']['Tables']['workspaces']['Row'];

/**
 * Active-workspace context for signed-in users. One workspace = one client =
 * one platform, so a single active workspace drives every tenant-scoped read.
 * Resolved once on mount from listWorkspaces (a direct RLS select, no trace id);
 * the active id lives in React state only (no localStorage, no hardcoding) and
 * defaults to the first row returned.
 */
interface WorkspaceContextValue {
  workspaceId: string | null;
  workspaceName: string | null;
  workspaces: WorkspaceRow[];
  loading: boolean;
  error: string | null;
  setActiveWorkspaceId: (id: string) => void;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const { session } = useSession();
  const [workspaces, setWorkspaces] = useState<WorkspaceRow[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!session) return;
    let active = true;
    setLoading(true);
    setError(null);

    listWorkspaces(supabase)
      .then((res) => {
        if (!active) return;
        if (!res.ok) {
          setError(res.error.message);
          setWorkspaces([]);
          setActiveId(null);
        } else {
          setWorkspaces(res.data);
          // Default the active workspace to the first row, keeping any prior
          // selection that is still present in the refreshed list.
          setActiveId((prev) =>
            prev !== null && res.data.some((w) => w.id === prev) ? prev : (res.data[0]?.id ?? null),
          );
        }
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (!active) return;
        logger.error('listWorkspaces failed', { error: String(err) });
        setError(String(err));
        setWorkspaces([]);
        setActiveId(null);
        setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [session]);

  const setActiveWorkspaceId = useCallback((id: string) => {
    setActiveId(id);
  }, []);

  const activeWorkspace = useMemo(
    () => workspaces.find((w) => w.id === activeId) ?? null,
    [workspaces, activeId],
  );

  const value = useMemo<WorkspaceContextValue>(
    () => ({
      workspaceId: activeWorkspace?.id ?? null,
      workspaceName: activeWorkspace?.name ?? null,
      workspaces,
      loading,
      error,
      setActiveWorkspaceId,
    }),
    [activeWorkspace, workspaces, loading, error, setActiveWorkspaceId],
  );

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceContextValue {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) {
    throw new Error('useWorkspace must be used within a WorkspaceProvider');
  }
  return ctx;
}
