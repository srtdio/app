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
import { platformLabel } from '@srtdio/posts';
import { supabase } from '@/lib/supabase';
import { useSession } from '@/lib/session-context';
import { useNewTrace } from '@/lib/trace-context';
import { getCurrentTraceId } from '@/lib/trace';
import { logger } from '@/lib/logger';
import { primeWorkspacePlatforms } from '@/lib/workspace-context-platform';

/** A workspace row, as returned by the RLS-scoped listWorkspaces select. */
export type WorkspaceRow = Database['public']['Tables']['workspaces']['Row'];

/**
 * The one display form of a workspace: "<Brand> - <Platform>". workspaces.name
 * holds the brand name only and the platform is fixed at creation, so the
 * suffix is composed here and never stored. Every surface that shows a
 * workspace name goes through this. Throws on an unknown platform.
 */
export function workspaceDisplayName(row: Pick<WorkspaceRow, 'name' | 'platform'>): string {
  return `${row.name} - ${platformLabel(row.platform)}`;
}

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
function workspaceNameFromMetadata(session: Session): string | null {
  return metadataString(session, 'workspace_name');
}

/** The free-plan rule, shown on the create form. No upgrade path yet. */
export const WORKSPACE_LIMIT_MESSAGE = 'On the free plan you can own one workspace.';

/**
 * Whether a workspace_create failure is the one-workspace-per-owner rule. The
 * workspaces_owner_limit trigger raises 'workspace_limit_reached'; PostgREST
 * passes the raised text through as the error message.
 */
export function isWorkspaceLimitError(message: string): boolean {
  return message.includes('workspace_limit_reached');
}

/** The create form's message for a workspace_create failure. */
export function workspaceCreateErrorMessage(message: string): string {
  return isWorkspaceLimitError(message) ? WORKSPACE_LIMIT_MESSAGE : message;
}

/** The caller's active (not deleted) workspaces that they own. */
export function ownedActiveCount(rows: readonly WorkspaceRow[], userId: string | null): number {
  if (userId === null) return 0;
  return rows.filter((w) => w.owner_user_id === userId && w.deleted_at === null).length;
}

/**
 * Whether the create form starts disabled with {@link WORKSPACE_LIMIT_MESSAGE}:
 * the caller already owns an active workspace and is not an active platform
 * operator. Exemption comes only from platform_operators; an unknown or failed
 * read is not exempt (the workspaces_owner_limit trigger still decides on
 * submit).
 */
export function workspaceCreateBlocked(input: {
  rows: readonly WorkspaceRow[];
  userId: string | null;
  isOperator: boolean | null;
}): boolean {
  if (ownedActiveCount(input.rows, input.userId) === 0) return false;
  return input.isOperator !== true;
}

/**
 * The caller's own active platform_operators row under RLS
 * (platform_operators_select_self). Any failure reads as not an operator.
 */
export async function readIsPlatformOperator(client: Client, userId: string): Promise<boolean> {
  const res = await client
    .from('platform_operators')
    .select('user_id')
    .eq('user_id', userId)
    .is('revoked_at', null)
    .maybeSingle();
  if (res.error) {
    logger.warn('operator read failed', { error: res.error.message });
    return false;
  }
  return res.data !== null;
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
  if (!created.ok) {
    // Already owns one: stop quietly and land in the workspace they have.
    if (isWorkspaceLimitError(created.error.message)) {
      const existing = await listWorkspaces(client);
      return { workspaces: existing.ok ? existing.data : [], error: null };
    }
    return { workspaces: [], error: created.error.message };
  }

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
  /** The active workspace's brand name (workspaces.name), unsuffixed. */
  workspaceName: string | null;
  /** The active workspace as shown everywhere: "<Brand> - <Platform>". */
  workspaceDisplayName: string | null;
  /** The active workspace's short key (e.g. "GBL"), or null before it resolves. */
  workspaceKey: string | null;
  workspaces: WorkspaceRow[];
  loading: boolean;
  /**
   * True once a workspace list has loaded for the current user. Before that,
   * `loading` is the initial load (the shell shows its full-screen state);
   * after it, a re-list keeps the shell mounted.
   */
  loaded: boolean;
  error: string | null;
  setActiveWorkspaceId: (id: string) => void;
  refreshWorkspaces: () => Promise<void>;
  /**
   * Merge a successful workspace_update into the cached row, without the
   * loading state a full refresh shows (that would remount the shell).
   */
  applyWorkspacePatch: (id: string, patch: WorkspacePatch) => void;
  /** True when the caller may not create another workspace (free plan, not exempt). */
  createBlocked: boolean;
}

