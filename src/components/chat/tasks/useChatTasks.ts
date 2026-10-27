// The open chat's Tasks, for the thread (batch lines, the composer button's
// dot) and the sheet. Reads: the channel's live items with its newest page of
// events, together, on open (a chat opened before this session paints its last
// list at once and revalidates), on the sheet opening, on a live task signal
// and on the tab turning visible after more than a minute away. Events for
// older history are read down to the oldest loaded message, page after page,
// and the thread holds an older page until its events are in (covers), so its
// lines paint in the same commit as its rows. Deleted tasks that event lines
// name come from one IN read; names the thread's profiles lack from one
// profile read.
//
// The one write is a Save (saveBatch: chat_task_save_batch with a fresh
// uuid_v7 trace id): edits and deletes paint at once and revert if the record
// refuses the Save; the sheet keeps its draft for Retry. Edits whose task
// changed since the sheet synced it come back as conflicts. Once recorded, ONE
// live Agora command (ext { sorted_event: 'task', channel_id, task_id }) tells
// the other members, who re-read the list and the newer events.
//
// "Is editing": while this person's sheet holds unsaved changes, a live-only
// command (ext { sorted_event: 'task_editing', channel_id, state }) goes out on
// the first change and every EDITING_REFRESH_MS, and 'off' on Save, Discard or
// close. Receivers keep each sender for EDITING_TTL_MS after the last one.
// Nothing is stored; a failed send is only logged.

import { mark } from '@/lib/perf-marks';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgoraChat } from 'agora-chat';
import type { Client } from '@srtdio/rpc';
import { supabase } from '@/lib/supabase';
import { logger } from '@/lib/logger';
import { generateTraceId } from '@/lib/trace';
import { readProfiles, type ChatProfile } from '@/lib/chat-reads';
import { useChat } from '@/lib/chat/chat-context';
import { userIdFromAgoraUsername } from '@/lib/chat/agora-identity';
import { createCmdMessage } from '@/lib/chat/message-factory';
import {
  SIGNAL_ACTION,
  sendSignal,
  typingCmdIsStale,
  type TypingConnection,
} from '@/lib/chat/typing';
import {
  LIVE_EVENT_KEY,
  parseLiveEvent,
  sendRouted,
  taskEventExt,
  type ChannelTarget,
} from '@/lib/chat/thread';
import type { ChatConnection, ChatContextValue } from '@/lib/chat/types';
import {
  applyChanges,
  editingSignalStep,
  isEmptyPayload,
  liveEditors,
  mergeEvents,
  readChannelTasks,
  readTaskEvents,
  readTasksByIds,
  saveTaskBatch,
  type BatchPayload,
  type ChatTask,
  type TaskConflict,
  type TaskEvent,
} from '@/lib/chat/tasks';

/** The list read: in flight with nothing to show, failed with nothing to show, or a list. */
export type TasksLoadState = 'loading' | 'failed' | 'ready';

/** What a Save came back with. */
export type SaveOutcome =
  | { ok: true; createdIds: string[]; conflicts: TaskConflict[]; batchId: string | null }
  | { ok: false };

export interface UseChatTasks {
  /** The live list (never a deleted task), by number. */
  tasks: ChatTask[];
  /** Oldest first. */
  events: TaskEvent[];
  /** Every task an event line may name: the list plus deleted items read by id. */
  lineTasks: ReadonlyMap<string, ChatTask>;
  /** The open channel's first read settled (ok or not). */
  loaded: boolean;
  /** Whether the list can show: 'ready' once a read succeeded (or a remembered list). */
  loadState: TasksLoadState;
  /** A Retry of a failed list read is in flight. */
  retrying: boolean;
  /**
   * Whether every event at or after this instant is read (a message at this
   * time can paint with its lines). True before the first read settles.
   */
  covers: (ms: number) => boolean;
  /** A name for a user id: "You", a loaded profile, else "Member". */
  nameOf: (userId: string) => string;
  refetch: () => void;
  /** Older history loaded: read the events back to this instant (queued until the first read). */
  ensureEventsSince: (iso: string) => void;
  /** One Save: creates, edits and deletes in one chat_task_save_batch. */
  saveBatch: (payload: BatchPayload) => Promise<SaveOutcome>;
  /** Other members whose sheet holds unsaved changes right now (user ids). */
  editors: string[];
  /** This sheet holds unsaved changes (true) or not (false); drives the live signal. */
  setEditing: (dirty: boolean) => void;
}

