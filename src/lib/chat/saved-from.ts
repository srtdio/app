// The "Saved from <chat> · <sender>" line on a saved copy in notes. A saved
// copy keeps its source's id (forwarded_from_message_id); the sources of a
// loaded page are read in ONE batched IN read (RLS: only sources the caller can
// still read come back, tombstones included), then the senders whose names are
// not loaded yet in one batched profile read. Never one read per row.

import type { Client, Result } from '@srtdio/rpc';
import type { Database } from '@srtdio/schemas';
import {
  abortable,
  readProfiles,
  withReadTimeout,
  type ChannelSummary,
  type ChatProfile,
} from '@/lib/chat-reads';
import type { ThreadMessage } from '@/lib/chat/thread';

type MessageRow = Database['public']['Tables']['chat_messages']['Row'];

/** The line when the source can no longer be read (the saver left that chat). */
export const SAVED_MESSAGE_LABEL = 'Saved message';

/** A source message as the line needs it. */
export interface SavedSource {
  id: string;
  channelId: string;
  senderUserId: string | null;
  deleted: boolean;
}

/** What one page's resolve learned: the readable sources and the sender names read. */
interface SavedSourcesRead {
  sources: SavedSource[];
  profiles: ChatProfile[];
}

/**
 * The source ids of loaded saved copies not asked about yet, in first-seen
 * order. Pure.
 */
export function savedSourceIds(
  messages: readonly Pick<ThreadMessage, 'forwardedFromId' | 'deleted'>[],
  asked: ReadonlySet<string>,
): string[] {
  const ids: string[] = [];
  for (const m of messages) {
    const id = m.forwardedFromId;
    if (id === undefined || m.deleted === true || asked.has(id) || ids.includes(id)) continue;
    ids.push(id);
  }
  return ids;
}

/**
 * Resolve one page's sources: one chat_messages IN read, then one users IN
 * read for the senders `knownName` does not have. 5s each. A failed profile
 * read keeps the sources (the line then shows the chat name alone until a
 * later read). Never throws.
 */
export async function readSavedSources(
  client: Client,
  params: { ids: readonly string[]; knownName: (userId: string) => boolean },
): Promise<Result<SavedSourcesRead>> {
  if (params.ids.length === 0) return { ok: true, data: { sources: [], profiles: [] } };
  const sourcesRes = await withReadTimeout(async (signal): Promise<Result<SavedSource[]>> => {
    const res = await abortable(
      client
        .from('chat_messages')
        .select('id, channel_id, sender_user_id, deleted_at')
        .in('id', [...params.ids]),
      signal,
    );
    if (res.error) return { ok: false, error: { code: 'unknown', message: res.error.message } };
    const rows = (res.data ?? []) as Pick<
      MessageRow,
      'id' | 'channel_id' | 'sender_user_id' | 'deleted_at'
    >[];
    return {
      ok: true,
      data: rows.map((r) => ({
        id: r.id,
        channelId: r.channel_id,
        senderUserId: r.sender_user_id,
        deleted: r.deleted_at !== null,
      })),
    };
  });
  if (!sourcesRes.ok) return sourcesRes;
  const senders = [
    ...new Set(
      sourcesRes.data
        .map((s) => s.senderUserId)
        .filter((id): id is string => id !== null && !params.knownName(id)),
    ),
  ];
  if (senders.length === 0) return { ok: true, data: { sources: sourcesRes.data, profiles: [] } };
  const profiles = await withReadTimeout((signal) => readProfiles(client, senders, signal));
  return {
    ok: true,
    data: { sources: sourcesRes.data, profiles: profiles.ok ? profiles.data : [] },
  };
}

/** The line a saved copy shows. */
export type SavedFromLine =
  | { kind: 'source'; label: string; channelId: string; messageId: string }
  | { kind: 'unreadable'; label: string };

/** A person's first name: the display name up to its first space. Pure. */
function firstName(displayName: string): string {
  const trimmed = displayName.trim();
  const space = trimmed.indexOf(' ');
  return space === -1 ? trimmed : trimmed.slice(0, space);
}

/**
 * The line for a saved copy: "Saved from <chat name> · <sender first name>"
 * (tappable, a tombstoned source too), or "Saved message" (not tappable) when
 * the source is not readable or its chat is not in my list. `source` undefined
 * means not resolved yet (no line). Pure.
 */
export function savedFromLine(input: {
  source: SavedSource | null | undefined;
  channelsById: ReadonlyMap<string, ChannelSummary>;
  nameOf: (userId: string) => string | undefined;
  currentUserId: string;
}): SavedFromLine | null {
  const { source } = input;
  if (source === undefined) return null;
  const channel = source !== null ? input.channelsById.get(source.channelId) : undefined;
  if (source === null || channel === undefined) {
    return { kind: 'unreadable', label: SAVED_MESSAGE_LABEL };
  }
  const sender =
    source.senderUserId === null
      ? undefined
      : source.senderUserId === input.currentUserId
        ? 'You'
        : input.nameOf(source.senderUserId);
  const who = sender !== undefined && sender !== '' ? ` · ${firstName(sender)}` : '';
  return {
    kind: 'source',
    label: `Saved from ${channel.title}${who}`,
    channelId: source.channelId,
    messageId: source.id,
  };
}
