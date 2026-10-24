// F8 conversation picker: pick one of the user's existing chat conversations and
// send the current post into it. The list comes verbatim from the existing
// listChannelSummaries (the same read the Chat page uses). Sending is Postgres
// first, like every chat send: the message is recorded through
// chat_message_send (sharePostToChannel), and only then published over Agora
// when the shell-level connection is open and the conversation has a live
// target. A closed connection, a Notes channel or an unsynced group never
// blocks the send: the row exists and receivers catch up from Postgres. No
// connection-gated UI anywhere; while the read is in flight, skeleton rows
// hold the final row height, and the body keeps one fixed height in every state.

import { useState, useEffect } from 'react';
import type { ReactElement } from 'react';
import { supabase } from '@/lib/supabase';
import { useChat } from '@/lib/chat';
import { listChannelSummaries, type ChannelSummary } from '@/lib/chat-reads';
import {
  sendText,
  targetFromSummary,
  type ChannelTarget,
  type ThreadConnection,
} from '@/lib/chat/thread';
import { createTextMessage } from '@/lib/chat/message-factory';
import { newMessageId } from '@/lib/chat/message-id';
import { sendMessageRecord } from '@/lib/chat/record';
import { sharePostToChannel } from '@/lib/chat/share-post';
import { createInFlightGuard } from '@/lib/chat/thread-actions';
import { generateTraceId } from '@/lib/trace';
import { logger } from '@/lib/logger';
import { errorText } from '@/lib/error-copy';
import { ActionRow } from '@/components/ui/ActionRow';
import { IconChat } from '@/components/ui/icons';

interface ConversationPickerProps {
  /** The post being shared into a conversation. */
  postId: string;
  workspaceId: string;
  currentUserId: string;
  /** Surface a success/failure toast (the page owns the toast stack). */
  onToast: (message: string) => void;
  /** Called after a successful send so the parent can close the sheet. */
  onSent: () => void;
}

export type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; channels: ChannelSummary[] }
  | { status: 'error' };

/** Human label for a conversation's type, beneath its title. */
function channelTypeLabel(channel: ChannelSummary): string {
  return channel.channelType === 'group' ? 'Group' : 'Direct message';
}

export function ConversationPicker({
  postId,
  workspaceId,
  currentUserId,
  onToast,
  onSent,
}: ConversationPickerProps) {
  const { client } = useChat();
  const [load, setLoad] = useState<LoadState>({ status: 'loading' });
  const [sendingId, setSendingId] = useState<string | null>(null);
  // Synchronous double-tap guard (state updates land a render later).
  const [guard] = useState(createInFlightGuard);

  // Populate the list from the existing channel read. An empty workspace/user id
  // (no active workspace) simply yields no conversations, handled by the empty
  // state below rather than a thrown error.
  useEffect(() => {
    let cancelled = false;
    setLoad({ status: 'loading' });
    void listChannelSummaries(supabase, { workspaceId, currentUserId }).then((result) => {
      if (cancelled) return;
      setLoad(result.ok ? { status: 'ready', channels: result.data } : { status: 'error' });
    });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, currentUserId]);

  async function send(channel: ChannelSummary): Promise<void> {
    const target: ChannelTarget | null = targetFromSummary(channel);
    const connection = client;
    const result = await sharePostToChannel(
      {
        guard,
        // Runs only once the guard admits this tap, so a busy tap never
        // touches the row label.
        record: (input) => {
          setSendingId(channel.channelId);
          return sendMessageRecord({ client: supabase, ...input });
        },
        publish:
          connection !== null && target !== null
            ? (liveIds) =>
                sendText({
                  connection: connection as ThreadConnection,
                  target,
                  text: '',
                  attachments: [],
                  sharedPostIds: [postId],
                  reply: null,
                  createMessage: createTextMessage,
                  liveIds,
                })
            : null,
        newMessageId,
        newTraceId: generateTraceId,
        onPublishFailed: ({ error, traceId, messageId }) =>
          logger.warn('chat: shared post live publish did not complete', {
            trace_id: traceId,
            message_id: messageId,
            error,
          }),
      },
      { channelId: channel.channelId, postId },
    );
    if (!result.ok && result.reason === 'busy') return;
    setSendingId(null);
    if (result.ok) {
      onToast('Post sent to chat');
      onSent();
      return;
    }
    logger.error('chat: shared post record failed', {
      channel_id: channel.channelId,
      error: result.message,
    });
    onToast(errorText('send the post', result.message));
  }

  return conversationPickerBody(load, sendingId, (channel) => void send(channel));
}

