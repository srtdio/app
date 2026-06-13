// Loads the channel list for the chat shell: the Sorted registry (chat_channels
// via listChannels) ordered created_at desc, enriched with display names via the
// batched channel-summary resolver. This reads the registry, never the message
// mirror. Last-message previews and unread counts are a later enhancement.

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { listChannels, resolveChannelSummaries, type ChannelSummary } from '@/lib/chat-reads';

export interface ChannelListState {
  loading: boolean;
  summaries: ChannelSummary[];
}

const EMPTY: ChannelListState = { loading: false, summaries: [] };

/**
 * Resolve every channel in the active workspace to a display summary. Any read
 * failure collapses to an empty list (chat-down never breaks the shell). Keyed
 * on workspace + user so a workspace switch reloads.
 */
export function useChatChannels(input: {
  workspaceId: string | null;
  currentUserId: string | null;
}): ChannelListState {
  const { workspaceId, currentUserId } = input;
  const [state, setState] = useState<ChannelListState>({ loading: true, summaries: [] });

  useEffect(() => {
    if (!workspaceId || !currentUserId) {
      setState(EMPTY);
      return;
    }
    let active = true;
    setState({ loading: true, summaries: [] });

    void (async () => {
      const listed = await listChannels(supabase, { workspace_id: workspaceId });
      if (!active) return;
      if (!listed.ok) {
        setState(EMPTY);
        return;
      }
      const ordered = [...listed.data].sort((a, b) => b.created_at.localeCompare(a.created_at));
      const resolved = await resolveChannelSummaries(supabase, {
        channels: ordered,
        currentUserId,
      });
      if (!active) return;
      setState({ loading: false, summaries: resolved.ok ? resolved.data : [] });
    })();

    return () => {
      active = false;
    };
  }, [workspaceId, currentUserId]);

  return state;
}
