// The workspace's members and their names, read ONCE per (user, workspace) and
// shared by every screen that needs them: the post owner picker, the brief
// detail, the Settings members panel, the chat member pickers and the comment
// @-mention picker; a chat open answers its names and mention picker rows from
// it while it is fresh (peekWorkspaceMembers, src/lib/chat/open-members.ts).
// The reads are exactly the ones those screens made on their
// own before: @srtdio/workspace's listMembers (RLS-scoped workspace_members
// select) and chat-reads' batched readProfiles over the distinct user ids. RLS
// stays the only boundary: nothing here widens a read, it only de-duplicates.
//
// Cache: a module-level Map keyed by `${userId}:${workspaceId}`, so one user's
// members are never served to another. N concurrent callers share one
// in-flight read. A failed load is not kept (the next mount retries). Signout
// clears everything; a workspace-data-changed event re-reads in the background;
// refetch() re-reads for every subscriber (the Members panel after a change).

import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { listMembers } from '@srtdio/workspace';
import type { Database } from '@srtdio/schemas';
import type { Result } from '@srtdio/rpc';
import { supabase } from '@/lib/supabase';
import { logger } from '@/lib/logger';
import { readProfiles } from '@/lib/chat-reads';
import type { ChatProfile } from '@/lib/chat-reads';
import { useSession } from '@/lib/session-context';
import { SIGNOUT_EVENT, WORKSPACE_DATA_CHANGED_EVENT } from '@/lib/events';
import { toMemberOptions, type MemberOption } from '@/components/chat/member-picker';

/** One membership row, exactly as listMembers returns it. */
export type WorkspaceMemberRow = Database['public']['Tables']['workspace_members']['Row'];

/** What the members read resolves to for one workspace. */
export interface WorkspaceMembersData {
  loading: boolean;
  /** The raw read error; callers that show fixed copy map it (withMembersLoadCopy). */
  error: string | null;
  /** Every membership row (active, pending, removed), in listMembers order. */
  rows: WorkspaceMemberRow[];
  /** Profiles for the distinct user ids of all rows. */
  profiles: Map<string, ChatProfile>;
  /** Active members as picker options, one per user, sorted by display name. */
  options: MemberOption[];
}

export interface WorkspaceMembersState extends WorkspaceMembersData {
  /** Re-read for every subscriber of this workspace. */
  refetch: () => void;
}

/** One selectable person in the mention picker (name + role + avatar). */
export interface MentionCandidate {
  id: string;
  name: string;
  /** Their @username; null when the person has none. */
  username: string | null;
  role: string;
  avatarUrl: string | null;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** The distinct user ids of the active members, in row order. */
export function activeMemberIds(
  rows: readonly Pick<WorkspaceMemberRow, 'user_id' | 'active'>[],
): string[] {
  const ids = new Set<string>();
  for (const row of rows) {
    if (row.active === true) ids.add(row.user_id);
  }
  return [...ids];
}

/** The distinct user ids of every row, in row order. */
function memberUserIds(rows: readonly Pick<WorkspaceMemberRow, 'user_id'>[]): string[] {
  return [...new Set(rows.map((row) => row.user_id))];
}

/**
 * The rows that are people in the workspace right now: active and not removed,
 * one per person (a person can have older removed or pending rows). Pure.
 */
export function currentMembers<
  T extends { user_id: string; active: boolean; removed_at: string | null },
>(rows: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const row of rows) {
    if (!row.active || row.removed_at !== null || seen.has(row.user_id)) continue;
    seen.add(row.user_id);
    out.push(row);
  }
  return out;
}

/** Active members as picker options: the profiles of the active ids, by name. */
function memberOptionsFrom(
  rows: readonly Pick<WorkspaceMemberRow, 'user_id' | 'active'>[],
  profiles: readonly ChatProfile[],
): MemberOption[] {
  const active = new Set(activeMemberIds(rows));
  return toMemberOptions(profiles.filter((p) => active.has(p.userId)));
}

/**
 * Current members as @-mention candidates, retaining role, sorted by name.
 * Removed people and invites never accepted are not mentionable.
 */
