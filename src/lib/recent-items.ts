// Recently opened items for the command palette's empty state. Device only:
// one localStorage key per user and workspace, holding {type, id, openedAt}
// plus a cached title and target, and nothing else (no content). Opens are
// recorded from one place, the shell's route-change hook (AppLayout), which
// reads the route with recentFromRoute. Titles are warmed off the paint path:
// after a record, one debounced idle read (one batched .in() per type) fills
// every uncached title, so the palette paints Recent from storage on its first
// frame. Once per session per workspace the palette re-reads every title in
// idle time; anything no longer returned (deleted, or no access) drops.
//
// Every storage read and write is wrapped: with storage blocked nothing is
// stored and the palette simply shows no recents. The list is cleared on
// sign-out and when a different user signs in on this device.

import { useEffect, useRef } from 'react';
import type { Client } from '@srtdio/rpc';
import { abortable, readMentionProfiles } from '@/lib/chat-reads';
import { isNotesChannelId, notesChannelId } from '@/lib/chat/notes';
import { resolveEntityRef } from '@/lib/entity-resolve';
import { entityUrlPath, parseEntityRef } from '@/lib/entityRef';
import { SIGNOUT_EVENT } from '@/lib/events';
import { generateTraceId } from '@/lib/trace';
import { chatMessageHref, chatTaskHref, planHref } from '@/lib/inbox/bell-types';

export type RecentType = 'post' | 'brief' | 'group' | 'plan' | 'file' | 'person' | 'task';

/** What is stored per open; title and target are the cache, absent until warmed. */
export interface RecentItem {
  type: RecentType;
  id: string;
  openedAt: number;
  title?: string;
  target?: RecentTarget;
}

/** Stored at most; the palette shows the newest RECENT_SHOWN. */
export const RECENT_MAX = 20;
export const RECENT_SHOWN = 8;

/** The type line under a recent's title. */
export const RECENT_TYPE_LABEL: Record<RecentType, string> = {
  post: 'Post',
  brief: 'Brief',
  group: 'Group',
  plan: 'Plan',
  file: 'File',
  person: 'Person',
  task: 'Task',
};

const KEY_PREFIX = 'sorted:recent:';

/** The storage key for one user in one workspace. Pure. */
export function recentKey(userId: string, workspaceId: string): string {
  return `${KEY_PREFIX}${userId}:${workspaceId}`;
}

/** The storage interface used here (localStorage, or a fake in tests). */
export type RecentStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;

/** localStorage, or null when the browser blocks it. */
export function deviceStorage(): RecentStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

const TYPES = new Set<string>(Object.keys(RECENT_TYPE_LABEL));

function isRecentTarget(value: unknown): value is RecentTarget {
  if (typeof value !== 'object' || value === null) return false;
  const { path, person } = value as Record<string, unknown>;
  return (
    (typeof path === 'string' && path.startsWith('/')) ||
    (typeof person === 'string' && person !== '')
  );
}

function isRecentItem(value: unknown): value is RecentItem {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.type === 'string' &&
    TYPES.has(v.type) &&
    typeof v.id === 'string' &&
    v.id !== '' &&
    typeof v.openedAt === 'number' &&
    (v.title === undefined || typeof v.title === 'string') &&
    (v.target === undefined || isRecentTarget(v.target))
  );
}

/** The one identity of a recent: type and id. Pure. */
export function recentItemKey(item: { type: RecentType; id: string }): string {
  return `${item.type}:${item.id}`;
}

/** Only the stored fields: a title and target are kept as a pair or not at all. */
function storedShape(item: RecentItem): RecentItem {
  const out: RecentItem = { type: item.type, id: item.id, openedAt: item.openedAt };
  if (item.title !== undefined && item.title !== '' && item.target !== undefined) {
    out.title = item.title;
    out.target =
      'path' in item.target ? { path: item.target.path } : { person: item.target.person };
  }
  return out;
}

/** True when a stored recent can paint without a read. Pure. */
export function hasCachedTitle(item: RecentItem): boolean {
  return item.title !== undefined && item.title !== '' && item.target !== undefined;
}

/** The cached recents as drawable entries, in order; uncached ones skipped. Pure. */
export function cachedEntries(items: readonly RecentItem[]): RecentEntry[] {
  const out: RecentEntry[] = [];
  for (const item of items) {
    if (item.title === undefined || item.title === '' || item.target === undefined) continue;
    out.push({ type: item.type, id: item.id, title: item.title, target: item.target });
  }
  return out;
}

