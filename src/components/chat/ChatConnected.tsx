import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { supabase } from '@/lib/supabase';
import { logger } from '@/lib/logger';
import { useMediaQuery } from '@/lib/use-media-query';
import {
  listChannelSummaries,
  readProfiles,
  type ChannelSummary,
  type ChatProfile,
} from '@/lib/chat-reads';
import { targetFromSummary, type ChannelTarget } from '@/lib/chat/thread';
import { useChatThread } from '@/lib/chat/use-chat-thread';
import type { ChatConnection } from '@/lib/chat/types';
import { ChannelList } from '@/components/chat/ChannelList';
import { MessageThread } from '@/components/chat/MessageThread';

interface ChatConnectedProps {
  client: ChatConnection | null;
  workspaceId: string;
  currentUserId: string;
}

const DESKTOP_QUERY = '(min-width: 768px)';

/** Resolve a channel's Agora target defensively; a bad row yields no target. */
function safeTarget(channel: ChannelSummary | null): ChannelTarget | null {
  if (channel === null) return null;
  try {
    return targetFromSummary(channel);
  } catch (error) {
    logger.error('chat: failed to derive channel target', { error: String(error) });
    return null;
  }
}

export function ChatConnected(props: ChatConnectedProps): ReactElement {
  const { client, workspaceId, currentUserId } = props;
  const isDesktop = useMediaQuery(DESKTOP_QUERY);

  const [channels, setChannels] = useState<ChannelSummary[]>([]);
  const [selected, setSelected] = useState<ChannelSummary | null>(null);
  const [profiles, setProfiles] = useState<Map<string, ChatProfile>>(new Map());

  // Load the channel list (registry + batched display resolution) for the workspace.
  useEffect(() => {
    let cancelled = false;
    void listChannelSummaries(supabase, { workspaceId, currentUserId }).then((result) => {
      if (cancelled) return;
      setChannels(result.ok ? result.data : []);
      if (!result.ok)
        logger.error('chat: failed to list channels', { error: result.error.message });
    });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, currentUserId]);

  const target = useMemo(() => safeTarget(selected), [selected]);
  const thread = useChatThread({ client, target, currentUserId });

  // Resolve sender display info in one batched read per set of new ids (no N+1).
  useEffect(() => {
    const needed = new Set<string>();
    for (const message of thread.messages) {
      if (message.senderUserId !== null && !profiles.has(message.senderUserId)) {
        needed.add(message.senderUserId);
      }
    }
    if (selected?.peerUserId != null && !profiles.has(selected.peerUserId)) {
      needed.add(selected.peerUserId);
    }
    if (needed.size === 0) return;
    let cancelled = false;
    void readProfiles(supabase, [...needed]).then((result) => {
      if (cancelled || !result.ok) return;
      setProfiles((prev) => {
        const next = new Map(prev);
        for (const profile of result.data) next.set(profile.userId, profile);
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [thread.messages, selected, profiles]);

  const onBack = useCallback(() => setSelected(null), []);

  const showList = isDesktop || selected === null;
  const showThread = isDesktop || selected !== null;

  return (
    <div className="flex h-full min-h-0">
      {showList ? (
        <div className="h-full w-full border-border md:w-72 md:border-r">
          <ChannelList
            channels={channels}
            selectedChannelId={selected?.channelId ?? null}
            onSelect={setSelected}
          />
        </div>
      ) : null}
      {showThread ? (
        <div className="h-full min-w-0 flex-1">
          {selected !== null ? (
            <MessageThread
              title={selected.title}
              profiles={profiles}
              messages={thread.messages}
              loading={thread.loading}
              sending={thread.sending}
              canSend={target !== null}
              onSend={thread.send}
              {...(isDesktop ? {} : { onBack })}
            />
          ) : (
            <div className="flex h-full items-center justify-center px-6 text-center text-sm text-fg-3">
              Select a conversation to start messaging.
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
