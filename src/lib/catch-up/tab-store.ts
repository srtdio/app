// Catch up per tab (13 Nov 2026): each list tab shows its own catch-up rows
// above the chip row (Pipeline: posts; Briefs: briefs; Plan: plan items, then
// bank ideas; Chat: chat messages and threads). One shared session read of the
// caller's unread inbox entries feeds every tab's count and queue (the
// sharedRead/readKey pattern): read once per session after the first paint,
// again only when the inbox changes (INBOX_CHANGED_EVENT: a mark read
// anywhere, the shell's poll after a live push). A tab open never reads when
// the held copy is current; nothing waits on the read before paint.
//
// One read state: a decision here, a row's Mark N as read, or an item opened
// anywhere (markEntityReadOnOpen's ENTITY_READ_ON_OPEN_EVENT) drops the held
// entries at once and writes them read on the server, so Activity's dots and
// "N new" follow on its next read; Activity's own reads reach here through
// the same change event.

import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { Client } from '@srtdio/rpc';
import type { Database } from '@srtdio/schemas';
import {
  fetchActivityEntries,
  mapEntry,
  type ActivityItem,
  type LoadResult,
} from '@/components/pages/activity/data';
import { INBOX_CHANGED_EVENT } from '@/lib/events';
import { ENTITY_READ_ON_OPEN_EVENT, type EntityReadOnOpen } from '@/lib/inbox/entity-open-event';
import { logger } from '@/lib/logger';
import { mark } from '@/lib/perf-marks';
import {
  invalidateReads,
  onSessionReadsHydrated,
  peekKept,
  primeRead,
  readKey,
  sharedRead,
} from '@/lib/session-read';
import { supabase } from '@/lib/supabase';
import { generateTraceId } from '@/lib/trace';
import type { ThreadForMeAll } from '@/lib/chat/thread-signals';
import type { ConversationSummary } from '@/lib/chat/chat-store';
import {
  buildCatchUpQueue,
  unreadIdsOf,
  type CatchUpItem,
  type CatchUpItemKind,
} from '@/lib/catch-up/queue';
import { buildThreadsQueue } from '@/lib/catch-up/threads';

/** A tab's catch-up row: what the ?catchup= value names. */
export type TabCatchUpKind = 'post' | 'brief' | 'plan-item' | 'idea' | 'chat';

export const TAB_CATCH_UP_KINDS: readonly TabCatchUpKind[] = [
  'post',
  'brief',
  'plan-item',
  'idea',
  'chat',
];

/** The rows' names (approved copy, word for word). */
export const TAB_CATCH_UP_TITLE: Readonly<Record<TabCatchUpKind, string>> = {
  post: 'Post catch up',
  brief: 'Brief catch up',
  'plan-item': 'Plan catch up',
  idea: 'Concept catch up',
  chat: 'Chat catch up',
};

/** The tab each row lives on. */
export const TAB_CATCH_UP_PATH: Readonly<Record<TabCatchUpKind, string>> = {
  post: '/pipeline',
  brief: '/briefs',
  'plan-item': '/plan',
  idea: '/plan',
  chat: '/chat',
};

/** The query param that opens a tab's catch up (the value is a TabCatchUpKind). */
export const TAB_CATCH_UP_PARAM = 'catchup';
/** The query param naming the entry to put first (an old Activity link). */
export const TAB_CATCH_UP_ENTRY_PARAM = 'entry';

/** Whether a param value names a tab's catch up. Pure. */
export function isTabCatchUpKind(value: string | null): value is TabCatchUpKind {
  return value !== null && (TAB_CATCH_UP_KINDS as readonly string[]).includes(value);
}

/** The card kinds one row's stack holds. Pure. */
export function itemKindsOf(tab: TabCatchUpKind): readonly CatchUpItemKind[] {
  return tab === 'chat' ? ['chat-main', 'chat-thread'] : [tab];
}

/** The row a card kind belongs to. Pure. */
export function tabKindOf(kind: CatchUpItemKind): TabCatchUpKind {
  return kind === 'chat-main' || kind === 'chat-thread' ? 'chat' : kind;
}

/** The link that opens one row's stack on its tab, `entryId` first when given. Pure. */
export function tabCatchUpHref(tab: TabCatchUpKind, entryId: string | null = null): string {
  const base = `${TAB_CATCH_UP_PATH[tab]}?${TAB_CATCH_UP_PARAM}=${tab}`;
  return entryId === null
    ? base
    : `${base}&${TAB_CATCH_UP_ENTRY_PARAM}=${encodeURIComponent(entryId)}`;
}

