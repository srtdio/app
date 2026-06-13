// Token fetch for Agora Chat. POSTs { workspace_id } to the chat-token worker
// (VITE_CHAT_TOKEN_URL) with a Bearer Supabase access token, through the same
// fetchWithTrace wrapper the app passes for assets so X-Trace-Id rides along.
//
// The worker contract is read verbatim from src/server/workers/chat-token.ts: a
// 200 returns { token, expires_at, agora_username, app_key }. This never throws
// on an expected failure (no URL, no session, network error, non-2xx); each of
// those resolves to { ok: false } so the availability gate can stay closed
// without breaking the rest of the app.

import type { ChatTokenResult } from '@/lib/chat/types';

export interface ChatTokenRequest {
  /** VITE_CHAT_TOKEN_URL; when empty/undefined chat is unavailable. */
  url: string | undefined;
  /** Supabase session access token; absent when signed out. */
  accessToken: string | undefined;
  workspaceId: string;
  /** Injected so tests pass a mock; the app passes fetchWithTrace. */
  fetcher: (input: string, init: RequestInit) => Promise<Response>;
}

/**
 * Mint a chat token, or report { ok: false } for any expected failure. The URL
 * and session are checked first so a closed gate never triggers a request.
 */
export async function fetchChatToken(request: ChatTokenRequest): Promise<ChatTokenResult> {
  if (!request.url || !request.accessToken) {
    return { ok: false };
  }

  let response: Response;
  try {
    response = await request.fetcher(request.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${request.accessToken}`,
      },
      body: JSON.stringify({ workspace_id: request.workspaceId }),
    });
  } catch {
    return { ok: false };
  }

  if (!response.ok) {
    return { ok: false };
  }
  return parseTokenBody(await readJson(response));
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/** Accept a body only when all four worker fields are present strings. */
function parseTokenBody(body: unknown): ChatTokenResult {
  if (typeof body !== 'object' || body === null) {
    return { ok: false };
  }
  const fields = body as Record<string, unknown>;
  const token = fields.token;
  const expiresAt = fields.expires_at;
  const agoraUsername = fields.agora_username;
  const appKey = fields.app_key;
  if (
    typeof token !== 'string' ||
    typeof expiresAt !== 'string' ||
    typeof agoraUsername !== 'string' ||
    typeof appKey !== 'string'
  ) {
    return { ok: false };
  }
  return {
    ok: true,
    token,
    expires_at: expiresAt,
    agora_username: agoraUsername,
    app_key: appKey,
  };
}
