// Message stars: the caller's own bookmarks on chat messages (RLS: own rows
// only). One small store per workspace holds the open channel's starred ids
// (read with the thread's first history page, so a star never pops in after
// first paint) plus every local star or unstar this session, so the bubble,
// the header Starred sheet, the chat home Starred list and the Contact or
// Group info Starred tab all read one source and never show a stale star.
//
// Writes go through chat_message_star_set (1 to 100 ids of one channel, one
// call per channel, a fresh uuid_v7 trace id per call; the actor is auth.uid()
// server-side). A toggle flips locally at once and reverts silently when the
// record refuses it (the caller shows the error toast). The lists read
// chat_message_starred_list: newest first, keyset paged, optional channel
// filter and the same prefix text search as chat_message_search (2 to 100
// characters; 1 character is ignored). Framework-light so every rule is unit
// tested with no DOM and no database.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useSyncExternalStore } from 'react';
import type { Client, Result } from '@srtdio/rpc';
import type { Database } from '@srtdio/schemas';
import { abortable, withReadTimeout } from '@/lib/chat-reads';
import { messagePreviewContent, previewText } from '@/lib/chat/chat-store';
import { rowToThreadMessage, type ChatMessageRow } from '@/lib/chat/thread';
import { generateTraceId } from '@/lib/trace';
import { logger } from '@/lib/logger';
import { supabase } from '@/lib/supabase';

type StarSetArgs = Database['public']['Functions']['chat_message_star_set']['Args'];
type StarredListFn = Database['public']['Functions']['chat_message_starred_list'];
type StarredListArgs = StarredListFn['Args'];
type StarredListRow = StarredListFn['Returns'][number];

/** The most ids one chat_message_star_set call takes. */
export const STAR_BATCH_MAX = 100;
/** One page of a starred list. */
export const STARRED_PAGE_SIZE = 30;
/** The shortest and longest trimmed text that narrows a starred list. */
const STARRED_QUERY_MIN = 2;

/** Copy. */
export const STAR_LABEL = 'Star';
export const UNSTAR_LABEL = 'Unstar';
export const STARRED_TITLE = 'Starred';
export const STARRED_HEADER_LABEL = 'Starred messages';
export const STARRED_EMPTY_TITLE = 'Starred messages show up here.';
/** The error toast when a star or unstar did not save (the change has reverted). */
export const STAR_FAILED_TOAST = "Couldn't update the star. Try again.";

/** One message a star write names. */
export interface StarTarget {
  id: string;
  channelId: string;
}

/** What every star surface reads. Immutable: a change makes a new snapshot. */
export interface StarSnapshot {
  /** The channel whose starred ids are loaded (the open thread), or null. */
  channelId: string | null;
  /** The loaded channel's starred message ids, as last read. */
  ids: ReadonlySet<string>;
  /** This session's own changes (true starred, false unstarred), newest wins. */
  local: ReadonlyMap<string, boolean>;
  /** Counts every accepted star; a list re-reads its first page when it moves. */
  version: number;
}

export const EMPTY_STARS: StarSnapshot = {
  channelId: null,
  ids: new Set(),
  local: new Map(),
  version: 0,
};

/** Whether a message shows as starred in the open thread. Pure. */
export function isStarredIn(snapshot: StarSnapshot, messageId: string): boolean {
  const local = snapshot.local.get(messageId);
  return local !== undefined ? local : snapshot.ids.has(messageId);
}

/** Whether a row a starred list read is still starred here (unstarred since: hidden). Pure. */
export function listRowStarred(snapshot: StarSnapshot, messageId: string): boolean {
  return snapshot.local.get(messageId) !== false;
}

/** Whether a message may be starred or unstarred: recorded and live. Pure. */
export function canStar(message: { state: string; deleted?: boolean | undefined }): boolean {
  return message.state === 'sent' && message.deleted !== true;
}

/**
 * The selection bar's action: Unstar when every selected message is already
 * starred, else Star (it stars them all). Null with nothing selected. Pure.
 */
