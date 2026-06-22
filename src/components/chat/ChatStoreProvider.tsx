// The always-on chat live layer. Mounted once at the shell (inside the Agora
// ChatProvider, the toast provider, and the router), it seeds the pure chat
// store from the registry roster + the Agora server conversation list on
// connect, then keeps it live off the controller's global incoming-message
// fan-out. A message for a conversation the user is not viewing fires a toast
// and stays unread; a message for the open conversation is marked read and
// acked. All store mutation lives in the pure reducer (chat-store.ts); this
// file only wires that reducer to Agora, React, and the toast surface.

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
import websdk from 'agora-chat';
import type { AgoraChat } from 'agora-chat';
import { supabase } from '@/lib/supabase';
import { logger } from '@/lib/logger';
import { useSession } from '@/lib/session-context';
import { useWorkspace } from '@/lib/workspace-context';
import { useToast } from '@/components/ui/toast';
import { Avatar } from '@/components/ui/Avatar';
import { listChannelSummaries, type ChannelSummary } from '@/lib/chat-reads';
import { useChat } from '@/lib/chat/chat-context';
import { toAgoraUsername } from '@/lib/chat/agora-identity';
import { targetFromSummary, type ChannelTarget } from '@/lib/chat/thread';
import { subscribeGlobalMessages } from '@/lib/chat/controller';
import {
  buildChannelIndex,
  fetchConversationSummaries,
  type ConversationsConnection,
} from '@/lib/chat/conversations';
import type { ChatConnection } from '@/lib/chat/types';
import * as store from '@/lib/chat/chat-store';
import type { AgoraConversationSummary, ChatStoreState } from '@/lib/chat/chat-store';

/** The store plus the actions the chat UI uses to keep it in step with Agora. */
export interface ChatStoreContextValue {
  state: ChatStoreState;
  /** Sum of unread across every channel; the Chat-tab badge reads this. */
  totalUnread: number;
  /** Mark the viewed channel (its incoming messages stay read), or clear it. */
  setActive: (channelId: string | null) => void;
  /** Reset a channel's unread and send the Agora channel-ack. */
  markConversationRead: (channelId: string) => void;
  /** Refresh a channel's last line after a successful own send ('You: ...'). */
  updateOwnMessage: (channelId: string, text: string) => void;
  /** Ask the chat page to open a channel (consumed via pendingOpenConversationId). */
  requestOpen: (channelId: string) => void;
  /** Clear the pending-open request once the chat page has acted on it. */
  clearPendingOpen: () => void;
}

/** The connection slice used to send a channel-ack, structurally the real Connection. */
interface AckConnection extends ChatConnection {
  send(message: AgoraChat.MessageBody): Promise<unknown>;
}

const ChatStoreContext = createContext<ChatStoreContextValue | null>(null);

function indexSummaries(roster: readonly ChannelSummary[]): Map<string, ChannelSummary> {
  const map = new Map<string, ChannelSummary>();
  for (const summary of roster) {
    map.set(summary.channelId, summary);
  }
  return map;
}

function buildTargets(roster: readonly ChannelSummary[]): Map<string, ChannelTarget> {
  const map = new Map<string, ChannelTarget>();
  for (const summary of roster) {
    const target = targetFromSummary(summary);
    if (target !== null) {
      map.set(summary.channelId, target);
    }
  }
  return map;
}

/** Send the Agora channel read-ack for a target; a failure is logged, not thrown. */
function sendChannelAck(client: ChatConnection, target: ChannelTarget): void {
  const ack = websdk.message.create({
    type: 'channel',
    chatType: target.chatType,
    to: target.targetId,
  });
  void (client as AckConnection).send(ack).catch((error: unknown) => {
    logger.warn('chat store: channel ack failed', { error: String(error) });
  });
}

