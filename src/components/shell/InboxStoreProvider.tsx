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
// ASSUMPTION: the inbox writer does not fan an entry out to the actor's own action,
// so a toast never reflects the current user's own activity and no self-filter is
// applied here.

import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { logger } from '@/lib/logger';
import { useSession } from '@/lib/session-context';
import { useWorkspace } from '@/lib/workspace-context';
import { useToast } from '@/components/ui/toast';
import { Avatar } from '@/components/ui/Avatar';
import { entityHref, mapEntry } from '@/components/pages/activity/data';
import { pickNewest, summarizeNew, toastFromEnriched } from '@/lib/inbox/inbox-live';
import { enrichNewRows, fetchInboxSince, fetchInboxUnreadCount } from '@/lib/inbox/inbox-reads';

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
      const { newRows, nextHighWaterMs } = summarizeNew(sinceRes.data, sinceMs);
      highWaterRef.current = nextHighWaterMs;
      if (newRows.length === 0) return;

      const enriched = await enrichNewRows(supabase, newRows);
      const spec = toastFromEnriched(enriched);
      if (spec === null) return;

      const newest = pickNewest(newRows);
      const href =
        newRows.length === 1 && newest !== null
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

  return <InboxStoreContext.Provider value={value}>{children}</InboxStoreContext.Provider>;
}

export function useInboxStore(): InboxStoreContextValue {
  const ctx = useContext(InboxStoreContext);
  if (ctx === null) {
    throw new Error('useInboxStore must be used within an InboxStoreProvider');
  }
  return ctx;
}
