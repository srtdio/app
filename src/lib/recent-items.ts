// Recently opened items for the command palette's empty state. Device only:
// one localStorage key per user and workspace, holding {type, id, openedAt}
// and nothing else (no titles, no content). Opens are recorded from one place,
// the shell's route-change hook (AppLayout), which reads the route with
// recentFromRoute. On palette open the titles come back with one batched .in()
// read per type; anything no longer returned (deleted, or no access) drops.
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

/** What is stored per open. */
export interface RecentItem {
  type: RecentType;
  id: string;
  openedAt: number;
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

function isRecentItem(value: unknown): value is RecentItem {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.type === 'string' &&
    TYPES.has(v.type) &&
    typeof v.id === 'string' &&
    v.id !== '' &&
    typeof v.openedAt === 'number'
  );
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
    const key = `${item.type}:${item.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ type: item.type, id: item.id, openedAt: item.openedAt });
  }
  return out.slice(0, RECENT_MAX);
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
  const next = dedupe([
    { type: item.type, id: item.id, openedAt: nowMs },
    ...readRecents(storage, userId, workspaceId),
  ]);
  try {
    storage.setItem(recentKey(userId, workspaceId), JSON.stringify(next));
  } catch {
    // Storage full or blocked: recents are a convenience, nothing to do.
  }
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
    void recordRouteOpen({
      client,
      storage: deviceStorage(),
      pathname,
      search,
      workspaceId,
      workspaceKey,
      userId,
      nowMs: Date.now(),
    });
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

async function readRows(
  query: PromiseLike<{ data: unknown; error: { message: string } | null }>,
  signal?: AbortSignal,
): Promise<Row[]> {
  try {
    const res = await abortable(query, signal);
    if (res.error) return [];
    return Array.isArray(res.data) ? (res.data as Row[]) : [];
  } catch {
    return [];
  }
}

/**
 * The newest RECENT_SHOWN recents with their titles: one batched .in() read
 * per type present, all in parallel (never one per item). An item a read does
 * not return (deleted, no access, or the read failed) is dropped silently.
 */
export async function loadRecentEntries(params: {
  client: Client;
  workspaceId: string;
  workspaceKey: string | null;
  userId: string;
  items: readonly RecentItem[];
  signal?: AbortSignal;
}): Promise<RecentEntry[]> {
  const { client, workspaceId, signal } = params;
  const items = params.items.slice(0, RECENT_SHOWN);
  const idsOf = (type: RecentType): string[] =>
    items.filter((i) => i.type === type).map((i) => i.id);
  const byType = new Map<RecentType, Map<string, { title: string; target: RecentTarget }>>();
  const put = (type: RecentType, id: string, title: string, target: RecentTarget): void => {
    const map = byType.get(type) ?? new Map<string, { title: string; target: RecentTarget }>();
    map.set(id, { title, target });
    byType.set(type, map);
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
  const when = (type: RecentType, run: (ids: string[]) => Promise<void>): void => {
    const ids = idsOf(type);
    if (ids.length > 0) reads.push(run(ids));
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
    for (const r of rows)
      put('post', str(r, 'id'), entityTitle('post', r), { path: entityPath('post', r) });
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
    for (const r of rows) {
      put('brief', str(r, 'id'), entityTitle('brief', r), { path: entityPath('brief', r) });
    }
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
    for (const r of rows) {
      put('plan', str(r, 'id'), str(r, 'title'), { path: planHref(str(r, 'id'), null) });
    }
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
    for (const r of rows) {
      const id = str(r, 'id');
      const name = str(r, 'display_name') !== '' ? str(r, 'display_name') : str(r, 'filename');
      put('file', id, name, { path: `/assets?asset=${encodeURIComponent(id)}` });
    }
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
    for (const r of rows) {
      const id = str(r, 'id');
      put('group', id, str(r, 'name'), {
        path: chatMessageHref(groupChannelId(workspaceId, id), null),
      });
    }
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
    for (const r of rows) {
      const id = str(r, 'id');
      put('task', id, str(r, 'title'), { path: chatTaskHref(str(r, 'channel_id'), id) });
    }
  });
  when('person', async (ids) => {
    const res = await readMentionProfiles(client, {
      workspaceId,
      userIds: ids,
      ...(signal !== undefined ? { signal } : {}),
    }).catch(() => null);
    if (res === null || !res.ok) return;
    for (const p of res.data) {
      // Only current members (and me): a person who left drops.
      if (p.userId !== params.userId && p.member !== true) continue;
      put('person', p.userId, p.displayName, { person: p.userId });
    }
  });
  await Promise.all(reads);

  const out: RecentEntry[] = [];
  for (const item of items) {
    const hit = byType.get(item.type)?.get(item.id);
    if (hit === undefined || hit.title === '') continue;
    out.push({ type: item.type, id: item.id, title: hit.title, target: hit.target });
  }
  return out;
}