/** The rows' second line: "N unread". Pure. */
export function tabCatchUpLine(count: number): string {
  return `${count} unread`;
}

/** The swipe / hover action: "Mark N as read". Pure. */
export function markNAsRead(count: number): string {
  return `Mark ${count} as read`;
}

// --- The pure queue per row --------------------------------------------------

/** The inbox cards of the held unread entries (one per item, newest first). Pure. */
export function inboxCards(input: {
  held: readonly ActivityItem[];
  nowMs: number;
  workspaceId: string;
  selfId: string | null;
}): CatchUpItem[] {
  return buildCatchUpQueue({
    tapped: null,
    held: input.held,
    nowMs: input.nowMs,
    workspaceId: input.workspaceId,
    selfId: input.selfId,
  });
}

/** The stand-in entry a chat with unread messages and no inbox entry leads with (already read: no inbox id). Pure. */
export function chatMainEntry(
  channelId: string,
  summary: ConversationSummary,
  workspaceId: string,
  selfId: string | null,
): ActivityItem | null {
  if (summary.lastMessageId === undefined || summary.lastMessageTs <= 0) return null;
  const at = new Date(summary.lastMessageTs).toISOString();
  return mapEntry({
    id: `chat:${channelId}`,
    workspace_id: workspaceId,
    user_id: selfId ?? '',
    event_type: 'mention',
    entity_type: 'chat_channel',
    entity_id: channelId,
    scope: 'chat',
    scope_key: null,
    tier: 'active',
    created_at: at,
    read_at: at,
    snoozed_until: null,
    deleted_at: null,
    email_sent_at: null,
    payload: { message_id: summary.lastMessageId },
    actor_user_id: null,
  });
}

function ms(at: string): number {
  const t = Date.parse(at);
  return Number.isNaN(t) ? 0 : t;
}

/**
 * Chat catch up's cards: one per chat with unread messages (plain messages
 * too: the chat store's unread counts, with the inbox card when one exists,
 * else a stand-in at the chat's newest message that writes only its read
 * cursor) and one per unread thread (the threads list, with the inbox card
 * when one exists). A chat the store holds as read never shows (seen once =
 * seen everywhere); before the store is ready the inbox cards stand alone.
 * Newest first. Pure.
 */
export function chatCards(input: {
  inbox: readonly CatchUpItem[];
  threads: readonly ThreadForMeAll[] | null;
  conversations: Readonly<Record<string, ConversationSummary>> | null;
  workspaceId: string;
  selfId: string | null;
}): CatchUpItem[] {
  const out = new Map<string, CatchUpItem>();
  const convos = input.conversations;
  for (const card of input.inbox) {
    if (card.kind === 'chat-thread') out.set(card.key, card);
    if (card.kind !== 'chat-main') continue;
    if (convos !== null && (convos[card.entityId]?.unread ?? 0) <= 0) continue;
    out.set(card.key, card);
  }
  for (const card of buildThreadsQueue(input.threads ?? [], input)) {
    if (!out.has(card.key)) out.set(card.key, card);
  }
  if (convos !== null) {
    for (const [channelId, summary] of Object.entries(convos)) {
      const key = `chat:${channelId}`;
      if (summary.unread <= 0 || out.has(key)) continue;
      const lead = chatMainEntry(channelId, summary, input.workspaceId, input.selfId);
      if (lead === null) continue;
      out.set(key, {
        key,
        kind: 'chat-main',
        entityId: channelId,
        threadRootId: null,
        workspaceId: input.workspaceId,
        lead,
        cardEntries: [lead],
        entries: [lead],
        latestAt: lead.createdAt,
        source: 'threads',
      });
    }
  }
  return [...out.values()].sort((a, b) => ms(b.latestAt) - ms(a.latestAt));
}

/** One row's queue: the cards of its kinds, newest first, `firstKey` first when held. Pure. */
export function tabQueue(
  cards: readonly CatchUpItem[],
  tab: TabCatchUpKind,
  firstKey: string | null = null,
): CatchUpItem[] {
  const kinds = itemKindsOf(tab);
  const mine = cards.filter((card) => kinds.includes(card.kind));
  if (firstKey === null) return mine;
  const first = mine.find((card) => card.key === firstKey);
  return first === undefined ? mine : [first, ...mine.filter((card) => card !== first)];
}

