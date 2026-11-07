// Delete for me: the messages the caller hid from their own view
// (chat_message_hides, RLS: own rows only). Everyone else still sees them.
//
// One read of the caller's own rows per workspace (message_id, channel_id),
// started in idle time after first paint and kept in the device cache under
// `chat:hides` (session-read.ts saves `chat:` keys), so a cold open filters
// from what the device holds and the read refreshes it quietly. Nothing on a
// paint path waits for it: until it lands the set is what the device held
// (or empty).
//
// The hidden set per workspace is a small subscribable store
// (useSyncExternalStore): the read's ids plus the ids hidden on this device
// this session (hideLocal), minus nothing (an Undo runs before the write, so
// unhideLocal only removes local ids). Every surface filters with a Set
// lookup at render: no await, no read.
//
// The write is chat_messages_hide (p_message_ids, p_trace_id), chunked at 100
// ids per call (the proc's cap). The trace id is minted at the user action.

import { useSyncExternalStore } from 'react';
import type { Client } from '@srtdio/rpc';
import type { Database } from '@srtdio/schemas';
import { supabase } from '@/lib/supabase';
import { logger } from '@/lib/logger';
import { abortable, withReadTimeout } from '@/lib/chat-reads';
import {
  OWN_PREFIX,
  messagePreviewContent,
  previewText,
  type ConversationSummary,
} from '@/lib/chat/chat-store';
import type { ThreadMessage } from '@/lib/chat/thread';
import { chunkIds } from '@/lib/chat/record';
import { whenIdle } from '@/lib/chunk-reload';
import { SIGNOUT_EVENT } from '@/lib/events';
import {
  onSessionReadsHydrated,
  peekKept,
  primeRead,
  readKey,
  sharedRead,
} from '@/lib/session-read';

type HideArgs = Database['public']['Functions']['chat_messages_hide']['Args'];

/** One hidden message, as read and as saved on the device. */
export interface HiddenRow {
  message_id: string;
  channel_id: string;
}

/** The proc's per-call cap on chat_messages_hide ids. */
export const HIDE_CHUNK_SIZE = 100;

/** The device-cache key's tail: `${userId}:${workspaceId}:chat:hides`. */
export const HIDES_WHAT = 'chat:hides';

/** The session read (and device cache) key of a workspace's hidden rows. */
export function hidesKey(userId: string, workspaceId: string): string {
  return readKey(userId, workspaceId, HIDES_WHAT);
}

const EMPTY: ReadonlySet<string> = new Set<string>();

interface WorkspaceHides {
  /** The read's rows (or the device's copy). */
  base: HiddenRow[];
  /** Hidden on this device this session, by id (channel id kept for the save). */
  local: Map<string, string>;
  /** base ids plus local ids; replaced (never mutated) on every change. */
  ids: ReadonlySet<string>;
}

const byWorkspace = new Map<string, WorkspaceHides>();
const listeners = new Set<() => void>();
let activeWorkspaceId: string | null = null;

function entry(workspaceId: string): WorkspaceHides {
  let held = byWorkspace.get(workspaceId);
  if (held === undefined) {
    held = { base: [], local: new Map(), ids: EMPTY };
    byWorkspace.set(workspaceId, held);
  }
  return held;
}

function recompute(held: WorkspaceHides): void {
  const ids = new Set<string>();
  for (const row of held.base) ids.add(row.message_id);
  for (const id of held.local.keys()) ids.add(id);
  held.ids = ids.size === 0 ? EMPTY : ids;
  for (const listener of [...listeners]) listener();
}

/** A saved or read value as rows, or null when it is not one. Pure. */
export function readHiddenRows(value: unknown): HiddenRow[] | null {
  if (!Array.isArray(value)) return null;
  const rows: HiddenRow[] = [];
  for (const item of value as unknown[]) {
    if (typeof item !== 'object' || item === null) continue;
    const row = item as Partial<HiddenRow>;
    if (typeof row.message_id !== 'string' || typeof row.channel_id !== 'string') continue;
    rows.push({ message_id: row.message_id, channel_id: row.channel_id });
  }
  return rows;
}

function setBase(workspaceId: string, rows: HiddenRow[]): void {
  const held = entry(workspaceId);
  held.base = rows;
  recompute(held);
}

/** The hidden message ids of a workspace (empty when none or unknown). Never reads. */
export function hiddenIdsFor(workspaceId: string | null | undefined): ReadonlySet<string> {
  const id = workspaceId ?? activeWorkspaceId;
  if (id === null || id === undefined) return EMPTY;
  return byWorkspace.get(id)?.ids ?? EMPTY;
}

/** Listen for any change to any workspace's hidden set. Returns unsubscribe. */
export function subscribeHides(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * The hidden ids of `workspaceId` (default: the workspace the chat store
 * loaded last), re-rendering on change. Pure render: never reads.
 */
export function useHiddenIds(workspaceId?: string | null): ReadonlySet<string> {
  return useSyncExternalStore(
    subscribeHides,
    () => hiddenIdsFor(workspaceId),
    () => EMPTY,
  );
}

/** Keep only what is not hidden. A Set lookup per item; the same array when nothing goes. Pure. */
export function withoutHidden<T>(
  items: readonly T[],
  hidden: ReadonlySet<string>,
  idOf: (item: T) => string,
): T[] {
  if (hidden.size === 0) return items as T[];
  let dropped = false;
  const kept = items.filter((item) => {
    const keep = !hidden.has(idOf(item));
    if (!keep) dropped = true;
    return keep;
  });
  return dropped ? kept : (items as T[]);
}

/**
 * A chat card's line once its last message is hidden: the latest visible
 * message among the rows the device already holds for that chat (`held`,
 * oldest first), else the empty line. Time and unread stay. The same summary
 * when its line is not hidden. No read. Pure.
 */
export function summaryWithoutHidden(
  summary: ConversationSummary | undefined,
  hidden: ReadonlySet<string>,
  held: () => readonly ThreadMessage[] | undefined,
): ConversationSummary | undefined {
  if (summary === undefined || hidden.size === 0) return summary;
  const shown = summary.lastMessageId;
  if (shown === undefined || !hidden.has(shown)) return summary;
  const rows = held() ?? [];
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (row === undefined || hidden.has(row.id) || row.deleted === true) continue;
    if (row.state !== 'sent') continue;
    const text = previewText(messagePreviewContent(row));
    if (text === '') continue;
    return {
      lastMessageText: text,
      lastMessageTs: summary.lastMessageTs,
      unread: summary.unread,
      lastMessageId: row.id,
      ...(row.mine ? { lastMessagePrefix: OWN_PREFIX } : {}),
    };
  }
  return { lastMessageText: '', lastMessageTs: summary.lastMessageTs, unread: summary.unread };
}