export function mentionCandidates(
  rows: readonly Pick<WorkspaceMemberRow, 'user_id' | 'active' | 'removed_at' | 'role'>[],
  profiles: ReadonlyMap<string, ChatProfile>,
): MentionCandidate[] {
  return currentMembers(rows)
    .map((row) => {
      const profile = profiles.get(row.user_id);
      return {
        id: row.user_id,
        name: profile?.displayName ?? '',
        username: profile?.username ?? null,
        role: row.role,
        avatarUrl: profile?.avatarUrl ?? null,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The chat pickers' members failure line; the raw error goes to the logger only. */
export const MEMBERS_LOAD_FAILED = "Couldn't load members. Try again.";

/** The same state with any raw error replaced by the fixed chat copy. */
export function withMembersLoadCopy<T extends { error: string | null }>(state: T): T {
  return state.error === null ? state : { ...state, error: MEMBERS_LOAD_FAILED };
}

/** The two reads, injected so the load is unit-tested without a client. */
interface MemberReaders {
  members: () => Promise<Result<WorkspaceMemberRow[]>>;
  profiles: (userIds: string[]) => ReturnType<typeof readProfiles>;
}

/** Read the members then their profiles. Never throws: a throw is an error state. */
export async function loadWorkspaceMembers(readers: MemberReaders): Promise<WorkspaceMembersData> {
  try {
    const members = await readers.members();
    if (!members.ok) {
      logger.warn('workspace members: load failed', { error: members.error.message });
      return { ...EMPTY_DATA, error: members.error.message };
    }
    const rows = members.data;
    const profiles = await readers.profiles(memberUserIds(rows));
    if (!profiles.ok) {
      logger.warn('workspace members: profiles load failed', { error: profiles.error.message });
      return { ...EMPTY_DATA, rows, error: profiles.error.message };
    }
    return {
      loading: false,
      error: null,
      rows,
      profiles: new Map(profiles.data.map((p) => [p.userId, p])),
      options: memberOptionsFrom(rows, profiles.data),
    };
  } catch (err: unknown) {
    logger.error('workspace members: load threw', { error: String(err) });
    return { ...EMPTY_DATA, error: String(err) };
  }
}

// ---------------------------------------------------------------------------
// Shared cache
// ---------------------------------------------------------------------------

const EMPTY_DATA: WorkspaceMembersData = {
  loading: false,
  error: null,
  rows: [],
  profiles: new Map(),
  options: [],
};

/** Nothing to read yet (no session or no workspace): nothing pending, no error. */
const IDLE: WorkspaceMembersData = EMPTY_DATA;

/** A key that has never resolved: loading, nothing to show. */
const LOADING: WorkspaceMembersData = { ...EMPTY_DATA, loading: true };

/** A served entry older than this re-reads in the background on the next mount. */
export const MEMBERS_STALE_MS = 60_000;

interface Entry {
  snapshot: WorkspaceMembersData;
  workspaceId: string;
  inflight: boolean;
  /** A refetch asked for while a read ran: one follow-up read after it. */
  queued: boolean;
  /** When the last successful read landed; null when none has (or it failed). */
  loadedAt: number | null;
}

const entries = new Map<string, Entry>();
const listeners = new Map<string, Set<() => void>>();
// Bumped on clear, so a read started before signout never lands afterwards.
let generation = 0;

function keyFor(userId: string, workspaceId: string): string {
  return `${userId}:${workspaceId}`;
}

function publish(key: string, entry: Entry, snapshot: WorkspaceMembersData): void {
  entry.snapshot = snapshot;
  for (const listener of listeners.get(key) ?? []) listener();
}

type LoadMode = 'initial' | 'refetch' | 'background';

function startRead(key: string, entry: Entry, mode: LoadMode): void {
  if (entry.inflight) {
    if (mode !== 'initial') entry.queued = true;
    return;
  }
  entry.inflight = true;
  if (mode === 'initial') publish(key, entry, LOADING);
  else if (mode === 'refetch')
    publish(key, entry, { ...entry.snapshot, loading: true, error: null });
  const started = generation;
  const { workspaceId } = entry;
  void loadWorkspaceMembers({
    members: () => listMembers(supabase, workspaceId),
    profiles: (userIds) => readProfiles(supabase, userIds),
  }).then((next) => {
    if (started !== generation || entries.get(key) !== entry) return;
    entry.inflight = false;
    if (entry.queued) {
      // A change landed while this read ran: its result may predate it.
      entry.queued = false;
      startRead(key, entry, entry.snapshot.loading ? 'refetch' : 'background');
      return;
    }
    entry.loadedAt = next.error === null ? Date.now() : null;
    // A background re-read that fails keeps the good list on screen; the next
    // mount retries (loadedAt stays null).
    const keepShown =
      mode === 'background' &&
      next.error !== null &&
      entry.snapshot.error === null &&
      entry.snapshot !== LOADING;
    if (!keepShown) publish(key, entry, next);
  });
}

function entryFor(userId: string, workspaceId: string): Entry {
  const key = keyFor(userId, workspaceId);
  let entry = entries.get(key);
  if (entry === undefined) {
    entry = {
      snapshot: LOADING,
      workspaceId,
      inflight: false,
      queued: false,
      loadedAt: null,
    };
    entries.set(key, entry);
  }
  return entry;
}

/** A mount: read unless a good, fresh entry is held or a read is running. */
export function ensureWorkspaceMembers(userId: string, workspaceId: string): void {
  const key = keyFor(userId, workspaceId);
  const entry = entryFor(userId, workspaceId);
  if (entry.inflight) return;
  if (entry.loadedAt === null) {
    // Never loaded, or the last load failed: failures are not cached.
    startRead(key, entry, 'initial');
    return;
  }
  if (Date.now() - entry.loadedAt > MEMBERS_STALE_MS) startRead(key, entry, 'background');
}

/**
 * The held members when a good read landed within MEMBERS_STALE_MS, else null.
 * Never reads: a caller that gets null reads on its own (and may warm the
 * cache with ensureWorkspaceMembers). The chat open answers its names and
 * picker rows from here, so a warm cache costs no request.
 */
export function peekWorkspaceMembers(
  userId: string,
  workspaceId: string,
  nowMs: number = Date.now(),
): WorkspaceMembersData | null {
  if (userId === '' || workspaceId === '') return null;
  const entry = entries.get(keyFor(userId, workspaceId));
  if (entry === undefined || entry.loadedAt === null) return null;
  if (nowMs - entry.loadedAt > MEMBERS_STALE_MS) return null;
  const snapshot = entry.snapshot;
  return snapshot.error === null && !snapshot.loading ? snapshot : null;
}

/** Re-read this workspace's members for every subscriber. */
function refetchWorkspaceMembers(userId: string, workspaceId: string): void {
  const key = keyFor(userId, workspaceId);
  startRead(key, entryFor(userId, workspaceId), 'refetch');
}

/** Drop every cached entry (signout; tests). Mounted readers re-read on next mount. */
export function resetWorkspaceMembersCache(): void {
  generation += 1;
  const keys = [...entries.keys()];
  entries.clear();
  for (const key of keys) {
    for (const listener of listeners.get(key) ?? []) listener();
  }
}

/** The workspace's rows changed: watched entries re-read, unwatched ones are dropped. */
function invalidateAll(): void {
  for (const [key, entry] of [...entries]) {
    if ((listeners.get(key)?.size ?? 0) > 0) {
      entry.loadedAt = null;
      // Background: the last list stays up until the new one lands.
      startRead(key, entry, 'background');
    } else {
      entries.delete(key);
    }
  }
}

function subscribeKey(key: string, listener: () => void): () => void {
  let set = listeners.get(key);
  if (set === undefined) {
    set = new Set();
    listeners.set(key, set);
  }
  set.add(listener);
  return () => {
    const current = listeners.get(key);
    if (current === undefined) return;
    current.delete(listener);
    if (current.size === 0) listeners.delete(key);
  };
}

function snapshotFor(key: string): WorkspaceMembersData {
  return entries.get(key)?.snapshot ?? LOADING;
}

if (typeof window !== 'undefined') {
  window.addEventListener(SIGNOUT_EVENT, resetWorkspaceMembersCache);
  window.addEventListener(WORKSPACE_DATA_CHANGED_EVENT, invalidateAll);
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

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

const NOOP_UNSUBSCRIBE = (): void => {};

/**
 * The workspace's members and names from the shared cache. No session or a
 * null / empty workspace id issues no read (filtering workspace_members by an
 * empty uuid is a guaranteed PostgREST 400) and returns the empty state.
 */
export function useWorkspaceMembers(workspaceId: string | null): WorkspaceMembersState {
  const userId = useSessionUserId();
  const key = userId !== null && userId !== '' && workspaceId ? keyFor(userId, workspaceId) : null;

  const subscribe = useCallback(
    (listener: () => void) => (key === null ? NOOP_UNSUBSCRIBE : subscribeKey(key, listener)),
    [key],
  );
  const getSnapshot = useCallback(() => (key === null ? IDLE : snapshotFor(key)), [key]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    if (key === null || userId === null || !workspaceId) return;
    ensureWorkspaceMembers(userId, workspaceId);
  }, [key, userId, workspaceId]);

  const refetch = useCallback(() => {
    if (key === null || userId === null || !workspaceId) return;
    refetchWorkspaceMembers(userId, workspaceId);
  }, [key, userId, workspaceId]);

  return useMemo(() => ({ ...snapshot, refetch }), [snapshot, refetch]);
}

interface MentionCandidatesState {
  candidates: MentionCandidate[];
  loading: boolean;
  error: string | null;
}

/** The workspace's current members as @-mention candidates; empty on a failed read. */
export function useMentionCandidates(workspaceId: string | null): MentionCandidatesState {
  const { rows, profiles, loading, error } = useWorkspaceMembers(workspaceId);
  const candidates = useMemo(
    () => (error === null ? mentionCandidates(rows, profiles) : []),
    [rows, profiles, error],
  );
  return { candidates, loading, error };
}