export function selectionStarAction(
  ids: Iterable<string>,
  starred: (messageId: string) => boolean,
): 'star' | 'unstar' | null {
  let any = false;
  for (const id of ids) {
    any = true;
    if (!starred(id)) return 'star';
  }
  return any ? 'unstar' : null;
}

/** Group targets by channel, in first-seen order, each split into 100-id chunks. Pure. */
export function groupByChannel(
  targets: readonly StarTarget[],
): Array<{ channelId: string; ids: string[] }> {
  const byChannel = new Map<string, string[]>();
  for (const target of targets) {
    const list = byChannel.get(target.channelId) ?? [];
    if (!list.includes(target.id)) list.push(target.id);
    byChannel.set(target.channelId, list);
  }
  const out: Array<{ channelId: string; ids: string[] }> = [];
  for (const [channelId, ids] of byChannel) {
    for (let at = 0; at < ids.length; at += STAR_BATCH_MAX) {
      out.push({ channelId, ids: ids.slice(at, at + STAR_BATCH_MAX) });
    }
  }
  return out;
}

function fail<T>(message: string): Result<T> {
  return { ok: false, error: { code: 'unknown', message } };
}

/** One chat_message_star_set call: named args, its own trace id. Never throws. */
export async function setStarsRecord(params: {
  client: Client;
  channelId: string;
  messageIds: readonly string[];
  starred: boolean;
  traceId: string;
}): Promise<Result<null>> {
  // Args built first, as notes.ts does: p_trace_id is the proc's trace parameter.
  const args: StarSetArgs = {
    p_message_ids: [...params.messageIds],
    p_channel_id: params.channelId,
    p_starred: params.starred,
    p_trace_id: params.traceId,
  };
  try {
    const res = await params.client.rpc('chat_message_star_set', args);
    if (res.error) return fail(res.error.message);
    return { ok: true, data: null };
  } catch (error: unknown) {
    return fail(String(error));
  }
}

/** The open channel's starred ids (RLS: the caller's own rows), one query. */
export async function loadChannelStars(
  client: Client,
  channelId: string,
  signal?: AbortSignal,
): Promise<Result<string[]>> {
  try {
    const res = await abortable(
      client.from('chat_message_stars').select('message_id').eq('channel_id', channelId),
      signal,
    );
    if (res.error) return fail(`loadChannelStars: ${res.error.message}`);
    const rows = (res.data ?? []) as Array<{ message_id: string }>;
    return { ok: true, data: rows.map((row) => row.message_id) };
  } catch (error: unknown) {
    return fail(String(error));
  }
}

/** A star write's outcome for the caller (the toast on failure). */
export type StarWriteResult = { ok: true } | { ok: false; message: string };

/** The per-workspace star store. */
export interface StarStore {
  readonly workspaceId: string;
  getSnapshot: () => StarSnapshot;
  subscribe: (listener: () => void) => () => void;
  /**
   * A channel's ids were read: they become the loaded set, and this session's
   * settled changes in that channel give way to the record (one in flight
   * stays until it answers).
   */
  setChannel: (channelId: string, ids: Iterable<string>) => void;
  /** Flip at once, write in the background, revert what the record refused. */
  toggle: (targets: readonly StarTarget[], starred: boolean) => Promise<StarWriteResult>;
  /** Messages that became tombstones: their stars are gone. */
  drop: (messageIds: Iterable<string>) => void;
}

type StarWrite = (params: {
  channelId: string;
  messageIds: readonly string[];
  starred: boolean;
  traceId: string;
}) => Promise<Result<null>>;