/** Hide these messages on this device now (Delete for me's optimistic step). */
export function hideLocal(
  workspaceId: string,
  items: readonly { messageId: string; channelId: string }[],
): void {
  if (items.length === 0) return;
  const held = entry(workspaceId);
  for (const item of items) held.local.set(item.messageId, item.channelId);
  recompute(held);
}

/** Show these messages again (Undo, or a failed write). Only ids hidden on this device. */
export function unhideLocal(workspaceId: string, messageIds: readonly string[]): void {
  const held = byWorkspace.get(workspaceId);
  if (held === undefined) return;
  let changed = false;
  for (const id of messageIds) changed = held.local.delete(id) || changed;
  if (changed) recompute(held);
}

/** Read the caller's own hidden rows in one workspace (RLS: own rows). Never throws. */
export async function readHiddenMessages(
  client: Client,
  workspaceId: string,
): Promise<{ ok: true; data: HiddenRow[] } | { ok: false; error: string }> {
  const result = await withReadTimeout<HiddenRow[]>(async (signal) => {
    const res = await abortable(
      client
        .from('chat_message_hides')
        .select('message_id, channel_id')
        .eq('workspace_id', workspaceId),
      signal,
    );
    if (res.error) {
      return {
        ok: false,
        error: { code: 'unknown', message: `readHiddenMessages: ${res.error.message}` },
      };
    }
    return { ok: true, data: readHiddenRows(res.data ?? []) ?? [] };
  });
  return result.ok
    ? { ok: true, data: result.data }
    : { ok: false, error: result.error.message };
}

/**
 * Start the hidden set for one workspace: seed it at once from what this
 * session or device holds (no read), then read once in idle time and keep
 * the result (device cache too). Returns the cancel. Never awaited by a caller.
 */
export function startHides(input: {
  userId: string;
  workspaceId: string;
  client?: Client;
}): () => void {
  const { userId, workspaceId } = input;
  const client = input.client ?? supabase;
  const key = hidesKey(userId, workspaceId);
  activeWorkspaceId = workspaceId;
  let cancelled = false;
  const seed = (): void => {
    const kept = readHiddenRows(peekKept<unknown>(key));
    if (kept !== null && !cancelled) setBase(workspaceId, kept);
  };
  seed();
  // A cold open: the device copy lands after boot; seed from it then.
  const offHydrated = onSessionReadsHydrated(seed);
  const cancelIdle = whenIdle(() => {
    if (cancelled) return;
    void sharedRead(
      key,
      async () => {
        const result = await readHiddenMessages(client, workspaceId);
        if (!result.ok) throw new Error(result.error);
        return result.data;
      },
      { freshMs: 60_000 },
    ).then(
      (rows) => {
        if (!cancelled) setBase(workspaceId, rows);
      },
      (error: unknown) => {
        logger.warn('chat hides read failed', { workspaceId, error: String(error) });
      },
    );
  });
  return () => {
    cancelled = true;
    offHydrated();
    cancelIdle();
  };
}

/**
 * Record Delete for me: chat_messages_hide in chunks of HIDE_CHUNK_SIZE, in
 * order, each with the action's trace id. Throws on the first failed chunk
 * (useUndoableAction's commit reverts and shows its failure toast). Once all
 * chunks hold, the device copy is saved with them so a cold open hides them.
 */
export async function hideMessages(input: {
  userId: string;
  workspaceId: string;
  items: readonly { messageId: string; channelId: string }[];
  traceId: string;
  client?: Client;
}): Promise<void> {
  const client = input.client ?? supabase;
  const ids = input.items.map((item) => item.messageId);
  for (const chunk of chunkIds(ids, HIDE_CHUNK_SIZE)) {
    const args: HideArgs = { p_message_ids: chunk, p_trace_id: input.traceId };
    const { error } = await client.rpc('chat_messages_hide', args);
    if (error) throw new Error(error.message);
  }
  const held = entry(input.workspaceId);
  const known = new Set(held.base.map((row) => row.message_id));
  const added = input.items
    .filter((item) => !known.has(item.messageId))
    .map((item) => ({ message_id: item.messageId, channel_id: item.channelId }));
  if (added.length > 0) {
    held.base = [...held.base, ...added];
    primeRead(hidesKey(input.userId, input.workspaceId), held.base, 60_000);
    recompute(held);
  }
}

/** Forget every workspace's hidden set (sign-out; tests). */
export function resetHides(): void {
  byWorkspace.clear();
  activeWorkspaceId = null;
  for (const listener of [...listeners]) listener();
}

if (typeof window !== 'undefined') window.addEventListener(SIGNOUT_EVENT, resetHides);
