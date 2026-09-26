// The always-on chat live layer. Mounted once at the shell (inside the Agora
// ChatProvider, the toast provider, and the router), it seeds the pure chat
// store from the registry roster plus Postgres (chat_unread_counts for badges
// and ordering, one bounded scan for the preview lines), then keeps it live off
// the controller's global incoming-message fan-out. Every live message is
// verified against its chat_messages row before it counts (the shared verifier
// logs a missing row once, for store and thread). Unread counts are re-read
// on open, on every reconnect, and 2s after the last incoming live message, so
// Postgres stays the truth for the badge. The store also holds the per-channel
// outbox (unrecorded own sends), so a channel switch never drops a failed bubble. A message for a conversation the user
// is not viewing fires a toast and stays unread; a message for the open
// conversation is marked read locally (the thread writes the cursor). All store
// mutation lives in the pure reducer (chat-store.ts); this file only wires that
// reducer to Agora, Postgres, React, and the toast surface.

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
import { useNavigate } from 'react-router-dom';
import type { AgoraChat } from 'agora-chat';
import { supabase } from '@/lib/supabase';
import { logger } from '@/lib/logger';
import { useSession } from '@/lib/session-context';
import { useWorkspace } from '@/lib/workspace-context';
import { useToast } from '@/components/ui/toast';
import { Avatar } from '@/components/ui/Avatar';
import { listChannelSummaries, type ChannelSummary } from '@/lib/chat-reads';
import { useChat } from '@/lib/chat/chat-context';
import { mapLiveTextMessage } from '@/lib/chat/thread';
import { liveVerifierFor } from '@/lib/chat/live-verify';
import { subscribeGlobalMessages } from '@/lib/chat/controller';
import { loadConversationPreviews, loadUnreadCounts } from '@/lib/chat/history';
import { createDebouncer, UNREAD_REFRESH_DEBOUNCE_MS } from '@/lib/chat/read-cursor';
import * as store from '@/lib/chat/chat-store';
import type { ChannelOutbox, ChatStoreState, Outbox } from '@/lib/chat/chat-store';

/** The store plus the actions the chat UI uses to keep it in step. */
export interface ChatStoreContextValue {
  state: ChatStoreState;
  /** Sum of unread across every channel; the Chat-tab badge reads this. */
  totalUnread: number;
  /** Mark the viewed channel (its incoming messages stay read), or clear it. */
  setActive: (channelId: string | null) => void;
  /** Zero a channel's unread locally (the thread records the read cursor). */
  markConversationRead: (channelId: string) => void;
  /** Refresh a channel's last line after a recorded own send ('You: ...'). */
  updateOwnMessage: (channelId: string, text: string, ts: number) => void;
  /** Re-read chat_unread_counts now (after a catch-up). */
  refreshUnreadCounts: () => void;
  /** Ask the chat page to open a channel (consumed via pendingOpenConversationId). */
  requestOpen: (channelId: string) => void;
  /** Clear the pending-open request once the chat page has acted on it. */
  clearPendingOpen: () => void;
  /** Unrecorded own sends per channel; survives channel switches. */
  outbox: ChannelOutbox;
}

const ChatStoreContext = createContext<ChatStoreContextValue | null>(null);

/** Bound on the live-message ids remembered for dedupe. */
const SEEN_IDS_LIMIT = 500;

function indexSummaries(roster: readonly ChannelSummary[]): Map<string, ChannelSummary> {
  const map = new Map<string, ChannelSummary>();
  for (const summary of roster) {
    map.set(summary.channelId, summary);
  }
  return map;
}

/** Remember a live message id; true when it was already seen. Bounded FIFO. */
export function rememberSeen(seen: Set<string>, id: string): boolean {
  if (seen.has(id)) return true;
  seen.add(id);
  if (seen.size > SEEN_IDS_LIMIT) {
    const oldest = seen.values().next().value;
    if (oldest !== undefined) seen.delete(oldest);
  }
  return false;
}

