// The chat home media chips (Photos, Videos, Files, Links, Voice notes), as
// WhatsApp lists them: the items themselves, not the messages. Pure: search
// hits (chat_messages rows from chat_message_search) flatten to one item per
// attachment (a 3-photo message is 3 tiles) or one item per url (a message
// with 2 links is 2 rows), newest first, then group under month headers
// ("This week", "October", "September 2025"). Plus the device-cache key and
// value of each chip's first page, so a chip tap paints before any read.

import { parseAttachmentMeta } from '@/lib/chat/attachments';
import { toLinkItems } from '@/lib/chat/channel-media';
import type { EntityRoutes } from '@/lib/chat/message-links';
import type { SearchHit, SearchKind } from '@/lib/chat/search';
import { civilDay } from '@/lib/time';

/** The chips whose items are attachments. */
export type MediaKind = 'photo' | 'video' | 'file' | 'voice';

/** A page that flattens to fewer tiles than this reads the next page once at once. */
export const MEDIA_MIN_TILES = 24;

/** One attachment of one message. */
export interface MediaItem {
  /** `${messageId}:${versionId}`: the React key, stable from cache to network. */
  key: string;
  messageId: string;
  channelId: string;
  senderId: string | null;
  createdAt: string;
  versionId: string;
  mime: string;
  name: string;
  size: number | null;
  width: number | null;
  height: number | null;
  thumbW: number | null;
  thumbH: number | null;
  durationMs: number | null;
  pageCount: number | null;
}

/** One url of one message. */
export interface LinkItem {
  /** `${messageId}:${index}` (index of the url in the body). */
  key: string;
  messageId: string;
  channelId: string;
  senderId: string | null;
  createdAt: string;
  url: string;
}

export type ChipItem = MediaItem | LinkItem;

export function isLinkItem(item: ChipItem): item is LinkItem {
  return 'url' in item;
}

/** The chip an attachment mime lists under. Pure. */
export function mediaKindOfMime(mime: string): MediaKind {
  if (mime.startsWith('image/')) return 'photo';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'voice';
  return 'file';
}

/** A file removed here behind the Undo window, or gone from a re-read row. */
export type RemovedLookup = (channelId: string, messageId: string, versionId: string) => boolean;

function positive(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : null;
}

/** The width/height a photo's meta may carry (older rows carry none). */
function metaSize(meta: unknown, versionId: string): { width: number | null; height: number | null } {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) {
    return { width: null, height: null };
  }
  const entry = (meta as Record<string, unknown>)[versionId];
  if (typeof entry !== 'object' || entry === null) return { width: null, height: null };
  const e = entry as Record<string, unknown>;
  return { width: positive(e.width), height: positive(e.height) };
}

/**
 * One item per attachment of `kind`, hits order (newest first), then each
 * message's attachment order. Files the sender removed are already gone from
 * attachment_asset_ids (removed_files holds only counts); files removed here
 * behind the Undo window are skipped through `isRemoved`. Pure.
 */
export function flattenMedia(
  hits: readonly SearchHit[],
  kind: MediaKind,
  isRemoved?: RemovedLookup,
): MediaItem[] {
  return hits.flatMap((hit) =>
    parseAttachmentMeta(hit.attachmentMeta ?? null, hit.attachmentAssetIds ?? []).flatMap((a) => {
      if (a.assetId === '' || mediaKindOfMime(a.mime) !== kind) return [];
      if (isRemoved?.(hit.channelId, hit.id, a.assetId) === true) return [];
      const size = metaSize(hit.attachmentMeta, a.assetId);
      return [
        {
          key: `${hit.id}:${a.assetId}`,
          messageId: hit.id,
          channelId: hit.channelId,
          senderId: hit.senderUserId,
          createdAt: hit.createdAt,
          versionId: a.assetId,
          mime: a.mime,
          name: a.name,
          size: a.size ?? null,
          width: size.width,
          height: size.height,
          thumbW: a.thumbW ?? null,
          thumbH: a.thumbH ?? null,
          durationMs: a.durationMs ?? null,
          pageCount: a.pageCount ?? null,
        },
      ];
    }),
  );
}

