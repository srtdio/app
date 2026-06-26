// Thin React adapter over the pure presence helpers. Subscribes to the DM peer's
// Agora presence on open, follows live changes, and tears everything down on
// channel switch / unmount. Presence may be disabled for an account, so a
// subscribe failure collapses to `available: false` and never throws: chat must
// keep working with no presence line at all.

import { useEffect, useState } from 'react';
import type { ChatConnection } from '@/lib/chat/types';
import {
  subscribePeerPresence,
  subscribePresenceChange,
  unsubscribePeerPresence,
  type PresenceConnection,
} from '@/lib/chat/presence';
import { toAgoraUsername } from '@/lib/chat/agora-identity';

export interface UseChatPresence {
  available: boolean;
  online: boolean;
  lastTimeMs: number | null;
}

/** The real connection structurally satisfies PresenceConnection; cast locally. */
function asPresenceConnection(client: ChatConnection): PresenceConnection {
  return client as PresenceConnection;
}

export function useChatPresence(params: {
  client: ChatConnection | null;
  peerUserId: string | null;
}): UseChatPresence {
  const { client, peerUserId } = params;
  const [available, setAvailable] = useState(false);
  const [online, setOnline] = useState(false);
  const [lastTimeMs, setLastTimeMs] = useState<number | null>(null);

  useEffect(() => {
    // No peer (group case) or no client: nothing to watch.
    if (client === null || peerUserId === null) {
      setAvailable(false);
      setOnline(false);
      setLastTimeMs(null);
      return;
    }

    let cancelled = false;
    const connection = asPresenceConnection(client);
    const peerUsername = toAgoraUsername(peerUserId);

    const teardownChange = subscribePresenceChange({
      connection,
      peerUsername,
      onChange: (state) => {
        if (cancelled) return;
        setOnline(state.online);
        setLastTimeMs(state.lastTimeMs);
      },
    });

    void (async () => {
      try {
        const state = await subscribePeerPresence({ connection, peerUsername });
        if (cancelled) return;
        setAvailable(true);
        if (state !== null) {
          setOnline(state.online);
          setLastTimeMs(state.lastTimeMs);
        } else {
          setOnline(false);
          setLastTimeMs(null);
        }
      } catch {
        // Presence may be disabled for the account: degrade, never crash chat.
        if (cancelled) return;
        setAvailable(false);
      }
    })();

    return () => {
      cancelled = true;
      teardownChange();
      void unsubscribePeerPresence({ connection, peerUsername }).catch(() => {});
    };
  }, [client, peerUserId]);

  return { available, online, lastTimeMs };
}
