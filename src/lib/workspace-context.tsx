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
import type { Session } from '@supabase/supabase-js';
import { listWorkspaces } from '@srtdio/workspace';
import { workspaceCreate } from '@srtdio/rpc';
import type { Client } from '@srtdio/rpc';
import type { Database, Json } from '@srtdio/schemas';
import { supabase } from '@/lib/supabase';
import { useSession } from '@/lib/session-context';
import { useNewTrace } from '@/lib/trace-context';
import { logger } from '@/lib/logger';

/** A workspace row, as returned by the RLS-scoped listWorkspaces select. */
export type WorkspaceRow = Database['public']['Tables']['workspaces']['Row'];

/** Read a non-empty string field from the session user's signup metadata. */
function metadataString(session: Session, key: string): string | null {
  const meta = session.user.user_metadata as Record<string, unknown> | undefined;
  const value = meta?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

/**
 * The workspace_name a self-serve signup stashed in user_metadata, or null for
 * invited / existing users (who must never auto-create a workspace).
 */
export function workspaceNameFromMetadata(session: Session): string | null {
  return metadataString(session, 'workspace_name');
}

export interface BootstrapResult {
  workspaces: WorkspaceRow[];
  error: string | null;
}

/**
 * One-shot first-load bootstrap: list the caller's workspaces and, when the
 * list is empty AND the session carries a signup workspace_name, create that
 * workspace once, then re-list so the new row is active. This is the single
 * creation path (SignUpPage no longer creates), so it works whether email
 * confirmation was ON (created on first authenticated load) or OFF.
 *
 * `guard` flips to true BEFORE the workspaceCreate await so a repeated
 * onAuthStateChange that re-enters this path cannot fire a second create and
 * produce a duplicate workspace. Metadata is read from the session user object
 * only, so there is no extra network round-trip.
 */
export async function bootstrapWorkspaces(
  client: Client,
  session: Session,
  guard: { current: boolean },
  newTrace: () => string,
): Promise<BootstrapResult> {
  const listed = await listWorkspaces(client);
  if (!listed.ok) return { workspaces: [], error: listed.error.message };
  if (listed.data.length > 0) return { workspaces: listed.data, error: null };

  const name = workspaceNameFromMetadata(session);
  if (name === null || guard.current) return { workspaces: listed.data, error: null };

  // Flip before the await: re-entry sees the guard set and bails (no duplicate).
  guard.current = true;
  const payload: Json = { name, timezone: metadataString(session, 'timezone') };
  const created = await workspaceCreate(client, { p_payload: payload, p_trace_id: newTrace() });
  if (!created.ok) return { workspaces: [], error: created.error.message };

  const relisted = await listWorkspaces(client);
  if (!relisted.ok) return { workspaces: [], error: relisted.error.message };
  return { workspaces: relisted.data, error: null };
}

/**
 * Active-workspace context for signed-in users. One workspace = one client =
 * one platform, so a single active workspace drives every tenant-scoped read.
 * Resolved once on mount via bootstrapWorkspaces; the active id lives in React
 * state only (no localStorage, no hardcoding) and defaults to the first row.
 */
interface WorkspaceContextValue {
  workspaceId: string | null;
  workspaceName: string | null;
  /** The active workspace's short key (e.g. "GBL"), or null before it resolves. */
  workspaceKey: string | null;
  workspaces: WorkspaceRow[];
  loading: boolean;
  error: string | null;
  setActiveWorkspaceId: (id: string) => void;
  refreshWorkspaces: () => Promise<void>;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const { session } = useSession();
  const newTrace = useNewTrace();
  const [workspaces, setWorkspaces] = useState<WorkspaceRow[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Attempt the create-on-first-load once per mount; survives the repeated
  // onAuthStateChange that flips `session` to a new (but equivalent) object.
  const bootstrapGuard = useRef(false);

  useEffect(() => {
    if (!session) return;
    let active = true;
    setLoading(true);
    setError(null);

    bootstrapWorkspaces(supabase, session, bootstrapGuard, newTrace)
      .then((res) => {
        if (!active) return;
        if (res.error !== null) {
          setError(res.error);
          setWorkspaces([]);
          setActiveId(null);
        } else {
          setWorkspaces(res.workspaces);
          // Default to the first row (the freshly created one when bootstrapped),
          // keeping any prior selection still present in the refreshed list.
          setActiveId((prev) =>
            prev !== null && res.workspaces.some((w) => w.id === prev)
              ? prev
              : (res.workspaces[0]?.id ?? null),
          );
        }
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (!active) return;
        logger.error('workspace bootstrap failed', { error: String(err) });
        setError(String(err));
        setWorkspaces([]);
        setActiveId(null);
        setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [session, newTrace]);

  const setActiveWorkspaceId = useCallback((id: string) => {
    setActiveId(id);
  }, []);

  // Re-run the same list bootstrap on demand (e.g. after a workspace is created
  // elsewhere), reusing the active-id default behavior: keep the current
  // selection if it still exists, otherwise fall back to the first row.
  const refreshWorkspaces = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    setError(null);
    try {
      const res = await bootstrapWorkspaces(supabase, session, bootstrapGuard, newTrace);
      if (res.error !== null) {
        setError(res.error);
        setWorkspaces([]);
        setActiveId(null);
      } else {
        setWorkspaces(res.workspaces);
        setActiveId((prev) =>
          prev !== null && res.workspaces.some((w) => w.id === prev)
            ? prev
            : (res.workspaces[0]?.id ?? null),
        );
      }
    } catch (err: unknown) {
      logger.error('workspace refresh failed', { error: String(err) });
      setError(String(err));
      setWorkspaces([]);
      setActiveId(null);
    } finally {
      setLoading(false);
    }
  }, [session, newTrace]);

  const activeWorkspace = useMemo(
    () => workspaces.find((w) => w.id === activeId) ?? null,
    [workspaces, activeId],
  );

  const value = useMemo<WorkspaceContextValue>(
    () => ({
      workspaceId: activeWorkspace?.id ?? null,
      workspaceName: activeWorkspace?.name ?? null,
      workspaceKey: activeWorkspace?.key ?? null,
      workspaces,
      loading,
      error,
      setActiveWorkspaceId,
      refreshWorkspaces,
    }),
    [activeWorkspace, workspaces, loading, error, setActiveWorkspaceId, refreshWorkspaces],
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