export function createStarStore(options: {
  workspaceId: string;
  /** The record write; the app's goes through Supabase. */
  write?: StarWrite;
}): StarStore {
  const write: StarWrite =
    options.write ?? ((params) => setStarsRecord({ client: supabase, ...params }));
  let snapshot: StarSnapshot = EMPTY_STARS;
  const listeners = new Set<() => void>();
  // The channel each local change belongs to, and the changes still in flight.
  const localChannel = new Map<string, string>();
  const inFlight = new Map<string, number>();

  const emit = (next: StarSnapshot): void => {
    snapshot = next;
    for (const listener of [...listeners]) listener();
  };
  const withLocal = (entries: Iterable<[string, boolean]>, bump = 0): void => {
    const local = new Map(snapshot.local);
    for (const [id, value] of entries) local.set(id, value);
    emit({ ...snapshot, local, version: snapshot.version + bump });
  };

  return {
    workspaceId: options.workspaceId,
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setChannel: (channelId, ids) => {
      const read = new Set(ids);
      const local = new Map(snapshot.local);
      // A settled change takes the record's value (lists keep hiding a row
      // the record no longer stars); one in flight waits for its answer.
      for (const [id, channel] of localChannel) {
        if (channel === channelId && !inFlight.has(id)) local.set(id, read.has(id));
      }
      emit({ ...snapshot, channelId, ids: read, local });
    },
    toggle: async (targets, starred) => {
      const groups = groupByChannel(targets);
      if (groups.length === 0) return { ok: true };
      const before = new Map<string, boolean>();
      for (const target of targets) {
        before.set(target.id, isStarredIn(snapshot, target.id));
        localChannel.set(target.id, target.channelId);
        inFlight.set(target.id, (inFlight.get(target.id) ?? 0) + 1);
      }
      withLocal(targets.map((t) => [t.id, starred] as [string, boolean]));
      const results = await Promise.all(
        groups.map(async (group) => {
          const traceId = generateTraceId();
          const result = await write({
            channelId: group.channelId,
            messageIds: group.ids,
            starred,
            traceId,
          });
          if (!result.ok) {
            logger.warn('chat: star write failed', {
              trace_id: traceId,
              channel_id: group.channelId,
              error: result.error.message,
            });
          }
          return { group, ok: result.ok, message: result.ok ? '' : result.error.message };
        }),
      );
      for (const target of targets) {
        const left = (inFlight.get(target.id) ?? 1) - 1;
        if (left <= 0) inFlight.delete(target.id);
        else inFlight.set(target.id, left);
      }
      const reverted: Array<[string, boolean]> = [];
      for (const { group, ok } of results) {
        if (ok) continue;
        // Revert only what still shows this write's value (a later tap wins).
        for (const id of group.ids) {
          if (snapshot.local.get(id) === starred) reverted.push([id, before.get(id) ?? false]);
        }
      }
      const accepted = results.some((r) => r.ok);
      withLocal(reverted, accepted && starred ? 1 : 0);
      const failed = results.find((r) => !r.ok);
      return failed === undefined ? { ok: true } : { ok: false, message: failed.message };
    },
    drop: (messageIds) => {
      const entries: Array<[string, boolean]> = [];
      for (const id of messageIds) {
        if (isStarredIn(snapshot, id) || snapshot.local.has(id)) entries.push([id, false]);
      }
      if (entries.length === 0) return;
      const ids = new Set(snapshot.ids);
      for (const [id] of entries) ids.delete(id);
      const local = new Map(snapshot.local);
      for (const [id, value] of entries) local.set(id, value);
      emit({ ...snapshot, ids, local });
    },
  };
}

/** The open workspace's star store; null outside the chat page (stars off). */
export const StarStoreContext = createContext<StarStore | null>(null);

export function useStarStore(): StarStore | null {
  return useContext(StarStoreContext);
}

const NO_SUBSCRIBE = (): (() => void) => () => undefined;
const EMPTY_SNAPSHOT = (): StarSnapshot => EMPTY_STARS;

/** The store's snapshot (EMPTY_STARS without a store). */
export function useStarSnapshot(store: StarStore | null): StarSnapshot {
  return useSyncExternalStore(
    store?.subscribe ?? NO_SUBSCRIBE,
    store?.getSnapshot ?? EMPTY_SNAPSHOT,
    store?.getSnapshot ?? EMPTY_SNAPSHOT,
  );
}