/** Every row's count (cards its stack would open). Pure. */
export function tabCounts(cards: readonly CatchUpItem[]): Record<TabCatchUpKind, number> {
  const counts: Record<TabCatchUpKind, number> = {
    post: 0,
    brief: 0,
    'plan-item': 0,
    idea: 0,
    chat: 0,
  };
  for (const card of cards) counts[tabKindOf(card.kind)] += 1;
  return counts;
}

// --- The shared session read --------------------------------------------------

/** How many unread entries the one read holds (a long unread backlog beyond it waits for the next read). */
export const CATCH_UP_READ_SIZE = 200;

/** The session read key of the unread entries. */
export function catchUpUnreadKey(userId: string, workspaceId: string): string {
  return readKey(userId, workspaceId, 'catch-up-unread');
}

interface Active {
  key: string;
  userId: string;
  workspaceId: string;
}

let active: Active | null = null;
/** Keys read ok and unchanged since (a tab open joins these, never reads). */
const current = new Set<string>();
const running = new Set<string>();
const listeners = new Set<() => void>();
const EMPTY: readonly ActivityItem[] = [];

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function heldSnapshot(): readonly ActivityItem[] {
  if (active === null) return EMPTY;
  const kept = peekKept<LoadResult>(active.key);
  return kept !== undefined && kept.ok ? kept.data : EMPTY;
}

function read(target: Active): void {
  if (running.has(target.key)) return;
  running.add(target.key);
  // Always a promise of a result (a stubbed reader that answers nothing reads as a failure).
  const load = async (): Promise<LoadResult> =>
    ((await fetchActivityEntries(supabase, target.workspaceId, {
      state: 'unread',
      pageSize: CATCH_UP_READ_SIZE,
    })) as LoadResult | undefined) ?? { ok: false, error: 'no result' };
  void sharedRead(target.key, load, { isOk: (res) => res.ok }).then(
    (res) => {
      running.delete(target.key);
      if (res.ok) {
        current.add(target.key);
        mark('catch-up:tab-read');
      } else {
        logger.warn('catch-up: tab read failed', { error: res.error });
      }
      emit();
    },
    (err: unknown) => {
      running.delete(target.key);
      logger.warn('catch-up: tab read failed', { error: String(err) });
    },
  );
}

/** Make a tenant active and read it unless the held copy is current. A command. */
export function ensureTabCatchUp(userId: string | null, workspaceId: string | null): void {
  if (userId === null || workspaceId === null) return;
  const key = catchUpUnreadKey(userId, workspaceId);
  let target = active;
  if (target?.key !== key) {
    target = { key, userId, workspaceId };
    active = target;
    emit();
  }
  if (!current.has(key)) read(target);
}

/** Drop entries from the held copy at once (they were read here or elsewhere). */
export function dropHeldEntries(ids: readonly string[]): void {
  if (active === null || ids.length === 0) return;
  const kept = peekKept<LoadResult>(active.key);
  if (kept === undefined || !kept.ok) return;
  const gone = new Set(ids);
  const data = kept.data.filter((item) => !gone.has(item.id));
  if (data.length === kept.data.length) return;
  primeRead<LoadResult>(active.key, { ok: true, data });
  emit();
}

/** Put entries back (a write failed). */
export function restoreHeldEntries(items: readonly ActivityItem[]): void {
  if (active === null || items.length === 0) return;
  const kept = peekKept<LoadResult>(active.key);
  if (kept === undefined || !kept.ok) return;
  const have = new Set(kept.data.map((item) => item.id));
  const back = items.filter((item) => !have.has(item.id));
  if (back.length === 0) return;
  primeRead<LoadResult>(active.key, { ok: true, data: [...kept.data, ...back] });
  emit();
}

async function markIdsRead(
  client: Client,
  workspaceId: string,
  ids: readonly string[],
  traceId: string,
): Promise<boolean> {
  const args: Database['public']['Functions']['inbox_mark_read_ids']['Args'] = {
    p_workspace_id: workspaceId,
    p_ids: [...ids],
    p_trace_id: traceId,
  };
  try {
    const { error } = await client.rpc('inbox_mark_read_ids', args);
    if (error)
      logger.warn('catch-up: mark ids read failed', { trace_id: traceId, error: error.message });
    return !error;
  } catch (error) {
    logger.warn('catch-up: mark ids read failed', { trace_id: traceId, error: String(error) });
    return false;
  }
}

/**
 * Write held entries read (one inbox_mark_read_ids, its own trace id), drop
 * them at once, put them back on a failure. Then the inbox change event, so
 * Activity and its badge re-read. A command.
 */
