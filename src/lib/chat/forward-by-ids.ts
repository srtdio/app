// Forward messages known only by id (the chat home chip views select items, not
// loaded thread rows): one read of those rows on the picker's Send (never on a
// paint or open), mapped exactly as the thread maps them (rowToThreadMessage,
// so body, files, shared posts and briefs carry over), then the thread's own
// forward run. A failed read fails the forward on its first chat (the picker
// toasts it and stays open).

import type { Client } from '@srtdio/rpc';
import type { ChannelSummary } from '@/lib/chat-reads';
import { loadMessagesByIds } from '@/lib/chat/history';
import { rowToThreadMessage, type ThreadMessage } from '@/lib/chat/thread';
import { logger } from '@/lib/logger';

export type ForwardByIdsResult = { ok: true } | { ok: false; failed: ChannelSummary | null };

export async function forwardMessagesByIds(input: {
  client: Client;
  currentUserId: string;
  messageIds: readonly string[];
  targets: ChannelSummary[];
  forward: (
    messages: readonly ThreadMessage[],
    targets: ChannelSummary[],
  ) => Promise<ForwardByIdsResult>;
}): Promise<ForwardByIdsResult> {
  if (input.messageIds.length === 0 || input.targets.length === 0) return { ok: true };
  const read = await loadMessagesByIds(input.client, input.messageIds);
  if (!read.ok) {
    logger.warn('chat: forward by id read failed', { error: read.error.message });
    return { ok: false, failed: input.targets[0] ?? null };
  }
  const messages = read.data
    .filter((row) => row.deleted_at === null)
    .map((row) => rowToThreadMessage(row, input.currentUserId));
  return input.forward(messages, input.targets);
}
