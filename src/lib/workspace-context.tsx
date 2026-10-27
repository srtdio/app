import { mark } from '@/lib/perf-marks';
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
import {
  dropWorkspaceReads,
  onSessionReadsHydrated,
  peekKept,
  primeRead,
  readKey,
  retainWorkspaceReads,
} from '@/lib/session-read';
import { dispatchInductionRefresh } from '@/lib/induction';
import { finishInduction } from '@/components/induction/induction-data';
import { onWake } from '@/lib/wake-read';

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
export const WORKSPACE_LIMIT_MESSAGE =
  'On the free plan you can own one workspace. Need another? Talk to us.';

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

interface BootstrapResult {
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
  mark('ws:list:start');
  const listed = await listWorkspaces(client);
  mark('ws:list:end');
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
 * The active id after a re-list: the current one while it is still listed,
 * otherwise the first remaining row (null: none left, the create form).
 */
export function nextActiveId(prev: string | null, rows: readonly WorkspaceRow[]): string | null {
  return prev !== null && rows.some((w) => w.id === prev) ? prev : (rows[0]?.id ?? null);
}

/** The user-level session-read key of the workspace list (saved on the device). */
export function workspacesReadKey(userId: string): string {
  return readKey(userId, '', 'shell:workspaces');
}

/** The workspace list this device saved for `userId`, when it has rows. Never reads. */
export function cachedWorkspaces(userId: string | null): WorkspaceRow[] | null {
  if (userId === null) return null;
  const rows = peekKept<WorkspaceRow[]>(workspacesReadKey(userId));
  return Array.isArray(rows) && rows.length > 0 ? rows : null;
}

/**
 * A fresh list landed: keep it for the next cold open and delete every saved
 * read of a workspace it no longer lists (removed or deleted).
 */
function keepFreshList(userId: string, rows: WorkspaceRow[]): void {
  primeRead(workspacesReadKey(userId), rows);
  retainWorkspaceReads(
    userId,
    rows.map((w) => w.id),
  );
}

/**
 * Induction is per user (user_private.induction_done_at), so stamping it done
 * once a workspace is deleted is what makes the create that follows skip it:
 * the person is not new. A failure is logged and the create then runs it.
 */
async function skipInductionAfterDelete(client: Client, traceId: string): Promise<void> {
  const res = await finishInduction(client, traceId);
  if (!res.ok) {
    logger.warn('induction skip after workspace delete failed', {
      error: res.error.message,
      trace_id: traceId,
    });
  }
  dispatchInductionRefresh();
}

/**
 * Active-workspace context for signed-in users. One workspace = one client =
 * one platform, so a single active workspace drives every tenant-scoped read.
 * Resolved once on mount via bootstrapWorkspaces; the active id lives in React
 * state only (no localStorage, no hardcoding) and defaults to the first row.
 * On a cold open the list this device saved (src/lib/device-cache.ts) paints
 * the shell at once (loaded, still loading); the fresh list replaces it.
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
   * Try again on the failed first list: re-runs the boot bootstrap in place
   * (no reload). A late answer from the failed attempt is dropped.
   */
  retryWorkspaces: () => void;
  /**
   * Merge a successful workspace_update into the cached row, without the
   * loading state a full refresh shows (that would remount the shell).
   */
  applyWorkspacePatch: (id: string, patch: WorkspacePatch) => void;
  /** True when the caller may not create another workspace (free plan, not exempt). */
  createBlocked: boolean;
  /**
   * The operator read above (isOperator), exposed as a plain boolean: true
   * only for an active platform_operators row. False while unread, so for
   * everyone else it never changes and never re-renders a consumer.
   */
  isPlatformOperator: boolean;
  /**
   * Set after the owner deletes a workspace: the create form shows the "is
   * gone" hint while it is, and the create that follows skips induction.
   */
  deletedWorkspace: { name: string } | null;
  clearDeletedWorkspace: () => void;
  /**
   * After a successful workspace_delete: skip induction for the next create,
   * drop the row (its chat connection closes with the active id), move to the
   * remaining workspace or none, and set deletedWorkspace.
   */
  workspaceDeleted: (id: string, name: string) => Promise<void>;
}

