// The chat's message reminders, mounted by ChatConnected around the chat
// surface: the viewer's pending reminders (reminders.ts) and the reminder
// sheet "Remind me" opens from a message's action menu (a new reminder, or
// change mode with "Cancel reminder" when one is pending on that message).
//
// The message menu reads a message's pending reminder from the already-loaded
// list (pendingReminderFor, no per-message read). A set or cancel shows there
// at once: the write's outcome is held locally until the reload lands.
//
// Data: one load on mount, then a reload when the tab becomes visible and on
// every REMINDERS_CHANGED_EVENT (a write here, a ring, the shell's inbox poll
// tick). Write failures toast "Couldn't do that. Try again."; a "message not
// found" (deleted meanwhile) stays silent. Every listener and in-flight read is
// dropped on unmount.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactElement, ReactNode } from 'react';
import type { Client } from '@srtdio/rpc';
import { supabase } from '@/lib/supabase';
import { logger } from '@/lib/logger';
import { generateTraceId } from '@/lib/trace';
import { newMessageId } from '@/lib/chat/message-id';
import type { NameOf } from '@/lib/chat/mentions';
import type { ThreadMessage } from '@/lib/chat/thread';
import { MESSAGE_LABEL, messagePreview } from '@/lib/inbox/alerts';
import {
  ACTION_FAILED_COPY,
  REMINDERS_CHANGED_EVENT,
  announceRemindersChanged,
  cancelReminder,
  mapReminderError,
  readPendingReminders,
  reminderSetCopy,
  setReminder,
  type ReminderRow,
} from '@/lib/chat/reminders';
import { useToast } from '@/components/ui/toast';

/** The toast after "Cancel reminder" in the change-mode sheet. */
export const REMINDER_CANCELLED_COPY = 'Reminder cancelled';

/** What the reminder sheet is for: a new reminder on a message, or a new time for one. */
export type ReminderTarget =
  | { mode: 'new'; messageId: string; channelId: string; preview: string }
  | { mode: 'change'; reminder: ReminderRow; preview: string };

export interface ReminderContextValue {
  canRemind: (messageId: string) => boolean;
  /** Opens the sheet: a new reminder, or change mode when one is pending on the message. */
  openReminderFor: (messageId: string) => void;
  /** The viewer's pending reminder on a message, from the loaded list; null when none. */
  pendingReminderFor: (messageId: string) => ReminderRow | null;
  /** The change-mode sheet's "Cancel reminder": cancels the target, toasts "Reminder cancelled". */
  cancelReminderFromSheet: () => Promise<void>;
  /** The sheet ChatReminderSheet shows (null: closed). */
  reminderTarget: ReminderTarget | null;
  closeReminder: () => void;
  pickReminderTime: (at: Date) => Promise<void>;
}

const ReminderContext = createContext<ReminderContextValue | null>(null);

/** The raw provider: ReminderProvider uses it; tests hand it a fixed value. */
export const ReminderValueProvider = ReminderContext.Provider;

/** The reminders, or null outside a ReminderProvider (the menu renders without it in tests). */
export function useReminderOptional(): ReminderContextValue | null {
  return useContext(ReminderContext);
}

/** What the reminder writes need: injected so tests drive them with a recording client. */
export interface ReminderActionDeps {
  client: Client;
  newTraceId: () => string;
  /** A fresh uuid_v7 for chat_reminder_set. */
  newId: () => string;
  /** Log a failure; toast `copy` (default "Couldn't do that. Try again."), null stays silent. */
  failed: (what: string, traceId: string, message: string, copy?: string | null) => void;
  notify: (title: string) => void;
  /** Every reminder reader reloads (the ring, this provider). */
  remindersChanged: () => void;
  /**
   * A reminder write landed: the message's pending reminder is now `next`
   * (null: none), shown at once until the reload brings the stored rows.
   */
  reminderChanged: (
    messageId: string,
    next: { id: string; channelId: string; remindAt: Date } | null,
  ) => void;
}