export function markHeldRead(items: readonly ActivityItem[]): void {
  const target = active;
  const unread = items.filter((item) => item.readAt === null);
  if (target === null || unread.length === 0) return;
  dropHeldEntries(unread.map((item) => item.id));
  const traceId = generateTraceId();
  void markIdsRead(
    supabase,
    target.workspaceId,
    unread.map((item) => item.id),
    traceId,
  ).then((ok) => {
    if (!ok) {
      restoreHeldEntries(unread);
      return;
    }
    window.dispatchEvent(new CustomEvent(INBOX_CHANGED_EVENT));
  });
}

/** The cards' unread inbox entries (a row's Mark N as read). Pure. */
export function heldEntriesOf(cards: readonly CatchUpItem[]): ActivityItem[] {
  const out: ActivityItem[] = [];
  const seen = new Set<string>();
  for (const card of cards) {
    const ids = new Set(unreadIdsOf(card));
    for (const entry of card.entries) {
      if (!ids.has(entry.id) || seen.has(entry.id)) continue;
      seen.add(entry.id);
      out.push(entry);
    }
  }
  return out;
}

/** The held entries of one item (the item opened somewhere). Pure. */
export function entriesOfItem(
  held: readonly ActivityItem[],
  entityType: string,
  entityId: string,
): ActivityItem[] {
  return held.filter(
    (item) => item.readAt === null && item.entityType === entityType && item.entityId === entityId,
  );
}

if (typeof window !== 'undefined') {
  // Any inbox change (a read here, in Activity, a toast, the poll after a push):
  // the held copy may differ, read again while a tab shows rows.
  window.addEventListener(INBOX_CHANGED_EVENT, () => {
    if (active === null) return;
    current.delete(active.key);
    invalidateReads(active.key);
    if (listeners.size > 0) read(active);
  });
  // An item opened anywhere: every held entry of it is read (the comment and
  // mention entries ride inbox_mark_entity_read; the rest are written here).
  window.addEventListener(ENTITY_READ_ON_OPEN_EVENT, (event) => {
    const detail = (event as CustomEvent<EntityReadOnOpen>).detail;
    if (detail === undefined) return;
    markHeldRead(entriesOfItem(heldSnapshot(), detail.type, detail.id));
  });
}

/** Test seam: forget the active tenant. */
export function resetTabCatchUpForTest(): void {
  active = null;
  current.clear();
  running.clear();
  emit();
}

/** Test seam: an active tenant with a known held copy (no read runs). */
export function seedTabCatchUpForTest(seed: {
  userId: string;
  workspaceId: string;
  held: ActivityItem[];
}): void {
  const key = catchUpUnreadKey(seed.userId, seed.workspaceId);
  active = { key, userId: seed.userId, workspaceId: seed.workspaceId };
  primeRead<LoadResult>(key, { ok: true, data: seed.held });
  current.add(key);
  emit();
}

function knownSnapshot(): boolean {
  return active !== null && peekKept<LoadResult>(active.key) !== undefined;
}

/** Whether the held copy exists (read this session or restored from the device). */
export function useHeldKnown(): boolean {
  return useSyncExternalStore(subscribe, knownSnapshot, knownSnapshot);
}

/**
 * The held unread entries (first paint from what the device holds; the read
 * starts in an effect after it, never awaited).
 */
export function useHeldUnread(
  userId: string | null,
  workspaceId: string | null,
): readonly ActivityItem[] {
  const key =
    userId !== null && workspaceId !== null ? catchUpUnreadKey(userId, workspaceId) : null;
  // This tenant's held copy, read or restored from the device: the first frame paints it.
  const peek = (): readonly ActivityItem[] => {
    if (key === null) return EMPTY;
    const kept = peekKept<LoadResult>(key);
    return kept !== undefined && kept.ok ? kept.data : EMPTY;
  };
  const held = useSyncExternalStore(subscribe, peek, peek);
  useEffect(() => {
    ensureTabCatchUp(userId, workspaceId);
    // The device's copy can land after the first frame (hydration): repaint then.
    return onSessionReadsHydrated(emit);
  }, [userId, workspaceId]);
  return held;
}

/** The inbox cards from the held entries (memoised on the held copy). */
export function useInboxCards(userId: string | null, workspaceId: string | null): CatchUpItem[] {
  const held = useHeldUnread(userId, workspaceId);
  return useMemo(
    () =>
      workspaceId === null
        ? []
        : inboxCards({ held, nowMs: Date.now(), workspaceId, selfId: userId }),
    [held, workspaceId, userId],
  );
}
