import type { AgoraChat } from 'agora-chat';

/**
 * Connection lifecycle as the rest of the app sees it. 'connecting' is the
 * first open (nothing has connected yet), 'reconnecting' is any gap after a
 * successful connection, and 'unavailable' is reached only when the availability
 * gate is closed (no token URL, no session, no workspace), on signout, or after
 * the controller's retry loop gives up. Chat reads and sends go to Postgres, so
 * the UI stays mounted through 'connecting' and 'reconnecting'.
 */
export type ChatStatus = 'connecting' | 'connected' | 'reconnecting' | 'unavailable';

/** Stable id for our SDK event handler, used on both add and remove. */
export const CHAT_EVENT_HANDLER_ID = 'sorted-chat';

/**
 * The slice of the agora-chat Connection the lifecycle drives. The real
 * AgoraChat.Connection satisfies it structurally; narrowing to these members
 * keeps the lifecycle code (and its mock in tests) honest about what it touches.
 */
export interface ChatConnection {
  open(params: { user: string; accessToken: string }): Promise<unknown>;
  close(): void;
  renewToken(token: string): Promise<unknown>;
  addEventHandler(id: string, handler: AgoraChat.EventHandlerType): void;
  removeEventHandler(id: string): void;
}

/** Builds a fresh connection bound to the App Key returned by the token worker. */
export type CreateConnection = (appKey: string) => ChatConnection;

/**
 * The chat-token worker's success body, verbatim (token, expires_at,
 * agora_username, app_key). Discriminated so callers branch on `ok` and never
 * read fields off a failed fetch.
 */
export type ChatTokenResult =
  | {
      ok: true;
      token: string;
      expires_at: string;
      agora_username: string;
      app_key: string;
    }
  | { ok: false };

/** Exposed via ChatProvider. `client` is null until the SDK connection is open. */
export interface ChatContextValue {
  status: ChatStatus;
  client: ChatConnection | null;
  /** Restart the connection attempt now (the Retry button, after the loop gave up). */
  retry: () => void;
}
