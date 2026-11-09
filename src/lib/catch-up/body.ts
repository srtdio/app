// Catch up's card bodies (9 Nov 2026): one card per item. Reads are batched
// for the current and the next card only, ONE read per kind (posts by id IN,
// briefs by id IN, plan items by id IN, plans by id IN, pictures by entity IN,
// comments by entity IN, plan comments by item IN, reply counts by parent IN,
// the inbox rows' read state by id IN), never one per row and never a full
// table. Chat cards reuse readCatchUpChat (reads.ts). Every read is a plain
// PostgREST select on the pooled connection (no transaction, no locks: read
// committed snapshot per statement is enough for a read-only card). A card
// whose item is gone or hidden, or whose entries were all read on another
// device, comes back 'skip'; a failed read comes back 'error' (the card shows
// its error state, the reply box and buttons stay usable).

import type { Client } from '@srtdio/rpc';
import { parseMentions, stripFormat } from '@srtdio/comments';
import { activityLine } from '@/components/pages/activity/data';
import { personAvatar, personName, resolvePeople } from '@/lib/people-names';
import { mentionNamesIn, resolveMentionPreview } from '@/lib/chat/mentions';
import { logger } from '@/lib/logger';
import { formatDue, formatOverdue, daysFromToday } from '@/lib/time';
import type { ViewerSide } from '@/lib/chat/viewer-role';
import { readCatchUpChat } from '@/lib/catch-up/reads';
import { unreadIdsOf, type CatchUpItem } from '@/lib/catch-up/queue';
import { foldNewlines } from '@/lib/catch-up/text';

/** Most rows a card reads per page (and per "load older" page). */
export const CATCH_UP_PAGE = 20;

/** Who wrote a row. */
export interface CatchUpAuthor {
  id: string | null;
  name: string;
  avatarUrl: string | null;
}

/** A message or a comment, drawn in the chat's work layout. */
export interface CatchUpMessageRow {
  kind: 'message';
  id: string;
  author: CatchUpAuthor;
  createdAt: string;
  /** Mentions resolved to @names, formatting stripped, newlines folded. */
  text: string;
  /** Replies under it (a thread); 0 when none or the item has no threads. */
  replyCount: number;
  /** A comment on words the caption no longer has: the old words. */
  earlierCaption?: string | null;
}

/** One feedback point. */
export interface CatchUpPoint {
  id: string;
  n: number;
  text: string;
  /** open (unresolved) points start expanded; resolved ones start folded. */
  open: boolean;
  replyCount: number;
}

/** A feedback batch (checkpoints_added): its author and numbered points. */
export interface CatchUpPointsRow {
  kind: 'points';
  id: string;
  author: CatchUpAuthor;
  createdAt: string;
  points: CatchUpPoint[];
}

/** An event with no comment of its own (stage change, plan review, brief created). */
export interface CatchUpEventRow {
  kind: 'event';
  id: string;
  author: CatchUpAuthor;
  createdAt: string;
  /** The Activity line without the name: "Sent Monday carousel for review". */
  line: string;
}

export type CatchUpRow = CatchUpMessageRow | CatchUpPointsRow | CatchUpEventRow;

/** The context strip (non-chat cards): what the item is, read only. */
export interface CatchUpContext {
  /** "Caption · 5 pictures" | "Caption · Video" | "Caption" | "Brief" | "Plan · {title}" | "Idea · Bank". */
  label: string;
  /** The pictures (asset version ids), first is the strip's thumbnail. */
  pictures: string[];
  /** A video post: the video's asset version id (plays inline). */
  video: string | null;
  /** Due words ("Due 12 Nov") or late ("2d late", bad); null without a due day. */
  due: { text: string; bad: boolean } | null;
  /** The full text (caption, brief objective, plan item notes); '' when none. */
  text: string;
}

/** A card's body. */
export interface CatchUpBody {
  /** The card's name (the name row). */
  title: string;
  context: CatchUpContext | null;
  /** Oldest first. */
  rows: CatchUpRow[];
  /** The "New" line sits before this row. */
  firstNewId: string | null;
  /** Older rows exist above (scroll up loads them). */
  hasOlder: boolean;
  /** Whether rows open threads (plan and idea comments have none). */
  threads: boolean;
  /** Chat thread cards: the newest reply (the thread is read up to it). */
  latestReplyId: string | null;
}