/** The stored list, newest first, de-duplicated; [] on any failure. */
export function readRecents(
  storage: RecentStorage | null,
  userId: string | null,
  workspaceId: string | null,
): RecentItem[] {
  if (storage === null || userId === null || workspaceId === null) return [];
  try {
    const raw = storage.getItem(recentKey(userId, workspaceId));
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return dedupe(parsed.filter(isRecentItem));
  } catch {
    return [];
  }
}

function dedupe(items: readonly RecentItem[]): RecentItem[] {
  const seen = new Set<string>();
  const out: RecentItem[] = [];
  for (const item of [...items].sort((a, b) => b.openedAt - a.openedAt)) {
    const key = recentItemKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(storedShape(item));
  }
  return out.slice(0, RECENT_MAX);
}

function writeRecents(
  storage: RecentStorage,
  userId: string,
  workspaceId: string,
  items: readonly RecentItem[],
): void {
  try {
    storage.setItem(recentKey(userId, workspaceId), JSON.stringify(dedupe(items)));
  } catch {
    // Storage full or blocked: recents are a convenience, nothing to do.
  }
}

/** Record one open: moved to the front, de-duplicated, capped at RECENT_MAX. Never throws. */
export function recordRecent(
  storage: RecentStorage | null,
  userId: string | null,
  workspaceId: string | null,
  item: { type: RecentType; id: string },
  nowMs: number,
): void {
  if (storage === null || userId === null || workspaceId === null) return;
  const stored = readRecents(storage, userId, workspaceId);
  // A reopen keeps the cached title and target; the session refresh updates them.
  const prev = stored.find((s) => recentItemKey(s) === recentItemKey(item));
  writeRecents(storage, userId, workspaceId, [
    { ...prev, type: item.type, id: item.id, openedAt: nowMs },
    ...stored,
  ]);
}

/** Remove one recent (the row's X). Sync, storage only. Never throws. */
export function removeRecent(
  storage: RecentStorage | null,
  userId: string | null,
  workspaceId: string | null,
  item: { type: RecentType; id: string },
): void {
  removeRecents(storage, userId, workspaceId, [item]);
}

/**
 * Remove exactly the listed recents (Clear all's commit). An item given with
 * its openedAt is removed only while it was not opened again since, so anything
 * opened during the Undo window stays. Sync, storage only. Never throws.
 */
export function removeRecents(
  storage: RecentStorage | null,
  userId: string | null,
  workspaceId: string | null,
  items: ReadonlyArray<{ type: RecentType; id: string; openedAt?: number }>,
): void {
  if (storage === null || userId === null || workspaceId === null || items.length === 0) return;
  const gone = new Map(items.map((i) => [recentItemKey(i), i.openedAt]));
  const stored = readRecents(storage, userId, workspaceId);
  const next = stored.filter((s) => {
    if (!gone.has(recentItemKey(s))) return true;
    const at = gone.get(recentItemKey(s));
    return at !== undefined && s.openedAt > at;
  });
  if (next.length !== stored.length) writeRecents(storage, userId, workspaceId, next);
}

/**
 * Remove every stored recents list on this device, except `keepUserId`'s
 * (sign-out passes none; a user change passes the new user). Never throws.
 */
export function clearRecents(
  storage: RecentStorage | null,
  keepUserId: string | null = null,
): void {
  if (storage === null) return;
  try {
    const keys: string[] = [];
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (key !== null && key.startsWith(KEY_PREFIX)) keys.push(key);
    }
    const keep = keepUserId !== null ? `${KEY_PREFIX}${keepUserId}:` : null;
    for (const key of keys) {
      if (keep === null || !key.startsWith(keep)) storage.removeItem(key);
    }
  } catch {
    // Blocked storage holds nothing to clear.
  }
}

/** What a route opens: an item by id, or a post/brief by its number (resolved by the caller). */
type RouteOpen =
  | { type: RecentType; id: string }
  | { type: 'post' | 'brief'; number: number }
  | null;

/**
 * The item a route shows, for recording: /posts/:id, /p/:ref (this workspace's
 * key), /briefs/:id, /b/:ref, /plans/:id, /assets?asset=, and /chat?channel=
 * (a group, a DM's other person, my notes as me, or &task= a task). Pure.
 */
