// React adapter over runChatConnection. Reads the optional token URL, the
// Supabase session, and the active workspace; opens a connection in an effect
// and closes it in the cleanup. The effect is keyed on the URL, access token,
// and workspaceId, so a workspace switch tears the old connection down (React
// runs the previous cleanup) before a new one opens.

import { useEffect, useMemo, useState } from 'react';
import { env } from '@/lib/env';
import { fetchWithTrace } from '@/lib/fetch';
import { SIGNOUT_EVENT } from '@/lib/events';
import { useSession } from '@/lib/session-context';
import { useWorkspace } from '@/lib/workspace-context';
import { fetchChatToken } from '@/lib/chat/chat-token';
import { createAgoraConnection } from '@/lib/chat/connection';
import { runChatConnection } from '@/lib/chat/controller';
import type { ChatConnection, ChatContextValue, ChatStatus } from '@/lib/chat/types';

/** Subscribe to the shell's signout event; returns the unsubscribe. */
function addSignoutListener(handler: () => void): () => void {
  window.addEventListener(SIGNOUT_EVENT, handler);
  return () => window.removeEventListener(SIGNOUT_EVENT, handler);
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
  const accessToken = session?.access_token;

  useEffect(() => {
    if (!url || !accessToken || !workspaceId) {
      setStatus('unavailable');
      setClient(null);
      return;
    }
    return runChatConnection({
      fetchToken: () => fetchChatToken({ url, accessToken, workspaceId, fetcher: fetchWithTrace }),
      createConnection: createAgoraConnection,
      setStatus,
      setClient,
      addSignoutListener,
    });
  }, [url, accessToken, workspaceId]);

  return useMemo<ChatContextValue>(() => ({ status, client }), [status, client]);
}
