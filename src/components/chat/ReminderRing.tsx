// The reminder ring, mounted once at the shell (InboxStoreProvider) so it runs
// on every page from app start. It renders nothing.
//
// - Loads the user's pending reminders (and their message previews, one IN
//   read each) on mount, when the tab becomes visible and whenever the pending
//   reminders may have changed (REMINDERS_CHANGED_EVENT: a reminder set, moved
//   or cancelled on this device, and the shell's inbox poll tick).
// - Arms ONE timeout for the next due reminder. On the minute it shows the
//   toast "Reminder: <preview>" (tap opens the chat at that message) and plays
//   the chime three times over about 5 s; tapping or dismissing the toast
//   stops the chime. The chat's Remind me reloads.
// - Missed on open: unread 'reminder' rows created after this device's last
//   seen moment (localStorage, try/catch) give one chime and the toast
//   "You missed N reminders"; tapping it opens Notifications.
// - The AudioContext is created on the first pointerdown or keydown, never
//   before (iPhone plays on the first tap after open).
// Every timer, listener and the AudioContext are released on unmount.

import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { logger } from '@/lib/logger';
import { readProfiles } from '@/lib/chat-reads';
import { mentionIds } from '@/lib/chat/mentions';
import { createChime, type Chime } from '@/lib/chat/chime';
import { messagePreview, readChatMessages, type ChatMessagePreview } from '@/lib/inbox/alerts';
import {
  REMINDERS_CHANGED_EVENT,
  announceRemindersChanged,
  armRing,
  missedCopy,
  missedCount,
  readLastSeen,
  readPendingReminders,
  readRung,
  readUnreadRemindersSince,
  writeLastSeen,
  writeRung,
  type ReminderRow,
} from '@/lib/chat/reminders';
import { chatMessageHref } from '@/lib/inbox/bell-types';
import { ACTIVITY_PATH } from '@/lib/inbox/inbox-live';
import { useToast } from '@/components/ui/toast';
import { ICON_SIZE, IconAlarmClock } from '@/components/ui/icons';

/** The toast's open affordance. */
const RING_TOAST_ACTION = 'Open';
/** How long a reminder toast stays (the chime runs about 5 s inside it). */
const RING_TOAST_MS = 8_000;

/** "Reminder: <preview>". Pure. */
export function ringTitle(preview: string): string {
  return `Reminder: ${preview}`;
}

/**
 * Whether a click landed on the dismiss control of the toast titled `title`
 * (the shared toast has no dismiss callback; this watches its 44px X). Pure
 * over the DOM it is handed.
 */
export function isDismissOf(target: EventTarget | null, title: string): boolean {
  if (typeof Element === 'undefined' || !(target instanceof Element)) return false;
  const button = target.closest('[aria-label="Dismiss notification"]');
  return button?.parentElement?.textContent?.includes(title) === true;
}

