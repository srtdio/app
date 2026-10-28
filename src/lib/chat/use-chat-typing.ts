// Thin React adapter over the pure typing primitives in typing.ts. It owns the
// two timers typing needs (an outbound throttle so a fast typist sends at most
// one signal per window, and a per-peer inbound clear so a row disappears once a
// peer stops) and nothing else; all SDK contact goes through the injected
// command factory. Mirrors use-chat-thread's casting of the Foundation client.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatConnection } from '@/lib/chat/types';
import type { ChannelTarget } from '@/lib/chat/thread';
import { createCmdMessage } from '@/lib/chat/message-factory';
import { sendTyping, subscribeTyping, type TypingConnection } from '@/lib/chat/typing';

/** Cast the Foundation client to the typing surface (mirrors asThreadConnection). */
function asTypingConnection(client: ChatConnection): TypingConnection {
  return client as TypingConnection;
}

/** Send one's own typing signal at most once per this window; first call fires. */
const OUTBOUND_THROTTLE_MS = 3000;

/**
 * Drop a peer from the indicator this long after their last signal. Strictly
 * greater than the outbound throttle so a continuously typing peer (who re-signals
 * every OUTBOUND_THROTTLE_MS) is never briefly cleared between their signals.
 */
const INBOUND_CLEAR_MS = 4000;

interface UseChatTyping {
  /** Sorted user ids currently typing in the open channel (peers only). */
  typingUserIds: string[];
  /** Broadcast that the current user is typing; throttled and a no-op when idle. */
  notifyTyping: () => void;
}

/** Typing ids tagged with the channel they were heard in. */
export interface TypingState {
  channelId: string | null;
  ids: string[];
}

/**
 * The ids to show for the open channel: only ones heard in it. A switch reads
 * as empty in the same render (the state still names the old channel), so no
 * stale id from the previous chat ever paints. Pure.
 */
export function typingIdsFor(state: TypingState, channelId: string | null): string[] {
  return channelId !== null && state.channelId === channelId ? state.ids : NO_IDS;
}

/** Add one id heard in a channel; a different channel starts a fresh list. Pure. */
export function addTypingId(state: TypingState, channelId: string, userId: string): TypingState {
  if (state.channelId !== channelId) return { channelId, ids: [userId] };
  return state.ids.includes(userId) ? state : { channelId, ids: [...state.ids, userId] };
}

/** Drop one id from a channel's list; other channels are left alone. Pure. */
export function removeTypingId(state: TypingState, channelId: string, userId: string): TypingState {
  if (state.channelId !== channelId || !state.ids.includes(userId)) return state;
  return { channelId, ids: state.ids.filter((id) => id !== userId) };
}

/**
 * Subscribe one open channel's typing into state and return the teardown. Each
 * peer signal (re)arms a clear timer; a peer's own message clears their row and
 * timer at once. Teardown clears every timer and the handler. The hook's inbound
 * effect, extracted so it runs under the node test job without a DOM.
 */
export function trackChannelTyping(params: {
  connection: TypingConnection;
  target: ChannelTarget | null;
  channelId: string;
  currentUserId: string;
  setState: (update: (prev: TypingState) => TypingState) => void;
}): () => void {
  const { connection, target, channelId, currentUserId, setState } = params;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const clearTimer = (userId: string): void => {
    const existing = timers.get(userId);
    if (existing !== undefined) clearTimeout(existing);
    timers.delete(userId);
  };
  const teardown = subscribeTyping({
    connection,
    target,
    channelId,
    currentUserId,
    onTypingFrom: (userId) => {
      setState((prev) => addTypingId(prev, channelId, userId));
      clearTimer(userId);
      timers.set(
        userId,
        setTimeout(() => {
          timers.delete(userId);
          setState((prev) => removeTypingId(prev, channelId, userId));
        }, INBOUND_CLEAR_MS),
      );
    },
    onMessageFrom: (userId) => {
      clearTimer(userId);
      setState((prev) => removeTypingId(prev, channelId, userId));
    },
  });
  return () => {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    teardown();
  };
}

const NO_IDS: string[] = [];
const EMPTY: TypingState = { channelId: null, ids: NO_IDS };

export function useChatTyping(params: {
  client: ChatConnection | null;
  target: ChannelTarget | null;
  /** The open Sorted channel id; typing is scoped to it both ways. */
  channelId: string | null;
  currentUserId: string;
}): UseChatTyping {
  const { client, target, channelId, currentUserId } = params;

  const [state, setState] = useState<TypingState>(EMPTY);
  const typingUserIds = typingIdsFor(state, channelId);

  // Outbound state read through refs so notifyTyping stays a stable callback.
  const clientRef = useRef(client);
  clientRef.current = client;
  const targetRef = useRef(target);
  targetRef.current = target;
  const channelIdRef = useRef(channelId);
  channelIdRef.current = channelId;
  const lastSentRef = useRef(0);

  const notifyTyping = useCallback(() => {
    const activeClient = clientRef.current;
    const activeTarget = targetRef.current;
    const activeChannelId = channelIdRef.current;
    if (activeClient === null || activeTarget === null || activeChannelId === null) return;
    const now = Date.now();
    if (now - lastSentRef.current < OUTBOUND_THROTTLE_MS) return;
    lastSentRef.current = now;
    // Best effort: a send while the socket is down rejects with the SDK's plain
    // error object; the next keystroke tries again, so it is dropped silently.
    void sendTyping({
      connection: asTypingConnection(activeClient),
      target: activeTarget,
      createCmd: createCmdMessage,
      channelId: activeChannelId,
    }).catch(() => {});
  }, []);

  // Inbound: subscribe per open channel, with or without an Agora target
  // (commands route by their channel id, so an unsynced or large group still
  // shows typing); each peer signal (re)arms a clear timer so the row stays
  // while they type and disappears INBOUND_CLEAR_MS after they stop, or at once
  // when their message lands. Switching channels or unmounting clears every
  // timer and the handler.
  useEffect(() => {
    setState(EMPTY);
    if (client === null || channelId === null) return;
    return trackChannelTyping({
      connection: asTypingConnection(client),
      target: targetRef.current,
      channelId,
      currentUserId,
      setState,
    });
  }, [client, channelId, currentUserId]);

  return { typingUserIds, notifyTyping };
}