/** The SDK handler id of the task subscription. */
const TASKS_EVENT_HANDLER_ID = 'chat-tasks';
/** Away this long, a visible tab re-reads the list. */
const TASKS_STALE_MS = 60_000;
/** The live "is editing" command's event name. */
const TASK_EDITING_EVENT = 'task_editing';
/** Most event pages one older-history read walks before it lets the page go. */
const MAX_EVENT_PAGES = 20;

interface TasksState {
  channelId: string | null;
  tasks: ChatTask[];
  events: TaskEvent[];
  /** Every event at or after this instant is read; -Infinity: all of them. */
  coveredFromMs: number;
  loaded: boolean;
  listOk: boolean;
  readFailed: boolean;
}

interface Remembered {
  tasks: ChatTask[];
  events: TaskEvent[];
  coveredFromMs: number;
}

// The last list per user and chat, this session only: a reopen paints it at once.
const remembered = new Map<string, Remembered>();

/** The chat connection when a ChatProvider is mounted (the app), else null (unit tests). */
function useChatOptional(): ChatContextValue | null {
  try {
    return useChat();
  } catch {
    return null;
  }
}

/** A live "is editing" command read off a cmd's ext; null for anything else. Pure. */
function parseEditingSignal(ext: unknown, channelId: string): { editing: boolean } | null {
  if (typeof ext !== 'object' || ext === null) return null;
  const r = ext as Record<string, unknown>;
  if (r[LIVE_EVENT_KEY] !== TASK_EDITING_EVENT || r.channel_id !== channelId) return null;
  return { editing: r.state === 'on' };
}

/** The ext of a live "is editing" command. Pure. */
function editingSignalExt(channelId: string, editing: boolean): Record<string, unknown> {
  return {
    [LIVE_EVENT_KEY]: TASK_EDITING_EVENT,
    channel_id: channelId,
    state: editing ? 'on' : 'off',
  };
}

