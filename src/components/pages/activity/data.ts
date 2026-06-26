// Activity (Inbox) read + write data layer. The page reads inbox_entries with a
// plain RLS-scoped select (each member sees only their own rows) and maps every
// row into a render-ready ActivityItem. The per-user read-state and snooze
// mutations go through the @srtdio/rpc wrappers (each carries an explicit
// p_trace_id). Everything here that does not touch the network is a pure,
// unit-tested function so the page stays thin.

import type { Client, Result } from '@srtdio/rpc';
import { inboxMarkAllRead, inboxMarkRead, inboxSnooze } from '@srtdio/rpc';
import type { Database, Json } from '@srtdio/schemas';
import { parseMentions } from '@srtdio/comments';
import { readProfiles } from '@/lib/chat-reads';
import { EX_MEMBER_LABEL } from '@/components/comments/commentProfiles';

type InboxEntryRow = Database['public']['Tables']['inbox_entries']['Row'];

/** Same token shape the comment thread resolves: the literal `@[<uuid>]`. */
const MENTION_TOKEN = /@\[([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\]/gi;

/**
 * Resolve every `@[<uuid>]` mention token in a comment body to a plain `@Name`
 * label, exactly as the comment thread does. An id `nameOf` does not resolve to
 * a member falls back to EX_MEMBER_LABEL; all surrounding text is returned
 * verbatim. Plain text only: no React nodes, no JSX, no styling.
 */
export function resolveBodyMentions(body: string, nameOf: (id: string) => string | null): string {
  return body.replace(
    MENTION_TOKEN,
    (_match, id: string) => `@${nameOf(id.toLowerCase()) ?? EX_MEMBER_LABEL}`,
  );
}

/**
 * Read one string field from an `unknown` jsonb payload. Returns null for a
 * missing key or a non-string value, so a malformed payload never crashes the
 * row and never prints "undefined"/"null". Used for EVERY payload field; the
 * payload is deliberately typed `unknown` and is never cast to `any`.
 */
export function payloadStr(p: unknown, key: string): string | null {
  if (typeof p !== 'object' || p === null) return null;
  const val = (p as Record<string, unknown>)[key];
  return typeof val === 'string' ? val : null;
}

/** The state chips: which slice of the inbox is shown. */
export type ActivityState = 'all' | 'unread' | 'snoozed';

/** The scope chips. 'everything' is the no-filter sentinel. */
export type ActivityScope = 'everything' | 'posts' | 'briefs' | 'people' | 'groups' | 'clients';

/** The sort direction, threaded straight from useSort('activity', ...). */
export type ActivityDirection = 'newest' | 'oldest';

/** Snooze kinds accepted by inbox_snooze (p_kind). 'clear' un-snoozes. */
export type SnoozeKind = '1h' | '4h' | 'tomorrow_9' | 'next_week' | 'clear';

export interface SnoozeOption {
  kind: SnoozeKind;
  label: string;
}

/** Menu options offered in the kebab. 'clear' is shown separately by the menu. */
export const SNOOZE_OPTIONS: readonly SnoozeOption[] = [
  { kind: '1h', label: 'For 1 hour' },
  { kind: '4h', label: 'For 4 hours' },
  { kind: 'tomorrow_9', label: 'Until tomorrow' },
  { kind: 'next_week', label: 'Until next week' },
];

/** One inbox entry, mapped to the fields the row renders. */
export interface ActivityItem {
  id: string;
  workspaceId: string;
  eventType: string;
  entityType: string | null;
  entityId: string | null;
  scope: string;
  tier: string;
  createdAt: string;
  readAt: string | null;
  snoozedUntil: string | null;
  // Derived from the payload via payloadStr (never cast to any).
  commentId: string | null;
  /** The asset id, asset events only (asset_uploaded / asset_version_added); null otherwise. */
  assetId: string | null;
  toStage: string | null;
  fromStage: string | null;
  /** The entity title, when the writer recorded one (briefs). */
  title: string | null;
  /** The acting user id (created_by / invited_by), when present. */
  actorId: string | null;
  /** Resolved display name for actorId, filled in after a profile read. */
  actorName: string | null;
  /** Resolved avatar image url for the actor, filled in after a profile read. */
  actorAvatarUrl: string | null;
  /** The comment text, resolved by the comments join (comment events only). */
  body: string | null;
  /** The post format (text/single_image/carousel/video/link), posts only. */
  format: string | null;
  /** The post caption, posts only (null otherwise). Feeds the thumbnail fallback body. */
  caption: string | null;
  /** The post's first-image asset_version_id, posts only; null for a text/imageless post. */
  thumbnailAssetVersionId: string | null;
}

/** Map a raw inbox_entries row into an ActivityItem. Pure; actorName stays null. */
export function mapEntry(row: InboxEntryRow): ActivityItem {
  const payload: unknown = row.payload as Json;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    eventType: row.event_type,
    entityType: row.entity_type,
    entityId: row.entity_id,
    scope: row.scope,
    tier: row.tier,
    createdAt: row.created_at,
    readAt: row.read_at,
    snoozedUntil: row.snoozed_until,
    commentId: payloadStr(payload, 'comment_id'),
    assetId: payloadStr(payload, 'asset_id'),
    toStage: payloadStr(payload, 'to_stage') ?? payloadStr(payload, 'to'),
    fromStage: payloadStr(payload, 'from_stage') ?? payloadStr(payload, 'from'),
    title: payloadStr(payload, 'title'),
    actorId: payloadStr(payload, 'created_by') ?? payloadStr(payload, 'invited_by'),
    actorName: null,
    actorAvatarUrl: null,
    body: null,
    format: null,
    caption: null,
    thumbnailAssetVersionId: null,
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

/** The non-null actor display names in source order, distinct. */
export function bucketActorNames(items: readonly ActivityItem[]): string[] {
  const names: string[] = [];
  for (const item of items) {
    if (item.actorName !== null) names.push(item.actorName);
  }
  return unique(names);
}

/** A post / brief target label that never renders "undefined"/"null". */
function entityTarget(item: ActivityItem): string {
  if (item.title !== null) return item.title;
  if (item.entityType === 'post') return 'a post';
  if (item.entityType === 'brief') return 'a brief';
  return 'Activity';
}

/**
 * The human-readable line for a row. Null-safe: a missing actor name drops the
 * name entirely rather than printing a placeholder, and a missing title falls
 * back to "a post" / "a brief" by entity type.
 */
export function activityLine(item: ActivityItem): string {
  const who = item.actorName;
  const target = entityTarget(item);
  switch (item.eventType) {
    case 'comment':
      return who !== null ? `${who} commented on ${target}` : `New comment on ${target}`;
    case 'mention':
      return who !== null ? `${who} mentioned you in ${target}` : `New mention in ${target}`;
    case 'comment_resolved':
      return who !== null
        ? `${who} resolved a thread on ${target}`
        : `A comment thread was resolved on ${target}`;
    case 'stage_change':
      return `Moved to ${item.toStage ?? 'a new stage'}`;
    case 'brief_created':
      return who !== null
        ? `${who} created ${target}`
        : item.title !== null
          ? `New brief: ${item.title}`
          : 'A new brief was created';
    case 'brief_closed':
      return who !== null
        ? `${who} closed ${target}`
        : item.title !== null
          ? `Brief ${item.title} closed`
          : 'A brief was closed';
    case 'asset_uploaded':
      return who !== null ? `${who} uploaded an asset` : 'New asset uploaded';
    case 'asset_version_added':
      return who !== null ? `${who} added an asset version` : 'New asset version';
    case 'invite':
      return who !== null ? `${who} invited a new member` : 'New workspace invite';
    default:
      return target;
  }
}

/**
 * The card header title: the entity title when known, a generic entity label for
 * a post/brief without a resolved title, and the full activity line otherwise (so
 * a non-entity entry, e.g. an invite, still reads as a sentence). Null-safe.
 */
export function cardTitle(item: ActivityItem): string {
  if (item.title !== null) return item.title;
  if (item.entityType === 'post') return 'Untitled post';
  if (item.entityType === 'brief') return 'Untitled brief';
  return activityLine(item);
}

/**
 * The short event line for inside a card: the event WITHOUT the entity title or
 * actor (the title is the card header, the actor is the avatar). Used for the lead
 * line and every threaded event line so the title is never repeated.
 */
export function shortLine(item: ActivityItem): string {
  switch (item.eventType) {
    case 'comment':
      return 'New comment';
    case 'mention':
      return 'New mention';
    case 'comment_resolved':
      return 'Thread resolved';
    case 'stage_change':
      return `Moved to ${item.toStage ?? 'a new stage'}`;
    case 'brief_created':
      return 'Brief created';
    case 'brief_closed':
      return 'Brief closed';
    case 'asset_uploaded':
      return 'New asset';
    case 'asset_version_added':
      return 'New asset version';
    case 'invite':
      return 'New member invited';
    default:
      return 'Activity';
  }
}

/** Trim a comment body to a single legible line of at most ~140 characters. */
function trimBody(text: string): string {
  const t = text.trim();
  return t.length <= 140 ? t : `${t.slice(0, 140).trimEnd()}…`;
}

/**
 * The body line shown inside a card. For a comment event it is the real comment
 * text, trimmed to ~140 chars; for every other event type (and for a comment with
 * an empty/missing body) it falls back to the existing generic short line. Never
 * throws and never renders an empty string for a comment that has text.
 */
export function cardBodyLine(item: ActivityItem): string {
  if (item.eventType === 'comment' && item.body !== null && item.body.trim().length > 0) {
    return trimBody(item.body);
  }
  return shortLine(item);
}

/**
 * Route to open when a row is clicked, or null when it has no detail surface.
 * Asset events have no post/brief entity: they deep-link to the asset lightbox via
 * the existing `?asset=` param. Post/brief comment events deep-link to the exact
 * comment via the existing `?comment=` param (consumed by PostDetailPage /
 * BriefDetailPage / AssetsPage already); a non-comment entry lands on the entity.
 */
export function entityHref(item: ActivityItem): string | null {
  if (item.eventType === 'asset_uploaded' || item.eventType === 'asset_version_added') {
    return item.assetId !== null ? `/assets?asset=${item.assetId}` : null;
  }
  if (item.entityId === null) return null;
  if (item.entityType === 'post') {
    return item.commentId !== null
      ? `/posts/${item.entityId}?comment=${item.commentId}`
      : `/posts/${item.entityId}`;
  }
  if (item.entityType === 'brief') {
    return item.commentId !== null
      ? `/briefs/${item.entityId}?comment=${item.commentId}`
      : `/briefs/${item.entityId}`;
  }
  return null;
}

/** A row is snoozed when its snoozed_until is in the future. */
export function isSnoozed(item: ActivityItem, nowMs: number): boolean {
  if (item.snoozedUntil === null) return false;
  const until = Date.parse(item.snoozedUntil);
  return !Number.isNaN(until) && until > nowMs;
}

/** Apply the state chip: All hides snoozed; Unread is unread + not snoozed. */
export function filterByState(
  items: readonly ActivityItem[],
  state: ActivityState,
  nowMs: number,
): ActivityItem[] {
  switch (state) {
    case 'snoozed':
      return items.filter((item) => isSnoozed(item, nowMs));
    case 'unread':
      return items.filter((item) => item.readAt === null && !isSnoozed(item, nowMs));
    case 'all':
    default:
      return items.filter((item) => !isSnoozed(item, nowMs));
  }
}

/** Apply the scope chip. 'everything' is the no-filter sentinel. */
export function filterByScope(
  items: readonly ActivityItem[],
  scope: ActivityScope,
): ActivityItem[] {
  if (scope === 'everything') return [...items];
  return items.filter((item) => item.scope === scope);
}

/** Count of currently-unread, non-snoozed rows (drives the chip badge / button). */
export function unreadCount(items: readonly ActivityItem[], nowMs: number): number {
  return items.reduce(
    (n, item) => (item.readAt === null && !isSnoozed(item, nowMs) ? n + 1 : n),
    0,
  );
}

/**
 * A compact relative-time label. No dependency: just elapsed buckets. Future or
 * unparseable timestamps collapse to "just now".
 */
export function relativeTime(iso: string, nowMs: number): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const sec = Math.round((nowMs - then) / 1000);
  if (sec < 45) return 'just now';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day}d`;
  const wk = Math.round(day / 7);
  if (wk < 5) return `${wk}w`;
  const mo = Math.round(day / 30);
  if (mo < 12) return `${mo}mo`;
  return `${Math.round(day / 365)}y`;
}

export interface DigestBucket {
  key: 'today' | 'yesterday' | 'earlier';
  label: string;
  /** Threaded groups: a 1-entry group renders solo, a multi-entry group threads. */
  groups: ActivityItem[][];
}

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * The threading key for an entry. Post/brief entries that share an entity collapse
 * into one thread; everything else (and any entry without an entity) stays solo so
 * it never threads with an unrelated row.
 */
export function entityKey(item: ActivityItem): string {
  if ((item.entityType === 'post' || item.entityType === 'brief') && item.entityId !== null) {
    return `${item.entityType}:${item.entityId}`;
  }
  return `solo:${item.id}`;
}

const newestFirst = (a: ActivityItem, b: ActivityItem): number =>
  Date.parse(b.createdAt) - Date.parse(a.createdAt);

/**
 * Thread one bucket's entries into per-entity groups, ordering both the entries
 * within each group and the groups themselves by `direction` (groups keyed on the
 * lead entry's timestamp). 'newest' leads with the newest entry/group.
 */
function threadGroups(bucket: ActivityItem[], direction: ActivityDirection): ActivityItem[][] {
  const byKey = new Map<string, ActivityItem[]>();
  for (const item of bucket) {
    const key = entityKey(item);
    const existing = byKey.get(key);
    if (existing) existing.push(item);
    else byKey.set(key, [item]);
  }
  const groups = [...byKey.values()].map((entries) => {
    const sorted = [...entries].sort(newestFirst);
    return direction === 'oldest' ? sorted.reverse() : sorted;
  });
  const leadMs = (group: ActivityItem[]): number => {
    const lead = group[0];
    return lead !== undefined ? Date.parse(lead.createdAt) : 0;
  };
  groups.sort((a, b) => leadMs(b) - leadMs(a));
  return direction === 'oldest' ? groups.reverse() : groups;
}

/**
 * Bucket items into Today / Yesterday / Earlier, then thread each bucket into
 * per-entity groups. Buckets, groups and entries all follow `direction`. 'newest'
 * = Today -> Yesterday -> Earlier, newest first; 'oldest' reverses. Empty dropped.
 */
export function groupDigest(
  items: readonly ActivityItem[],
  direction: ActivityDirection,
): DigestBucket[] {
  const todayStart = startOfDay(Date.now());
  const yesterdayStart = todayStart - 86_400_000;

  const today: ActivityItem[] = [];
  const yesterday: ActivityItem[] = [];
  const earlier: ActivityItem[] = [];
  for (const item of items) {
    const t = Date.parse(item.createdAt);
    if (!Number.isNaN(t) && t >= todayStart) today.push(item);
    else if (!Number.isNaN(t) && t >= yesterdayStart) yesterday.push(item);
    else earlier.push(item);
  }

  const buckets: DigestBucket[] = [
    { key: 'today', label: 'Today', groups: threadGroups(today, direction) },
    { key: 'yesterday', label: 'Yesterday', groups: threadGroups(yesterday, direction) },
    { key: 'earlier', label: 'Earlier', groups: threadGroups(earlier, direction) },
  ];
  const ordered = direction === 'oldest' ? buckets.reverse() : buckets;
  return ordered.filter((bucket) => bucket.groups.length > 0);
}

// --- network -----------------------------------------------------------------

export type LoadResult = { ok: true; data: ActivityItem[] } | { ok: false; error: string };

/** One page of inbox rows. The live writer emits minimal payloads, so author and
 * title are resolved by join (see fetchActivityEntries), never read from payload. */
export const ACTIVITY_PAGE_SIZE = 50;

/** Event types whose actor is the comment author, resolved via the comments join.
 *  comment_resolved is intentionally absent: its actor is the resolver (not the
 *  comment author) and is not carried in the minimal payload, so it renders
 *  actor-less. The comment deep-link still works off the payload comment_id. */
const COMMENT_EVENTS = ['comment', 'mention'];

const SELECT_COLS =
  'id, workspace_id, event_type, entity_type, entity_id, scope, tier, created_at, read_at, snoozed_until, payload';

// One row of the batched first-image lookup, mirroring the Pipeline loader's
// firstImageByPost (packages/posts/src/reads.ts): an asset_attachments row with
// its pinned version's mime_type embedded via an inner join (so only image-backed
// attachments survive). The aliased select is wider than the generated row type
// can express, so the result is cast through `unknown`.
interface FirstImageRow {
  entity_id: string;
  asset_version_id: string;
  asset_versions: { mime_type: string | null } | null;
}

/**
 * Read one page of the caller's inbox for a workspace and enrich each row with the
 * data the live (minimal) payloads omit: the actor's display name and the entity
 * title, both resolved by batched joins (no N+1). One RLS-scoped select, then wave
 * one (comments / posts / briefs by id) and wave two (users by id). Every join is
 * best-effort: a failed sub-query leaves its field null rather than failing the
 * feed. Soft-deleted rows are excluded; the inbox is a permanent surface. Pass
 * `before` (the oldest loaded created_at) to fetch the next, older page.
 */
export async function fetchActivityEntries(
  client: Client,
  workspaceId: string,
  input: { before?: string } = {},
): Promise<LoadResult> {
  const base = client
    .from('inbox_entries')
    .select(SELECT_COLS)
    .eq('workspace_id', workspaceId)
    .is('deleted_at', null);
  const scoped = input.before !== undefined ? base.lt('created_at', input.before) : base;
  const res = await scoped.order('created_at', { ascending: false }).limit(ACTIVITY_PAGE_SIZE);
  if (res.error) return { ok: false, error: res.error.message };

  const rows = (res.data ?? []).map((row) => row as InboxEntryRow);
  const items = rows.map(mapEntry);

  const commentIds = unique(
    items.flatMap((item) =>
      COMMENT_EVENTS.includes(item.eventType) && item.commentId !== null ? [item.commentId] : [],
    ),
  );
  const postIds = unique(
    items.flatMap((item) =>
      item.entityType === 'post' && item.entityId !== null ? [item.entityId] : [],
    ),
  );
  const briefIds = unique(
    items.flatMap((item) =>
      item.entityType === 'brief' && item.entityId !== null ? [item.entityId] : [],
    ),
  );

  // WAVE 1: resolve comment authors and entity titles. Each sub-query is fired
  // only when it has ids; a failed one yields an empty map (never fails the feed).
  // The first-image read mirrors the Pipeline loader's firstImageByPost exactly
  // (asset_attachments, image-mime inner join, position then attached_at order),
  // run once over the distinct post ids on the page (no N+1); a failure degrades
  // every thumbnailAssetVersionId to null rather than failing the feed.
  const [commentsRes, postsRes, briefsRes, firstImagesRes] = await Promise.all([
    commentIds.length > 0
      ? client.from('comments').select('id, author_user_id, body').in('id', commentIds)
      : Promise.resolve(null),
    postIds.length > 0
      ? client.from('posts').select('id, title, format, caption').in('id', postIds)
      : Promise.resolve(null),
    briefIds.length > 0
      ? client.from('briefs').select('id, title').in('id', briefIds)
      : Promise.resolve(null),
    postIds.length > 0
      ? client
          .from('asset_attachments')
          .select('entity_id, asset_version_id, asset_versions!inner(mime_type)')
          .eq('entity_type', 'post')
          .in('entity_id', postIds)
          .is('deleted_at', null)
          .like('asset_versions.mime_type', 'image/%')
          .order('entity_id', { ascending: true })
          .order('position', { ascending: true })
          .order('attached_at', { ascending: true })
      : Promise.resolve(null),
  ]);

  const commentAuthors = new Map<string, string>();
  const commentBodies = new Map<string, string>();
  if (commentsRes !== null && commentsRes.error === null) {
    for (const r of commentsRes.data ?? []) {
      commentAuthors.set(r.id, r.author_user_id);
      if (typeof r.body === 'string') commentBodies.set(r.id, r.body);
    }
  }
  const postTitles = new Map<string, string>();
  const postFormats = new Map<string, string>();
  const postCaptions = new Map<string, string>();
  if (postsRes !== null && postsRes.error === null) {
    for (const r of postsRes.data ?? []) {
      postTitles.set(r.id, r.title);
      if (typeof r.format === 'string') postFormats.set(r.id, r.format);
      if (typeof r.caption === 'string') postCaptions.set(r.id, r.caption);
    }
  }
  // The first-image asset_version_id per post: the lowest-position image-mime
  // attachment, the first row seen per entity_id (rows arrive grouped + ordered).
  const postThumbnails = new Map<string, string>();
  if (firstImagesRes !== null && firstImagesRes.error === null) {
    const imageRows = (firstImagesRes.data ?? []) as unknown as FirstImageRow[];
    for (const r of imageRows) {
      if (!postThumbnails.has(r.entity_id)) postThumbnails.set(r.entity_id, r.asset_version_id);
    }
  }
  const briefTitles = new Map<string, string>();
  if (briefsRes !== null && briefsRes.error === null) {
    for (const r of briefsRes.data ?? []) briefTitles.set(r.id, r.title);
  }

  // WAVE 2: resolve the display names for every actor id we now know about: the
  // comment authors plus the payload-supplied created_by / invited_by (actorId).
  const userIds = unique([
    ...items
      .flatMap((item) =>
        COMMENT_EVENTS.includes(item.eventType) && item.commentId !== null
          ? [commentAuthors.get(item.commentId)]
          : [],
      )
      .filter((id): id is string => typeof id === 'string'),
    ...items.flatMap((item) => (item.actorId !== null ? [item.actorId] : [])),
    ...[...commentBodies.values()].flatMap((body) => parseMentions(body)),
  ]);
  const userNames = new Map<string, string>();
  const userAvatars = new Map<string, string>();
  if (userIds.length > 0) {
    const profiles = await readProfiles(client, userIds);
    if (profiles.ok) {
      for (const p of profiles.data) {
        userNames.set(p.userId, p.displayName);
        if (p.avatarUrl !== null) userAvatars.set(p.userId, p.avatarUrl);
      }
    }
  }

  // STITCH: fill actorName and the resolved entity title from the joins above.
  items.forEach((item, idx) => {
    const payload: unknown = rows[idx]?.payload as Json | undefined;

    // Resolve the actor id for this event, then map it to a name + avatar in one
    // place so both stay in sync. Comment events take the comment author; brief and
    // invite events take their payload-supplied id; everything else has no actor.
    let actorUserId: string | null = null;
    if (COMMENT_EVENTS.includes(item.eventType)) {
      actorUserId = item.commentId !== null ? (commentAuthors.get(item.commentId) ?? null) : null;
    } else if (item.eventType === 'brief_created' || item.eventType === 'brief_closed') {
      actorUserId = payloadStr(payload, 'created_by');
    } else if (item.eventType === 'invite') {
      actorUserId = payloadStr(payload, 'invited_by');
    }
    item.actorName = actorUserId !== null ? (userNames.get(actorUserId) ?? null) : null;
    item.actorAvatarUrl = actorUserId !== null ? (userAvatars.get(actorUserId) ?? null) : null;

    // The comment text, for comment events only (other events have no body).
    // Mention tokens are resolved to @Name here so the card never prints a raw
    // @[uuid]; the same resolution the comment thread applies inline.
    const rawBody =
      item.eventType === 'comment' && item.commentId !== null
        ? (commentBodies.get(item.commentId) ?? null)
        : null;
    item.body =
      rawBody !== null ? resolveBodyMentions(rawBody, (id) => userNames.get(id) ?? null) : null;

    if (item.entityType === 'post') {
      item.title = item.entityId !== null ? (postTitles.get(item.entityId) ?? null) : null;
      item.format = item.entityId !== null ? (postFormats.get(item.entityId) ?? null) : null;
      item.caption = item.entityId !== null ? (postCaptions.get(item.entityId) ?? null) : null;
      item.thumbnailAssetVersionId =
        item.entityId !== null ? (postThumbnails.get(item.entityId) ?? null) : null;
    } else if (item.entityType === 'brief') {
      const fromJoin = item.entityId !== null ? briefTitles.get(item.entityId) : undefined;
      item.title = fromJoin ?? payloadStr(payload, 'title') ?? null;
      item.format = null;
      item.caption = null;
      item.thumbnailAssetVersionId = null;
    } else if (item.eventType === 'asset_uploaded') {
      item.title = payloadStr(payload, 'filename');
      item.format = null;
      item.caption = null;
      item.thumbnailAssetVersionId = null;
    } else {
      item.title = null;
      item.format = null;
      item.caption = null;
      item.thumbnailAssetVersionId = null;
    }
  });

  return { ok: true, data: items };
}

/** Clear read_at on one entry (the caller's own, within its month partition). */
export function markEntryRead(
  client: Client,
  item: ActivityItem,
  workspaceId: string,
  traceId: string,
): Promise<Result<undefined>> {
  return inboxMarkRead(client, {
    p_entry_id: item.id,
    p_workspace_id: workspaceId,
    p_created_at: item.createdAt,
    p_trace_id: traceId,
  });
}

/** Mark every unread, non-snoozed entry read (workspace-wide). */
export function markAllEntriesRead(
  client: Client,
  workspaceId: string,
  traceId: string,
): Promise<Result<undefined>> {
  return inboxMarkAllRead(client, { p_workspace_id: workspaceId, p_trace_id: traceId });
}

/** Set or clear snoozed_until on one entry. */
export function snoozeEntry(
  client: Client,
  item: ActivityItem,
  workspaceId: string,
  kind: SnoozeKind,
  traceId: string,
): Promise<Result<undefined>> {
  return inboxSnooze(client, {
    p_entry_id: item.id,
    p_workspace_id: workspaceId,
    p_created_at: item.createdAt,
    p_kind: kind,
    p_trace_id: traceId,
  });
}