/**
 * The sheet body's fixed height in every state (loading, list, empty, error),
 * so nothing shifts when the read settles; a longer list scrolls inside it.
 * Keep in step with BODY_BOX.
 */
export const CONVERSATION_BODY_PX = 288;

/** One ActionRow's box: py-2 plus the text-base and text-sm snug line boxes. */
const CONVERSATION_ROW_PX = 16 + 14 * 1.375 + 12 * 1.375;
/** The gap-1 between rows. */
const CONVERSATION_ROW_GAP_PX = 4;

/** Skeleton rows while the list loads: enough to fill the fixed body. */
export const CONVERSATION_SKELETON_ROWS = Math.ceil(
  (CONVERSATION_BODY_PX + CONVERSATION_ROW_GAP_PX) /
    (CONVERSATION_ROW_PX + CONVERSATION_ROW_GAP_PX),
);

/** The fixed body box shared by all four states. */
const BODY_BOX = 'h-[288px] overflow-y-auto';

/**
 * One placeholder with an ActionRow's box (padding, min height, the label and
 * sub line boxes at their line heights), so the rows swap in without a shift.
 */
function ConversationSkeletonRow(): ReactElement {
  return (
    <div
      data-conversation-skeleton=""
      className="flex w-full min-h-[44px] items-center gap-3 rounded-lg px-3 py-2"
    >
      <span className="h-[18px] w-[18px] shrink-0 rounded bg-panel-2" />
      <span className="flex min-w-0 flex-col">
        <span className="text-base font-medium leading-snug">
          <span className="inline-block h-3 w-32 rounded bg-panel-2 align-middle" />
        </span>
        <span className="text-sm leading-snug">
          <span className="inline-block h-2.5 w-20 rounded bg-panel-2 align-middle" />
        </span>
      </span>
    </div>
  );
}

/**
 * The picker's body for a load state: skeleton rows while loading, the error
 * or empty line, else one row per conversation. Never reads the connection.
 * Hook-free.
 */
export function conversationPickerBody(
  load: LoadState,
  sendingId: string | null,
  onSend: (channel: ChannelSummary) => void,
): ReactElement {
  if (load.status === 'loading') {
    return (
      <div className={BODY_BOX}>
        <div
          role="status"
          aria-busy="true"
          aria-label="Loading conversations"
          className="flex h-full flex-col gap-1 overflow-hidden"
        >
          {Array.from({ length: CONVERSATION_SKELETON_ROWS }).map((_, i) => (
            <ConversationSkeletonRow key={i} />
          ))}
        </div>
      </div>
    );
  }

  if (load.status === 'error' || load.channels.length === 0) {
    return (
      <div className={BODY_BOX}>
        <p className="flex h-full items-center justify-center px-3 text-center text-base text-fg-3">
          {load.status === 'error' ? errorText('load conversations', null) : 'No conversations yet'}
        </p>
      </div>
    );
  }

  return (
    <div className={BODY_BOX}>
      <div className="flex flex-col gap-1">
        {load.channels.map((channel) => (
          <ActionRow
            key={channel.channelId}
            icon={<IconChat size={18} />}
            label={channel.title}
            sub={sendingId === channel.channelId ? 'Sending…' : channelTypeLabel(channel)}
            onClick={() => onSend(channel)}
          />
        ))}
      </div>
    </div>
  );
}
