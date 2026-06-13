// React adapter over the framework-agnostic thread logic. Opens the live thread
// for the selected channel (history + incoming subscription) and tears it down
// on channel change or unmount. Sender names/avatars are resolved by mapping the
// Agora username back to a Sorted user id and reading profiles in one batched
// query (no per-message fetch).

import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { listProfilesByIds, type UserProfileRow } from '@/lib/chat-reads';
import { logger } from '@/lib/logger';
import { fromAgoraUsername, toAgoraUsername } from '@/lib/chat/agora-identity';
import {
  openThread,
  sendText,
  type ThreadConnection,
  type ThreadMessage,
  type ThreadTarget,
} from '@/lib/chat/thread';

export interface SenderProfile {
  displayName: string;
  avatarUrl: string | null;
}

export interface ThreadView {
  messages: ThreadMessage[];
  senderFor: (username: string) => SenderProfile | null;
  send: (text: string) => void;
}

interface SenderRef {
  username: string;
  userId: string;
}

export function useChatThread(input: {
  client: ThreadConnection;
  target: ThreadTarget | null;
  currentUserId: string;
}): ThreadView {
  const { client, target, currentUserId } = input;
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [senders, setSenders] = useState<Map<string, SenderProfile>>(new Map());

  useEffect(() => {
    setMessages([]);
    if (target === null) return;
    return openThread({
      client,
      target,
      onHistory: setMessages,
      onIncoming: (message) => setMessages((prev) => [...prev, message]),
    });
  }, [client, target]);

  useEffect(() => {
    const unresolved = unresolvedSenders(messages, senders);
    if (unresolved.length === 0) return;
    let active = true;
    void (async () => {
      const res = await listProfilesByIds(supabase, { ids: unresolved.map((s) => s.userId) });
      if (!active || !res.ok) return;
      setSenders((prev) => mergeSenders(prev, unresolved, res.data));
    })();
    return () => {
      active = false;
    };
  }, [messages, senders]);

  const send = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (target === null || trimmed.length === 0) return;
      void sendText({ client, target, text: trimmed })
        .then((result) => {
          setMessages((prev) => [
            ...prev,
            {
              id: result.serverMsgId,
              senderUsername: toAgoraUsername(currentUserId),
              body: trimmed,
              time: Date.now(),
            },
          ]);
        })
        .catch((error: unknown) => logger.error('chat send failed', { error: String(error) }));
    },
    [client, target, currentUserId],
  );

  const senderFor = useCallback((username: string) => senders.get(username) ?? null, [senders]);

  return useMemo<ThreadView>(() => ({ messages, senderFor, send }), [messages, senderFor, send]);
}

/** Sender usernames in the thread not yet resolved and that map to a valid id. */
function unresolvedSenders(
  messages: ThreadMessage[],
  known: Map<string, SenderProfile>,
): SenderRef[] {
  const out = new Map<string, SenderRef>();
  for (const message of messages) {
    const username = message.senderUsername;
    if (username.length === 0 || known.has(username) || out.has(username)) continue;
    try {
      out.set(username, { username, userId: fromAgoraUsername(username) });
    } catch {
      // Not a Sorted-derived username (e.g. a system sender); leave unresolved.
    }
  }
  return [...out.values()];
}

function mergeSenders(
  prev: Map<string, SenderProfile>,
  refs: SenderRef[],
  profiles: UserProfileRow[],
): Map<string, SenderProfile> {
  const byId = new Map(profiles.map((p) => [p.id, p]));
  const next = new Map(prev);
  for (const ref of refs) {
    const found = byId.get(ref.userId);
    next.set(ref.username, {
      displayName: found?.display_name ?? 'Member',
      avatarUrl: found?.avatar_url ?? null,
    });
  }
  return next;
}
