// The always-on inbox (Activity) live layer. Mounted once at the shell (inside the
// toast provider and the router), it seeds the unread count for the active
// workspace and keeps it live with a foreground-only 30s poll. A poll that finds
// rows newer than the high-water mark fires a single toast (coalescing a burst)
// and advances the mark. The high-water mark is baselined to mount time so the
// existing backlog never toasts. Mirrors ChatStoreProvider: all decisions live in
// the pure layer (inbox-live.ts); this file only wires it to PostgREST, React, the
// toast surface and the nav badge (read via useInboxStore).
//
// POLL: 30s balances immediacy against battery/network for an approval tool, and a
// backgrounded tab does no work (the tick is skipped while document.hidden and runs
// immediately on the return to visible).
//
// BELL: the chat bell's rows (bell-types.ts) never count or toast as Activity. A
// new chat mention toasts "<name> mentioned you" with Open instead (the bell's
// toast), and every tick asks the mounted bell to refetch. BellRing (the
// reminder ring, chime and missed-on-open toast) is mounted here so it runs on
// every page from app start.
//
// ASSUMPTION: the inbox writer does not fan an entry out to the actor's own action,
// so a toast never reflects the current user's own activity and no self-filter is
// applied here.

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
  mentionToastFrom,
  pickNewest,
  splitNewRows,
  summarizeNew,
  toastFromEnriched,
} from '@/lib/inbox/inbox-live';
import { enrichNewRows, fetchInboxSince, fetchInboxUnreadCount } from '@/lib/inbox/inbox-reads';
import { readProfiles } from '@/lib/chat-reads';
import { requestBellRefresh } from '@/lib/chat/bell';
import { listenForNameSignout, resetMentionNames } from '@/lib/chat/mentions';
import { BellRing } from '@/components/chat/BellRing';

/** The slice the nav reads: the actionable unread count for the active workspace. */
export interface InboxStoreContextValue {
  unreadCount: number;
}

const InboxStoreContext = createContext<InboxStoreContextValue | null>(null);

const POLL_MS = 30_000;
const INBOX_CHANGED_EVENT = 'sorted:inbox-changed';

export function InboxStoreProvider({ children }: { children: ReactNode }): ReactElement {
  const { session } = useSession();
  const { workspaceId } = useWorkspace();
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  // The chat on screen (if any): its new mentions need no toast.
  const openChatRef = useRef<string | null>(null);
  openChatRef.current = location.pathname.startsWith('/chat')
    ? new URLSearchParams(location.search).get('channel')
    : null;
  const userId = session?.user.id ?? null;

  const [unreadCount, setUnreadCount] = useState(0);

  // The newest created_at already accounted for (ms). Seeded to mount time so the
  // existing backlog never toasts; reset on a workspace/user switch below.
  const highWaterRef = useRef<number>(Date.now());
  // The active workspace/user, mirrored into refs so the single interval tick and
  // the change listener never read a stale closure.
  const workspaceIdRef = useRef<string | null>(workspaceId);
  const userIdRef = useRef<string | null>(userId);

  // Refetch only the count (CQS: a query, no toast side effect). Used by the change
  // event and as the first half of each poll tick.
  const refreshCount = (ws: string, uid: string): void => {
    void (async () => {
      const nowIso = new Date().toISOString();
      const res = await fetchInboxUnreadCount(supabase, { workspaceId: ws, userId: uid, nowIso });
      if (res.ok) setUnreadCount(res.data);
      else logger.warn('inbox store: count refresh failed', { error: res.error.message });
    })();
  };

  // The full poll tick, held in a ref so the interval registers once yet always
  // runs the latest closure (toast/navigate). Refetches the count, then diffs new
  // rows against the high-water mark and toasts at most once for the batch.
  const tickRef = useRef<() => void>(() => {});
  tickRef.current = () => {
    const ws = workspaceIdRef.current;
    const uid = userIdRef.current;
    if (ws === null || uid === null) return;
    refreshCount(ws, uid);
    requestBellRefresh();
    void (async () => {
      const sinceMs = highWaterRef.current;
      const sinceIso = new Date(sinceMs).toISOString();
      const sinceRes = await fetchInboxSince(supabase, {
        workspaceId: ws,
        userId: uid,
        sinceIso,
      });
      if (!sinceRes.ok) {
        logger.warn('inbox store: since fetch failed', { error: sinceRes.error.message });
        return;
      }
      const summary = summarizeNew(sinceRes.data.rows, sinceMs);
      highWaterRef.current = summary.nextHighWaterMs;
      const { activity: newRows, chatMentions } = splitNewRows(summary.newRows);
      const elsewhere = chatMentions.filter((r) => r.entity_id !== openChatRef.current);
      if (elsewhere.length > 0) void toastMentions(elsewhere);
      if (newRows.length === 0) return;

      // The count is exact (bell rows are filtered before the cap), not the page size.
      const enriched = await enrichNewRows(
        supabase,
        newRows,
        undefined,
        sinceRes.data.activityCount,
      );
      const spec = toastFromEnriched(enriched);
      if (spec === null) return;

      const newest = pickNewest(newRows);
      const href =
        enriched.count === 1 && newest !== null
          ? (entityHref(mapEntry(newest)) ?? '/activity')
          : '/activity';
      toast.show({
        title: spec.title,
        ...(spec.description !== undefined ? { description: spec.description } : {}),
        icon: (
          <Avatar
            {...(spec.actorName !== null ? { name: spec.actorName } : {})}
            {...(spec.actorAvatarUrl !== null ? { src: spec.actorAvatarUrl } : {})}
            size="sm"
          />
        ),
        onPress: () => navigate(href),
      });
    })();
  };

  // The bell's toast for new chat mentions: one batched name read, one toast.
  const toastMentions = async (rows: Parameters<typeof mentionToastFrom>[0]): Promise<void> => {
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
    const spec = mentionToastFrom(rows, (id) => names.get(id)?.name ?? null);
    if (spec === null) return;
    const actor = spec.actorId !== null ? names.get(spec.actorId) : undefined;
    toast.show({
      title: spec.title,
      description: spec.description,
      icon: (
        <Avatar
          {...(actor !== undefined ? { name: actor.name } : {})}
          {...(actor?.avatar != null ? { src: actor.avatar } : {})}
          size="sm"
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

  // Mount + workspace/user switch: reset the high-water mark to now (the backlog
  // must not toast) and seed the count. A null tenant clears the count to zero.
  useEffect(() => {
    workspaceIdRef.current = workspaceId;
    userIdRef.current = userId;
    highWaterRef.current = Date.now();
    if (workspaceId === null || userId === null) {
      setUnreadCount(0);
      return;
    }
    refreshCount(workspaceId, userId);
    // refreshCount reads its args, not refs, so no cleanup flag is needed here.
  }, [workspaceId, userId]);

  // The foreground-only poll plus the two window listeners, installed once. The
  // tick is skipped while the tab is hidden and runs immediately on return; the
  // change event refetches the count. All three are torn down on unmount.
  useEffect(() => {
    const onVisibility = (): void => {
      if (!document.hidden) tickRef.current();
    };
    const onChanged = (): void => {
      const ws = workspaceIdRef.current;
      const uid = userIdRef.current;
      if (ws !== null && uid !== null) refreshCount(ws, uid);
    };
    const interval = window.setInterval(() => {
      if (document.hidden) return;
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
        <BellRing key={`${workspaceId}:${userId}`} workspaceId={workspaceId} userId={userId} />
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