/**
 * The least time between two wake rechecks: focus and visibilitychange fire
 * together on a wake, and a fast answer must not let the second one re-read.
 */
export const RECHECK_GAP_MS = 2_000;

/** The workspace fields workspace_update may change. */
type WorkspacePatch = Partial<Pick<WorkspaceRow, 'name' | 'logo_url' | 'timezone'>>;

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const { session } = useSession();
  const newTrace = useNewTrace();
  const [workspaces, setWorkspaces] = useState<WorkspaceRow[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bumped by retryWorkspaces: re-runs the bootstrap effect for the same user.
  const [bootAttempt, setBootAttempt] = useState(0);
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
  const [deletedWorkspace, setDeletedWorkspace] = useState<{ name: string } | null>(null);
  // Read by the delete and the recheck below without keying their effects on them.
  const workspacesRef = useRef(workspaces);
  const activeIdRef = useRef(activeId);
  useEffect(() => {
    workspacesRef.current = workspaces;
    activeIdRef.current = activeId;
  }, [workspaces, activeId]);
  // The user whose saved list is shown while the fresh one loads (null: none).
  const [cacheFor, setCacheFor] = useState<string | null>(null);
  const cacheForRef = useRef(cacheFor);
  cacheForRef.current = cacheFor;
  const loadedRef = useRef(loaded);
  loadedRef.current = loaded;
  // The boot bootstrap still out (null: none): a wake recheck waits for it,
  // since its list is the fresh one.
  const bootRef = useRef<object | null>(null);

  // Paint from the device in the same render the user appears in: the shell
  // gate never shows a loader frame for a list this device already has.
  const [seededFor, setSeededFor] = useState<string | null>(null);
  if (userId === null && seededFor !== null) setSeededFor(null);
  if (userId !== null && seededFor !== userId) {
    setSeededFor(userId);
    const cached = cachedWorkspaces(userId);
    if (cached !== null) {
      mark('device-cache:workspaces');
      setWorkspaces(cached);
      setActiveId(nextActiveId(null, cached));
      setLoaded(true);
      setLoading(true);
      setCacheFor(userId);
    }
  }

  // Exemption from the one-workspace rule, read once per user under RLS.
  useEffect(() => {
    setIsOperator(null);
    if (userId === null) return;
    let active = true;
    readIsPlatformOperator(supabase, userId).then(
      (next) => {
        mark('operator:end');
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
    const fromCache = cacheForRef.current === userId;
    setLoading(true);
    if (!fromCache) setLoaded(false);
    setError(null);

    // The device cache seeded after the first render (a slow hydrate): paint
    // its list if the fresh one has not landed yet.
    const offHydrated = onSessionReadsHydrated(() => {
      if (!active || loadedRef.current) return;
      const cached = cachedWorkspaces(userId);
      if (cached === null) return;
      mark('device-cache:workspaces');
      setWorkspaces(cached);
      setActiveId((prev) => nextActiveId(prev, cached));
      setLoaded(true);
      setCacheFor(userId);
    });

    const run = {};
    bootRef.current = run;
    const settled = (): void => {
      if (bootRef.current === run) bootRef.current = null;
    };
    bootstrapWorkspaces(supabase, current, bootstrapGuard, newTrace)
      .then((res) => {
        settled();
        if (!active) return;
        const shownFromCache = cacheForRef.current === userId;
        setCacheFor(null);
        if (res.error !== null && shownFromCache) {
          // The saved list is on screen: keep it, as a failed re-list does.
          logger.error('workspace bootstrap failed', { error: res.error });
        } else if (res.error !== null) {
          setError(res.error);
          setWorkspaces([]);
          setActiveId(null);
        } else {
          keepFreshList(userId, res.workspaces);
          setWorkspaces(res.workspaces);
          // Default to the first row (the freshly created one when bootstrapped),
          // keeping any prior selection still present in the refreshed list
          // (a saved workspace no longer listed moves to the next row).
          setActiveId((prev) => nextActiveId(prev, res.workspaces));
          setLoaded(true);
        }
        setLoading(false);
      })
      .catch((err: unknown) => {
        settled();
        if (!active) return;
        logger.error('workspace bootstrap failed', { error: String(err) });
        const shownFromCache = cacheForRef.current === userId;
        setCacheFor(null);
        if (!shownFromCache) {
          setError(String(err));
          setWorkspaces([]);
          setActiveId(null);
        }
        setLoading(false);
      });

    return () => {
      active = false;
      offHydrated();
    };
  }, [userId, newTrace, bootAttempt]);

  const retryWorkspaces = useCallback(() => setBootAttempt((n) => n + 1), []);

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
        keepFreshList(current.user.id, res.workspaces);
        setWorkspaces(res.workspaces);
        setActiveId((prev) => nextActiveId(prev, res.workspaces));
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

  const applyWorkspacePatch = useCallback(
    (id: string, patch: WorkspacePatch) => {
      setWorkspaces((rows) => {
        const next = rows.map((row) => (row.id === id ? { ...row, ...patch } : row));
        // Own writes update the saved list too.
        if (userId !== null) primeRead(workspacesReadKey(userId), next);
        return next;
      });
    },
    [userId],
  );

  const clearDeletedWorkspace = useCallback(() => setDeletedWorkspace(null), []);

  const workspaceDeleted = useCallback(
    async (id: string, name: string) => {
      await skipInductionAfterDelete(supabase, newTrace());
      if (userId !== null) dropWorkspaceReads(userId, id);
      const remaining = workspacesRef.current.filter((row) => row.id !== id);
      if (userId !== null) primeRead(workspacesReadKey(userId), remaining);
      setWorkspaces(remaining);
      setActiveId((prev) => nextActiveId(prev === id ? null : prev, remaining));
      setDeletedWorkspace({ name });
    },
    [newTrace, userId],
  );

  // Another member deleted the active workspace (or removed this member): RLS
  // stops listing it, and its kept session reads are deleted. Re-list
  // quietly when the tab comes back and move to the remaining workspace (or
  // none, the create form). No loading state and no error: a failed read keeps
  // what is shown. One read per wake: focus and visibilitychange share one
  // handler, a recheck still out (or one started under RECHECK_GAP_MS ago)
  // skips, and so does a wake while the boot bootstrap is still out.
  useEffect(() => {
    if (!loaded) return;
    let active = true;
    const recheck = (): Promise<void> | undefined => {
      const current = activeIdRef.current;
      if (current === null) return undefined;
      mark('workspace:recheck');
      return listWorkspaces(supabase).then(
        (res) => {
          if (!active || !res.ok) return;
          if (userId !== null) keepFreshList(userId, res.data);
          if (res.data.some((w) => w.id === current)) return;
          if (userId !== null) dropWorkspaceReads(userId, current);
          setWorkspaces(res.data);
          setActiveId((prev) => nextActiveId(prev === current ? null : prev, res.data));
        },
        (err: unknown) => logger.warn('workspace recheck failed', { error: String(err) }),
      );
    };
    const off = onWake(recheck, {
      minGapMs: RECHECK_GAP_MS,
      blocked: () => bootRef.current !== null,
    });
    return () => {
      active = false;
      off();
    };
  }, [loaded, userId]);

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

  // A boolean, not the tri-state: null -> false (every non-operator) changes nothing.
  const isPlatformOperator = isOperator === true;

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
      retryWorkspaces,
      applyWorkspacePatch,
      createBlocked,
      isPlatformOperator,
      deletedWorkspace,
      clearDeletedWorkspace,
      workspaceDeleted,
    }),
    [
      activeWorkspace,
      workspaces,
      loading,
      loaded,
      error,
      setActiveWorkspaceId,
      refreshWorkspaces,
      retryWorkspaces,
      applyWorkspacePatch,
      createBlocked,
      isPlatformOperator,
      deletedWorkspace,
      clearDeletedWorkspace,
      workspaceDeleted,
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