export function ReminderRing(props: { workspaceId: string; userId: string }): null {
  const { workspaceId, userId } = props;
  const toast = useToast();
  const navigate = useNavigate();
  // Latest toast / navigate without re-running the effect.
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  useEffect(() => {
    let disposed = false;
    const chime: Chime = createChime();
    const rung = new Set(readRung(userId));
    let rows: ReminderRow[] = [];
    let messages = new Map<string, ChatMessagePreview>();
    let names = new Map<string, string>();
    let cancelTimer: () => void = () => {};
    let stopWatch: () => void = () => {};
    let loadSeq = 0;

    /**
     * Stop the chime when the toast titled `title` is dismissed, or when it
     * leaves on its own (so a chime still waiting for the first tap never
     * plays minutes later). The listener and timer go with it.
     */
    const watchDismiss = (title: string): void => {
      stopWatch();
      const onClick = (event: MouseEvent): void => {
        if (isDismissOf(event.target, title)) {
          chime.stop();
          stopWatch();
        }
      };
      const expire = setTimeout(() => {
        chime.stop();
        stopWatch();
      }, RING_TOAST_MS);
      document.addEventListener('click', onClick, true);
      stopWatch = () => {
        clearTimeout(expire);
        document.removeEventListener('click', onClick, true);
        stopWatch = () => {};
      };
    };

    const arm = (): void => {
      cancelTimer();
      cancelTimer = armRing({
        rows,
        now: () => Date.now(),
        rung,
        onRing: ring,
        onRearm: arm,
      });
    };

    const ring = (row: ReminderRow): void => {
      if (disposed) return;
      rung.add(row.id);
      writeRung(userId, [...rung]);
      const preview = messagePreview(messages.get(row.message_id), (id) => names.get(id));
      const title = ringTitle(preview);
      chime.play();
      watchDismiss(title);
      toastRef.current.show({
        title,
        description: RING_TOAST_ACTION,
        icon: <IconAlarmClock size={ICON_SIZE.nav} className="text-accent" />,
        durationMs: RING_TOAST_MS,
        onPress: () => {
          chime.stop();
          stopWatch();
          navigateRef.current(chatMessageHref(row.channel_id, row.message_id));
        },
      });
      // The rung reminder is no longer pending: the chat's Remind me reloads
      // (this ring reloads too and arms the next one).
      announceRemindersChanged();
    };

    const load = async (): Promise<void> => {
      loadSeq += 1;
      const seq = loadSeq;
      const res = await readPendingReminders(supabase, { workspaceId });
      if (disposed || seq !== loadSeq) return;
      if (!res.ok) {
        logger.warn('reminder ring: reminders read failed', { error: res.error.message });
        return;
      }
      const loaded = await readChatMessages(
        supabase,
        res.data.map((r) => r.message_id),
      );
      const mentioned = [...new Set([...loaded.values()].flatMap((m) => mentionIds(m.body ?? '')))];
      const loadedNames = new Map<string, string>();
      if (mentioned.length > 0) {
        const profiles = await readProfiles(supabase, mentioned);
        if (profiles.ok) for (const p of profiles.data) loadedNames.set(p.userId, p.displayName);
      }
      if (disposed || seq !== loadSeq) return;
      rows = res.data;
      messages = loaded;
      names = loadedNames;
      arm();
    };

    const checkMissed = async (): Promise<void> => {
      const lastSeen = readLastSeen(userId);
      const now = Date.now();
      writeLastSeen(userId, now);
      if (lastSeen === null) return;
      const res = await readUnreadRemindersSince(supabase, {
        workspaceId,
        userId,
        sinceIso: new Date(lastSeen).toISOString(),
      });
      if (disposed) return;
      if (!res.ok) {
        logger.warn('reminder ring: missed read failed', { error: res.error.message });
        return;
      }
      const count = missedCount(res.data, lastSeen, rung);
      for (const e of res.data) if (e.reminderId !== null) rung.add(e.reminderId);
      writeRung(userId, [...rung]);
      if (count === 0) return;
      const title = missedCopy(count);
      chime.play(1);
      watchDismiss(title);
      toastRef.current.show({
        title,
        description: RING_TOAST_ACTION,
        icon: <IconAlarmClock size={ICON_SIZE.nav} className="text-accent" />,
        durationMs: RING_TOAST_MS,
        onPress: () => {
          chime.stop();
          stopWatch();
          navigateRef.current(ACTIVITY_PATH);
        },
      });
    };

    const markSeen = (): void => {
      const now = Date.now();
      writeLastSeen(userId, now);
    };
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') {
        void checkMissed();
        void load();
      } else {
        markSeen();
      }
    };
    const onPageHide = (): void => markSeen();
    const onRemindersChanged = (): void => void load();

    void checkMissed();
    void load();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener(REMINDERS_CHANGED_EVENT, onRemindersChanged);
    return () => {
      disposed = true;
      cancelTimer();
      stopWatch();
      chime.dispose();
      markSeen();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener(REMINDERS_CHANGED_EVENT, onRemindersChanged);
    };
  }, [workspaceId, userId]);

  return null;
}