export function recentFromRoute(
  pathname: string,
  search: string,
  ctx: { workspaceId: string; workspaceKey: string | null; userId: string },
): RouteOpen {
  const params = new URLSearchParams(search);
  const parts = pathname.split('/').filter((p) => p !== '');
  const [head, tail] = parts;
  if (parts.length === 2 && tail !== undefined) {
    const id = decodeURIComponent(tail);
    if (head === 'posts') return { type: 'post', id };
    if (head === 'briefs') return { type: 'brief', id };
    if (head === 'plans') return { type: 'plan', id };
    if (head === 'p' || head === 'b') {
      const ref = parseEntityRef(id);
      if (ref === null || ctx.workspaceKey === null) return null;
      if (ref.key !== ctx.workspaceKey.toUpperCase()) return null;
      return { type: head === 'p' ? 'post' : 'brief', number: ref.number };
    }
    return null;
  }
  if (parts.length === 1 && head === 'assets') {
    const asset = params.get('asset');
    return asset !== null && asset !== '' ? { type: 'file', id: asset } : null;
  }
  if (parts.length === 1 && head === 'chat') {
    const channel = params.get('channel');
    if (channel === null || channel === '') return null;
    const task = params.get('task');
    if (task !== null && task !== '') return { type: 'task', id: task };
    if (isNotesChannelId(channel)) {
      return channel === notesChannelId(ctx.workspaceId, ctx.userId)
        ? { type: 'person', id: ctx.userId }
        : null;
    }
    const [kind, ws, a, b] = channel.split('__');
    if (ws !== ctx.workspaceId) return null;
    if (kind === 'group' && a !== undefined && b === undefined) return { type: 'group', id: a };
    if (kind === 'dm' && a !== undefined && b !== undefined) {
      if (a === ctx.userId) return { type: 'person', id: b };
      if (b === ctx.userId) return { type: 'person', id: a };
    }
    return null;
  }
  return null;
}

/**
 * Record a route's open: an id route at once; a /p/ or /b/ short link once
 * its number resolves (one ref_resolve rpc on this workspace's key, which the
 * caller already holds in memory). Never throws.
 */
export async function recordRouteOpen(params: {
  client: Client;
  storage: RecentStorage | null;
  pathname: string;
  search: string;
  workspaceId: string;
  workspaceKey: string | null;
  userId: string;
  nowMs: number;
  /** The open's trace id, sent as p_trace_id; a fresh uuid_v7 when absent. */
  traceId?: string;
}): Promise<void> {
  const open = recentFromRoute(params.pathname, params.search, params);
  if (open === null) return;
  if ('id' in open) {
    recordRecent(params.storage, params.userId, params.workspaceId, open, params.nowMs);
    return;
  }
  // recentFromRoute only returns a number for this workspace's own key.
  if (params.workspaceKey === null) return;
  try {
    const res = await resolveEntityRef(params.client, {
      traceId: params.traceId ?? generateTraceId(),
      workspaceKey: params.workspaceKey.toUpperCase(),
      kind: open.type,
      number: open.number,
    });
    if (!res.ok || res.data.entityId === null) return;
    // The key names this workspace (recentFromRoute checked); a different id
    // back means the key moved, so the open is not recorded here.
    if (res.data.workspaceId !== params.workspaceId) return;
    recordRecent(
      params.storage,
      params.userId,
      params.workspaceId,
      { type: open.type, id: res.data.entityId },
      params.nowMs,
    );
  } catch {
    // An unresolved link is simply not recorded.
  }
}

/**
 * The shell's one recording point (AppLayout): every route change records
 * what it opened, for this user in this workspace. Also clears every list on
 * sign-out, and the other users' lists when the signed-in user changes.
 */
export function useRecentRecorder(params: {
  client: Client;
  pathname: string;
  search: string;
  workspaceId: string | null;
  workspaceKey: string | null;
  userId: string | null;
  paused: boolean;
}): void {
  const { client, pathname, search, workspaceId, workspaceKey, userId, paused } = params;
  const lastUser = useRef<string | null>(null);
  const warmer = useRef<TitleWarmer | null>(null);

  // One warmer per user and workspace; a switch or unmount aborts its read.
  useEffect(() => {
    if (workspaceId === null || userId === null) return;
    const w = createTitleWarmer({ client, workspaceId, workspaceKey, userId });
    warmer.current = w;
    return () => {
      w.dispose();
      if (warmer.current === w) warmer.current = null;
    };
  }, [client, workspaceId, workspaceKey, userId]);

  useEffect(() => {
    if (userId === null || lastUser.current === userId) return;
    if (lastUser.current !== null) clearRecents(deviceStorage(), userId);
    lastUser.current = userId;
  }, [userId]);

  useEffect(() => {
    const onSignout = (): void => clearRecents(deviceStorage());
    window.addEventListener(SIGNOUT_EVENT, onSignout);
    return () => window.removeEventListener(SIGNOUT_EVENT, onSignout);
  }, []);

  useEffect(() => {
    if (paused || workspaceId === null || userId === null) return;
    // Recording is sync for id routes; the title warm-up is debounced into
    // idle time, so neither blocks navigation or paint.
    void recordRouteOpen({
      client,
      storage: deviceStorage(),
      pathname,
      search,
      workspaceId,
      workspaceKey,
      userId,
      nowMs: Date.now(),
    }).then(() => warmer.current?.schedule());
  }, [client, pathname, search, workspaceId, workspaceKey, userId, paused]);
}

