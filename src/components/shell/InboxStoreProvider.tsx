// The always-on inbox (Notifications) live layer. Mounted once at the shell (inside the
// toast provider and the router), it seeds the unread count for the active
// workspace and keeps it live with a foreground-only 30s poll. A poll that finds
// rows newer than the high-water mark fires a single toast (coalescing a burst),
// advances the mark and tells an open Notifications page (sorted:inbox-changed,
// detail 'poll'). The high-water mark is seeded from the newest server row's
// created_at (never the device clock) so the existing backlog never toasts.
//
// RACES: every read captures its workspace and user, and a result whose tenant
// is no longer active is dropped (count, toasts and the mark alike). One
// in-flight guard covers the timer and the return-to-visible tick, and toasts
// are deduped by entry id. Mirrors ChatStoreProvider: all decisions live in
// the pure layer (inbox-live.ts); this file only wires it to PostgREST, React, the
// toast surface and the nav badge (read via useInboxStore).
//
// POLL: 30s balances immediacy against battery/network for an approval tool. A
// backgrounded tab polls every second interval (60s) so the tab alert can tell
// the viewer something happened (tab-alert.ts), and ticks immediately on the
// return to visible.
//
// COUNT: every unread row counts (the chat, plan and task alerts included), so
// the Notifications badge matches the page.
//
// TOASTS: the rows the bell used to own (bell-types.ts) never word the activity
// toast. A new chat mention toasts "<name> mentioned you" with Open instead,
// and every tick asks the reminder readers to reload. ReminderRing (the
// reminder ring, chime and missed-on-open toast) is mounted here so it runs on
// every page from app start.
//
// OWN ROWS: since 20261018140000 every action also writes the actor one
// already-read row of their own (inbox_self_entry). Those are history, not news:
// othersRows drops them before any toast or tone.
//
// TONE: new Activity rows from someone else play the chat's notification tone
// (shared throttle, notify-sound.ts), except while Notifications is open.

import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { logger } from '@/lib/logger';
import { useSession } from '@/lib/session-context';
import { useWorkspace } from '@/lib/workspace-context';
import { useToast } from '@/components/ui/toast';
import { Avatar } from '@/components/ui/Avatar';
import { entityHref, mapEntry } from '@/components/pages/activity/data';
import {
  ACTIVITY_PATH,
  activityToneWanted,
  mentionToastFrom,
  mentionTabText,
  othersRows,
  pickNewest,
  POLL_CHANGE_SOURCE,
  unseenRows,
  splitNewRows,
  summarizeNew,
  toastFromEnriched,
} from '@/lib/inbox/inbox-live';
import {
  enrichNewRows,
  fetchInboxSince,
  fetchNewestInboxAt,
  readActivityBadge,
} from '@/lib/inbox/inbox-reads';
import { generateTraceId } from '@/lib/trace';
import { readProfiles } from '@/lib/chat-reads';
import { announceRemindersChanged } from '@/lib/chat/reminders';
import { listenForNameSignout, resetMentionNames } from '@/lib/chat/mentions';
import { ReminderRing } from '@/components/chat/ReminderRing';
import { playToneShared } from '@/lib/chat/notify-sound';
import { pushTabAlert } from '@/lib/tab-alert';
import { INBOX_CHANGED_EVENT } from '@/lib/events';

/** The slice the nav reads: the actionable unread count for the active workspace. */
export interface InboxStoreContextValue {
  unreadCount: number;
}

const InboxStoreContext = createContext<InboxStoreContextValue | null>(null);

const POLL_MS = 30_000;