export function ChatStoreProvider({ children }: { children: ReactNode }): ReactElement {
  const { status, client } = useChat();
  const { session } = useSession();
  const { workspaceId } = useWorkspace();
  const toast = useToast();
  const navigate = useNavigate();
  const currentUserId = session?.user.id ?? null;

  const [state, setState] = useState<ChatStoreState>(store.initialState);

  // The live handler reads these refs so the global subscription registers once
  // and never goes stale: roster index (Agora target -> our channel_id), display
  // summaries, ack targets, the current user's Agora username, the connection,
  // and the active channel.
  const channelIndexRef = useRef<Map<string, string>>(new Map());
  const summariesRef = useRef<Map<string, ChannelSummary>>(new Map());
  const targetsRef = useRef<Map<string, ChannelTarget>>(new Map());
  const currentAgoraUsernameRef = useRef<string | null>(null);
  const clientRef = useRef<ChatConnection | null>(null);
  const activeRef = useRef<string | null>(null);

  useEffect(() => {
    activeRef.current = state.activeConversationId;
  }, [state.activeConversationId]);

  const setActive = useCallback((channelId: string | null) => {
    setState((prev) => store.setActive(prev, channelId));
  }, []);

  const markConversationRead = useCallback((channelId: string) => {
    setState((prev) => store.markRead(prev, channelId));
    const client = clientRef.current;
    const target = targetsRef.current.get(channelId);
    if (client !== null && target !== undefined) {
      sendChannelAck(client, target);
    }
  }, []);

  const updateOwnMessage = useCallback((channelId: string, text: string) => {
    setState((prev) => store.updateOwnMessage(prev, { channelId, text, ts: Date.now() }));
  }, []);

  const requestOpen = useCallback((channelId: string) => {
    setState((prev) => store.requestOpen(prev, channelId));
  }, []);

  const clearPendingOpen = useCallback(() => {
    setState((prev) => store.clearPendingOpen(prev));
  }, []);

  // Seed the store on connect: one bounded roster query plus the paginated Agora
  // conversation list, merged into the store. Re-runs on workspace/user switch.
  useEffect(() => {
    if (status !== 'connected' || client === null || !workspaceId || currentUserId === null) {
      clientRef.current = null;
      return;
    }
    let agoraUsername: string;
    try {
      agoraUsername = toAgoraUsername(currentUserId);
    } catch (error) {
      logger.error('chat store: bad current user id', { error: String(error) });
      return;
    }
    currentAgoraUsernameRef.current = agoraUsername;
    clientRef.current = client;
    let cancelled = false;

    void (async (): Promise<void> => {
      const rosterRes = await listChannelSummaries(supabase, { workspaceId, currentUserId });
      if (cancelled) return;
      if (!rosterRes.ok) {
        logger.error('chat store: roster load failed', { error: rosterRes.error.message });
        return;
      }
      const roster = rosterRes.data;
      let convos: AgoraConversationSummary[] = [];
      try {
        convos = await fetchConversationSummaries({
          connection: client as ConversationsConnection,
          roster,
          currentAgoraUsername: agoraUsername,
        });
      } catch (error) {
        logger.warn('chat store: conversation fetch failed', { error: String(error) });
      }
      if (cancelled) return;
      channelIndexRef.current = buildChannelIndex(roster);
      summariesRef.current = indexSummaries(roster);
      targetsRef.current = buildTargets(roster);
      setState(store.mergeInitial(roster, convos));
    })();

    return () => {
      cancelled = true;
    };
  }, [status, client, workspaceId, currentUserId]);

  // Latest incoming-message logic, held in a ref so the global subscription
  // below registers exactly once yet always runs the current closure.
  const onIncomingRef = useRef<(message: AgoraChat.TextMsgBody) => void>(() => {});
  onIncomingRef.current = (raw) => {
    const key = raw.chatType === 'groupChat' ? raw.to : raw.from;
    if (key === undefined) return;
    const channelId = channelIndexRef.current.get(key);
    if (channelId === undefined) return;
    if (raw.from !== undefined && raw.from === currentAgoraUsernameRef.current) return;

    setState((prev) =>
      store.applyIncoming(prev, {
        channelId,
        senderIsSelf: false,
        text: raw.msg,
        ts: raw.time,
      }),
    );

    if (channelId === activeRef.current) {
      markConversationRead(channelId);
      return;
    }

    const summary = summariesRef.current.get(channelId);
    if (summary === undefined) return;
    toast.show({
      title: summary.title,
      description: raw.msg,
      icon: (
        <Avatar
          name={summary.title}
          size="sm"
          {...(summary.avatarUrl !== null ? { src: summary.avatarUrl } : {})}
        />
      ),
      onPress: () => {
        requestOpen(channelId);
        navigate('/chat');
      },
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
      requestOpen,
      clearPendingOpen,
    }),
    [state, setActive, markConversationRead, updateOwnMessage, requestOpen, clearPendingOpen],
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