/** A group's chat channel id (the server's group__{workspace}__{group} form). Pure. */
function groupChannelId(workspaceId: string, groupId: string): string {
  return `group__${workspaceId}__${groupId}`;
}

/** Where a recent opens: a path, or a person (their DM, or my notes). */
export type RecentTarget = { path: string } | { person: string };

/** One recent with its title, ready to draw. */
export interface RecentEntry {
  type: RecentType;
  id: string;
  title: string;
  target: RecentTarget;
}

type Row = Record<string, unknown>;

function str(row: Row, key: string): string {
  const v = row[key];
  return typeof v === 'string' ? v : '';
}

function num(row: Row, key: string): number | null {
  const v = row[key];
  return typeof v === 'number' ? v : null;
}

/** A read's rows; null when the read failed (so nothing is dropped for it). */
async function readRows(
  query: PromiseLike<{ data: unknown; error: { message: string } | null }>,
  signal?: AbortSignal,
): Promise<Row[] | null> {
  try {
    const res = await abortable(query, signal);
    if (res.error) return null;
    return Array.isArray(res.data) ? (res.data as Row[]) : [];
  } catch {
    return null;
  }
}

/** One batched title read: each item's title and target, and the types whose read failed. */
export interface RecentTitles {
  found: Map<string, { title: string; target: RecentTarget }>;
  failed: Set<RecentType>;
}

/**
 * The titles of the given recents: one batched .in() read per type present,
 * all in parallel (never one per item). An item a read does not return
 * (deleted, or no access) is absent from `found`; a failed read lists its type
 * in `failed`.
 */
