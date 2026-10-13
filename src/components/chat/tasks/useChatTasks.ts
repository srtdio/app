// The open chat's task list, for the thread (event lines, the composer button's
// dot) and the sheet. Reads: every task of the channel and its newest page of
// events, together, on open (a chat opened before this session paints its last
// list at once and revalidates), on the sheet opening, and on the tab turning
// visible after more than a minute away (the due timer has no live push).
// Older events load when older history does. Names the thread's profiles do
// not carry come from one batched profile read.
//
// Writes are optimistic with a fresh uuid_v7 trace id each: a field write
// shows at once and reverts if the record refuses it (the row then offers
// "Not saved · Retry"); adds queue in order, each showing at once with its
// preview number until the server row replaces it. Only after the record
// accepts a write is a live Agora command sent (ext { sorted_event: 'task',
// channel_id, task_id }), exactly like marks; receivers re-read that one task
// and the events newer than their latest.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgoraChat } from 'agora-chat';
import type { Client } from '@srtdio/rpc';
import { supabase } from '@/lib/supabase';
import { logger } from '@/lib/logger';
import { generateTraceId } from '@/lib/trace';
import { readProfiles, type ChatProfile } from '@/lib/chat-reads';
import { useChat } from '@/lib/chat/chat-context';
import { createCmdMessage } from '@/lib/chat/message-factory';
import { sendSignal, type TypingConnection } from '@/lib/chat/typing';
import { parseLiveEvent, taskEventExt, type ChannelTarget } from '@/lib/chat/thread';
import type { ChatConnection, ChatContextValue } from '@/lib/chat/types';
import {
  applyTaskField,
  createTask,
  mergeEvents,
  readChannelTasks,
  readTask,
  readTaskEvents,
  setTaskField,
  upsertTask,
  type ChatTask,
  type TaskEvent,
  type TaskField,
  type TaskSide,
} from '@/lib/chat/tasks';

/** An add shown before the server row exists. */
export interface PendingTask {
  key: string;
  side: TaskSide;
  title: string;
  /** The preview number it showed with. */
  number: number;
  failed: boolean;
}

/** A refused field write, kept so the row can retry it. */
export interface FailedWrite {
  field: TaskField;
  value: string;
}

export interface UseChatTasks {
  tasks: ChatTask[];
  /** Oldest first. */
  events: TaskEvent[];
  /** The open channel's first read settled (ok or not). */
  loaded: boolean;
  pending: PendingTask[];
  /** Refused field writes by task id. */
  failed: ReadonlyMap<string, FailedWrite>;
  /** A name for a user id: "You", a loaded profile, else "Member". */
  nameOf: (userId: string) => string;
  refetch: () => void;
  /** Older history loaded: make sure the events back to this instant are read. */
  ensureEventsSince: (iso: string) => void;
  create: (side: TaskSide, title: string, number: number) => void;
  setField: (task: ChatTask, field: TaskField, value: string) => void;
  retryField: (taskId: string) => void;
  retryCreate: (key: string) => void;
}

/** The SDK handler id of the task subscription. */
export const TASKS_EVENT_HANDLER_ID = 'chat-tasks';
/** Away this long, a visible tab re-reads the list (the due timer has no push). */
export const TASKS_STALE_MS = 60_000;