/** The workspace fields workspace_update may change. */
export type WorkspacePatch = Partial<Pick<WorkspaceRow, 'name' | 'logo_url' | 'timezone'>>;

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const { session } = useSession();
  const newTrace = useNewTrace();
  const [workspaces, setWorkspaces] = useState<WorkspaceRow[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Attempt the create-on-first-load once per mount; survives the repeated
  // onAuthStateChange that flips `session` to a new (but equivalent) object.
  const bootstrapGuard = useRef(false);
  const userId = session?.user.id ?? null;
  // The latest session, read by the bootstrap without keying on it: a token
  // refresh for the same user hands over a new session object, which must not
  // re-list workspaces (that remounted the whole shell on tab focus).
  const sessionRef = useRef(session);
  useEffect(() => {
    sessionRef.current = session;
  }, [session]);
  const [isOperator, setIsOperator] = useState<boolean | null>(null);

  // Exemption from the one-workspace rule, read once per user under RLS.
  useEffect(() => {
    setIsOperator(null);
    if (userId === null) return;
    let active = true;
    readIsPlatformOperator(supabase, userId).then(
      (next) => {
        if (active) setIsOperator(next);
      },
      (err: unknown) => {
        logger.warn('operator read failed', { error: String(err) });
        if (active) setIsOperator(false);
      },
    );
    return () => {
      active = false;
    };
  }, [userId]);

  // Keyed on the user id: a new user (or a sign-in after sign-out) re-runs the
  // full bootstrap; a token refresh for the same user does not.
  useEffect(() => {
    const current = sessionRef.current;
    if (userId === null || current === null) return;
    let active = true;
    setLoading(true);
    setLoaded(false);
    setError(null);

    bootstrapWorkspaces(supabase, current, bootstrapGuard, newTrace)
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
          setLoaded(true);
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
  }, [userId, newTrace]);

  const setActiveWorkspaceId = useCallback((id: string) => {
    setActiveId(id);
  }, []);

  // Re-run the same list bootstrap on demand (e.g. after a workspace is created
  // elsewhere), reusing the active-id default behavior: keep the current
  // selection if it still exists, otherwise fall back to the first row. Only
  // reachable from the loaded shell, so a failure keeps the rows already shown
  // and is logged; it never swaps the shell for the error screen.
  const refreshWorkspaces = useCallback(async () => {
    const current = sessionRef.current;
    if (!current) return;
    setLoading(true);
    try {
      const res = await bootstrapWorkspaces(supabase, current, bootstrapGuard, newTrace);
      if (res.error !== null) {
        logger.error('workspace refresh failed', {
          error: res.error,
          trace_id: getCurrentTraceId(),
        });
      } else {
        setWorkspaces(res.workspaces);
        setActiveId((prev) =>
          prev !== null && res.workspaces.some((w) => w.id === prev)
            ? prev
            : (res.workspaces[0]?.id ?? null),
        );
      }
    } catch (err: unknown) {
      logger.error('workspace refresh failed', {
        error: String(err),
        trace_id: getCurrentTraceId(),
      });
    } finally {
      setLoading(false);
    }
  }, [newTrace]);

  const applyWorkspacePatch = useCallback((id: string, patch: WorkspacePatch) => {
    setWorkspaces((rows) => rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  }, []);

  // The listed rows already carry each platform: seed the sheets' lookup.
  useEffect(() => {
    primeWorkspacePlatforms(workspaces);
  }, [workspaces]);

  const activeWorkspace = useMemo(
    () => workspaces.find((w) => w.id === activeId) ?? null,
    [workspaces, activeId],
  );

  const createBlocked = useMemo(
    () => workspaceCreateBlocked({ rows: workspaces, userId, isOperator }),
    [workspaces, userId, isOperator],
  );

  const value = useMemo<WorkspaceContextValue>(
    () => ({
      workspaceId: activeWorkspace?.id ?? null,
      workspaceName: activeWorkspace?.name ?? null,
      workspaceDisplayName: activeWorkspace ? workspaceDisplayName(activeWorkspace) : null,
      workspaceKey: activeWorkspace?.key ?? null,
      workspaces,
      loading,
      loaded,
      error,
      setActiveWorkspaceId,
      refreshWorkspaces,
      applyWorkspacePatch,
      createBlocked,
    }),
    [
      activeWorkspace,
      workspaces,
      loading,
      loaded,
      error,
      setActiveWorkspaceId,
      refreshWorkspaces,
      applyWorkspacePatch,
      createBlocked,
    ],
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