export interface ReminderActions {
  setReminderAt: (target: { messageId: string; channelId: string }, at: Date) => Promise<void>;
  /** Resolves true when the reminder was cancelled. */
  cancelReminder: (reminder: ReminderRow) => Promise<boolean>;
}

/**
 * The reminder writes. Each mints a trace id, calls its proc (p_trace_id
 * explicit) and asks every reader to reload; on failure it logs and toasts the
 * mapped copy.
 */
export function createReminderActions(deps: ReminderActionDeps): ReminderActions {
  return {
    async setReminderAt(target, at) {
      const traceId = deps.newTraceId();
      // A new id every time: the proc ignores an id it already holds and
      // replaces the pending reminder on the same message (Change time).
      const id = deps.newId();
      const res = await setReminder({
        client: deps.client,
        id,
        messageId: target.messageId,
        channelId: target.channelId,
        remindAt: at,
        traceId,
      });
      if (res.ok) {
        deps.reminderChanged(target.messageId, { id, channelId: target.channelId, remindAt: at });
        deps.notify(reminderSetCopy(at, new Date()));
      } else deps.failed('reminder set', traceId, res.message, mapReminderError(res.message));
      deps.remindersChanged();
    },
    async cancelReminder(reminder) {
      const traceId = deps.newTraceId();
      const res = await cancelReminder({ client: deps.client, id: reminder.id, traceId });
      if (!res.ok) deps.failed('reminder cancel', traceId, res.message);
      else deps.reminderChanged(reminder.message_id, null);
      deps.remindersChanged();
      return res.ok;
    },
  };
}