export async function readRecentTitles(params: {
  client: Client;
  workspaceId: string;
  workspaceKey: string | null;
  userId: string;
  items: ReadonlyArray<{ type: RecentType; id: string }>;
  signal?: AbortSignal;
}): Promise<RecentTitles> {
  const { client, workspaceId, signal, items } = params;
  const idsOf = (type: RecentType): string[] => [
    ...new Set(items.filter((i) => i.type === type).map((i) => i.id)),
  ];
  const found = new Map<string, { title: string; target: RecentTarget }>();
  const failed = new Set<RecentType>();
  const put = (type: RecentType, id: string, title: string, target: RecentTarget): void => {
    if (title !== '') found.set(recentItemKey({ type, id }), { title, target });
  };
  const entityPath = (kind: 'post' | 'brief', row: Row): string => {
    const n = num(row, 'number');
    if (params.workspaceKey !== null && n !== null) {
      return entityUrlPath(kind, params.workspaceKey, n);
    }
    return `/${kind === 'post' ? 'posts' : 'briefs'}/${str(row, 'id')}`;
  };
  // The title, never a KEY-N code; an untitled row reads "Untitled post/brief".
  const entityTitle = (kind: 'post' | 'brief', row: Row): string => {
    const title = str(row, 'title').trim();
    return title !== '' ? title : `Untitled ${kind}`;
  };

  const reads: Promise<void>[] = [];
  const when = (type: RecentType, run: (ids: string[]) => Promise<Row[] | null>): void => {
    const ids = idsOf(type);
    if (ids.length > 0) {
      reads.push(
        run(ids).then((rows) => {
          if (rows === null) failed.add(type);
        }),
      );
    }
  };
  when('post', async (ids) => {
    const rows = await readRows(
      client
        .from('posts')
        .select('id, title, number')
        .eq('workspace_id', workspaceId)
        .is('deleted_at', null)
        .in('id', ids),
      signal,
    );
    for (const r of rows ?? [])
      put('post', str(r, 'id'), entityTitle('post', r), { path: entityPath('post', r) });
    return rows;
  });
  when('brief', async (ids) => {
    const rows = await readRows(
      client
        .from('briefs')
        .select('id, title, number')
        .eq('workspace_id', workspaceId)
        .is('deleted_at', null)
        .in('id', ids),
      signal,
    );
    for (const r of rows ?? []) {
      put('brief', str(r, 'id'), entityTitle('brief', r), { path: entityPath('brief', r) });
    }
    return rows;
  });
  when('plan', async (ids) => {
    const rows = await readRows(
      client
        .from('plans')
        .select('id, title')
        .eq('workspace_id', workspaceId)
        .is('deleted_at', null)
        .in('id', ids),
      signal,
    );
    for (const r of rows ?? []) {
      put('plan', str(r, 'id'), str(r, 'title'), { path: planHref(str(r, 'id'), null) });
    }
    return rows;
  });
  when('file', async (ids) => {
    const rows = await readRows(
      client
        .from('assets')
        .select('id, display_name, filename')
        .eq('workspace_id', workspaceId)
        .is('deleted_at', null)
        .in('id', ids),
      signal,
    );
    for (const r of rows ?? []) {
      const id = str(r, 'id');
      const name = str(r, 'display_name') !== '' ? str(r, 'display_name') : str(r, 'filename');
      put('file', id, name, { path: `/assets?asset=${encodeURIComponent(id)}` });
    }
    return rows;
  });
  when('group', async (ids) => {
    const rows = await readRows(
      client
        .from('groups')
        .select('id, name')
        .eq('workspace_id', workspaceId)
        .is('deleted_at', null)
        .in('id', ids),
      signal,
    );
    for (const r of rows ?? []) {
      const id = str(r, 'id');
      put('group', id, str(r, 'name'), {
        path: chatMessageHref(groupChannelId(workspaceId, id), null),
      });
    }
    return rows;
  });
  when('task', async (ids) => {
    const rows = await readRows(
      client
        .from('chat_tasks')
        .select('id, title, channel_id')
        .eq('workspace_id', workspaceId)
        .in('id', ids),
      signal,
    );
    for (const r of rows ?? []) {
      const id = str(r, 'id');
      put('task', id, str(r, 'title'), { path: chatTaskHref(str(r, 'channel_id'), id) });
    }
    return rows;
  });
  when('person', async (ids) => {
    const res = await readMentionProfiles(client, {
      workspaceId,
      userIds: ids,
      ...(signal !== undefined ? { signal } : {}),
    }).catch(() => null);
    if (res === null || !res.ok) return null;
    for (const p of res.data) {
      // Only current members (and me): a person who left drops.
      if (p.userId !== params.userId && p.member !== true) continue;
      put('person', p.userId, p.displayName, { person: p.userId });
    }
    return [];
  });
  await Promise.all(reads);
  return { found, failed };
}

/**
 * The newest RECENT_SHOWN recents with their titles, read fresh (one batched
 * read per type). An item a read does not return (deleted, no access, or the
 * read failed) is dropped silently.
 */
export async function loadRecentEntries(params: {
  client: Client;
  workspaceId: string;
  workspaceKey: string | null;
  userId: string;
  items: readonly RecentItem[];
  signal?: AbortSignal;
}): Promise<RecentEntry[]> {
  const items = params.items.slice(0, RECENT_SHOWN);
  const { found } = await readRecentTitles({ ...params, items });
  const out: RecentEntry[] = [];
  for (const item of items) {
    const hit = found.get(recentItemKey(item));
    if (hit === undefined) continue;
    out.push({ type: item.type, id: item.id, title: hit.title, target: hit.target });
  }
  return out;
}

/**
 * Write a title read back into storage: each returned item gets its title and
 * target; with `drop`, an item that was read, whose type's read succeeded and
 * that came back missing (deleted, or no access) is removed. Items recorded
 * after the read started are left alone. Sync. Never throws.
 */
export function writeRecentTitles(
  storage: RecentStorage | null,
  userId: string,
  workspaceId: string,
  read: ReadonlyArray<{ type: RecentType; id: string }>,
  titles: RecentTitles,
  drop: boolean,
): void {
  if (storage === null) return;
  const asked = new Set(read.map(recentItemKey));
  const next: RecentItem[] = [];
  for (const item of readRecents(storage, userId, workspaceId)) {
    const key = recentItemKey(item);
    const hit = titles.found.get(key);
    if (hit !== undefined) {
      next.push({ ...item, title: hit.title, target: hit.target });
    } else if (drop && asked.has(key) && !titles.failed.has(item.type)) {
      continue;
    } else {
      next.push(item);
    }
  }
  writeRecents(storage, userId, workspaceId, next);
}