export type CatchUpBodyResult = CatchUpBody | 'skip' | 'error';

/** A thread opened full screen inside a card. */
export interface CatchUpThread {
  root: CatchUpMessageRow;
  replies: CatchUpMessageRow[];
}

/** The points' default fold: open (unresolved) points start expanded, resolved ones folded. Pure. */
export function defaultPointOpen(point: { open: boolean }): boolean {
  return point.open;
}

/** The Activity line without the actor's name, its first letter raised. Pure. */
export function lineWithoutName(line: string, name: string | null): string {
  const trimmed = name !== null && name !== '' && line.startsWith(`${name} `)
    ? line.slice(name.length + 1)
    : line;
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

/** The context label of an item. Pure. */
export function contextLabel(input: {
  kind: CatchUpItem['kind'];
  pictures: number;
  video: boolean;
  planTitle?: string | null;
}): string {
  switch (input.kind) {
    case 'brief':
      return 'Brief';
    case 'plan-item':
      return input.planTitle != null && input.planTitle !== '' ? `Plan · ${input.planTitle}` : 'Plan';
    case 'idea':
      return 'Idea · Bank';
    default:
      if (input.video) return 'Caption · Video';
      if (input.pictures > 1) return `Caption · ${input.pictures} pictures`;
      if (input.pictures === 1) return 'Caption · 1 picture';
      return 'Caption';
  }
}

/** Due words for the strip: "Due 12 Nov" ahead, "2d late" (bad) behind. Pure. */
export function dueWords(
  target: string | null,
  zone: string | null | undefined,
  now: Date = new Date(),
  done = false,
): { text: string; bad: boolean } | null {
  if (target === null) return null;
  const days = daysFromToday(target, zone, now);
  if (days === undefined) return null;
  if (days < 0 && !done) return formatOverdue(target, zone, now);
  return { text: `Due ${formatDue(target, zone, now)}`, bad: false };
}

function nameOf(workspaceId: string, id: string | null, fallback = 'Member'): CatchUpAuthor {
  return {
    id,
    name: (id !== null ? personName(workspaceId, id) : null) ?? fallback,
    avatarUrl: id !== null ? personAvatar(workspaceId, id) : null,
  };
}

function cleanText(workspaceId: string, body: string): string {
  return foldNewlines(stripFormat(resolveMentionPreview(body, mentionNamesIn(workspaceId))));
}

interface CommentRowLite {
  id: string;
  entity_id: string;
  author_user_id: string;
  body: string;
  created_at: string;
  parent_comment_id: string | null;
  ledger_batch_id: string | null;
  ledger_seq: number | null;
  resolved_at: string | null;
  closed_at: string | null;
  accepted_at: string | null;
}

const COMMENT_COLUMNS =
  'id, entity_id, author_user_id, body, created_at, parent_comment_id, ledger_batch_id, ledger_seq, resolved_at, closed_at, accepted_at';

interface PlanCommentLite {
  id: string;
  item_id: string;
  author_user_id: string | null;
  body: string;
  created_at: string;
  visibility: string;
}

/** Comments into rows: consecutive points of one batch become one points row. Pure. */
export function commentRows(
  workspaceId: string,
  comments: readonly CommentRowLite[],
  replyCounts: ReadonlyMap<string, number>,
): CatchUpRow[] {
  const out: CatchUpRow[] = [];
  for (const c of comments) {
    if (c.ledger_batch_id != null) {
      const last = out[out.length - 1];
      const point: CatchUpPoint = {
        id: c.id,
        n: c.ledger_seq ?? (last?.kind === 'points' ? last.points.length + 1 : 1),
        text: cleanText(workspaceId, c.body),
        open: c.resolved_at === null && c.closed_at === null && c.accepted_at === null,
        replyCount: replyCounts.get(c.id) ?? 0,
      };
      if (last?.kind === 'points' && last.id === c.ledger_batch_id) {
        last.points.push(point);
        continue;
      }
      out.push({
        kind: 'points',
        id: c.ledger_batch_id,
        author: nameOf(workspaceId, c.author_user_id),
        createdAt: c.created_at,
        points: [point],
      });
      continue;
    }
    out.push({
      kind: 'message',
      id: c.id,
      author: nameOf(workspaceId, c.author_user_id),
      createdAt: c.created_at,
      text: cleanText(workspaceId, c.body),
      replyCount: replyCounts.get(c.id) ?? 0,
    });
  }
  return out;
}

/** Event rows for the card-making entries that carry no comment of their own. Pure. */
export function eventRows(item: CatchUpItem): CatchUpEventRow[] {
  return item.cardEntries
    .filter(
      (e) =>
        e.eventType === 'stage_change' || e.eventType === 'plan_review' || e.eventType === 'brief_created',
    )
    .map((e) => ({
      kind: 'event' as const,
      id: `event:${e.id}`,
      author: { id: e.actorId, name: e.actorName ?? 'Someone', avatarUrl: e.actorAvatarUrl },
      createdAt: e.createdAt,
      line: lineWithoutName(activityLine(e), e.actorName),
    }));
}

function byTime(a: { createdAt: string }, b: { createdAt: string }): number {
  return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
}

/** The oldest unread card entry's anchor row id in `rows` (the "New" line). Pure. */
export function firstNewOf(item: CatchUpItem, rows: readonly CatchUpRow[]): string | null {
  const unread = item.cardEntries.filter((e) => e.readAt === null);
  const pool = unread.length > 0 ? unread : item.cardEntries;
  const anchors = new Set<string>();
  for (const e of pool) {
    if (e.commentId !== null) anchors.add(e.commentId);
    if (e.batchId != null) anchors.add(e.batchId);
    anchors.add(`event:${e.id}`);
  }
  const oldestUnreadAt = [...pool].sort(byTime)[0]?.createdAt ?? null;
  for (const row of rows) {
    if (anchors.has(row.id)) return row.id;
    if (row.kind === 'points' && row.points.some((p) => anchors.has(p.id))) return row.id;
  }
  // No anchor drawn (a reply, an older page): the first row at or after the oldest unread.
  if (oldestUnreadAt !== null) {
    const after = rows.find((r) => r.createdAt >= oldestUnreadAt);
    if (after !== undefined) return after.id;
  }
  return null;
}

async function replyCountsFor(
  client: Client,
  table: 'comments',
  parentIds: string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (parentIds.length === 0) return counts;
  const res = await client
    .from(table)
    .select('parent_comment_id')
    .in('parent_comment_id', parentIds)
    .is('deleted_at', null);
  if (res.error !== null) return counts;
  for (const r of res.data ?? []) {
    const p = r.parent_comment_id;
    if (p !== null) counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  return counts;
}

/**
 * The bodies of `items` (the current and next cards), by item key. One read
 * per kind across both cards. `zone` is the workspace zone (due words).
 */
export async function readCatchUpBodies(
  client: Client,
  input: {
    workspaceId: string;
    items: readonly CatchUpItem[];
    side: ViewerSide;
    zone?: string | null;
  },
): Promise<Map<string, CatchUpBodyResult>> {
  const { workspaceId, items, side } = input;
  const out = new Map<string, CatchUpBodyResult>();
  if (items.length === 0) return out;
  const ids = (kind: CatchUpItem['kind'][]): string[] => [
    ...new Set(items.filter((i) => kind.includes(i.kind)).map((i) => i.entityId)),
  ];
  const postIds = ids(['post']);
  const briefIds = ids(['brief']);
  const itemIds = ids(['plan-item', 'idea']);
  const commentEntityIds = [...postIds, ...briefIds];
  const entryIds = items.flatMap(unreadIdsOf);
  const chatItems = items.filter((i) => i.kind === 'chat-main' || i.kind === 'chat-thread');

  try {
    const [posts, briefs, planItems, pictures, comments, planComments, entries, chat] =
      await Promise.all([
        postIds.length > 0
          ? client
              .from('posts')
              .select('id, title, caption, format, target_date, stage, deleted_at')
              .in('id', postIds)
          : Promise.resolve(null),
        briefIds.length > 0
          ? client
              .from('briefs')
              .select('id, title, objective, target_date, status, deleted_at')
              .in('id', briefIds)
          : Promise.resolve(null),
        itemIds.length > 0
          ? client
              .from('plan_items')
              .select('id, title, description, target_date, plan_id, show_to_client, deleted_at')
              .in('id', itemIds)
          : Promise.resolve(null),
        postIds.length > 0
          ? client
              .from('asset_attachments')
              .select('entity_id, asset_version_id, asset_versions!inner(mime_type)')
              .eq('entity_type', 'post')
              .in('entity_id', postIds)
              .is('deleted_at', null)
              .order('entity_id', { ascending: true })
              .order('position', { ascending: true })
              .order('attached_at', { ascending: true })
          : Promise.resolve(null),
        commentEntityIds.length > 0
          ? client
              .from('comments')
              .select(COMMENT_COLUMNS)
              .in('entity_id', commentEntityIds)
              .is('parent_comment_id', null)
              .is('deleted_at', null)
              .order('created_at', { ascending: false })
              .limit(CATCH_UP_PAGE * commentEntityIds.length)
          : Promise.resolve(null),
        itemIds.length > 0
          ? client
              .from('plan_item_comments')
              .select('id, item_id, author_user_id, body, created_at, visibility')
              .in('item_id', itemIds)
              .is('deleted_at', null)
              .order('created_at', { ascending: false })
              .limit(CATCH_UP_PAGE * itemIds.length)
          : Promise.resolve(null),
        entryIds.length > 0
          ? client.from('inbox_entries').select('id, read_at').in('id', entryIds)
          : Promise.resolve(null),
        chatItems.length > 0
          ? readCatchUpChatItems(client, workspaceId, chatItems)
          : Promise.resolve(new Map<string, CatchUpBodyResult>()),
      ]);

    // Read on another device by now: every unread entry of a card read.
    const readNow = new Set<string>();
    if (entries !== null && entries.error === null) {
      for (const r of entries.data ?? []) if (r.read_at !== null) readNow.add(r.id);
    }

    const planIds = [
      ...new Set(
        (planItems?.data ?? []).flatMap((r) => (r.plan_id !== null ? [r.plan_id] : [])),
      ),
    ];
    const commentRowsAll = (comments?.data ?? []) as CommentRowLite[];
    const [plans, counts] = await Promise.all([
      planIds.length > 0
        ? client.from('plans').select('id, title').in('id', planIds)
        : Promise.resolve(null),
      replyCountsFor(
        client,
        'comments',
        commentRowsAll.map((c) => c.id),
      ),
    ]);
    const authors = [
      ...new Set([
        ...commentRowsAll.flatMap((c) => [c.author_user_id, ...parseMentions(c.body)]),
        ...((planComments?.data ?? []) as PlanCommentLite[]).flatMap((c) => [
          ...(c.author_user_id !== null ? [c.author_user_id] : []),
          ...parseMentions(c.body),
        ]),
      ]),
    ];
    await resolvePeople(client, workspaceId, authors);

    const failed =
      posts?.error != null ||
      briefs?.error != null ||
      planItems?.error != null ||
      comments?.error != null ||
      planComments?.error != null;
    if (failed) logger.warn('catch-up: body read failed', { count: items.length });

    const picturesBy = new Map<string, { images: string[]; video: string | null }>();
    if (pictures !== null && pictures.error === null) {
      for (const r of pictures.data ?? []) {
        const mime = mimeOf(r.asset_versions);
        const got = picturesBy.get(r.entity_id) ?? { images: [], video: null };
        if (mime.startsWith('image/')) got.images.push(r.asset_version_id);
        else if (mime.startsWith('video/') && got.video === null) got.video = r.asset_version_id;
        picturesBy.set(r.entity_id, got);
      }
    }
    const planTitle = new Map((plans?.data ?? []).map((p) => [p.id, p.title]));

    for (const item of items) {
      const unread = unreadIdsOf(item);
      if (unread.length > 0 && unread.every((id) => readNow.has(id))) {
        out.set(item.key, 'skip');
        continue;
      }
      if (item.kind === 'chat-main' || item.kind === 'chat-thread') {
        out.set(item.key, chat.get(item.key) ?? 'error');
        continue;
      }
      if (failed) {
        out.set(item.key, 'error');
        continue;
      }
      out.set(
        item.key,
        bodyOf(item, {
          workspaceId,
          side,
          zone: input.zone ?? null,
          post: posts?.data?.find((p) => p.id === item.entityId),
          brief: briefs?.data?.find((b) => b.id === item.entityId),
          planItem: planItems?.data?.find((p) => p.id === item.entityId),
          planTitle,
          pictures: picturesBy.get(item.entityId) ?? { images: [], video: null },
          comments: commentRowsAll.filter((c) => c.entity_id === item.entityId),
          planComments: ((planComments?.data ?? []) as PlanCommentLite[]).filter(
            (c) => c.item_id === item.entityId,
          ),
          counts,
        }),
      );
    }
  } catch (error) {
    logger.warn('catch-up: body read threw', { error: String(error) });
    for (const item of items) out.set(item.key, 'error');
  }
  return out;
}

function mimeOf(joined: unknown): string {
  const one = Array.isArray(joined) ? (joined[0] as unknown) : joined;
  if (typeof one !== 'object' || one === null) return '';
  const mime = (one as Record<string, unknown>).mime_type;
  return typeof mime === 'string' ? mime : '';
}

interface BodyParts {
  workspaceId: string;
  side: ViewerSide;
  zone: string | null;
  post: { title: string | null; caption: string | null; format: string | null; target_date: string | null; stage: string; deleted_at: string | null } | undefined;
  brief: { title: string; objective: string | null; target_date: string | null; status: string; deleted_at: string | null } | undefined;
  planItem: { title: string | null; description: string | null; target_date: string | null; plan_id: string | null; show_to_client: boolean; deleted_at: string | null } | undefined;
  planTitle: ReadonlyMap<string, string>;
  pictures: { images: string[]; video: string | null };
  comments: CommentRowLite[];
  planComments: PlanCommentLite[];
  counts: ReadonlyMap<string, number>;
}

/** One non-chat card's body from its read rows; 'skip' when gone or hidden. Pure. */
export function bodyOf(item: CatchUpItem, parts: BodyParts): CatchUpBodyResult {
  const { workspaceId, side } = parts;
  const approver = side === 'client';
  let context: CatchUpContext | null = null;
  let rows: CatchUpRow[] = [];
  let hasOlder = false;
  let title = item.lead.title ?? '';
  if (item.kind === 'post') {
    const post = parts.post;
    if (post === undefined || post.deleted_at !== null) return 'skip';
    if (approver && post.stage === 'draft') return 'skip';
    title = post.title ?? title;
    const caption = foldNewlines(post.caption ?? '');
    const video = post.format === 'video' ? parts.pictures.video : null;
    const pictures = parts.pictures.images;
    context =
      caption === '' && pictures.length === 0 && video === null
        ? null
        : {
            label: contextLabel({ kind: 'post', pictures: pictures.length, video: video !== null }),
            pictures,
            video,
            due: dueWords(post.target_date, parts.zone, new Date(), post.stage === 'approved'),
            text: caption,
          };
    rows = commentRows(workspaceId, [...parts.comments].reverse(), parts.counts);
    hasOlder = parts.comments.length >= CATCH_UP_PAGE;
  } else if (item.kind === 'brief') {
    const brief = parts.brief;
    if (brief === undefined || brief.deleted_at !== null) return 'skip';
    title = brief.title;
    context = {
      label: contextLabel({ kind: 'brief', pictures: 0, video: false }),
      pictures: [],
      video: null,
      due: dueWords(brief.target_date, parts.zone, new Date(), brief.status !== 'open'),
      text: foldNewlines(brief.objective ?? ''),
    };
    rows = commentRows(workspaceId, [...parts.comments].reverse(), parts.counts);
    hasOlder = parts.comments.length >= CATCH_UP_PAGE;
  } else {
    const planItem = parts.planItem;
    if (planItem === undefined || planItem.deleted_at !== null) return 'skip';
    if (approver && item.kind === 'idea' && !planItem.show_to_client) return 'skip';
    title = planItem.title ?? title;
    context = {
      label: contextLabel({
        kind: item.kind,
        pictures: 0,
        video: false,
        planTitle: planItem.plan_id !== null ? (parts.planTitle.get(planItem.plan_id) ?? null) : null,
      }),
      pictures: [],
      video: null,
      due: dueWords(planItem.target_date, parts.zone),
      text: foldNewlines(stripFormat(planItem.description ?? '')),
    };
    const visible = parts.planComments.filter((c) => !(approver && c.visibility === 'team'));
    rows = [...visible].reverse().map((c) => ({
      kind: 'message' as const,
      id: c.id,
      author: nameOf(workspaceId, c.author_user_id),
      createdAt: c.created_at,
      text: cleanText(workspaceId, c.body),
      replyCount: 0,
    }));
    hasOlder = parts.planComments.length >= CATCH_UP_PAGE;
  }
  rows = [...rows, ...eventRows(item)].sort(byTime);
  if (rows.length === 0 && context === null) return 'skip';
  return {
    title: title !== '' ? title : (item.lead.title ?? ''),
    context,
    rows,
    firstNewId: firstNewOf(item, rows),
    hasOlder,
    threads: item.kind === 'post' || item.kind === 'brief',
    latestReplyId: null,
  };
}

/** Chat cards through readCatchUpChat (by the lead entry), as card bodies. */
async function readCatchUpChatItems(
  client: Client,
  workspaceId: string,
  items: readonly CatchUpItem[],
): Promise<Map<string, CatchUpBodyResult>> {
  const out = new Map<string, CatchUpBodyResult>();
  const got = await readCatchUpChat(
    client,
    workspaceId,
    items.map((i) => i.lead),
  );
  for (const item of items) {
    const chat = got.get(item.lead.id);
    if (chat === undefined) {
      out.set(item.key, 'error');
      continue;
    }
    const toRow = (m: (typeof chat.messages)[number]): CatchUpMessageRow => ({
      kind: 'message',
      id: m.id,
      author: { id: m.senderId, name: m.senderName, avatarUrl: m.senderAvatarUrl },
      createdAt: m.createdAt,
      text: foldNewlines(m.text),
      replyCount: chat.replyCounts.get(m.id) ?? 0,
    });
    const rows: CatchUpRow[] = [
      ...(chat.root !== null ? [toRow(chat.root)] : []),
      ...chat.messages.map(toRow),
    ];
    if (rows.length === 0) {
      out.set(item.key, 'skip');
      continue;
    }
    out.set(item.key, {
      title: item.kind === 'chat-thread' ? (chat.threadName ?? 'Thread') : (item.lead.chatName ?? item.lead.actorName ?? 'Chat'),
      context: null,
      rows,
      firstNewId: chat.firstNewId,
      hasOlder: chat.hasOlder,
      threads: item.kind === 'chat-main',
      latestReplyId: chat.latestReplyId,
    });
  }
  return out;
}

/** Older top-level rows of a card, before `beforeAt` (20 per page). */
export async function readCatchUpOlder(
  client: Client,
  input: { workspaceId: string; item: CatchUpItem; beforeAt: string; side: ViewerSide },
): Promise<{ rows: CatchUpRow[]; hasOlder: boolean } | null> {
  const { workspaceId, item, beforeAt } = input;
  try {
    if (item.kind === 'post' || item.kind === 'brief') {
      const res = await client
        .from('comments')
        .select(COMMENT_COLUMNS)
        .eq('entity_id', item.entityId)
        .is('parent_comment_id', null)
        .is('deleted_at', null)
        .lt('created_at', beforeAt)
        .order('created_at', { ascending: false })
        .limit(CATCH_UP_PAGE);
      if (res.error !== null) return null;
      const list = (res.data ?? []) as CommentRowLite[];
      const [counts] = await Promise.all([
        replyCountsFor(client, 'comments', list.map((c) => c.id)),
        resolvePeople(client, workspaceId, list.map((c) => c.author_user_id)),
      ]);
      return { rows: commentRows(workspaceId, [...list].reverse(), counts), hasOlder: list.length >= CATCH_UP_PAGE };
    }
    if (item.kind === 'plan-item' || item.kind === 'idea') {
      const res = await client
        .from('plan_item_comments')
        .select('id, item_id, author_user_id, body, created_at, visibility')
        .eq('item_id', item.entityId)
        .is('deleted_at', null)
        .lt('created_at', beforeAt)
        .order('created_at', { ascending: false })
        .limit(CATCH_UP_PAGE);
      if (res.error !== null) return null;
      const list = ((res.data ?? []) as PlanCommentLite[]).filter(
        (c) => !(input.side === 'client' && c.visibility === 'team'),
      );
      await resolvePeople(client, workspaceId, list.flatMap((c) => (c.author_user_id !== null ? [c.author_user_id] : [])));
      return {
        rows: [...list].reverse().map((c) => ({
          kind: 'message' as const,
          id: c.id,
          author: nameOf(workspaceId, c.author_user_id),
          createdAt: c.created_at,
          text: cleanText(workspaceId, c.body),
          replyCount: 0,
        })),
        hasOlder: (res.data ?? []).length >= CATCH_UP_PAGE,
      };
    }
    if (item.kind === 'chat-main') {
      const res = await client
        .from('chat_messages')
        .select('id, sender_user_id, body, created_at')
        .eq('channel_id', item.entityId)
        .is('thread_root_message_id', null)
        .is('deleted_at', null)
        .lt('created_at', beforeAt)
        .order('created_at', { ascending: false })
        .limit(CATCH_UP_PAGE);
      if (res.error !== null) return null;
      const list = res.data ?? [];
      const [counts] = await Promise.all([
        chatReplyCounts(client, list.map((m) => m.id)),
        resolvePeople(client, workspaceId, list.flatMap((m) => (m.sender_user_id !== null ? [m.sender_user_id] : []))),
      ]);
      return {
        rows: [...list].reverse().map((m) => ({
          kind: 'message' as const,
          id: m.id,
          author: nameOf(workspaceId, m.sender_user_id),
          createdAt: m.created_at,
          text: cleanText(workspaceId, m.body ?? ''),
          replyCount: counts.get(m.id) ?? 0,
        })),
        hasOlder: list.length >= CATCH_UP_PAGE,
      };
    }
    return { rows: [], hasOlder: false };
  } catch (error) {
    logger.warn('catch-up: older read threw', { error: String(error) });
    return null;
  }
}

/** Reply counts of chat roots: one IN read. */
export async function chatReplyCounts(client: Client, rootIds: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (rootIds.length === 0) return counts;
  const res = await client
    .from('chat_messages')
    .select('thread_root_message_id')
    .in('thread_root_message_id', rootIds)
    .is('deleted_at', null);
  if (res.error !== null) return counts;
  for (const r of res.data ?? []) {
    const root = r.thread_root_message_id;
    if (root !== null) counts.set(root, (counts.get(root) ?? 0) + 1);
  }
  return counts;
}

/**
 * A thread opened full screen inside a card: a chat root and its replies, or
 * a comment (or feedback point) and its replies (parent_comment_id). Replies
 * oldest first. Null on a failed read.
 */
export async function readCatchUpThread(
  client: Client,
  input: {
    workspaceId: string;
    kind: 'chat' | 'comment';
    root: CatchUpMessageRow;
    channelId?: string | null;
  },
): Promise<CatchUpThread | null> {
  const { workspaceId, root } = input;
  try {
    if (input.kind === 'chat') {
      const res = await client
        .from('chat_messages')
        .select('id, sender_user_id, body, created_at')
        .eq('thread_root_message_id', root.id)
        .is('deleted_at', null)
        .order('created_at', { ascending: true })
        .limit(200);
      if (res.error !== null) return null;
      const list = res.data ?? [];
      await resolvePeople(client, workspaceId, list.flatMap((m) => (m.sender_user_id !== null ? [m.sender_user_id, ...parseMentions(m.body ?? '')] : [])));
      return {
        root,
        replies: list.map((m) => ({
          kind: 'message',
          id: m.id,
          author: nameOf(workspaceId, m.sender_user_id),
          createdAt: m.created_at,
          text: cleanText(workspaceId, m.body ?? ''),
          replyCount: 0,
        })),
      };
    }
    const res = await client
      .from('comments')
      .select('id, author_user_id, body, created_at')
      .eq('parent_comment_id', root.id)
      .is('deleted_at', null)
      .order('created_at', { ascending: true })
      .limit(200);
    if (res.error !== null) return null;
    const list = res.data ?? [];
    await resolvePeople(client, workspaceId, list.flatMap((c) => [c.author_user_id, ...parseMentions(c.body)]));
    return {
      root,
      replies: list.map((c) => ({
        kind: 'message',
        id: c.id,
        author: nameOf(workspaceId, c.author_user_id),
        createdAt: c.created_at,
        text: cleanText(workspaceId, c.body),
        replyCount: 0,
      })),
    };
  } catch (error) {
    logger.warn('catch-up: thread read threw', { error: String(error) });
    return null;
  }
}

