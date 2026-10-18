// The open chat's task list, for the thread (event lines, the composer button's
// dot) and the sheet. Reads: the channel's open items and the ones changed
// today, with its newest page of events, together, on open (a chat opened
// before this session paints its last list at once and revalidates), on the
// sheet opening, and on the tab turning visible after more than a minute away
// (the due timer has no live push). Events for older history are read down to
// the oldest loaded message, page after page, and the thread holds an older
// page until its events are in (covers), so its lines paint in the same commit
// as its rows. Tasks that event lines name but the list does not hold come
// from one IN read; names the thread's profiles lack from one profile read.
//
// Writes are optimistic with a fresh uuid_v7 trace id each: a saved edit (only
// its changed fields, one chat_task_save) shows at once and reverts if the
// record refuses it (the row then offers "Not saved · Retry"). Adds go through
// the add queue (add-queue.ts): one at a time in typed order, each one
// chat_task_create with its priority and due; a failure pauses it; a created
// item stays until the list holds its row. A delete hides the item at once
// behind an Undo toast (useUndoableAction); chat_task_delete runs only when the
// window ends. Only after the record accepts a write is a live Agora
// command sent (ext { sorted_event: 'task', channel_id, task_id }), exactly
// like marks; receivers re-read that one task and the events newer than their
// latest.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgoraChat } from 'agora-chat';
import type { Client } from '@srtdio/rpc';
import { supabase } from '@/lib/supabase';
import { logger } from '@/lib/logger';
import { generateTraceId } from '@/lib/trace';
import { useUndoableAction } from '@/lib/use-undoable-action';
import { readProfiles, type ChatProfile } from '@/lib/chat-reads';
import { useChat } from '@/lib/chat/chat-context';
import { createCmdMessage } from '@/lib/chat/message-factory';
import { sendSignal, type TypingConnection } from '@/lib/chat/typing';
import { parseLiveEvent, taskEventExt, type ChannelTarget } from '@/lib/chat/thread';
import type { ChatConnection, ChatContextValue } from '@/lib/chat/types';
import {
  applyTaskChanges,
  createTask,
  deleteTask,
  hasChanges,
  mergeEvents,
  readChannelTasks,
  readTask,
  readTaskEvents,
  readTasksByIds,
  saveTask,
  upsertTask,
  type ChatTask,
  type TaskChanges,
  type TaskEvent,
  type TaskPriority,
  type TaskSide,
} from '@/lib/chat/tasks';
import { announceTaskDueChanged } from '@/lib/chat/task-ring';
import {
  enqueue,
  markSending,
  nextToSend,
  reconcile,
  removeEntry,
  retryEntry,
  settleCreate,
  type PendingTask,
} from '@/components/chat/tasks/add-queue';

export type { PendingTask } from '@/components/chat/tasks/add-queue';

/** A refused save, kept so the row can retry it. */
export interface FailedWrite {
  changes: TaskChanges;
}

/** The Undo toast's title for a delete. */
export const TASK_DELETED_LABEL = 'Task deleted';

/** What the add row picked besides the title. */
export interface NewTaskOptions {
  priority?: TaskPriority;
  dueAt?: string | null;
}

export interface UseChatTasks {
  tasks: ChatTask[];
  /** Oldest first. */
  events: TaskEvent[];
  /** Every task an event line may name: the list plus older items read by id. */
  lineTasks: ReadonlyMap<string, ChatTask>;
  /** The open channel's first read settled (ok or not). */
  loaded: boolean;
  /**
   * Whether every event at or after this instant is read (a message at this
   * time can paint with its lines). True before the first read settles: the
   * open hold owns that wait.
   */
  covers: (ms: number) => boolean;
  /** Adds not yet in the list, in typed order. */
  pending: PendingTask[];
  /** Refused saves by task id. */
  failed: ReadonlyMap<string, FailedWrite>;
  /** A name for a user id: "You", a loaded profile, else "Member". */
  nameOf: (userId: string) => string;
  refetch: () => void;
  /** Older history loaded: read the events back to this instant (queued until the first read). */
  ensureEventsSince: (iso: string) => void;
  create: (side: TaskSide, title: string, number: number, options?: NewTaskOptions) => void;
  /** Save an edit: only the changed fields, one write. */
  save: (task: ChatTask, changes: TaskChanges) => void;
  retryField: (taskId: string) => void;
  /** Hide at once behind "Task deleted" / Undo; the delete runs when the window ends. */
  remove: (task: ChatTask) => void;
  /** Read one task the list does not hold (a line or alert for a closed item). */
  ensureTask: (taskId: string) => void;
  retryCreate: (key: string) => void;
  /** Drop a failed add (its x); the adds behind it go on. */
  removeCreate: (key: string) => void;
}

