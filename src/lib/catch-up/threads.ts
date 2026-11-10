// Activity's Threads button (10 Nov 2026): the unread threads I am in across
// the workspace (chat_threads_for_me_all, pre-launch threads read), and the
// threads-only catch-up queue its tap opens on the EXISTING CatchUpScreen (one
// 'chat-thread' card per unread thread, newest first). A thread is not an
// inbox entry, so its card's lead is a stand-in chat-mention entry already
// read (it never writes inbox ids): Mark as read writes only the thread's
// read point (chat_thread_read_set), Undo puts it back (chat_thread_mark_unread).
//
// The list lives in one module store per workspace so the button, the queue
// and catch up's decisions read the same copy: a decision patches it at once
// (the count falls while catch up runs). Reads: once after Activity's first
// paint (never awaited before it), then again on a live thread reply from the
// chat connection's existing fan-out (subscribeGlobalMessages: no new
// channel), debounced. No notifications: the inbox is untouched.

import { useEffect, useSyncExternalStore } from 'react';
import type { Client } from '@srtdio/rpc';
import { mapEntry, type ActivityItem } from '@/components/pages/activity/data';
import { subscribeGlobalMessages } from '@/lib/chat/controller';
import { parseLiveThreadRoot } from '@/lib/chat/thread';
import { loadThreadsForMeAll, type ThreadForMeAll } from '@/lib/chat/thread-signals';
import { logger } from '@/lib/logger';
import { mark } from '@/lib/perf-marks';
import { supabase } from '@/lib/supabase';
import { generateTraceId } from '@/lib/trace';
import type { CatchUpItem } from '@/lib/catch-up/queue';

/** How long a burst of live thread replies waits before the one re-read. */
export const THREADS_LIVE_DEBOUNCE_MS = 1000;

/** The card key of a thread (the same key the inbox queue gives a thread). Pure. */
export function threadKey(channelId: string, rootId: string): string {
  return `thread:${channelId}:${rootId}`;
}

/**
 * The stand-in entry a thread card leads with: a chat mention in the thread at
 * its newest reply, already read (so no inbox id is ever written), by the
 * newest reply's sender. Pure.
 */
export function threadEntry(
  thread: ThreadForMeAll,
  workspaceId: string,
  selfId: string | null,
): ActivityItem {
  return mapEntry({
    id: threadKey(thread.channelId, thread.rootId),
    workspace_id: workspaceId,
    user_id: selfId ?? '',
    event_type: 'mention',
    entity_type: 'chat_channel',
    entity_id: thread.channelId,
    scope: 'chat',
    scope_key: null,
    tier: 'active',
    created_at: thread.lastReplyAt,
    read_at: thread.lastReplyAt,
    snoozed_until: null,
    deleted_at: null,
    email_sent_at: null,
    payload: { message_id: thread.lastReplyId, thread_root_id: thread.rootId },
    actor_user_id: thread.lastReplySender,
  });
}

function ms(at: string): number {
  const t = Date.parse(at);
  return Number.isNaN(t) ? 0 : t;
}

/** The unread threads, newest reply first (pre-launch threads already read by the loader). Pure. */
export function unreadThreads(threads: readonly ThreadForMeAll[]): ThreadForMeAll[] {
  return threads
    .filter((t) => t.unread)
    .sort((a, b) => ms(b.lastReplyAt) - ms(a.lastReplyAt) || (a.rootId < b.rootId ? -1 : 1));
}

/** The Threads button's count. Pure. */
export function unreadThreadCount(threads: readonly ThreadForMeAll[] | null): number {
  return threads === null ? 0 : threads.filter((t) => t.unread).length;
}

/**
 * The threads-only catch-up queue: one 'chat-thread' card per unread thread,
 * newest reply first, fixed when catch up opens. Pure.
 */
export function buildThreadsQueue(
  threads: readonly ThreadForMeAll[],
  input: { workspaceId: string; selfId: string | null },
): CatchUpItem[] {
  return unreadThreads(threads).map((thread) => {
    const lead = threadEntry(thread, input.workspaceId, input.selfId);
    return {
      key: threadKey(thread.channelId, thread.rootId),
      kind: 'chat-thread',
      entityId: thread.channelId,
      threadRootId: thread.rootId,
      workspaceId: input.workspaceId,
      lead,
      cardEntries: [lead],
      entries: [lead],
      latestAt: thread.lastReplyAt,
      source: 'threads',
    };
  });
}

// --- The per-workspace store ------------------------------------------------

const lists = new Map<string, ThreadForMeAll[]>();
const listeners = new Set<() => void>();
const inFlight = new Map<string, Promise<void>>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** Subscribe to any change of any workspace's list. */
export function subscribeThreads(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The list this device holds for a workspace; null before the first read. */
export function peekThreads(workspaceId: string | null): ThreadForMeAll[] | null {
  return workspaceId === null ? null : (lists.get(workspaceId) ?? null);
}

/** Replace a workspace's list (a read landed). */
export function setThreads(workspaceId: string, threads: ThreadForMeAll[]): void {
  lists.set(workspaceId, threads);
  emit();
}

/** Mark one thread read or unread in the held list (catch up's decision, or its rollback). */
export function patchThreadUnread(
  workspaceId: string,
  channelId: string,
  rootId: string,
  unread: boolean,
): void {
  const list = lists.get(workspaceId);
  if (list === undefined) return;
  let changed = false;
  const next = list.map((t) => {
    if (t.channelId !== channelId || t.rootId !== rootId || t.unread === unread) return t;
    changed = true;
    return { ...t, unread };
  });
  if (!changed) return;
  lists.set(workspaceId, next);
  emit();
}

/** The threads-only queue from the held list (empty before the first read). */
export function peekThreadsQueue(workspaceId: string, selfId: string | null): CatchUpItem[] {
  return buildThreadsQueue(lists.get(workspaceId) ?? [], { workspaceId, selfId });
}

/** Read a workspace's threads once (calls in flight are joined); a failure keeps the held list. */
export function refreshThreads(client: Client, workspaceId: string): Promise<void> {
  const running = inFlight.get(workspaceId);
  if (running !== undefined) return running;
  const traceId = generateTraceId();
  const run = loadThreadsForMeAll(client, workspaceId, traceId).then((res) => {
    inFlight.delete(workspaceId);
    if (!res.ok) {
      logger.warn('threads: read failed', { trace_id: traceId, error: res.error.message });
      return;
    }
    mark('activity:threads-read');
    setThreads(workspaceId, res.data);
  });
  inFlight.set(workspaceId, run);
  return run;
}

/** Test seam: forget every held list. */
export function resetThreadsStore(): void {
  lists.clear();
  inFlight.clear();
  emit();
}

/**
 * The Threads button's data: the held list (null before the first read). The
 * read starts in an effect, after the first paint, never awaited by it; a live
 * thread reply on the chat connection's existing fan-out re-reads it,
 * debounced.
 */
export function useWorkspaceThreads(workspaceId: string | null): ThreadForMeAll[] | null {
  const threads = useSyncExternalStore(
    subscribeThreads,
    () => peekThreads(workspaceId),
    () => peekThreads(workspaceId),
  );
  useEffect(() => {
    if (workspaceId === null) return undefined;
    void refreshThreads(supabase, workspaceId);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = subscribeGlobalMessages((message) => {
      if (parseLiveThreadRoot((message as { ext?: unknown }).ext) === null) return;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void refreshThreads(supabase, workspaceId);
      }, THREADS_LIVE_DEBOUNCE_MS);
    });
    return () => {
      off();
      if (timer !== null) clearTimeout(timer);
    };
  }, [workspaceId]);
  return threads;
}