/** Debounce before the warm-up read: a burst of route changes becomes one read. */
export const WARM_DEBOUNCE_MS = 1500;

/** Run in idle time (requestIdleCallback, or a timeout where it is missing); returns a cancel. */
export function whenIdle(run: () => void): () => void {
  const w = typeof window === 'undefined' ? undefined : window;
  if (w !== undefined && typeof w.requestIdleCallback === 'function') {
    const id = w.requestIdleCallback(run, { timeout: WARM_DEBOUNCE_MS });
    return () => w.cancelIdleCallback(id);
  }
  const id = setTimeout(run, 0);
  return () => clearTimeout(id);
}

export interface TitleWarmer {
  /** Ask for a warm-up: debounced, then one batched read for every uncached item. */
  schedule: () => void;
  /** Cancel a pending warm-up and abort one in flight. */
  dispose: () => void;
}

/**
 * The recorder's title warm-up: after a record, wait WARM_DEBOUNCE_MS (each
 * new record restarts the wait), then in idle time read the titles of every
 * stored item that has none, one batched .in() per type present, and write
 * them into storage. Never one read per item; never on the paint path.
 */
export function createTitleWarmer(params: {
  client: Client;
  workspaceId: string;
  workspaceKey: string | null;
  userId: string;
  storage?: () => RecentStorage | null;
  idle?: (run: () => void) => () => void;
}): TitleWarmer {
  const storageOf = params.storage ?? deviceStorage;
  const idle = params.idle ?? whenIdle;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let cancelIdle: (() => void) | null = null;
  let controller: AbortController | null = null;
  let disposed = false;

  const run = (): void => {
    cancelIdle = null;
    const storage = storageOf();
    const uncached = readRecents(storage, params.userId, params.workspaceId).filter(
      (i) => !hasCachedTitle(i),
    );
    if (uncached.length === 0 || controller !== null) return;
    const c = new AbortController();
    controller = c;
    void readRecentTitles({ ...params, items: uncached, signal: c.signal })
      .then((titles) => {
        if (c.signal.aborted || disposed) return;
        writeRecentTitles(storage, params.userId, params.workspaceId, uncached, titles, false);
      })
      .finally(() => {
        if (controller === c) controller = null;
      });
  };

  return {
    schedule: () => {
      if (disposed) return;
      const uncached = readRecents(storageOf(), params.userId, params.workspaceId).some(
        (i) => !hasCachedTitle(i),
      );
      if (!uncached) return;
      if (timer !== null) clearTimeout(timer);
      cancelIdle?.();
      cancelIdle = null;
      timer = setTimeout(() => {
        timer = null;
        cancelIdle = idle(run);
      }, WARM_DEBOUNCE_MS);
    },
    dispose: () => {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      cancelIdle?.();
      controller?.abort();
    },
  };
}

// Users and workspaces whose titles were refreshed in this page session.
const refreshed = new Set<string>();

/** True once this session refreshed this user's titles in this workspace. */
export function recentsRefreshed(userId: string, workspaceId: string): boolean {
  return refreshed.has(recentKey(userId, workspaceId));
}

/** For tests: forget which sessions refreshed. */
export function resetRecentsRefresh(): void {
  refreshed.clear();
}

/**
 * The palette's freshness pass, at most once per page session per user and
 * workspace: re-read every stored item's title (one batched read per type) and
 * write the result into storage; anything no longer returned drops. Storage
 * only: rows on screen are never repainted, changes show on the next open. An
 * aborted pass does not count, so the next open tries again.
 */
export async function refreshRecentTitles(params: {
  client: Client;
  storage: RecentStorage | null;
  workspaceId: string;
  workspaceKey: string | null;
  userId: string;
  signal?: AbortSignal;
}): Promise<void> {
  const key = recentKey(params.userId, params.workspaceId);
  if (refreshed.has(key)) return;
  const items = readRecents(params.storage, params.userId, params.workspaceId);
  if (items.length === 0) return;
  refreshed.add(key);
  const titles = await readRecentTitles({ ...params, items });
  if (params.signal?.aborted === true) {
    refreshed.delete(key);
    return;
  }
  writeRecentTitles(params.storage, params.userId, params.workspaceId, items, titles, true);
}
