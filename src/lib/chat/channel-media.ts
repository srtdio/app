// Reads behind the chat info Media, Files and Links tabs (ChatInfoTabs), which
// serve DMs and groups alike: the reads take a channel id only. Each tab is ONE
// RLS-scoped chat_messages select per page (cleared windows and other tenants
// never come back), keyset-paged on (created_at, id) exactly like history.ts,
// so there is no per-row query. Rows are mapped to flat items here; presigning
// and sender names are the caller's (PresignCache, profiles map).

import type { Client, Result } from '@srtdio/rpc';
import { olderThanFilter } from '@/lib/chat/history';
import { parseAttachmentMeta } from '@/lib/chat/attachments';
import { withoutGone } from '@/lib/chat/media-gone';
import { classify, tokenize, type EntityRoutes } from '@/lib/chat/message-links';
import type { MessageCursor } from '@/lib/chat/thread';
import { getFillCount } from '@/lib/use-fill-count';

/**
 * One page per tab read: one screen's worth of rows (getFillCount, read once
 * per app load), so the first page and every Load more fill one screen. A full
 * page means Load more may find older rows. Media and Files share the one
 * attachments read, so it pages by the list's row count.
 */
export function channelMediaPageSize(): number {
  return getFillCount();
}

/** One attachment of one message, newest message first. */
export interface ChannelAttachmentItem {
  messageId: string;
  versionId: string;
  name: string;
  /** '' for a legacy id with no attachment_meta: it lists as a file. */
  mime: string;
  size: number | null;
  createdAt: string;
  senderUserId: string | null;
}

/** One external url found in a message body. */
export interface ChannelLinkItem {
  messageId: string;
  url: string;
  createdAt: string;
  senderUserId: string | null;
}

/** A page of items plus the keyset cursor for the next (older) page. */
export interface ChannelPage<T> {
  items: T[];
  /** The last row read was a full page: an older page may exist. */
  hasMore: boolean;
  /** The oldest row of this page, for the next read; null on an empty page. */
  cursor: MessageCursor | null;
}

interface AttachmentRow {
  id: string;
  sender_user_id: string | null;
  attachment_asset_ids: string[] | null;
  attachment_meta: unknown;
  created_at: string;
}

interface LinkRow {
  id: string;
  sender_user_id: string | null;
  body: string | null;
  created_at: string;
}

function fail<T>(message: string): Result<T> {
  return { ok: false, error: { code: 'unknown', message } };
}

function pageOf<T>(
  rows: readonly { id: string; created_at: string }[],
  items: T[],
  size: number,
): ChannelPage<T> {
  const last = rows[rows.length - 1];
  return {
    items,
    hasMore: rows.length >= size,
    cursor: last === undefined ? null : { createdAt: last.created_at, id: last.id },
  };
}

/** Flatten attachment rows (already newest first) to one item per asset version id. */
export function toAttachmentItems(rows: readonly AttachmentRow[]): ChannelAttachmentItem[] {
  // A message deleted for everyone, or hidden for me and written, lists nothing.
  return withoutGone(rows, (row) => row.id).flatMap((row) =>
    parseAttachmentMeta(row.attachment_meta, row.attachment_asset_ids ?? []).map((a) => ({
      messageId: row.id,
      versionId: a.assetId,
      name: a.name,
      mime: a.mime,
      size: a.size ?? null,
      createdAt: row.created_at,
      senderUserId: row.sender_user_id,
    })),
  );
}

/**
 * Media tab gets image/* only; Files gets everything else (video, legacy, docs)
 * except audio/*, which the thread renders as voice notes and neither tab lists.
 */
export function splitMediaFiles(items: readonly ChannelAttachmentItem[]): {
  images: ChannelAttachmentItem[];
  files: ChannelAttachmentItem[];
} {
  const images: ChannelAttachmentItem[] = [];
  const files: ChannelAttachmentItem[] = [];
  for (const item of items) {
    if (item.mime.startsWith('audio/')) continue;
    (item.mime.startsWith('image/') ? images : files).push(item);
  }
  return { images, files };
}

/**
 * External urls of link rows ([text](url) included), in body order; links to
 * this app's posts or briefs are cards, not links.
 */
export function toLinkItems(
  rows: readonly LinkRow[],
  appOrigin: string | null,
  routes: EntityRoutes,
): ChannelLinkItem[] {
  return withoutGone(rows, (row) => row.id).flatMap((row) =>
    tokenize(row.body ?? '').flatMap((segment) =>
      segment.kind !== 'text' && classify(segment.url, appOrigin, routes).kind === 'external'
        ? [
            {
              messageId: row.id,
              url: segment.url,
              createdAt: row.created_at,
              senderUserId: row.sender_user_id,
            },
          ]
        : [],
    ),
  );
}

/** One page of the channel's attachment messages, newest first. */
export async function listChannelAttachments(
  client: Client,
  params: { channelId: string; before?: MessageCursor },
): Promise<Result<ChannelPage<ChannelAttachmentItem>>> {
  const size = channelMediaPageSize();
  let query = client
    .from('chat_messages')
    .select('id, sender_user_id, attachment_asset_ids, attachment_meta, created_at')
    .eq('channel_id', params.channelId)
    .is('deleted_at', null)
    .not('attachment_asset_ids', 'is', null);
  if (params.before !== undefined) query = query.or(olderThanFilter(params.before));
  const res = await query
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(size);
  if (res.error) return fail(`listChannelAttachments: ${res.error.message}`);
  const rows = (res.data ?? []) as AttachmentRow[];
  return { ok: true, data: pageOf(rows, toAttachmentItems(rows), size) };
}

/** One page of the channel's messages that may carry a url, newest first. */
export async function listChannelLinks(
  client: Client,
  params: {
    channelId: string;
    before?: MessageCursor;
    appOrigin: string | null;
    routes: EntityRoutes;
  },
): Promise<Result<ChannelPage<ChannelLinkItem>>> {
  const size = channelMediaPageSize();
  let query = client
    .from('chat_messages')
    .select('id, sender_user_id, body, created_at')
    .eq('channel_id', params.channelId)
    .is('deleted_at', null)
    .ilike('body', '%http%');
  if (params.before !== undefined) query = query.or(olderThanFilter(params.before));
  const res = await query
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(size);
  if (res.error) return fail(`listChannelLinks: ${res.error.message}`);
  const rows = (res.data ?? []) as LinkRow[];
  return { ok: true, data: pageOf(rows, toLinkItems(rows, params.appOrigin, params.routes), size) };
}