export function ReminderProvider(props: {
  workspaceId: string;
  currentUserId: string;
  /** The open chat and its loaded messages: Remind me and its preview read them. */
  openChannelId: string | null;
  messages: readonly ThreadMessage[];
  nameOf: NameOf;
  children: ReactNode;
}): ReactElement {
  const { workspaceId, currentUserId } = props;
  const toast = useToast();
  const [reminders, setReminders] = useState<readonly ReminderRow[]>([]);
  const [reminderTarget, setReminderTarget] = useState<ReminderTarget | null>(null);
  // Reminder writes not yet in a reload, by message id (null: cancelled).
  const [localReminders, setLocalReminders] = useState<ReadonlyMap<string, ReminderRow | null>>(
    new Map(),
  );

  const mountedRef = useRef(true);
  const seqRef = useRef(0);
  const messagesRef = useRef(props.messages);
  messagesRef.current = props.messages;
  const openChannelRef = useRef(props.openChannelId);
  openChannelRef.current = props.openChannelId;
  const nameOfRef = useRef(props.nameOf);
  nameOfRef.current = props.nameOf;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const reload = useCallback((): void => {
    seqRef.current += 1;
    const seq = seqRef.current;
    void readPendingReminders(supabase, { workspaceId }).then((res) => {
      if (!mountedRef.current || seq !== seqRef.current) return;
      if (!res.ok) {
        // A failed reload keeps what is loaded (and any write held locally).
        logger.warn('reminders: load failed', { error: res.error.message });
        return;
      }
      setReminders(res.data);
      setLocalReminders(new Map());
    });
  }, [workspaceId]);

  // First load, a fresh one on a workspace switch, then the tab becoming
  // visible and every "reminders changed" reload.
  useEffect(() => {
    setReminders([]);
    reload();
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') reload();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener(REMINDERS_CHANGED_EVENT, reload);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener(REMINDERS_CHANGED_EVENT, reload);
    };
  }, [reload]);

  const actions = useMemo(
    () =>
      createReminderActions({
        client: supabase,
        newTraceId: generateTraceId,
        newId: newMessageId,
        failed: (what, traceId, message, copy = ACTION_FAILED_COPY) => {
          logger.warn(`reminders: ${what} failed`, { trace_id: traceId, error: message });
          if (copy !== null) toast.show({ title: copy });
        },
        notify: (title) => toast.show({ title }),
        remindersChanged: announceRemindersChanged,
        reminderChanged: (messageId, next) =>
          setLocalReminders((prev) =>
            new Map(prev).set(
              messageId,
              next === null
                ? null
                : {
                    id: next.id,
                    user_id: currentUserId,
                    message_id: messageId,
                    channel_id: next.channelId,
                    workspace_id: workspaceId,
                    remind_at: next.remindAt.toISOString(),
                    fired_at: null,
                    cancelled_at: null,
                    created_at: new Date().toISOString(),
                  },
            ),
          ),
      }),
    [workspaceId, currentUserId, toast],
  );

  const previewOfMessage = useCallback((messageId: string): string => {
    const m = messagesRef.current.find((x) => x.id === messageId);
    if (m === undefined) return MESSAGE_LABEL;
    return messagePreview(
      {
        id: m.id,
        channelId: openChannelRef.current ?? '',
        senderUserId: m.senderUserId,
        body: m.body,
        hasAttachments: m.attachments.length > 0,
        hasPosts: m.sharedPostIds.length > 0,
        hasBriefs: m.sharedBriefIds.length > 0,
        hasPlans: (m.sharedPlanIds ?? []).length > 0,
      },
      nameOfRef.current,
    );
  }, []);

  const canRemind = useCallback((messageId: string): boolean => {
    const m = messagesRef.current.find((x) => x.id === messageId);
    return (
      openChannelRef.current !== null &&
      m !== undefined &&
      m.state === 'sent' &&
      m.deleted !== true &&
      m.createdAt !== ''
    );
  }, []);

  const pendingReminderFor = useCallback(
    (messageId: string): ReminderRow | null => {
      const local = localReminders.get(messageId);
      if (local !== undefined) return local;
      return (
        reminders.find(
          (r) => r.message_id === messageId && r.fired_at === null && r.cancelled_at === null,
        ) ?? null
      );
    },
    [reminders, localReminders],
  );

  const openReminderFor = useCallback(
    (messageId: string): void => {
      const channelId = openChannelRef.current;
      if (channelId === null) return;
      const preview = previewOfMessage(messageId);
      const pending = pendingReminderFor(messageId);
      setReminderTarget(
        pending !== null
          ? { mode: 'change', reminder: pending, preview }
          : { mode: 'new', messageId, channelId, preview },
      );
    },
    [previewOfMessage, pendingReminderFor],
  );

  const pickReminderTime = useCallback(
    async (at: Date): Promise<void> => {
      const target = reminderTarget;
      setReminderTarget(null);
      if (target === null) return;
      await actions.setReminderAt(
        target.mode === 'new'
          ? { messageId: target.messageId, channelId: target.channelId }
          : { messageId: target.reminder.message_id, channelId: target.reminder.channel_id },
        at,
      );
    },
    [reminderTarget, actions],
  );

  const cancelReminderFromSheet = useCallback(async (): Promise<void> => {
    const target = reminderTarget;
    setReminderTarget(null);
    if (target === null || target.mode !== 'change') return;
    if (await actions.cancelReminder(target.reminder))
      toast.show({ title: REMINDER_CANCELLED_COPY });
  }, [reminderTarget, actions, toast]);

  const closeReminder = useCallback((): void => setReminderTarget(null), []);

  const value = useMemo<ReminderContextValue>(
    () => ({
      canRemind,
      openReminderFor,
      pendingReminderFor,
      cancelReminderFromSheet,
      reminderTarget,
      closeReminder,
      pickReminderTime,
    }),
    [
      canRemind,
      openReminderFor,
      pendingReminderFor,
      cancelReminderFromSheet,
      reminderTarget,
      closeReminder,
      pickReminderTime,
    ],
  );

  return <ReminderContext.Provider value={value}>{props.children}</ReminderContext.Provider>;
}