/**
 * One item per external url, body order, parsed exactly as the chat info
 * Links tab does (channel-media.ts toLinkItems). Pure.
 */
export function flattenLinks(
  hits: readonly SearchHit[],
  appOrigin: string | null,
  routes: EntityRoutes,
): LinkItem[] {
  return hits.flatMap((hit) =>
    toLinkItems(
      [{ id: hit.id, sender_user_id: hit.senderUserId, body: hit.body, created_at: hit.createdAt }],
      appOrigin,
      routes,
    ).map((link, index) => ({
      key: `${hit.id}:${index}`,
      messageId: hit.id,
      channelId: hit.channelId,
      senderId: hit.senderUserId,
      createdAt: hit.createdAt,
      url: link.url,
    })),
  );
}

/** A chip's items from its hits. Pure. */
export function flattenHits(
  hits: readonly SearchHit[],
  kind: SearchKind,
  opts: { appOrigin: string | null; routes: EntityRoutes; isRemoved?: RemovedLookup },
): ChipItem[] {
  return kind === 'link'
    ? flattenLinks(hits, opts.appOrigin, opts.routes)
    : flattenMedia(hits, kind, opts.isRemoved);
}

/** One month header and its items. */
export interface MonthGroup<T> {
  /** 'week', or the month as 'YYYY-MM'. */
  key: string;
  /** 'This week', 'October', or 'September 2025' outside the current year. */
  label: string;
  items: T[];
}

export const THIS_WEEK_LABEL = 'This week';

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** Whole calendar days from day a to day b (YYYY-MM-DD). */
function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** The header an item's day falls under, on the device zone. Pure. */
export function monthGroupOf(
  createdAt: string,
  nowMs: number,
  timeZone?: string,
): { key: string; label: string } {
  const ts = Date.parse(createdAt);
  const today = civilDay(nowMs, timeZone);
  const day = Number.isNaN(ts) ? today : civilDay(ts, timeZone);
  if (daysBetween(day, today) < 7) return { key: 'week', label: THIS_WEEK_LABEL };
  const year = day.slice(0, 4);
  const month = MONTHS[Number(day.slice(5, 7)) - 1] ?? '';
  return {
    key: day.slice(0, 7),
    label: year === today.slice(0, 4) ? month : `${month} ${year}`,
  };
}

/** Items (newest first) under their month headers, in order. Pure. */
export function groupByMonth<T extends { createdAt: string }>(
  items: readonly T[],
  nowMs: number,
  timeZone?: string,
): MonthGroup<T>[] {
  const groups: MonthGroup<T>[] = [];
  for (const item of items) {
    const { key, label } = monthGroupOf(item.createdAt, nowMs, timeZone);
    const last = groups[groups.length - 1];
    if (last !== undefined && last.key === key) last.items.push(item);
    else groups.push({ key, label, items: [item] });
  }
  return groups;
}

/** "0:12", "4:05", "1:02:03". Pure. */
export function formatDurationMs(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** The session-read `what` of a chip's saved first page (device cache, `chat:` prefix). */
export function mediaCacheWhat(kind: SearchKind): string {
  return `chat:media:${kind}`;
}

/** A chip's saved first page: the flattened items (never urls of files). */
export interface MediaCacheValue {
  kind: SearchKind;
  items: ChipItem[];
}

/** Whether a saved value is one this build can paint. Pure. */
export function isMediaCacheValue(raw: unknown, kind: SearchKind): raw is MediaCacheValue {
  if (typeof raw !== 'object' || raw === null) return false;
  const v = raw as Partial<MediaCacheValue>;
  return v.kind === kind && Array.isArray(v.items);
}