interface Remembered {
  tasks: ChatTask[];
  events: TaskEvent[];
  full: boolean;
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

export function useChatTasks(params: {
  /** Null: no task list here (Personal notes, no chat). */
  channelId: string | null;
  currentUserId: string;
  target: ChannelTarget | null;
  profiles: ReadonlyMap<string, ChatProfile>;
  /** Injected in tests; the app uses the shared Supabase client. */
  db?: Client;
}): UseChatTasks {
  const { channelId, currentUserId, target, profiles } = params;
  const db: Client = params.db ?? supabase;
  const chat = useChatOptional();
  const connection = chat?.client ?? null;
  const memoKey = channelId !== null ? `${currentUserId}:${channelId}` : null;
  const initial = memoKey !== null ? remembered.get(memoKey) : undefined;
  const [state, setState] = useState<{
    channelId: string | null;
    tasks: ChatTask[];
    events: TaskEvent[];
    full: boolean;
    loaded: boolean;
  }>(() => ({
    channelId,
    tasks: initial?.tasks ?? [],
    events: initial?.events ?? [],
    full: initial?.full ?? false,
    loaded: initial !== undefined,
  }));
  // A switch renders the new chat's remembered list (or nothing) at once.
  let current = state;
  if (state.channelId !== channelId) {
    current = {
      channelId,
      tasks: initial?.tasks ?? [],
      events: initial?.events ?? [],
      full: initial?.full ?? false,
      loaded: initial !== undefined,
    };
    setState(current);
  }
  const [pending, setPending] = useState<PendingTask[]>([]);
  const [failed, setFailed] = useState<Map<string, FailedWrite>>(new Map());
  const [names, setNames] = useState<Map<string, string>>(new Map());

  const channelRef = useRef(channelId);
  channelRef.current = channelId;
  const stateRef = useRef(current);
  stateRef.current = current;
  const connectionRef = useRef(connection);
  connectionRef.current = connection;
  const targetRef = useRef(target);
  targetRef.current = target;
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const requestedNames = useRef(new Set<string>());
  const oldestReadRef = useRef<string | null>(null);

  const apply = useCallback(
    (forChannel: string, change: (prev: typeof current) => typeof current): void => {
      setState((prev) => {
        if (prev.channelId !== forChannel) return prev;
        const next = change(prev);
        remembered.set(`${currentUserId}:${forChannel}`, {
          tasks: next.tasks,
          events: next.events,
          full: next.full,
        });
        return next;
      });
    },
    [currentUserId],
  );

  const load = useCallback(
    async (forChannel: string): Promise<void> => {
      const [tasks, events] = await Promise.all([
        readChannelTasks(db, forChannel),
        readTaskEvents(db, forChannel),
      ]);
      if (channelRef.current !== forChannel) return;
      if (!tasks.ok || !events.ok) {
        logger.warn('chat: tasks load failed', {
          channel_id: forChannel,
          error: !tasks.ok ? tasks.error.message : !events.ok ? events.error.message : '',
        });
        // Settled (the open never holds on it), but not remembered as a list.
        setState((prev) => (prev.channelId === forChannel ? { ...prev, loaded: true } : prev));
        return;
      }
      const page = events.data;
      oldestReadRef.current = page.events[0]?.createdAt ?? null;
      apply(forChannel, (prev) => ({
        ...prev,
        tasks: tasks.data,
        // Keep anything older already read (an earlier ensureEventsSince).
        events: mergeEvents(
          prev.events.filter(
            (e) =>
              page.events[0] === undefined ||
              Date.parse(e.createdAt) < Date.parse(page.events[0].createdAt),
          ),
          page.events,
        ),
        full: page.full,
        loaded: true,
      }));
    },
    [db, apply],
  );

  useEffect(() => {
    setPending([]);
    setFailed(new Map());
    oldestReadRef.current = null;
    if (channelId !== null) void load(channelId);
  }, [channelId, load]);

  const refetch = useCallback((): void => {
    const forChannel = channelRef.current;
    if (forChannel !== null) void load(forChannel);
  }, [load]);

  // The due timer has no live push: a tab back after a minute re-reads.
  useEffect(() => {
    if (channelId === null) return;
    let hiddenAt: number | null = null;
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') {
        hiddenAt = Date.now();
        return;
      }
      if (hiddenAt !== null && Date.now() - hiddenAt > TASKS_STALE_MS) refetch();
      hiddenAt = null;
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [channelId, refetch]);

  /** Re-read one task and the events newer than the newest held. */
  const refreshOne = useCallback(
    async (taskId: string): Promise<void> => {
      const forChannel = channelRef.current;
      if (forChannel === null) return;
      const newest = stateRef.current.events[stateRef.current.events.length - 1];
      const [task, events] = await Promise.all([
        readTask(db, taskId),
        readTaskEvents(db, forChannel, { sinceIso: newest?.createdAt ?? null }),
      ]);
      if (channelRef.current !== forChannel) return;
      if (!task.ok || !events.ok) {
        logger.warn('chat: task refresh failed', {
          task_id: taskId,
          error: !task.ok ? task.error.message : !events.ok ? events.error.message : '',
        });
        return;
      }
      const row = task.data;
      apply(forChannel, (prev) => ({
        ...prev,
        tasks:
          row !== null && row.channelId === forChannel ? upsertTask(prev.tasks, row) : prev.tasks,
        events: mergeEvents(prev.events, events.data.events),
      }));
    },
    [db, apply],
  );

  const ensureEventsSince = useCallback(
    (iso: string): void => {
      const forChannel = channelRef.current;
      const oldest = oldestReadRef.current;
      if (forChannel === null || !stateRef.current.full || oldest === null) return;
      if (!(Date.parse(iso) < Date.parse(oldest))) return;
      oldestReadRef.current = iso;
      void readTaskEvents(db, forChannel, { sinceIso: iso, untilIso: oldest }).then((res) => {
        if (channelRef.current !== forChannel || !res.ok) return;
        apply(forChannel, (prev) => ({
          ...prev,
          events: mergeEvents(prev.events, res.data.events),
        }));
      });
    },
    [db, apply],
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

  const runField = useCallback(
    async (task: ChatTask, field: TaskField, value: string): Promise<void> => {
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
          applyTaskField(before, field, value, currentUserId, new Date().toISOString()),
        ),
      }));
      const result = await setTaskField({ client: db, taskId: task.id, field, value, traceId });
      if (!result.ok) {
        logger.warn('chat: task write failed', {
          trace_id: traceId,
          task_id: task.id,
          field,
          error: result.message,
        });
        apply(forChannel, (prev) => ({ ...prev, tasks: upsertTask(prev.tasks, before) }));
        if (channelRef.current === forChannel) {
          setFailed((prev) => new Map(prev).set(task.id, { field, value }));
        }
        return;
      }
      signal(forChannel, task.id, traceId);
      await refreshOne(task.id);
    },
    [db, apply, currentUserId, signal, refreshOne],
  );

  const setField = useCallback<UseChatTasks['setField']>(
    (task, field, value) => void runField(task, field, value),
    [runField],
  );

  const retryField = useCallback<UseChatTasks['retryField']>(
    (taskId) => {
      const write = failed.get(taskId);
      const task = stateRef.current.tasks.find((t) => t.id === taskId);
      if (write === undefined || task === undefined) return;
      void runField(task, write.field, write.value);
    },
    [failed, runField],
  );

  const runCreate = useCallback(
    async (forChannel: string, entry: PendingTask): Promise<void> => {
      const traceId = generateTraceId();
      const result = await createTask({
        client: db,
        channelId: forChannel,
        title: entry.title,
        side: entry.side,
        traceId,
      });
      if (channelRef.current !== forChannel) return;
      if (!result.ok) {
        logger.warn('chat: task create failed', { trace_id: traceId, error: result.message });
        setPending((prev) => prev.map((p) => (p.key === entry.key ? { ...p, failed: true } : p)));
        return;
      }
      signal(forChannel, result.data, traceId);
      await refreshOne(result.data);
      setPending((prev) => prev.filter((p) => p.key !== entry.key));
    },
    [db, signal, refreshOne],
  );

  const enqueue = useCallback(
    (forChannel: string, entry: PendingTask): void => {
      // Adds record in the order they were typed, one at a time.
      queueRef.current = queueRef.current.then(() => runCreate(forChannel, entry));
    },
    [runCreate],
  );

  const create = useCallback<UseChatTasks['create']>(
    (side, title, number) => {
      const forChannel = channelRef.current;
      const trimmed = title.trim();
      if (forChannel === null || trimmed === '') return;
      const entry: PendingTask = {
        key: generateTraceId(),
        side,
        title: trimmed,
        number,
        failed: false,
      };
      setPending((prev) => [...prev, entry]);
      enqueue(forChannel, entry);
    },
    [enqueue],
  );

  const retryCreate = useCallback<UseChatTasks['retryCreate']>(
    (key) => {
      const forChannel = channelRef.current;
      const entry = pending.find((p) => p.key === key);
      if (forChannel === null || entry === undefined) return;
      setPending((prev) => prev.map((p) => (p.key === key ? { ...p, failed: false } : p)));
      enqueue(forChannel, { ...entry, failed: false });
    },
    [pending, enqueue],
  );

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

  return useMemo(
    () => ({
      tasks: current.tasks,
      events: current.events,
      loaded: current.loaded,
      pending,
      failed,
      nameOf,
      refetch,
      ensureEventsSince,
      create,
      setField,
      retryField,
      retryCreate,
    }),
    [
      current.tasks,
      current.events,
      current.loaded,
      pending,
      failed,
      nameOf,
      refetch,
      ensureEventsSince,
      create,
      setField,
      retryField,
      retryCreate,
    ],
  );
}