/** The SDK handler id of the task subscription. */
export const TASKS_EVENT_HANDLER_ID = 'chat-tasks';
/** Away this long, a visible tab re-reads the list (the due timer has no push). */
export const TASKS_STALE_MS = 60_000;
/** Most event pages one older-history read walks before it lets the page go. */
const MAX_EVENT_PAGES = 20;

interface TasksState {
  channelId: string | null;
  tasks: ChatTask[];
  events: TaskEvent[];
  /** Every event at or after this instant is read; -Infinity: all of them. */
  coveredFromMs: number;
  loaded: boolean;
}

interface Remembered {
  tasks: ChatTask[];
  events: TaskEvent[];
  coveredFromMs: number;
}

// The last list per user and chat, this session only: a reopen paints it at once.
const remembered = new Map<string, Remembered>();

/** The chat connection when a ChatProvider is mounted (the app), else null (unit tests). */
export function useChatOptional(): ChatContextValue | null {
  try {
    return useChat();
  } catch {
    return null;
  }
}

/** Subscribe to live task signals for one chat; returns the teardown. */
export function subscribeTaskEvents(
  connection: Pick<ChatConnection, 'addEventHandler' | 'removeEventHandler'>,
  channelId: string,
  onTask: (taskId: string) => void,
): () => void {
  const handler: AgoraChat.EventHandlerType = {
    onCmdMessage: (raw) => {
      const event = parseLiveEvent(raw.ext);
      if (event.kind === 'task' && event.channelId === channelId) onTask(event.taskId);
    },
  };
  connection.addEventHandler(TASKS_EVENT_HANDLER_ID, handler);
  return () => connection.removeEventHandler(TASKS_EVENT_HANDLER_ID);
}

function freshState(channelId: string | null, from: Remembered | undefined): TasksState {
  return {
    channelId,
    tasks: from?.tasks ?? [],
    events: from?.events ?? [],
    coveredFromMs: from?.coveredFromMs ?? Number.POSITIVE_INFINITY,
    loaded: from !== undefined,
  };
}

