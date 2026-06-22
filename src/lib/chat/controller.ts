// Framework-agnostic connection lifecycle. The React hook is a thin adapter over
// this; keeping the logic here lets it be unit-tested under the repo's node test
// job without a DOM, with agora-chat and the network fully injected.
//
// Contract: runChatConnection starts one connection attempt and returns a
// teardown. Every expected failure resolves to status 'unavailable' and never
// throws. Teardown (called by the hook on workspace change, unmount, or signout)
// removes the event handler, closes the connection, and drops the signout
// listener, leaving nothing dangling.

import type { AgoraChat } from 'agora-chat';
import {
  CHAT_EVENT_HANDLER_ID,
  type ChatConnection,
  type ChatStatus,
  type ChatTokenResult,
  type CreateConnection,
} from '@/lib/chat/types';

/** A subscriber to every incoming text message, regardless of the open thread. */
export type GlobalMessageHandler = (message: AgoraChat.TextMsgBody) => void;

// Always-on fan-out for incoming text. The foundation handler (added below on
// every connection) feeds this registry so the live store can track unread for
// all conversations without opening a per-thread handler. The set is
// module-level so it survives reconnects; subscribers come and go with their
// own teardown and the foundation handler simply reads whoever is registered.
const globalMessageHandlers = new Set<GlobalMessageHandler>();

/** Subscribe to every incoming text message; returns the unsubscribe. */
export function subscribeGlobalMessages(handler: GlobalMessageHandler): () => void {
  globalMessageHandlers.add(handler);
  return () => {
    globalMessageHandlers.delete(handler);
  };
}

function dispatchGlobalMessage(message: AgoraChat.TextMsgBody): void {
  for (const handler of globalMessageHandlers) {
    handler(message);
  }
}

export interface RunChatConnectionParams {
  /** Mints a fresh token; reused for the initial open and for renewal. */
  fetchToken: () => Promise<ChatTokenResult>;
  createConnection: CreateConnection;
  setStatus: (status: ChatStatus) => void;
  setClient: (client: ChatConnection | null) => void;
  /** Subscribe to signout; returns the unsubscribe to call in teardown. */
  addSignoutListener: (handler: () => void) => () => void;
}

/**
 * Begin connecting and return a teardown. Status goes 'connecting' immediately,
 * 'connected' once the SDK opens, and 'unavailable' on any failure or on
 * signout. Renewal is driven by the SDK's onTokenWillExpire callback.
 */
export function runChatConnection(params: RunChatConnectionParams): () => void {
  const { fetchToken, createConnection, setStatus, setClient, addSignoutListener } = params;
  let connection: ChatConnection | null = null;
  let cancelled = false;

  setStatus('connecting');

  const detach = (conn: ChatConnection): void => {
    conn.removeEventHandler(CHAT_EVENT_HANDLER_ID);
    conn.close();
  };

  const teardown = (): void => {
    cancelled = true;
    removeSignout();
    if (connection !== null) {
      detach(connection);
      connection = null;
    }
    setClient(null);
  };

  const removeSignout = addSignoutListener(() => {
    teardown();
    setStatus('unavailable');
  });

  const renew = async (conn: ChatConnection): Promise<void> => {
    const next = await fetchToken();
    if (cancelled || !next.ok) {
      return;
    }
    try {
      await conn.renewToken(next.token);
    } catch {
      // A failed renewal surfaces as onDisconnected, which flips to 'unavailable'.
    }
  };

  const connect = async (): Promise<void> => {
    const result = await fetchToken();
    if (cancelled) {
      return;
    }
    if (!result.ok) {
      setStatus('unavailable');
      return;
    }

    const conn = createConnection(result.app_key);
    conn.addEventHandler(CHAT_EVENT_HANDLER_ID, {
      onConnected: () => setStatus('connected'),
      onDisconnected: () => setStatus('unavailable'),
      onTokenWillExpire: () => {
        void renew(conn);
      },
      onTextMessage: (message) => dispatchGlobalMessage(message),
      onError: () => {
        /* Errors are reported through onDisconnected; nothing to surface here. */
      },
    });

    try {
      await conn.open({ user: result.agora_username, accessToken: result.token });
    } catch {
      detach(conn);
      setStatus('unavailable');
      return;
    }

    if (cancelled) {
      detach(conn);
      return;
    }
    connection = conn;
    setClient(conn);
    setStatus('connected');
  };

  void connect();

  return teardown;
}
