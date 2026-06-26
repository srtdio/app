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

export interface UseChatTyping {
  /** Sorted user ids currently typing in the open channel (peers only). */
  typingUserIds: string[];
  /** Broadcast that the current user is typing; throttled and a no-op when idle. */
  notifyTyping: () => void;
}

export function useChatTyping(params: {
  client: ChatConnection | null;
  target: ChannelTarget | null;
  currentUserId: string;
}): UseChatTyping {
  const { client, target, currentUserId } = params;

  const [typingUserIds, setTypingUserIds] = useState<string[]>([]);

  // Outbound state read through refs so notifyTyping stays a stable callback.
  const clientRef = useRef(client);
  clientRef.current = client;
  const targetRef = useRef(target);
  targetRef.current = target;
  const lastSentRef = useRef(0);

  const notifyTyping = useCallback(() => {
    const activeClient = clientRef.current;
    const activeTarget = targetRef.current;
    if (activeClient === null || activeTarget === null) return;
    const now = Date.now();
    if (now - lastSentRef.current < OUTBOUND_THROTTLE_MS) return;
    lastSentRef.current = now;
    void sendTyping({
      connection: asTypingConnection(activeClient),
      target: activeTarget,
      createCmd: createCmdMessage,
    });
  }, []);

  // Inbound: subscribe per open channel; each peer signal (re)arms a clear timer
  // so the row stays while they type and disappears INBOUND_CLEAR_MS after they
  // stop. Switching channels or unmounting clears every timer and the handler.
  useEffect(() => {
    if (client === null || target === null) {
      setTypingUserIds([]);
      return;
    }
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const teardown = subscribeTyping({
      connection: asTypingConnection(client),
      target,
      currentUserId,
      onTypingFrom: (userId) => {
        setTypingUserIds((prev) => (prev.includes(userId) ? prev : [...prev, userId]));
        const existing = timers.get(userId);
        if (existing !== undefined) clearTimeout(existing);
        timers.set(
          userId,
          setTimeout(() => {
            timers.delete(userId);
            setTypingUserIds((prev) => prev.filter((id) => id !== userId));
          }, INBOUND_CLEAR_MS),
        );
      },
    });
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      teardown();
    };
  }, [client, target, currentUserId]);

  return { typingUserIds, notifyTyping };
}
