import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { useSearchParams } from 'react-router-dom';
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
import { useChatTyping } from '@/lib/chat/use-chat-typing';
import { useChatPresence } from '@/lib/chat/use-chat-presence';
import { useChatStore } from '@/components/chat/ChatStoreProvider';
import type { ChatConnection } from '@/lib/chat/types';
import { ChannelList } from '@/components/chat/ChannelList';
import { MessageThread } from '@/components/chat/MessageThread';
import { NewChatSheet } from '@/components/chat/NewChatSheet';
import { GroupInfoSheet } from '@/components/chat/GroupInfoSheet';

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
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [groupInfoOpen, setGroupInfoOpen] = useState(false);

  // Email deep-link: ?channel={channelId} selects that channel once the list
  // loads. Read through refs so the initial-load effect keeps its existing deps
  // (no extra channel refetch); the selection fires once per distinct id and only
  // 'channel' is stripped, preserving any sibling deep-link param.
  const [searchParams, setSearchParams] = useSearchParams();
  const searchParamsRef = useRef(searchParams);
  searchParamsRef.current = searchParams;
  const setSearchParamsRef = useRef(setSearchParams);
  setSearchParamsRef.current = setSearchParams;
  const selectedFromParam = useRef<string | null>(null);

  // Load the channel list (registry + batched display resolution) for the workspace.
  useEffect(() => {
    let cancelled = false;
    void listChannelSummaries(supabase, { workspaceId, currentUserId }).then((result) => {
      if (cancelled) return;
      setChannels(result.ok ? result.data : []);
      if (!result.ok) {
        logger.error('chat: failed to list channels', { error: result.error.message });
        return;
      }
      const channel = searchParamsRef.current.get('channel');
      if (channel === null || channel === '') return;
      if (selectedFromParam.current !== channel) {
        selectedFromParam.current = channel;
        const found = result.data.find((c) => c.channelId === channel);
        if (found !== undefined) setSelected(found);
      }
      const next = new URLSearchParams(searchParamsRef.current);
      next.delete('channel');
      setSearchParamsRef.current(next, { replace: true });
    });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, currentUserId]);

  // Re-read the channel list after a mutation. When channelId is given, the
  // matching (possibly newly created) channel is selected and opened.
  const refreshChannels = useCallback(
    async (channelId: string | null): Promise<void> => {
      const result = await listChannelSummaries(supabase, { workspaceId, currentUserId });
      if (!result.ok) {
        logger.error('chat: failed to refresh channels', { error: result.error.message });
        return;
      }
      setChannels(result.data);
      if (channelId !== null) {
        const found = result.data.find((channel) => channel.channelId === channelId);
        if (found !== undefined) setSelected(found);
      }
    },
    [workspaceId, currentUserId],
  );

  const onDmReady = useCallback(
    (channelId: string) => {
      setNewChatOpen(false);
      void refreshChannels(channelId);
    },
    [refreshChannels],
  );

  const onGroupCreated = useCallback(() => {
    setNewChatOpen(false);
    void refreshChannels(null);
  }, [refreshChannels]);

  const onGroupChanged = useCallback(() => {
    void refreshChannels(selected?.channelId ?? null);
  }, [refreshChannels, selected]);

  const onGroupLeft = useCallback(() => {
    setGroupInfoOpen(false);
    setSelected(null);
    void refreshChannels(null);
  }, [refreshChannels]);

  const {
    state: chatStore,
    setActive,
    markConversationRead,
    updateOwnMessage,
    clearPendingOpen,
  } = useChatStore();

  // Keep the live store's active conversation in step with the open channel:
  // opening one marks it read (and acks Agora); leaving or unmounting clears it.
  const selectedChannelId = selected?.channelId ?? null;
  useEffect(() => {
    if (selectedChannelId === null) {
      setActive(null);
      return;
    }
    setActive(selectedChannelId);
    markConversationRead(selectedChannelId);
    return () => setActive(null);
  }, [selectedChannelId, setActive, markConversationRead]);

  // A toast press asks the store to open a channel; consume it once the list is
  // loaded by selecting that channel, then clear the request.
  const pendingOpen = chatStore.pendingOpenConversationId;
  useEffect(() => {
    if (pendingOpen === null || channels.length === 0) return;
    const found = channels.find((channel) => channel.channelId === pendingOpen);
    if (found !== undefined) setSelected(found);
    clearPendingOpen();
  }, [pendingOpen, channels, clearPendingOpen]);

  const onOwnMessage = useCallback(
    (text: string) => {
      if (selectedChannelId !== null) updateOwnMessage(selectedChannelId, text);
    },
    [selectedChannelId, updateOwnMessage],
  );

  const target = useMemo(() => safeTarget(selected), [selected]);
  const thread = useChatThread({ client, target, currentUserId, onOwnMessage });
  const typing = useChatTyping({ client, target, currentUserId });
  const presence = useChatPresence({ client, peerUserId: selected?.peerUserId ?? null });

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

  const isGroup = selected?.channelType === 'group';

  return (
    <div className="flex h-full min-h-0">
      {showList ? (
        <div className="h-full w-full border-border md:w-72 md:border-r">
          <ChannelList
            channels={channels}
            selectedChannelId={selected?.channelId ?? null}
            onSelect={setSelected}
            onNewChat={() => setNewChatOpen(true)}
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
              typingUserIds={typing.typingUserIds}
              onTyping={typing.notifyTyping}
              {...(selected?.peerUserId != null ? { presence } : {})}
              {...(isDesktop ? {} : { onBack })}
              {...(isGroup ? { onOpenInfo: () => setGroupInfoOpen(true) } : {})}
            />
          ) : (
            <div className="flex h-full items-center justify-center px-6 text-center text-sm text-fg-3">
              Select a conversation to start messaging.
            </div>
          )}
        </div>
      ) : null}

      <NewChatSheet
        open={newChatOpen}
        onClose={() => setNewChatOpen(false)}
        workspaceId={workspaceId}
        currentUserId={currentUserId}
        onDmReady={onDmReady}
        onGroupCreated={onGroupCreated}
      />

      {isGroup && selected?.groupId != null ? (
        <GroupInfoSheet
          open={groupInfoOpen}
          onClose={() => setGroupInfoOpen(false)}
          workspaceId={workspaceId}
          groupId={selected.groupId}
          groupName={selected.title}
          currentUserId={currentUserId}
          onChanged={onGroupChanged}
          onLeft={onGroupLeft}
        />
      ) : null}
    </div>
  );
}
