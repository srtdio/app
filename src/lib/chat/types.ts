import type { AgoraChat } from 'agora-chat';

/**
 * Connection lifecycle as the rest of the app sees it. 'connecting' is the
 * first open (nothing has connected yet), 'reconnecting' is any gap after a
 * successful connection (live delivery is being restored; the loop never gives
 * up). 'unavailable' is reached only when the availability gate is closed (no
 * token URL, no session, no workspace), on signout, or when the token endpoint
 * refuses the caller (401/403) or cannot be reached at all (CORS/network).
 * 'kicked' means another device signed in with this account and retrying has
 * stopped for this session until the user taps to reconnect. Chat reads and
 * sends go to Postgres, so the UI stays mounted in every state that has a
 * workspace and a user.
 */
export type ChatStatus = 'connecting' | 'connected' | 'reconnecting' | 'unavailable' | 'kicked';

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
  | { ok: false; reason: ChatTokenFailure };

/**
 * Why a token mint failed. 'auth': the worker answered 401/403. 'network': the
 * request itself failed (CORS, offline, DNS). 'config': no URL or no session,
 * so no request was made. 'error': any other non-2xx or a malformed body.
 */
export type ChatTokenFailure = 'auth' | 'network' | 'config' | 'error';

/** Exposed via ChatProvider. `client` is null until the SDK connection is open. */
export interface ChatContextValue {
  status: ChatStatus;
  client: ChatConnection | null;
  /** Restart the connection attempt now (the Retry / reconnect tap). */
  retry: () => void;
}