export function InboxStoreProvider({ children }: { children: ReactNode }): ReactElement {
  const { session } = useSession();
  const { workspaceId } = useWorkspace();
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  // The chat on screen (if any): its new mentions need no toast.
  const openChatRef = useRef<string | null>(null);
  // The route on screen: new Activity rows never tone while Activity is open.
  const pathnameRef = useRef(location.pathname);
  pathnameRef.current = location.pathname;
  openChatRef.current = location.pathname.startsWith('/chat')
    ? new URLSearchParams(location.search).get('channel')
    : null;
  const userId = session?.user.id ?? null;

  const [unreadCount, setUnreadCount] = useState(0);

  // The newest created_at already accounted for (ms), from the server's clock.
  // Null until seeded for the active workspace/user (a tick seeds it and toasts
  // nothing); reset on a workspace/user switch below.
  const highWaterRef = useRef<number | null>(null);
  // The active workspace/user, mirrored into refs so the single interval tick and
  // the change listener never read a stale closure.
  const workspaceIdRef = useRef<string | null>(workspaceId);
  const userIdRef = useRef<string | null>(userId);
  // One poll at a time, shared by the timer and the return-to-visible tick.
  const inFlightRef = useRef(false);
  // Entry ids already toasted for the active tenant: a row is never toasted twice.
  const toastedRef = useRef<Set<string>>(new Set());

  // Whether a read started for ws/uid still matches the active tenant.
  const stillActive = (ws: string, uid: string): boolean =>
    workspaceIdRef.current === ws && userIdRef.current === uid;

  // Refetch only the count (CQS: a query, no toast side effect). Used by the change
  // event and as the first half of each poll tick. One activity_badge_read per
  // refresh, shared with the Activity page's Mentions count (readActivityBadge).
  // A stale tenant's count is dropped.
  const refreshCount = (ws: string, uid: string): void => {
    void (async () => {
      const res = await readActivityBadge(supabase, {
        userId: uid,
        workspaceId: ws,
        traceId: generateTraceId(),
        refresh: true,
      });
      if (!stillActive(ws, uid)) return;
      if (res.ok) setUnreadCount(res.data.unread);
      else logger.warn('inbox store: count refresh failed', { error: res.error.message });
    })();
  };

  // Seed "seen up to" from the newest server row (zero when there is none). A
  // failed read leaves it unseeded, so the next tick tries again.
  const seedHighWater = async (ws: string, uid: string): Promise<void> => {
    const res = await fetchNewestInboxAt(supabase, { workspaceId: ws, userId: uid });
    if (!stillActive(ws, uid)) return;
    if (!res.ok) {
      logger.warn('inbox store: seed failed', { error: res.error.message });
      return;
    }
    const ms = res.data !== null ? Date.parse(res.data) : 0;
    highWaterRef.current = Number.isNaN(ms) ? 0 : ms;
  };

  // One poll: seed the mark if unseeded, else diff new rows against it, tell
  // Notifications, and toast at most once for the batch (never a row twice).
  const pollNew = async (ws: string, uid: string): Promise<void> => {
    const sinceMs = highWaterRef.current;
    if (sinceMs === null) {
      await seedHighWater(ws, uid);
      return;
    }
    const sinceIso = new Date(sinceMs).toISOString();
    const sinceRes = await fetchInboxSince(supabase, {
      workspaceId: ws,
      userId: uid,
      sinceIso,
    });
    if (!stillActive(ws, uid)) return;
    if (!sinceRes.ok) {
      logger.warn('inbox store: since fetch failed', { error: sinceRes.error.message });
      return;
    }
    const summary = summarizeNew(sinceRes.data.rows, sinceMs);
    highWaterRef.current = summary.nextHighWaterMs;
    if (summary.newRows.length > 0) {
      window.dispatchEvent(new CustomEvent(INBOX_CHANGED_EVENT, { detail: POLL_CHANGE_SOURCE }));
    }
    const fresh = unseenRows(summary.newRows, toastedRef.current);
    const { activity, chatMentions } = splitNewRows(fresh);
    const elsewhere = chatMentions.filter((r) => r.entity_id !== openChatRef.current);
    if (elsewhere.length > 0) void toastMentions(elsewhere, ws);
    // The viewer's own already-read rows are history: no toast, no tone.
    const newRows = othersRows(activity, uid);
    if (newRows.length === 0) return;
    if (activityToneWanted(newRows.length, pathnameRef.current, document.hidden)) {
      playToneShared();
    }

    // The server count is exact (bell rows are filtered before the cap); the own
    // rows dropped from this page are taken off it.
    const ownDropped = activity.length - newRows.length;
    const enriched = await enrichNewRows(
      supabase,
      newRows,
      undefined,
      Math.max(newRows.length, sinceRes.data.activityCount - ownDropped),
    );
    if (!stillActive(ws, uid)) return;
    const spec = toastFromEnriched(enriched);
    if (spec === null) return;
    // Background tab: the tab speaks the same words as the toast.
    pushTabAlert({ kind: 'activity', text: spec.title });

    const newest = pickNewest(newRows);
    const href =
      enriched.count === 1 && newest !== null
        ? (entityHref(mapEntry(newest)) ?? ACTIVITY_PATH)
        : ACTIVITY_PATH;
    toast.show({
      title: spec.title,
      ...(spec.description !== undefined ? { description: spec.description } : {}),
      icon: (
        <Avatar
          {...(spec.actorName !== null ? { name: spec.actorName } : {})}
          {...(spec.actorAvatarUrl !== null ? { src: spec.actorAvatarUrl } : {})}
          role="inline"
        />
      ),
      onPress: () => navigate(href),
    });
  };

  // The full poll tick, held in a ref so the interval registers once yet always
  // runs the latest closure (toast/navigate). Refetches the count, then diffs new
  // rows against the high-water mark and toasts at most once for the batch.
  const tickRef = useRef<() => void>(() => {});
  tickRef.current = () => {
    const ws = workspaceIdRef.current;
    const uid = userIdRef.current;
    if (ws === null || uid === null || inFlightRef.current) return;
    refreshCount(ws, uid);
    announceRemindersChanged();
    inFlightRef.current = true;
    void pollNew(ws, uid).finally(() => {
      inFlightRef.current = false;
    });
  };

  // The toast for new chat mentions: one batched name read, one toast, and the
  // background tab's "<Name> mentioned you". Dropped if the workspace changed.
  const toastMentions = async (
    rows: Parameters<typeof mentionToastFrom>[0],
    ws: string,
  ): Promise<void> => {
    const ids = [
      ...new Set(rows.flatMap((r) => (r.actor_user_id != null ? [r.actor_user_id] : []))),
    ];
    const names = new Map<string, { name: string; avatar: string | null }>();
    if (ids.length > 0) {
      const profiles = await readProfiles(supabase, ids);
      if (profiles.ok) {
        for (const p of profiles.data)
          names.set(p.userId, { name: p.displayName, avatar: p.avatarUrl });
      } else {
        logger.warn('inbox store: mention names failed', { error: profiles.error.message });
      }
    }
    if (workspaceIdRef.current !== ws) return;
    const spec = mentionToastFrom(rows, (id) => names.get(id)?.name ?? null);
    if (spec === null) return;
    const actor = spec.actorId !== null ? names.get(spec.actorId) : undefined;
    for (const row of rows) {
      const name = row.actor_user_id != null ? (names.get(row.actor_user_id)?.name ?? null) : null;
      pushTabAlert({ kind: 'chat', text: mentionTabText(name) });
    }
    toast.show({
      title: spec.title,
      description: spec.description,
      icon: (
        <Avatar
          {...(actor !== undefined ? { name: actor.name } : {})}
          {...(actor?.avatar != null ? { src: actor.avatar } : {})}
          role="inline"
        />
      ),
      onPress: () => navigate(spec.href),
    });
  };

  // Sign-out, and a different signed-in user on this tab, clear the shared name
  // registry, so a second account never sees the first account's names.
  useEffect(() => listenForNameSignout(window), []);
  const namesUserRef = useRef<string | null>(userId);
  if (namesUserRef.current !== userId) {
    if (namesUserRef.current !== null) resetMentionNames();
    namesUserRef.current = userId;
  }

  // Mount + workspace/user switch: re-seed the high-water mark from the server
  // (the backlog must not toast), forget the toasted ids and seed the count. A
  // null tenant clears the count to zero. Reads for the old tenant are dropped.
  useEffect(() => {
    workspaceIdRef.current = workspaceId;
    userIdRef.current = userId;
    highWaterRef.current = null;
    toastedRef.current = new Set();
    if (workspaceId === null || userId === null) {
      setUnreadCount(0);
      return;
    }
    refreshCount(workspaceId, userId);
    void seedHighWater(workspaceId, userId);
  }, [workspaceId, userId]);

  // The foreground-only poll plus the two window listeners, installed once. The
  // tick is skipped while the tab is hidden and runs immediately on return; the
  // change event refetches the count. All three are torn down on unmount.
  useEffect(() => {
    const onVisibility = (): void => {
      if (!document.hidden) tickRef.current();
    };
    const onChanged = (event: Event): void => {
      // The poll's own event: the tick already refetched the count.
      if (event instanceof CustomEvent && event.detail === POLL_CHANGE_SOURCE) return;
      const ws = workspaceIdRef.current;
      const uid = userIdRef.current;
      if (ws !== null && uid !== null) refreshCount(ws, uid);
    };
    // Hidden: every second interval only (60s), to stay light on battery.
    let hiddenSkip = false;
    const interval = window.setInterval(() => {
      if (document.hidden) {
        hiddenSkip = !hiddenSkip;
        if (hiddenSkip) return;
      } else {
        hiddenSkip = false;
      }
      tickRef.current();
    }, POLL_MS);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener(INBOX_CHANGED_EVENT, onChanged);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener(INBOX_CHANGED_EVENT, onChanged);
    };
  }, []);

  const value = useMemo<InboxStoreContextValue>(() => ({ unreadCount }), [unreadCount]);

  return (
    <InboxStoreContext.Provider value={value}>
      {children}
      {workspaceId !== null && userId !== null ? (
        <ReminderRing key={`${workspaceId}:${userId}`} workspaceId={workspaceId} userId={userId} />
      ) : null}
    </InboxStoreContext.Provider>
  );
}

export function useInboxStore(): InboxStoreContextValue {
  const ctx = useContext(InboxStoreContext);
  if (ctx === null) {
    throw new Error('useInboxStore must be used within an InboxStoreProvider');
  }
  return ctx;
}
