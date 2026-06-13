import type { AgoraChat } from 'agora-chat';

/**
 * Connection lifecycle as the rest of the app sees it. There is no error state:
 * any failure (missing env, no session, 401, SDK throw, network) collapses to
 * 'unavailable' so chat-down can never break the surrounding app.
 */
export type ChatStatus = 'connecting' | 'connected' | 'unavailable';

/** Stable id for our SDK event handler, used on both add and remove. */
export const CHAT_EVENT_HANDLER_ID = 'sorted-chat';

/**
 * The slice of the agora-chat Connection this PR drives. The real
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

/** Exposed to later PRs via ChatProvider. `client` is null until connected. */
export interface ChatContextValue {
  status: ChatStatus;
  client: ChatConnection | null;
}
