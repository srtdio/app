// Fetches each conversation's last message + unread count from the Agora server
// and maps every result back to OUR channel_id using the exact channel<->Agora
// mapping the open/send path already uses (targetFromSummary): group channels
// key on their synced Agora group id, DM channels on the peer's derived Agora
// username. The SDK stays behind an injected connection surface so this module
// is driven the same way thread.ts is, and the mapping reuses the registry
// roster (ChannelSummary[]) rather than inventing a second one.

import type { AgoraChat } from 'agora-chat';
import type { ChannelSummary } from '@/lib/chat-reads';
import { targetFromSummary } from '@/lib/chat/thread';
import type { ChatConnection } from '@/lib/chat/types';
import { OWN_PREFIX, type AgoraConversationSummary } from '@/lib/chat/chat-store';

/** Agora's server cap per page; we iterate the cursor until it is exhausted. */
const PAGE_SIZE = 50;

/**
 * The connection surface this module drives: the server conversation list. It is
 * a structural slice of the real Connection, so the Foundation client casts to
 * it the way it casts to ThreadConnection, without `unknown` or `any`.
 */
export interface ConversationsConnection extends ChatConnection {
  getServerConversations(params: {
    pageSize?: number;
    cursor?: string;
  }): Promise<AgoraChat.AsyncResult<AgoraChat.ServerConversations>>;
}

/** True when an Agora last-message overview is a text body we can preview. */
function isTextBody(message: unknown): message is AgoraChat.TextMsgBody {
  return (
    typeof message === 'object' &&
    message !== null &&
    'type' in message &&
    (message as { type: unknown }).type === 'txt'
  );
}

/**
 * Page through the server conversation list to completion. Channel counts per
 * workspace are small, so this bounded loop fully replaces an N+1 over channels;
 * it stops when the SDK returns an empty cursor (the documented last page).
 */
async function fetchServerConversations(
  connection: ConversationsConnection,
): Promise<AgoraChat.ConversationItem[]> {
  const all: AgoraChat.ConversationItem[] = [];
  let cursor = '';
  for (;;) {
    const result = await connection.getServerConversations({ pageSize: PAGE_SIZE, cursor });
    const data = result.data;
    if (data === undefined) {
      break;
    }
    all.push(...data.conversations);
    if (data.cursor === '') {
      break;
    }
    cursor = data.cursor;
  }
  return all;
}

/**
 * Index a workspace roster by its Agora conversation id (the same target the
 * open/send path resolves). Channels without a resolvable target (group not yet
 * synced, peer unknown) are omitted, so they simply get no Agora summary.
 */
export function buildChannelIndex(roster: readonly ChannelSummary[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const summary of roster) {
    const target = targetFromSummary(summary);
    if (target !== null) {
      index.set(target.targetId, summary.channelId);
    }
  }
  return index;
}

function previewOf(message: AgoraChat.ConversationItem['lastMessage']): {
  text: string;
  ts: number;
  from: string | undefined;
} {
  if (isTextBody(message)) {
    return { text: message.msg, ts: message.time, from: message.from };
  }
  return { text: '', ts: 0, from: undefined };
}

/**
 * Fetch the Agora conversation summaries and map them to our channel_id. Items
 * with no matching channel in the roster are dropped. A last message sent by the
 * current user carries the 'You' prefix so the seeded list line reads correctly.
 */
export async function fetchConversationSummaries(params: {
  connection: ConversationsConnection;
  roster: readonly ChannelSummary[];
  currentAgoraUsername: string;
}): Promise<AgoraConversationSummary[]> {
  const index = buildChannelIndex(params.roster);
  const items = await fetchServerConversations(params.connection);
  const summaries: AgoraConversationSummary[] = [];
  for (const item of items) {
    const channelId = index.get(item.conversationId);
    if (channelId === undefined) {
      continue;
    }
    const preview = previewOf(item.lastMessage);
    const isOwn = preview.from !== undefined && preview.from === params.currentAgoraUsername;
    summaries.push({
      channelId,
      lastMessageText: preview.text,
      lastMessageTs: preview.ts,
      unread: item.unReadCount,
      ...(isOwn ? { lastMessagePrefix: OWN_PREFIX } : {}),
    });
  }
  return summaries;
}