/** Subscribe to live task signals for one chat; returns the teardown. */
function subscribeTaskEvents(params: {
  connection: Pick<ChatConnection, 'addEventHandler' | 'removeEventHandler'>;
  channelId: string;
  currentUserId: string;
  onTask: () => void;
  onEditing: (userId: string, editing: boolean) => void;
}): () => void {
  const { connection, channelId, currentUserId } = params;
  const handler: AgoraChat.EventHandlerType = {
    onCmdMessage: (raw) => {
      const event = parseLiveEvent(raw.ext);
      if (event.kind === 'task' && event.channelId === channelId) {
        params.onTask();
        return;
      }
      const editing = parseEditingSignal(raw.ext, channelId);
      if (editing === null || raw.from === undefined) return;
      if (typingCmdIsStale((raw as { time?: unknown }).time, Date.now())) return;
      const from = userIdFromAgoraUsername(raw.from);
      if (from.ok && from.userId !== currentUserId) params.onEditing(from.userId, editing.editing);
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
    listOk: from !== undefined,
    readFailed: false,
  };
}

/** The list with a payload's edits and deletes painted (creates wait for their rows). Pure. */
function paintPayload(tasks: readonly ChatTask[], payload: BatchPayload): ChatTask[] {
  const deleting = new Set(payload.deletes.map((d) => d.task_id));
  const edits = new Map(payload.edits.map((e) => [e.task_id, e.changes] as const));
  return tasks
    .filter((t) => !deleting.has(t.id))
    .map((t) => {
      const changes = edits.get(t.id);
      return changes === undefined ? t : applyChanges(t, changes);
    });
}

export function useChatTasks(params: {
  /** Null: no Tasks here (Personal notes, no chat). */
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
  const [state, setState] = useState<TasksState>(() => freshState(channelId, initial));
  // A switch renders the new chat's remembered list (or nothing) at once.
  let current = state;
  if (state.channelId !== channelId) {
    current = freshState(channelId, initial);
    setState(current);
  }
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [extra, setExtra] = useState<Map<string, ChatTask>>(new Map());
  const [retrying, setRetrying] = useState(false);
  const [heard, setHeard] = useState<Map<string, number>>(new Map());
  const [nowMs, setNowMs] = useState(() => Date.now());

  const channelRef = useRef(channelId);
  channelRef.current = channelId;
  const stateRef = useRef(current);
  stateRef.current = current;
  const connectionRef = useRef(connection);
  connectionRef.current = connection;
  const targetRef = useRef(target);
  targetRef.current = target;
  const requestedNames = useRef(new Set<string>());
  const requestedTasks = useRef(new Set<string>());
  const wantSinceRef = useRef<number | null>(null);
  const ensuringRef = useRef(false);

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

  /** Read older events page by page down to what older history asked for. */
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
    async (forChannel: string): Promise<boolean> => {
      const [tasks, events] = await Promise.all([
        readChannelTasks(db, forChannel),
        readTaskEvents(db, forChannel),
      ]);
      mark('chat:tasks:loaded');
      if (channelRef.current !== forChannel) return false;
      if (!tasks.ok || !events.ok) {
        logger.warn('chat: tasks load failed', {
          channel_id: forChannel,
          error: !tasks.ok ? tasks.error.message : !events.ok ? events.error.message : '',
        });
        setState((prev) =>
          prev.channelId === forChannel
            ? { ...prev, loaded: true, coveredFromMs: -Infinity, readFailed: true }
            : prev,
        );
        return false;
      }
      const page = events.data;
      const oldest = page.events[0];
      const cover = page.full && oldest !== undefined ? Date.parse(oldest.createdAt) : -Infinity;
      stateRef.current = {
        ...stateRef.current,
        loaded: true,
        coveredFromMs: cover,
        listOk: true,
        readFailed: false,
      };
      apply(forChannel, (prev) => ({
        ...prev,
        tasks: tasks.data,
        events: mergeEvents(prev.events, page.events),
        coveredFromMs: Math.min(prev.coveredFromMs, cover),
        loaded: true,
        listOk: true,
        readFailed: false,
      }));
      void runEnsure(forChannel);
      return true;
    },
    [db, apply, runEnsure],
  );

  useEffect(() => {
    setExtra(new Map());
    setHeard(new Map());
    requestedTasks.current = new Set();
    wantSinceRef.current = null;
    if (channelId !== null) void load(channelId);
  }, [channelId, load]);

  const refetch = useCallback((): void => {
    const forChannel = channelRef.current;
    if (forChannel === null) return;
    const retry = stateRef.current.readFailed && !stateRef.current.listOk;
    if (retry) setRetrying(true);
    void load(forChannel).finally(() => {
      if (retry) setRetrying(false);
    });
  }, [load]);

  // A tab back after a minute re-reads.
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

  const ensureEventsSince = useCallback(
    (iso: string): void => {
      const forChannel = channelRef.current;
      const ms = Date.parse(iso);
      if (forChannel === null || Number.isNaN(ms)) return;
      const want = wantSinceRef.current;
      wantSinceRef.current = want === null ? ms : Math.min(want, ms);
      if (stateRef.current.loaded) void runEnsure(forChannel);
    },
    [runEnsure],
  );

  const onEditing = useCallback((userId: string, editing: boolean): void => {
    setHeard((prev) => {
      const next = new Map(prev);
      if (editing) next.set(userId, Date.now());
      else next.delete(userId);
      return next;
    });
    setNowMs(Date.now());
  }, []);

  useEffect(() => {
    if (connection === null || channelId === null) return;
    return subscribeTaskEvents({
      connection,
      channelId,
      currentUserId,
      onTask: () => {
        // A Save there: its sender is done editing.
        refetch();
      },
      onEditing,
    });
  }, [connection, channelId, currentUserId, refetch, onEditing]);

  // Drop editors whose signal went quiet (one tick a second while any are held).
  useEffect(() => {
    if (heard.size === 0) return;
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [heard.size]);

  /** Tell peers the list changed; never fails the write (they catch up on open). */
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

  /** The live-only "is editing" command (never queued for an offline peer). */
  const sendEditing = useCallback((forChannel: string, editing: boolean): void => {
    const live = connectionRef.current;
    const liveTarget = targetRef.current;
    if (live === null || liveTarget === null) return;
    void sendRouted(live as TypingConnection, liveTarget, (to, chatType) =>
      createCmdMessage({
        chatType,
        type: 'cmd',
        to,
        action: SIGNAL_ACTION,
        ext: editingSignalExt(forChannel, editing),
        deliverOnlineOnly: true,
      }),
    ).catch((error: unknown) =>
      logger.warn('chat: task editing signal failed', { error: String(error) }),
    );
  }, []);

  // The sender's timing (editingSignalStep): start, refresh while dirty, stop.
  const [dirty, setDirty] = useState(false);
  const lastSentRef = useRef<number | null>(null);
  useEffect(() => {
    const forChannel = channelId;
    if (forChannel === null) return;
    const step = (): void => {
      const now = Date.now();
      const what = editingSignalStep({ dirty, lastSentMs: lastSentRef.current, nowMs: now });
      if (what === 'start' || what === 'refresh') {
        lastSentRef.current = now;
        sendEditing(forChannel, true);
      } else if (what === 'stop') {
        lastSentRef.current = null;
        sendEditing(forChannel, false);
      }
    };
    step();
    if (!dirty) return;
    const timer = setInterval(step, 1000);
    return () => clearInterval(timer);
  }, [dirty, channelId, sendEditing]);
  // Leaving the chat (or unmounting) while editing says stop.
  useEffect(
    () => () => {
      if (channelId !== null && lastSentRef.current !== null) {
        lastSentRef.current = null;
        sendEditing(channelId, false);
      }
    },
    [channelId, sendEditing],
  );
  const setEditing = useCallback((value: boolean) => setDirty(value), []);

  const saveBatch = useCallback<UseChatTasks['saveBatch']>(
    async (payload) => {
      const forChannel = channelRef.current;
      if (forChannel === null || isEmptyPayload(payload)) return { ok: false };
      const traceId = generateTraceId();
      const before = stateRef.current.tasks;
      apply(forChannel, (prev) => ({ ...prev, tasks: paintPayload(prev.tasks, payload) }));
      const result = await saveTaskBatch({ client: db, channelId: forChannel, payload, traceId });
      if (!result.ok) {
        logger.warn('chat: task save failed', {
          trace_id: traceId,
          creates: payload.creates.length,
          edits: payload.edits.length,
          deletes: payload.deletes.length,
          error: result.message,
        });
        apply(forChannel, (prev) => ({ ...prev, tasks: before }));
        return { ok: false };
      }
      const { batchId, createdIds, conflicts } = result.data;
      if (channelRef.current === forChannel) {
        const first =
          createdIds[0] ?? payload.edits[0]?.task_id ?? payload.deletes[0]?.task_id ?? null;
        if (batchId !== null && first !== null) signal(forChannel, first, traceId);
        // The rows, the conflicts' current values and the batch line arrive together.
        await load(forChannel);
      }
      return { ok: true, createdIds, conflicts, batchId };
    },
    [db, apply, signal, load],
  );

  // Tasks the event lines name that the list does not hold (deleted): one IN read per new batch.
  const taskIds = useMemo(() => new Set(current.tasks.map((t) => t.id)), [current.tasks]);
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

  const lineTasks = useMemo(() => {
    const map = new Map(extra);
    for (const t of current.tasks) map.set(t.id, t);
    return map;
  }, [extra, current.tasks]);

  // Names the thread's profiles lack (people who left): one read.
  useEffect(() => {
    const ids = new Set<string>();
    for (const e of current.events) if (e.actorId !== null) ids.add(e.actorId);
    for (const id of heard.keys()) ids.add(id);
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
  }, [current.events, heard, profiles, currentUserId, db]);

  const nameOf = useCallback(
    (userId: string): string => {
      if (userId === currentUserId) return 'You';
      return profiles.get(userId)?.displayName ?? names.get(userId) ?? 'Member';
    },
    [currentUserId, profiles, names],
  );

  const coveredFromMs = current.coveredFromMs;
  const loaded = current.loaded;
  const loadState: TasksLoadState = current.listOk
    ? 'ready'
    : current.readFailed
      ? 'failed'
      : 'loading';
  const visibleTasks = useMemo(
    () => current.tasks.filter((t) => t.deletedAt == null).sort((a, b) => a.number - b.number),
    [current.tasks],
  );
  const covers = useCallback(
    (ms: number): boolean => !loaded || ms >= coveredFromMs,
    [loaded, coveredFromMs],
  );
  const editorIds = liveEditors(heard, nowMs);
  const editorsKey = editorIds.join(',');
  const editors = useMemo(() => (editorsKey === '' ? [] : editorsKey.split(',')), [editorsKey]);

  return useMemo(
    () => ({
      tasks: visibleTasks,
      events: current.events,
      lineTasks,
      loaded,
      loadState,
      retrying,
      covers,
      nameOf,
      refetch,
      ensureEventsSince,
      saveBatch,
      editors,
      setEditing,
    }),
    [
      visibleTasks,
      current.events,
      lineTasks,
      loaded,
      loadState,
      retrying,
      covers,
      nameOf,
      refetch,
      ensureEventsSince,
      saveBatch,
      editors,
      setEditing,
    ],
  );
}