/** One message's star, re-rendering only when it changes. */
export function useIsStarred(messageId: string): boolean {
  const store = useStarStore();
  const read = useCallback(
    () => (store === null ? false : isStarredIn(store.getSnapshot(), messageId)),
    [store, messageId],
  );
  return useSyncExternalStore(store?.subscribe ?? NO_SUBSCRIBE, read, read);
}

/**
 * The open channel's star reads, framework-free: each load reads the ids,
 * puts them in the store and only THEN reports the channel settled, so the
 * render that drops the thread's skeleton already paints every star. A load
 * superseded by a newer one (or a channel switch) is dropped.
 */
export function createChannelStarsLoader(deps: {
  store: StarStore;
  read: (channelId: string) => Promise<Result<string[]>>;
  onSettled: (channelId: string) => void;
  current: () => string | null;
}): { load: (channelId: string) => Promise<void> } {
  let seq = 0;
  return {
    load: async (channelId) => {
      seq += 1;
      const mine = seq;
      const result = await deps.read(channelId);
      if (mine !== seq || deps.current() !== channelId) return;
      if (result.ok) deps.store.setChannel(channelId, result.data);
      else
        logger.warn('chat: stars load failed', {
          channel_id: channelId,
          error: result.error.message,
        });
      // Settled either way: a failed read paints with what was known.
      deps.onSettled(channelId);
    },
  };
}

/**
 * The open channel's starred ids: read when the channel opens (the thread
 * holds its first paint until this settles, ok or not), and again on window
 * focus, the tab turning visible and every catch-up (`refetch`). A failed or
 * hung read settles after 5s with what was known.
 */
export function useChannelStars(params: {
  store: StarStore;
  channelId: string | null;
  /** Injected in tests; the app uses the shared Supabase client. */
  db?: Client;
}): { settled: boolean; refetch: () => void } {
  const { store, channelId } = params;
  const db: Client = params.db ?? supabase;
  const [settledFor, setSettledFor] = useState<string | null>(null);
  const channelRef = useRef(channelId);
  channelRef.current = channelId;
  const { load } = useMemo(
    () =>
      createChannelStarsLoader({
        store,
        read: (forChannel) => withReadTimeout((signal) => loadChannelStars(db, forChannel, signal)),
        onSettled: setSettledFor,
        current: () => channelRef.current,
      }),
    [store, db],
  );

  useEffect(() => {
    if (channelId !== null) void load(channelId);
  }, [channelId, load]);

  useEffect(() => {
    if (channelId === null) return;
    const forChannel = channelId;
    const again = (): void => {
      if (document.visibilityState === 'visible') void load(forChannel);
    };
    window.addEventListener('focus', again);
    document.addEventListener('visibilitychange', again);
    return () => {
      window.removeEventListener('focus', again);
      document.removeEventListener('visibilitychange', again);
    };
  }, [channelId, load]);

  const refetch = useCallback(() => {
    const forChannel = channelRef.current;
    if (forChannel !== null) void load(forChannel);
  }, [load]);

  return { settled: channelId !== null && settledFor === channelId, refetch };
}

/** The trimmed text a starred list is narrowed by, or null (under 2 characters). Pure. */
export function starredQuery(raw: string): string | null {
  const q = raw.trim();
  return q.length >= STARRED_QUERY_MIN ? q : null;
}

/** The keyset cursor: the last row of the previous page. */
export interface StarredCursor {
  createdAt: string;
  id: string;
}

/**
 * Named args of one chat_message_starred_list call; optional args are left
 * out when unset (server defaults). Pure.
 */
export function starredListArgs(params: {
  workspaceId: string;
  traceId: string;
  channelId?: string | null;
  query?: string | null;
  before?: StarredCursor | null;
  limit?: number;
}): StarredListArgs {
  const query = params.query != null ? starredQuery(params.query) : null;
  return {
    p_workspace_id: params.workspaceId,
    p_trace_id: params.traceId,
    ...(params.channelId != null ? { p_channel_id: params.channelId } : {}),
    ...(query !== null ? { p_query: query } : {}),
    ...(params.before != null
      ? { p_before_created_at: params.before.createdAt, p_before_id: params.before.id }
      : {}),
    p_limit: params.limit ?? STARRED_PAGE_SIZE,
  };
}

