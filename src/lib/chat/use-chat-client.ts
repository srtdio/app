// React adapter over runChatConnection. Reads the optional token URL, the
// Supabase session, and the active workspace; opens a connection in an effect
// and tears it down in the cleanup. The effect is keyed on the URL, the signed-in
// USER and the workspace, never the access token: Supabase rotates the token
// every 15 minutes, and a rotation must not close the live connection. The
// current token is read through a ref whenever the loop mints a chat token (open
// or renewal), so renewals always carry the freshest session. The connection
// reopens only on workspace change, sign-out (the user id goes away, plus the
// signout event), or unmount.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { env } from '@/lib/env';
import { fetchWithTrace } from '@/lib/fetch';
import { SIGNOUT_EVENT } from '@/lib/events';
import { useSession } from '@/lib/session-context';
import { useWorkspace } from '@/lib/workspace-context';
import { fetchChatToken } from '@/lib/chat/chat-token';
import { createAgoraConnection } from '@/lib/chat/connection';
import { runChatConnection } from '@/lib/chat/controller';
import type { ChatConnection, ChatContextValue, ChatStatus } from '@/lib/chat/types';

/** The inputs a connection is keyed on; anything else (the token) never reopens it. */
export interface ConnectionKeyInputs {
  url: string | undefined;
  userId: string | undefined;
  workspaceId: string | null;
}

/**
 * The identity of one connection. Two renders with the same key share the
 * connection; a changed key tears down and reopens. The access token is
 * deliberately not part of the key.
 */
export function connectionKey(inputs: ConnectionKeyInputs): string {
  return `${inputs.url ?? ''}|${inputs.userId ?? ''}|${inputs.workspaceId ?? ''}`;
}

/** Subscribe to the shell's signout event; returns the unsubscribe. */
function addSignoutListener(handler: () => void): () => void {
  window.addEventListener(SIGNOUT_EVENT, handler);
  return () => window.removeEventListener(SIGNOUT_EVENT, handler);
}

/** Wake signals: the tab becoming visible and the browser coming back online. */
function addWakeListener(handler: () => void): () => void {
  const onVisibility = (): void => {
    if (document.visibilityState === 'visible') handler();
  };
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('online', handler);
  return () => {
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('online', handler);
  };
}

/**
 * Drive the chat connection from auth + workspace state. When the token URL is
 * unset, there is no session, or no active workspace, the status is
 * 'unavailable' and no connection is attempted.
 */
export function useChatClient(): ChatContextValue {
  const { session } = useSession();
  const { workspaceId } = useWorkspace();
  const [status, setStatus] = useState<ChatStatus>('unavailable');
  const [client, setClient] = useState<ChatConnection | null>(null);

  const url = env.VITE_CHAT_TOKEN_URL;
  const userId = session?.user.id;

  // The freshest access token, read lazily by every token mint (open + renew).
  const accessTokenRef = useRef(session?.access_token);
  accessTokenRef.current = session?.access_token;
  const retryRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (!url || !userId || !workspaceId) {
      setStatus('unavailable');
      setClient(null);
      retryRef.current = () => {};
      return;
    }
    const handle = runChatConnection({
      fetchToken: () =>
        fetchChatToken({
          url,
          accessToken: accessTokenRef.current,
          workspaceId,
          fetcher: fetchWithTrace,
        }),
      createConnection: createAgoraConnection,
      setStatus,
      setClient,
      addSignoutListener,
      addWakeListener,
    });
    retryRef.current = handle.retry;
    return () => {
      retryRef.current = () => {};
      handle.teardown();
    };
    // Keyed on the connection identity only (see connectionKey): the access
    // token is read through the ref and must never reopen the connection.
  }, [url, userId, workspaceId]);

  const retry = useCallback(() => retryRef.current(), []);

  return useMemo<ChatContextValue>(() => ({ status, client, retry }), [status, client, retry]);
}
