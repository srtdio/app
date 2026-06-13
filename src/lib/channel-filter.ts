// Pure, derived search for the chat channel list. The conversation summaries are
// already loaded by ChatConnected; this filters them client-side by display name
// (group name or DM peer name). No Agora, no DB read, no live-path involvement.

import type { ChannelSummary } from '@/lib/chat-reads';

/**
 * Filter conversation summaries by their display title (case-insensitive,
 * trimmed). An empty query returns the list unchanged so clearing search
 * restores every conversation in its existing order.
 */
export function filterChannelsByName(channels: ChannelSummary[], query: string): ChannelSummary[] {
  const q = query.trim().toLowerCase();
  if (q === '') return channels;
  return channels.filter((channel) => channel.title.toLowerCase().includes(q));
}