/** One starred message as a list row draws it. */
export interface StarredRow {
  id: string;
  channelId: string;
  senderUserId: string | null;
  body: string;
  createdAt: string;
  /** The compact attachment summary when the body is empty ("Photo", "File"); else ''. */
  mediaLine: string;
}

export interface StarredPage {
  rows: StarredRow[];
  next: StarredCursor | null;
}

/** Map one returned chat_messages row. Pure. */
export function toStarredRow(row: StarredListRow): StarredRow {
  const body = row.body ?? '';
  return {
    id: row.id,
    channelId: row.channel_id,
    senderUserId: row.sender_user_id,
    body,
    createdAt: row.created_at,
    mediaLine:
      body.trim() !== ''
        ? ''
        : previewText(messagePreviewContent(rowToThreadMessage(row as ChatMessageRow, ''))),
  };
}

/** A full page means there may be more: the next cursor is its last row. Pure. */
export function starredNext(rows: readonly StarredRow[], limit: number): StarredCursor | null {
  const last = rows[rows.length - 1];
  if (last === undefined || rows.length < limit) return null;
  return { createdAt: last.createdAt, id: last.id };
}

/** One page of chat_message_starred_list: one RPC, its own trace id. Never throws. */
export async function loadStarredPage(params: {
  client: Client;
  workspaceId: string;
  channelId?: string | null;
  query?: string | null;
  before?: StarredCursor | null;
  limit?: number;
  signal?: AbortSignal;
  traceId?: string;
}): Promise<Result<StarredPage>> {
  const limit = params.limit ?? STARRED_PAGE_SIZE;
  const args = starredListArgs({
    workspaceId: params.workspaceId,
    traceId: params.traceId ?? generateTraceId(),
    channelId: params.channelId ?? null,
    query: params.query ?? null,
    before: params.before ?? null,
    limit,
  });
  try {
    const res = await abortable(
      params.client.rpc('chat_message_starred_list', args),
      params.signal,
    );
    if (res.error) return fail(res.error.message);
    const rows = ((res.data ?? []) as StarredListRow[]).map(toStarredRow);
    return { ok: true, data: { rows, next: starredNext(rows, limit) } };
  } catch (error: unknown) {
    return fail(String(error));
  }
}

/** Newest first, as the server orders: created_at desc, then id desc. */
function newerFirst(a: StarredRow, b: StarredRow): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/**
 * A re-read first page folded into what is loaded: every row once (the fresh
 * copy wins), newest first, so the list never shortens on a refresh. Pure.
 */
export function mergeStarredRows(
  loaded: readonly StarredRow[],
  fresh: readonly StarredRow[],
): StarredRow[] {
  const byId = new Map<string, StarredRow>();
  for (const row of loaded) byId.set(row.id, row);
  for (const row of fresh) byId.set(row.id, row);
  return [...byId.values()].sort(newerFirst);
}

/** The edit bar's label. Pure. */
export function unstarLabel(count: number): string {
  return `${UNSTAR_LABEL} (${count})`;
}

/**
 * The "Sender › Chat" head of a list row: "You" for my own messages, the
 * known name otherwise ("Unknown" until read). The chat part is left out in a
 * per-chat view and for DMs. Pure.
 */
export function starredRowHead(input: {
  senderUserId: string | null;
  currentUserId: string;
  nameOf: (userId: string) => string | undefined;
  chatTitle: string | null;
  showChat: boolean;
  isDm: boolean;
}): { sender: string; chat: string | null } {
  const sender =
    input.senderUserId !== null && input.senderUserId === input.currentUserId
      ? 'You'
      : ((input.senderUserId !== null ? input.nameOf(input.senderUserId) : undefined) ?? 'Unknown');
  const chat = input.showChat && !input.isDm && input.chatTitle !== null ? input.chatTitle : null;
  return { sender, chat };
}