export function useChatTasks(params: {
  /** Null: no task list here (Personal notes, no chat). */
  channelId: string | null;
  currentUserId: string;
  target: ChannelTarget | null;
  profiles: ReadonlyMap<string, ChatProfile>;
  /** The workspace zone: "today" for the list read. */
  timeZone: string;
  /** Injected in tests; the app uses the shared Supabase client. */
  db?: Client;
}): UseChatTasks {
  const { channelId, currentUserId, target, profiles, timeZone } = params;
  const db: Client = params.db ?? supabase;
  const chat = useChatOptional();
  const connection = chat?.client ?? null;
  const memoKey = channelId !== null ? `${currentUserId}:${channelId}` : null;
  const initial = memoKey !== null ? remembered.get(memoKey) : undefined;
  const [state, setState] = useState<TasksState>(() => freshState(channelId, initial));
  // A switch renders the new chat's remembered list (or nothing) at once.
  let current = state;
  if (state.channelId !== channelId) {
    current = freshState(channelId, initial);
    setState(current);
  }
  const [pending, setPending] = useState<PendingTask[]>([]);
  const [failed, setFailed] = useState<Map<string, FailedWrite>>(new Map());
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [extra, setExtra] = useState<Map<string, ChatTask>>(new Map());
  // Deleted here, Undo window still open: hidden from every list.
  const [hidden, setHidden] = useState<Map<string, string>>(new Map());
  const undoable = useUndoableAction();

  const channelRef = useRef(channelId);
  channelRef.current = channelId;
  const stateRef = useRef(current);
  stateRef.current = current;
  const connectionRef = useRef(connection);
  connectionRef.current = connection;
  const targetRef = useRef(target);
  targetRef.current = target;
  const zoneRef = useRef(timeZone);
  zoneRef.current = timeZone;
  const requestedNames = useRef(new Set<string>());
  const requestedTasks = useRef(new Set<string>());
  // The oldest instant older history asked for (kept until the first read).
  const wantSinceRef = useRef<number | null>(null);
  const ensuringRef = useRef(false);
  // A created item whose row the follow-up read missed: the next open or
  // visible tick re-reads the list.
  const staleRef = useRef(false);
  const sendingRef = useRef<string | null>(null);

  const apply = useCallback(
    (forChannel: string, change: (prev: TasksState) => TasksState): void => {
      setState((prev) => {
        if (prev.channelId !== forChannel) return prev;
        const next = change(prev);
        if (next.loaded) {
          remembered.set(`${currentUserId}:${forChannel}`, {
            tasks: next.tasks,
            events: next.events,
            coveredFromMs: next.coveredFromMs,
          });
        }
        return next;
      });
    },
    [currentUserId],
  );

  /**
   * Read the events between what is covered and what older history asked for,
   * one page after another (a page is the newest 200 of the window), until the
   * window is read. A failed read releases the wait (the lines then come with
   * the next list read).
   */
  const runEnsure = useCallback(
    async (forChannel: string): Promise<void> => {
      if (ensuringRef.current) return;
      ensuringRef.current = true;
      let cover = stateRef.current.coveredFromMs;
      try {
        for (let page = 0; page < MAX_EVENT_PAGES; page += 1) {
          const want = wantSinceRef.current;
          if (channelRef.current !== forChannel || !stateRef.current.loaded) return;
          if (want === null || !(want < cover)) return;
          const res = await readTaskEvents(db, forChannel, {
            sinceIso: new Date(want - 1).toISOString(),
            untilIso: Number.isFinite(cover) ? new Date(cover).toISOString() : null,
          });
          if (channelRef.current !== forChannel) return;
          if (!res.ok) {
            logger.warn('chat: older task events failed', {
              channel_id: forChannel,
              error: res.error.message,
            });
            cover = Math.min(cover, want);
            apply(forChannel, (prev) => ({
              ...prev,
              coveredFromMs: Math.min(prev.coveredFromMs, want),
            }));
            return;
          }
          const oldest = res.data.events[0];
          const next = res.data.full && oldest !== undefined ? Date.parse(oldest.createdAt) : want;
          cover = Math.min(cover, next);
          const reached = cover;
          apply(forChannel, (prev) => ({
            ...prev,
            events: mergeEvents(prev.events, res.data.events),
            coveredFromMs: Math.min(prev.coveredFromMs, reached),
          }));
        }
        // The page cap: let the held page go rather than hold it.
        const want = wantSinceRef.current;
        if (want !== null) {
          apply(forChannel, (prev) => ({
            ...prev,
            coveredFromMs: Math.min(prev.coveredFromMs, want),
          }));
        }
      } finally {
        ensuringRef.current = false;
      }
    },
    [db, apply],
  );

  const load = useCallback(
    async (forChannel: string): Promise<void> => {
      const [tasks, events] = await Promise.all([
        readChannelTasks(db, forChannel, { nowMs: Date.now(), timeZone: zoneRef.current }),
        readTaskEvents(db, forChannel),
      ]);
      if (channelRef.current !== forChannel) return;
      if (!tasks.ok || !events.ok) {
        logger.warn('chat: tasks load failed', {
          channel_id: forChannel,
          error: !tasks.ok ? tasks.error.message : !events.ok ? events.error.message : '',
        });
        // Settled (nothing holds on it, no page waits), but not remembered as a list.
        setState((prev) =>
          prev.channelId === forChannel
            ? { ...prev, loaded: true, coveredFromMs: -Infinity }
            : prev,
        );
        return;
      }
      staleRef.current = false;
      const page = events.data;
      const oldest = page.events[0];
      const cover = page.full && oldest !== undefined ? Date.parse(oldest.createdAt) : -Infinity;
      stateRef.current = { ...stateRef.current, loaded: true, coveredFromMs: cover };
      apply(forChannel, (prev) => ({
        ...prev,
        tasks: tasks.data,
        // Older events already read stay (they are still true).
        events: mergeEvents(prev.events, page.events),
        coveredFromMs: cover,
        loaded: true,
      }));
      // Older history asked before this read (or reaches past it): read on down.
      void runEnsure(forChannel);
    },
    [db, apply, runEnsure],
  );

  useEffect(() => {
    setPending([]);
    setFailed(new Map());
    setExtra(new Map());
    setHidden(new Map());
    requestedTasks.current = new Set();
    wantSinceRef.current = null;
    staleRef.current = false;
    sendingRef.current = null;
    if (channelId !== null) void load(channelId);
  }, [channelId, load]);

  const refetch = useCallback((): void => {
    const forChannel = channelRef.current;
    if (forChannel !== null) void load(forChannel);
  }, [load]);

  // The due timer has no live push: a tab back after a minute re-reads (at
  // once when a created item still waits for its row).
  useEffect(() => {
    if (channelId === null) return;
    let hiddenAt: number | null = null;
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') {
        hiddenAt = Date.now();
        return;
      }
      const away = hiddenAt !== null && Date.now() - hiddenAt > TASKS_STALE_MS;
      if (away || staleRef.current) refetch();
      hiddenAt = null;
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [channelId, refetch]);

  /** Re-read one task and the events newer than the newest held; false when the task is not in. */
  const refreshOne = useCallback(
    async (taskId: string): Promise<boolean> => {
      const forChannel = channelRef.current;
      if (forChannel === null) return false;
      const newest = stateRef.current.events[stateRef.current.events.length - 1];
      const [task, events] = await Promise.all([
        readTask(db, taskId),
        readTaskEvents(db, forChannel, { sinceIso: newest?.createdAt ?? null }),
      ]);
      if (channelRef.current !== forChannel) return false;
      if (events.ok) {
        apply(forChannel, (prev) => ({
          ...prev,
          events: mergeEvents(prev.events, events.data.events),
        }));
      }
      if (task.ok && task.data === null) {
        // Gone from reads (deleted by a member): out of every list, its line keeps the number.
        const goneAt = new Date().toISOString();
        apply(forChannel, (prev) => ({
          ...prev,
          tasks: prev.tasks.map((t) =>
            t.id === taskId && t.deletedAt === null ? { ...t, deletedAt: goneAt } : t,
          ),
        }));
        return false;
      }
      if (!task.ok || task.data === null || task.data.channelId !== forChannel) {
        if (!task.ok)
          logger.warn('chat: task refresh failed', { task_id: taskId, error: task.error.message });
        return false;
      }
      const row = task.data;
      apply(forChannel, (prev) => ({ ...prev, tasks: upsertTask(prev.tasks, row) }));
      return true;
    },
    [db, apply],
  );

  const ensureEventsSince = useCallback(
    (iso: string): void => {
      const forChannel = channelRef.current;
      const ms = Date.parse(iso);
      if (forChannel === null || Number.isNaN(ms)) return;
      const want = wantSinceRef.current;
      wantSinceRef.current = want === null ? ms : Math.min(want, ms);
      // Before the first read this only queues; that read walks on down.
      if (stateRef.current.loaded) void runEnsure(forChannel);
    },
    [runEnsure],
  );

  useEffect(() => {
    if (connection === null || channelId === null) return;
    return subscribeTaskEvents(connection, channelId, (taskId) => void refreshOne(taskId));
  }, [connection, channelId, refreshOne]);

  /** Tell peers a task changed; never fails the write (they catch up on open). */
  const signal = useCallback((forChannel: string, taskId: string, traceId: string): void => {
    const live = connectionRef.current;
    const liveTarget = targetRef.current;
    if (live === null || liveTarget === null) return;
    void sendSignal({
      connection: live as TypingConnection,
      target: liveTarget,
      createCmd: createCmdMessage,
      ext: taskEventExt({ channelId: forChannel, taskId }),
    }).catch((error: unknown) =>
      logger.warn('chat: task signal failed', { trace_id: traceId, error: String(error) }),
    );
  }, []);

  const runSave = useCallback(
    async (task: ChatTask, changes: TaskChanges): Promise<void> => {
      if (!hasChanges(changes)) return;
      const forChannel = task.channelId;
      const traceId = generateTraceId();
      const before = stateRef.current.tasks.find((t) => t.id === task.id) ?? task;
      setFailed((prev) => {
        if (!prev.has(task.id)) return prev;
        const next = new Map(prev);
        next.delete(task.id);
        return next;
      });
      apply(forChannel, (prev) => ({
        ...prev,
        tasks: upsertTask(
          prev.tasks,
          applyTaskChanges(before, changes, currentUserId, new Date().toISOString()),
        ),
      }));
      const result = await saveTask({ client: db, taskId: task.id, changes, traceId });
      if (!result.ok) {
        logger.warn('chat: task save failed', {
          trace_id: traceId,
          task_id: task.id,
          fields: Object.keys(changes).join(','),
          error: result.message,
        });
        apply(forChannel, (prev) => ({ ...prev, tasks: upsertTask(prev.tasks, before) }));
        if (channelRef.current === forChannel) {
          setFailed((prev) => new Map(prev).set(task.id, { changes }));
        }
        return;
      }
      signal(forChannel, task.id, traceId);
      // The due ring (BellRing) re-arms for this device's new due time.
      if ('due' in changes || 'status' in changes) announceTaskDueChanged();
      await refreshOne(task.id);
    },
    [db, apply, currentUserId, signal, refreshOne],
  );

  const save = useCallback<UseChatTasks['save']>(
    (task, changes) => void runSave(task, changes),
    [runSave],
  );

  const retryField = useCallback<UseChatTasks['retryField']>(
    (taskId) => {
      const write = failed.get(taskId);
      const task = stateRef.current.tasks.find((t) => t.id === taskId);
      if (write === undefined || task === undefined) return;
      void runSave(task, write.changes);
    },
    [failed, runSave],
  );

  const unhide = useCallback((taskId: string): void => {
    setHidden((prev) => {
      if (!prev.has(taskId)) return prev;
      const next = new Map(prev);
      next.delete(taskId);
      return next;
    });
  }, []);

  const runUndoable = undoable.run;
  const remove = useCallback<UseChatTasks['remove']>(
    (task) => {
      const forChannel = task.channelId;
      const hiddenAt = new Date().toISOString();
      setHidden((prev) => new Map(prev).set(task.id, hiddenAt));
      runUndoable({
        label: TASK_DELETED_LABEL,
        commit: async () => {
          const traceId = generateTraceId();
          const result = await deleteTask({ client: db, taskId: task.id, traceId });
          if (!result.ok) {
            logger.warn('chat: task delete failed', {
              trace_id: traceId,
              task_id: task.id,
              error: result.message,
            });
            throw new Error(result.message);
          }
          // Recorded: the row itself carries the delete from here on.
          apply(forChannel, (prev) => ({
            ...prev,
            tasks: prev.tasks.map((t) => (t.id === task.id ? { ...t, deletedAt: hiddenAt } : t)),
          }));
          unhide(task.id);
          signal(forChannel, task.id, traceId);
          announceTaskDueChanged();
          await refreshOne(task.id);
        },
        revert: () => unhide(task.id),
      });
    },
    [db, apply, signal, refreshOne, unhide, runUndoable],
  );

  const ensureTask = useCallback<UseChatTasks['ensureTask']>(
    (taskId) => {
      const forChannel = channelRef.current;
      if (forChannel === null) return;
      if (stateRef.current.tasks.some((t) => t.id === taskId)) return;
      if (extra.has(taskId) || requestedTasks.current.has(taskId)) return;
      requestedTasks.current.add(taskId);
      void readTask(db, taskId).then((res) => {
        if (!res.ok) {
          // A later open may try again.
          requestedTasks.current.delete(taskId);
          logger.warn('chat: task read failed', { task_id: taskId, error: res.error.message });
          return;
        }
        const row = res.data;
        if (row === null || row.channelId !== forChannel || channelRef.current !== forChannel) {
          return;
        }
        setExtra((prev) => new Map(prev).set(row.id, row));
      });
    },
    [db, extra],
  );

  // The add queue's pump: one create at a time, in typed order; a failed head
  // holds the rest (add-queue.ts).
  useEffect(() => {
    const forChannel = channelId;
    if (forChannel === null || sendingRef.current !== null) return;
    const entry = nextToSend(pending);
    if (entry === null) return;
    sendingRef.current = entry.key;
    setPending((queue) => markSending(queue, entry.key));
    void (async () => {
      const traceId = generateTraceId();
      // One call carries title, priority and due: one chat line.
      const result = await createTask({
        client: db,
        channelId: forChannel,
        title: entry.title,
        side: entry.side,
        priority: entry.priority ?? 2,
        dueAt: entry.dueAt ?? null,
        traceId,
      });
      if (channelRef.current !== forChannel) return;
      sendingRef.current = null;
      if (!result.ok) {
        logger.warn('chat: task create failed', { trace_id: traceId, error: result.message });
        setPending((queue) => settleCreate(queue, entry.key, { ok: false }));
        return;
      }
      // Saved: the entry stays until the list holds the row, whatever the read does.
      setPending((queue) => settleCreate(queue, entry.key, { ok: true, id: result.data }));
      signal(forChannel, result.data, traceId);
      const listed = await refreshOne(result.data);
      if (!listed && channelRef.current === forChannel) staleRef.current = true;
    })();
  }, [pending, channelId, db, signal, refreshOne]);

  // A saved add leaves the queue once the list holds its row.
  const taskIds = useMemo(() => new Set(current.tasks.map((t) => t.id)), [current.tasks]);
  useEffect(() => {
    setPending((queue) => reconcile(queue, taskIds));
  }, [taskIds]);

  const create = useCallback<UseChatTasks['create']>((side, title, number, options) => {
    const trimmed = title.trim();
    if (channelRef.current === null || trimmed === '') return;
    setPending((queue) =>
      enqueue(queue, {
        key: generateTraceId(),
        side,
        title: trimmed,
        number,
        state: 'queued',
        priority: options?.priority ?? 2,
        dueAt: options?.dueAt ?? null,
      }),
    );
  }, []);

  const retryCreate = useCallback<UseChatTasks['retryCreate']>((key) => {
    setPending((queue) => retryEntry(queue, key));
  }, []);

  const removeCreate = useCallback<UseChatTasks['removeCreate']>((key) => {
    setPending((queue) => removeEntry(queue, key));
  }, []);

  // Tasks the event lines name that the list does not hold (closed before
  // today): one IN read per new batch.
  useEffect(() => {
    const forChannel = channelId;
    if (forChannel === null) return;
    const missing = [
      ...new Set(current.events.map((e) => e.taskId).filter((id) => !taskIds.has(id))),
    ].filter((id) => !requestedTasks.current.has(id));
    if (missing.length === 0) return;
    for (const id of missing) requestedTasks.current.add(id);
    void readTasksByIds(db, missing).then((res) => {
      if (!res.ok || channelRef.current !== forChannel) return;
      setExtra((prev) => {
        const next = new Map(prev);
        for (const t of res.data) next.set(t.id, t);
        return next;
      });
    });
  }, [current.events, taskIds, channelId, db]);

  // A delete in its Undo window reads as deleted everywhere (lists skip it).
  const tasks = useMemo(
    () =>
      hidden.size === 0
        ? current.tasks
        : current.tasks.map((t) => {
            const at = hidden.get(t.id);
            return at !== undefined && t.deletedAt === null ? { ...t, deletedAt: at } : t;
          }),
    [current.tasks, hidden],
  );

  const lineTasks = useMemo(() => {
    const map = new Map(extra);
    for (const [id, at] of hidden) {
      const t = map.get(id);
      if (t !== undefined && t.deletedAt === null) map.set(id, { ...t, deletedAt: at });
    }
    for (const t of tasks) map.set(t.id, t);
    return map;
  }, [extra, tasks, hidden]);

  // Names the thread's profiles lack (people who left, the due setter): one read.
  useEffect(() => {
    const ids = new Set<string>();
    for (const e of current.events) if (e.actorId !== null) ids.add(e.actorId);
    for (const t of current.tasks) if (t.dueSetBy !== null) ids.add(t.dueSetBy);
    const missing = [...ids].filter(
      (id) => id !== currentUserId && !profiles.has(id) && !requestedNames.current.has(id),
    );
    if (missing.length === 0) return;
    for (const id of missing) requestedNames.current.add(id);
    void readProfiles(db, missing).then((res) => {
      if (!res.ok) return;
      setNames((prev) => {
        const next = new Map(prev);
        for (const p of res.data) next.set(p.userId, p.displayName);
        return next;
      });
    });
  }, [current.events, current.tasks, profiles, currentUserId, db]);

  const nameOf = useCallback(
    (userId: string): string => {
      if (userId === currentUserId) return 'You';
      return profiles.get(userId)?.displayName ?? names.get(userId) ?? 'Member';
    },
    [currentUserId, profiles, names],
  );

  const coveredFromMs = current.coveredFromMs;
  const loaded = current.loaded;
  const covers = useCallback(
    (ms: number): boolean => !loaded || ms >= coveredFromMs,
    [loaded, coveredFromMs],
  );
  // A saved add whose row is already listed never shows twice.
  const shownPending = useMemo(
    () => pending.filter((p) => !(p.state === 'saved' && p.id !== undefined && taskIds.has(p.id))),
    [pending, taskIds],
  );

  return useMemo(
    () => ({
      tasks,
      events: current.events,
      lineTasks,
      loaded,
      covers,
      pending: shownPending,
      failed,
      nameOf,
      refetch,
      ensureEventsSince,
      create,
      save,
      retryField,
      remove,
      ensureTask,
      retryCreate,
      removeCreate,
    }),
    [
      tasks,
      current.events,
      lineTasks,
      loaded,
      covers,
      shownPending,
      failed,
      nameOf,
      refetch,
      ensureEventsSince,
      create,
      save,
      retryField,
      remove,
      ensureTask,
      retryCreate,
      removeCreate,
    ],
  );
}