export function ChatStoreProvider({ children }: { children: ReactNode }): ReactElement {
  const { status } = useChat();
  const { session } = useSession();
  const { workspaceId } = useWorkspace();
  const toast = useToast();
  const navigate = useNavigate();
  const currentUserId = session?.user.id ?? null;

  const [state, setState] = useState<ChatStoreState>(store.initialState);

  // The live handler reads these refs so the global subscription registers once
  // and never goes stale: roster summaries, the active channel, and the ids
  // already folded in.
  const summariesRef = useRef<Map<string, ChannelSummary>>(new Map());
  const activeRef = useRef<string | null>(null);
  const seenRef = useRef<Set<string>>(new Set());
  const outboxRef = useRef<Outbox>({});
  const outbox = useMemo(() => store.createChannelOutbox(outboxRef), []);

  useEffect(() => {
    activeRef.current = state.activeConversationId;
  }, [state.activeConversationId]);

  const setActive = useCallback((channelId: string | null) => {
    setState((prev) => store.setActive(prev, channelId));
  }, []);

  const markConversationRead = useCallback((channelId: string) => {
    setState((prev) => store.markRead(prev, channelId));
  }, []);

  const updateOwnMessage = useCallback((channelId: string, text: string, ts: number) => {
    setState((prev) => store.updateOwnMessage(prev, { channelId, text, ts }));
  }, []);

  const requestOpen = useCallback((channelId: string) => {
    setState((prev) => store.requestOpen(prev, channelId));
  }, []);

  const clearPendingOpen = useCallback(() => {
    setState((prev) => store.clearPendingOpen(prev));
  }, []);

  const refreshUnreadCounts = useCallback(() => {
    if (workspaceId === null || currentUserId === null) return;
    const forWorkspace = workspaceId;
    void loadUnreadCounts(supabase, forWorkspace).then((result) => {
      if (!result.ok) {
        logger.warn('chat store: unread counts load failed', { error: result.error.message });
        return;
      }
      setState((prev) => store.applyUnreadCounts(prev, result.data));
    });
  }, [workspaceId, currentUserId]);

  // Seed the store on workspace/user switch: the roster (registry), then the
  // unread counts and the preview lines from Postgres. Independent of the Agora
  // connection: the list and badges work while chat is still connecting.
  useEffect(() => {
    if (!workspaceId || currentUserId === null) return;
    let cancelled = false;
    seenRef.current = new Set();
    outboxRef.current = {};
    void (async (): Promise<void> => {
      const rosterRes = await listChannelSummaries(supabase, { workspaceId, currentUserId });
      if (cancelled) return;
      if (!rosterRes.ok) {
        logger.error('chat store: roster load failed', { error: rosterRes.error.message });
        return;
      }
      const roster = rosterRes.data;
      summariesRef.current = indexSummaries(roster);
      setState(store.mergeInitial(roster));
      const [counts, previews] = await Promise.all([
        loadUnreadCounts(supabase, workspaceId),
        loadConversationPreviews(supabase, workspaceId),
      ]);
      if (cancelled) return;
      if (!counts.ok) {
        logger.warn('chat store: unread counts load failed', { error: counts.error.message });
      }
      if (!previews.ok) {
        logger.warn('chat store: previews load failed', { error: previews.error.message });
      }
      setState((prev) => {
        const withPreviews = previews.ok
          ? store.applyPreviews(prev, previews.data, currentUserId)
          : prev;
        return counts.ok ? store.applyUnreadCounts(withPreviews, counts.data) : withPreviews;
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId, currentUserId]);

  // Every (re)connect re-reads the counts: live messages missed while offline
  // are already in Postgres.
  const previousStatusRef = useRef(status);
  useEffect(() => {
    const previous = previousStatusRef.current;
    previousStatusRef.current = status;
    if (status === 'connected' && previous !== 'connected') refreshUnreadCounts();
  }, [status, refreshUnreadCounts]);

  // Debounced reconcile after live traffic (2s after the last incoming message).
  const refreshRef = useRef(refreshUnreadCounts);
  refreshRef.current = refreshUnreadCounts;
  const debouncedRefresh = useMemo(
    () => createDebouncer<null>(() => refreshRef.current(), UNREAD_REFRESH_DEBOUNCE_MS),
    [],
  );
  useEffect(() => () => debouncedRefresh.cancel(), [debouncedRefresh]);

  // Latest incoming-message logic, held in a ref so the global subscription
  // below registers exactly once yet always runs the current closure.
  const onIncomingRef = useRef<(message: AgoraChat.TextMsgBody) => void>(() => {});
  onIncomingRef.current = (raw) => {
    if (currentUserId === null) return;
    const mapped = mapLiveTextMessage(raw, currentUserId);
    if (!mapped.ok) {
      logger.warn('chat store: live message without sorted ids ignored', { agora_id: raw.id });
      return;
    }
    if (mapped.message.mine) return;
    if (rememberSeen(seenRef.current, mapped.message.id)) return;
    const forUser = currentUserId;
    // Only a row the caller can read counts: badge, preview and toast all come
    // from the verified row, never from the Agora payload.
    void liveVerifierFor(supabase)
      .verify(mapped.message.id)
      .then((lookup) => {
        if (!lookup.found) return;
        const row = lookup.row;
        if (row.sender_user_id === forUser) return;
        const summary = summariesRef.current.get(row.channel_id);
        if (summary === undefined) return;
        const text = store.previewText({
          body: row.body ?? '',
          hasAttachments:
            (row.attachment_asset_ids ?? []).length > 0 || (row.shared_post_ids ?? []).length > 0,
        });
        const ts = Date.parse(row.created_at);
        setState((prev) =>
          store.applyIncoming(prev, {
            channelId: row.channel_id,
            senderIsSelf: false,
            text,
            ts: Number.isNaN(ts) ? mapped.message.time : ts,
          }),
        );
        debouncedRefresh.schedule(null);

        if (row.channel_id === activeRef.current) return;
        toast.show({
          title: summary.title,
          description: text,
          icon: (
            <Avatar
              name={summary.title}
              size="sm"
              {...(summary.avatarUrl !== null ? { src: summary.avatarUrl } : {})}
            />
          ),
          onPress: () => {
            requestOpen(row.channel_id);
            navigate('/chat');
          },
        });
      });
  };

  useEffect(() => subscribeGlobalMessages((message) => onIncomingRef.current(message)), []);

  const value = useMemo<ChatStoreContextValue>(
    () => ({
      state,
      totalUnread: store.selectTotalUnread(state),
      setActive,
      markConversationRead,
      updateOwnMessage,
      refreshUnreadCounts,
      requestOpen,
      clearPendingOpen,
      outbox,
    }),
    [
      outbox,
      state,
      setActive,
      markConversationRead,
      updateOwnMessage,
      refreshUnreadCounts,
      requestOpen,
      clearPendingOpen,
    ],
  );

  return <ChatStoreContext.Provider value={value}>{children}</ChatStoreContext.Provider>;
}

export function useChatStore(): ChatStoreContextValue {
  const ctx = useContext(ChatStoreContext);
  if (ctx === null) {
    throw new Error('useChatStore must be used within a ChatStoreProvider');
  }
  return ctx;
}
