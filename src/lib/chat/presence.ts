// Peer presence for DM headers, driven entirely by Agora Chat presence. Pure
// functions with the SDK connection injected (mirrors thread.ts): the React
// adapter and tests supply a connection, these helpers never reach for a global.
// Online/offline is derived automatically by Agora from login/logout, so we only
// subscribe + read; we never publishPresence.

import type { AgoraChat } from 'agora-chat';
import type { ChatConnection } from '@/lib/chat/types';

/** Stable id for our presence event handler, distinct from the thread handler. */
export const PRESENCE_EVENT_HANDLER_ID = 'chat-presence';

/** Subscription window; Agora caps and we renew on every channel open anyway. */
export const PRESENCE_SUBSCRIBE_EXPIRY_SECONDS = 604800; // 7 days

/** Peer presence as the header sees it. `lastTimeMs` is epoch ms or null. */
export interface PresenceState {
  online: boolean;
  lastTimeMs: number | null;
}

/**
 * The slice of the agora-chat Connection this PR drives for presence. The real
 * AgoraChat.Connection satisfies it structurally; narrowing keeps the code (and
 * its mock) honest about what it touches.
 */
export interface PresenceConnection extends ChatConnection {
  subscribePresence(params: {
    usernames: string[];
    expiry: number;
  }): Promise<AgoraChat.AsyncResult<AgoraChat.SubscribePresenceResult>>;
  unsubscribePresence(params: { usernames: string[] }): Promise<void>;
}

/** A device→status map is "online" when any device reports a positive status. */
export function onlineFromStatusMap(status: object): boolean {
  return (Object.values(status) as unknown[]).some((v) => Number(v) > 0);
}

/** Parse an initial subscribe fetch for the peer; null when the peer is absent. */
export function parseSubscribePresence(
  list: AgoraChat.SubscribePresence[],
  peerUsername: string,
): PresenceState | null {
  const entry = list.find((e) => e.uid === peerUsername);
  if (entry === undefined) return null;
  return {
    online: onlineFromStatusMap(entry.status),
    lastTimeMs: entry.last_time > 0 ? entry.last_time * 1000 : null,
  };
}

/** Parse a live presence-change event for the peer; null when absent. */
export function parsePresenceEvent(
  list: AgoraChat.PresenceType[],
  peerUsername: string,
): PresenceState | null {
  const entry = list.find((e) => e.userId === peerUsername);
  if (entry === undefined) return null;
  return {
    online: entry.statusDetails.some((d) => d.status > 0),
    lastTimeMs: entry.lastTime > 0 ? entry.lastTime * 1000 : null,
  };
}

/** Subscribe to the peer and return its current presence (null if not present). */
export async function subscribePeerPresence(params: {
  connection: PresenceConnection;
  peerUsername: string;
}): Promise<PresenceState | null> {
  const { connection, peerUsername } = params;
  const res = await connection.subscribePresence({
    usernames: [peerUsername],
    expiry: PRESENCE_SUBSCRIBE_EXPIRY_SECONDS,
  });
  const list = res.data?.result ?? [];
  return parseSubscribePresence(list, peerUsername);
}

/** Register the live change handler; returns a teardown that removes it. */
export function subscribePresenceChange(params: {
  connection: PresenceConnection;
  peerUsername: string;
  onChange: (state: PresenceState) => void;
}): () => void {
  const { connection, peerUsername, onChange } = params;
  connection.addEventHandler(PRESENCE_EVENT_HANDLER_ID, {
    onPresenceStatusChange: (list) => {
      const s = parsePresenceEvent(list, peerUsername);
      if (s !== null) onChange(s);
    },
  });
  return () => connection.removeEventHandler(PRESENCE_EVENT_HANDLER_ID);
}

/** Best-effort unsubscribe when the header stops watching the peer. */
export async function unsubscribePeerPresence(params: {
  connection: PresenceConnection;
  peerUsername: string;
}): Promise<void> {
  await params.connection.unsubscribePresence({ usernames: [params.peerUsername] });
}
