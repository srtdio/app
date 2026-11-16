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
import { entryLine, lineWithoutName } from '@/components/pages/activity/data';

export { lineWithoutName };
import { personAvatar, personName, resolvePeople } from '@/lib/people-names';
import {
  mentionLabel,
  mentionNamesIn,
  resolveMentionPreview,
  splitMentions,
} from '@/lib/chat/mentions';
import { logger } from '@/lib/logger';
import { formatDue, formatOverdue, daysFromToday } from '@/lib/time';
import type { ViewerSide } from '@/lib/chat/viewer-role';
import { readCatchUpChat } from '@/lib/catch-up/reads';
import { chatPointOf } from '@/lib/catch-up/writes';
import { isOwnEntry, unreadIdsOf, type CatchUpItem } from '@/lib/catch-up/queue';
import { foldNewlines } from '@/lib/catch-up/text';
import { replyStatsOf, type ReplyInfo } from '@/lib/catch-up/types';
import { parseAttachmentMeta, type MessageAttachment } from '@/lib/chat/attachments';
import {
  fetchCommentFiles,
  toCommentFileAttachments,
  type CommentFile,
} from '@/components/comments/comment-files';

export { replyStatsOf, type ReplyInfo };

/** Most rows a card reads per page (and per "load older" page). */
export const CATCH_UP_PAGE = 20;

/**
 * Most unread rows a card reads from its first unread one (16 Nov 2026,
 * Slack): the card starts at its first unread row, so 50 new comments open
 * with the New line on top, never mid-way. Bounded: <= 2 cards are read.
 */
export const CATCH_UP_UNREAD_MAX = 200;

/** The unread read starts this far before the oldest unread entry (entry vs row clock). */
const SINCE_MARGIN_MS = 5 * 60_000;

/**
 * Where a card's unread read starts: the oldest unread entry (not my own)
 * less the margin; null when nothing is unread (the newest page). Pure.
 */
export function unreadSinceOf(item: CatchUpItem): string | null {
  const unread = item.entries.filter((e) => e.readAt === null && !isOwnEntry(e, null));
  const oldest = [...unread].sort(byTime)[0];
  if (oldest === undefined) return null;
  const at = Date.parse(oldest.createdAt);
  return Number.isNaN(at) ? null : new Date(at - SINCE_MARGIN_MS).toISOString();
}

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
  /** The "@name" labels of its mentions (catchUpText), drawn bold; absent: none. */
  mentions?: string[];
  /** Replies under it (a thread); 0 when none or the item has no threads. */
  replyCount: number;
  /** Up to 2 unique repliers, newest first (the replies row's photos). */
  repliers?: CatchUpAuthor[];
  /** The newest reply's time (the replies row's full time). */
  lastReplyAt?: string;
  /** A comment on words the caption no longer has: the old words. */
  earlierCaption?: string | null;
  /** A reply drawn on its card: the thread it sits in ("Replied in thread: ..."). */
  threadRoot?: CatchUpMessageRow;
  /** The stored file ids (comments, 16 Nov 2026); the bodies read fills `files` from them. */
  fileIds?: string[];
  /** Its photos and files, drawn under the text as chat draws them. */
  files?: MessageAttachment[];
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
  /** Whether rows open threads (every kind: plan and idea comments have one level of replies). */
  threads: boolean;
  /** Chat thread cards: the newest reply (the thread is read up to it). */
  latestReplyId: string | null;
  /** Chat thread cards: the thread's root; tapping any row opens this thread. */
  cardRoot?: CatchUpMessageRow;
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
      return input.planTitle != null && input.planTitle !== ''
        ? `Plan · ${input.planTitle}`
        : 'Plan';
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

/** A row's replies-row fields from its ReplyInfo (none: nothing). Pure. */
export function repliesOf(
  workspaceId: string,
  info: ReplyInfo | undefined,
): Pick<CatchUpMessageRow, 'repliers' | 'lastReplyAt'> {
  if (info === undefined) return {};
  return { repliers: info.repliers.map((id) => nameOf(workspaceId, id)), lastReplyAt: info.lastAt };
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

/**
 * A message row's text (cleanText) plus its mentions as drawn ("@name", the
 * labels the text holds), so the row can draw them bold and tint itself when
 * one is me. Also the optimistic row of a reply sent from Catch up, so a
 * just-sent mention reads "@name", never the stored token. Pure.
 */
export function catchUpText(
  workspaceId: string,
  body: string,
): { text: string; mentions: string[] } {
  const nameOf = mentionNamesIn(workspaceId);
  const mentions = splitMentions(body).flatMap((segment) => {
    if (segment.kind !== 'mention') return [];
    const label = mentionLabel(segment.userId, nameOf);
    return label === '' ? [] : [label];
  });
  return { text: cleanText(workspaceId, body), mentions: [...new Set(mentions)] };
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
  attachment_asset_ids?: string[] | null;
}

const COMMENT_COLUMNS =
  'id, entity_id, author_user_id, body, created_at, parent_comment_id, ledger_batch_id, ledger_seq, resolved_at, closed_at, accepted_at, attachment_asset_ids';

interface PlanCommentLite {
  id: string;
  item_id: string;
  author_user_id: string | null;
  body: string;
  created_at: string;
  visibility: string;
  parent_comment_id: string | null;
  attachment_asset_ids?: string[] | null;
}

const PLAN_COMMENT_COLUMNS =
  'id, item_id, author_user_id, body, created_at, visibility, parent_comment_id, attachment_asset_ids';

/** Comments into rows: consecutive points of one batch become one points row. Pure. */
export function commentRows(
  workspaceId: string,
  comments: readonly CommentRowLite[],
  replyCounts: ReadonlyMap<string, number>,
  replyInfo: ReadonlyMap<string, ReplyInfo> = new Map(),
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
    out.push(messageOf(workspaceId, c, replyCounts, replyInfo));
  }
  return out;
}

function messageOf(
  workspaceId: string,
  c: CommentRowLite,
  counts: ReadonlyMap<string, number>,
  info: ReadonlyMap<string, ReplyInfo> = new Map(),
): CatchUpMessageRow {
  return {
    kind: 'message',
    id: c.id,
    author: nameOf(workspaceId, c.author_user_id),
    createdAt: c.created_at,
    ...catchUpText(workspaceId, c.body),
    replyCount: counts.get(c.id) ?? 0,
    ...repliesOf(workspaceId, info.get(c.id)),
    ...fileIdsOf(c.attachment_asset_ids),
  };
}

function fileIdsOf(ids: readonly string[] | null | undefined): { fileIds?: string[] } {
  return ids != null && ids.length > 0 ? { fileIds: [...ids] } : {};
}

/** Every stored file id on `rows` (and their thread roots), deduped. Pure. */
export function rowFileIds(rows: readonly CatchUpRow[]): string[] {
  const out = new Set<string>();
  for (const row of rows) {
    if (row.kind !== 'message') continue;
    for (const id of row.fileIds ?? []) out.add(id);
    for (const id of row.threadRoot?.fileIds ?? []) out.add(id);
  }
  return [...out];
}

/** `rows` with `files` filled from their stored ids and the read details. Pure. */
export function withFiles(
  rows: readonly CatchUpRow[],
  files: ReadonlyMap<string, CommentFile>,
): CatchUpRow[] {
  const fill = (row: CatchUpMessageRow): CatchUpMessageRow => {
    const out =
      row.fileIds !== undefined
        ? { ...row, files: toCommentFileAttachments(row.fileIds, files) }
        : row;
    return out.threadRoot !== undefined ? { ...out, threadRoot: fill(out.threadRoot) } : out;
  };
  return rows.map((row) => (row.kind === 'message' ? fill(row) : row));
}

/** A plan or idea comment as a message row, its replies row from counts / info. Pure. */
function planMessageOf(
  workspaceId: string,
  c: PlanCommentLite,
  counts: ReadonlyMap<string, number>,
  info: ReadonlyMap<string, ReplyInfo> = new Map(),
): CatchUpMessageRow {
  return {
    kind: 'message',
    id: c.id,
    author: nameOf(workspaceId, c.author_user_id),
    createdAt: c.created_at,
    ...catchUpText(workspaceId, c.body),
    replyCount: counts.get(c.id) ?? 0,
    ...repliesOf(workspaceId, info.get(c.id)),
    ...fileIdsOf(c.attachment_asset_ids),
  };
}

/**
 * Event rows (9 Nov 2026: every notification gets its own line): one row per
 * UNREAD entry of the item that is not already drawn as a message row or in a
 * feedback points block. One entry = at most one row; entries naming the same
 * comment (a mention and a comment on one comment) share the one message row.
 * Read entries and own actions get no row; an unknown type reads activityLine's
 * fallback, and a missing actor "Someone". Pure.
 */
export function eventRows(item: CatchUpItem, drawn: readonly CatchUpRow[] = []): CatchUpEventRow[] {
  const shown = new Set<string>();
  for (const row of drawn) {
    shown.add(row.id);
    if (row.kind === 'points') for (const p of row.points) shown.add(p.id);
  }
  const out: CatchUpEventRow[] = [];
  for (const e of item.entries) {
    if (e.readAt !== null || isOwnEntry(e, null)) continue;
    if (e.commentId !== null && shown.has(e.commentId)) continue;
    if (e.batchId != null && shown.has(e.batchId)) continue;
    if (e.commentId !== null) shown.add(e.commentId);
    const { actor, text } = entryLine(e);
    out.push({
      kind: 'event',
      id: `event:${e.id}`,
      author: { id: e.actorId, name: actor, avatarUrl: e.actorAvatarUrl },
      createdAt: e.createdAt,
      line: text,
    });
  }
  return out;
}

function byTime(a: { createdAt: string }, b: { createdAt: string }): number {
  return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
}

/** The oldest unread card entry's anchor row id in `rows` (the "New" line). Pure. */
export function firstNewOf(item: CatchUpItem, rows: readonly CatchUpRow[]): string | null {
  // Every unread entry of the item counts (event lines included), so the New
  // line sits above the oldest unread line of any kind.
  const unread = item.entries.filter((e) => e.readAt === null && !isOwnEntry(e, null));
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

/** Reply counts plus repliers / last reply time, by parent: the same ONE IN read. */
export async function replyCountsFor(
  client: Client,
  table: 'comments',
  parentIds: string[],
): Promise<{ counts: Map<string, number>; info: Map<string, ReplyInfo> }> {
  if (parentIds.length === 0) return replyStatsOf([]);
  const res = await client
    .from(table)
    .select('parent_comment_id, author_user_id, created_at')
    .in('parent_comment_id', parentIds)
    .is('deleted_at', null)
    .order('created_at', { ascending: false });
  if (res.error !== null) return replyStatsOf([]);
  return replyStatsOf(
    (res.data ?? []).map((r) => ({
      parent: r.parent_comment_id,
      author: r.author_user_id,
      at: r.created_at,
    })),
  );
}

/** Plan comment reply counts plus repliers / last reply time, by parent: ONE IN read. */
export async function planReplyCountsFor(
  client: Client,
  parentIds: string[],
): Promise<{ counts: Map<string, number>; info: Map<string, ReplyInfo> }> {
  if (parentIds.length === 0) return replyStatsOf([]);
  const res = await client
    .from('plan_item_comments')
    .select('parent_comment_id, author_user_id, created_at')
    .in('parent_comment_id', parentIds)
    .is('deleted_at', null)
    .order('created_at', { ascending: false });
  if (res.error !== null) return replyStatsOf([]);
  return replyStatsOf(
    (res.data ?? []).map((r) => ({
      parent: r.parent_comment_id,
      author: r.author_user_id,
      at: r.created_at,
    })),
  );
}

interface PageRead {
  data: unknown;
  error: unknown;
}

/**
 * One card's top-level rows, newest first: from `newer` (the unread rows,
 * oldest first) when given, then `older` (the page before them, newest
 * first). olderFull: the older page came back full (more above). Never throws.
 */
async function unreadPage<T>(
  newer: (() => PromiseLike<PageRead>) | null,
  older: () => PromiseLike<PageRead>,
): Promise<{ rows: T[]; error: unknown; olderFull: boolean }> {
  const [a, b] = await Promise.all([newer !== null ? newer() : null, older()]);
  const error = a?.error ?? b.error ?? null;
  const fresh = a !== null && Array.isArray(a.data) ? ([...a.data] as T[]).reverse() : [];
  const before = Array.isArray(b.data) ? (b.data as T[]) : [];
  return { rows: [...fresh, ...before], error, olderFull: before.length >= CATCH_UP_PAGE };
}

// Top-level comments, one read per entity in parallel, so a busy item never
// pushes another's rows out of a shared limit. Bounded, not N+1: the bodies
// read only ever gets the current and next card (<= 2 entities). With an
// unread start (`since`, 16 Nov 2026) a card reads every row from its first
// unread one (up to CATCH_UP_UNREAD_MAX) plus one page before it, in parallel.
export async function topLevelComments(
  client: Client,
  entityIds: readonly string[],
  since: ReadonlyMap<string, string> = new Map(),
): Promise<{ data: CommentRowLite[]; error: unknown; olderFull: Set<string> }> {
  const all = await Promise.all(
    entityIds.map((id) => {
      const base = () =>
        client
          .from('comments')
          .select(COMMENT_COLUMNS)
          .eq('entity_id', id)
          .is('parent_comment_id', null)
          .is('deleted_at', null);
      const from = since.get(id);
      return from === undefined
        ? unreadPage<CommentRowLite>(null, () =>
            base().order('created_at', { ascending: false }).limit(CATCH_UP_PAGE),
          )
        : unreadPage<CommentRowLite>(
            () =>
              base()
                .gte('created_at', from)
                .order('created_at', { ascending: true })
                .limit(CATCH_UP_UNREAD_MAX),
            () =>
              base()
                .lt('created_at', from)
                .order('created_at', { ascending: false })
                .limit(CATCH_UP_PAGE),
          );
    }),
  );
  const failed = all.find((r) => r.error !== null);
  return {
    data: all.flatMap((r) => r.rows),
    error: failed?.error ?? null,
    olderFull: new Set(entityIds.filter((_, i) => all[i]?.olderFull === true)),
  };
}

// Plan / idea top-level comments: the same shape as topLevelComments, one
// read per item (<= 2), from its first unread one when it has one.
async function planTopLevelComments(
  client: Client,
  itemIds: readonly string[],
  since: ReadonlyMap<string, string>,
): Promise<{ data: PlanCommentLite[]; error: unknown; olderFull: Set<string> }> {
  const all = await Promise.all(
    itemIds.map((id) => {
      const base = () =>
        client
          .from('plan_item_comments')
          .select(PLAN_COMMENT_COLUMNS)
          .eq('item_id', id)
          .is('parent_comment_id', null)
          .is('deleted_at', null);
      const from = since.get(id);
      return from === undefined
        ? unreadPage<PlanCommentLite>(null, () =>
            base().order('created_at', { ascending: false }).limit(CATCH_UP_PAGE),
          )
        : unreadPage<PlanCommentLite>(
            () =>
              base()
                .gte('created_at', from)
                .order('created_at', { ascending: true })
                .limit(CATCH_UP_UNREAD_MAX),
            () =>
              base()
                .lt('created_at', from)
                .order('created_at', { ascending: false })
                .limit(CATCH_UP_PAGE),
          );
    }),
  );
  const failed = all.find((r) => r.error !== null);
  return {
    data: all.flatMap((r) => r.rows),
    error: failed?.error ?? null,
    olderFull: new Set(itemIds.filter((_, i) => all[i]?.olderFull === true)),
  };
}

/** Unread post/brief (or plan/idea) entries' comment ids not drawn as top-level rows. Pure. */
export function threadReplyIds(
  items: readonly CatchUpItem[],
  drawn: readonly { id: string }[],
  kinds: readonly CatchUpItem['kind'][] = ['post', 'brief'],
): string[] {
  const shown = new Set(drawn.map((c) => c.id));
  const ids = items
    .filter((i) => kinds.includes(i.kind))
    .flatMap((i) => i.entries.filter((e) => e.readAt === null && !isOwnEntry(e, null)))
    .flatMap((e) => (e.commentId !== null && !shown.has(e.commentId) ? [e.commentId] : []));
  return [...new Set(ids)];
}

// The replies by id (ONE IN read), kept when inside a thread; roots not in
// `have` in ONE more IN read, their reply counts beside it.
async function threadRepliesFor(
  client: Client,
  ids: string[],
  have: readonly CommentRowLite[],
): Promise<{
  replies: CommentRowLite[];
  roots: CommentRowLite[];
  counts: Map<string, number>;
  info: Map<string, ReplyInfo>;
}> {
  const none = { replies: [], roots: [], ...replyStatsOf([]) };
  if (ids.length === 0) return none;
  const res = await client
    .from('comments')
    .select(COMMENT_COLUMNS)
    .in('id', ids)
    .is('deleted_at', null);
  if (res.error !== null) return none;
  const replies = ((res.data ?? []) as CommentRowLite[]).filter(
    (c) => c.parent_comment_id !== null,
  );
  const known = new Set(have.map((c) => c.id));
  const missing = [...new Set(replies.map((c) => c.parent_comment_id ?? ''))].filter(
    (id) => !known.has(id),
  );
  if (missing.length === 0) return { ...none, replies };
  const [roots, stats] = await Promise.all([
    client.from('comments').select(COMMENT_COLUMNS).in('id', missing).is('deleted_at', null),
    replyCountsFor(client, 'comments', missing),
  ]);
  return { replies, roots: (roots.data ?? []) as CommentRowLite[], ...stats };
}

// Plan comment replies by id (ONE IN read), kept when inside a thread; roots
// not in `have` in ONE more IN read, their reply counts beside it.
async function planThreadRepliesFor(
  client: Client,
  ids: string[],
  have: readonly PlanCommentLite[],
): Promise<{
  replies: PlanCommentLite[];
  roots: PlanCommentLite[];
  counts: Map<string, number>;
  info: Map<string, ReplyInfo>;
}> {
  const none = { replies: [], roots: [], ...replyStatsOf([]) };
  if (ids.length === 0) return none;
  const res = await client
    .from('plan_item_comments')
    .select(PLAN_COMMENT_COLUMNS)
    .in('id', ids)
    .is('deleted_at', null);
  if (res.error !== null) return none;
  const replies = ((res.data ?? []) as PlanCommentLite[]).filter(
    (c) => c.parent_comment_id !== null,
  );
  const known = new Set(have.map((c) => c.id));
  const missing = [...new Set(replies.map((c) => c.parent_comment_id ?? ''))].filter(
    (id) => !known.has(id),
  );
  if (missing.length === 0) return { ...none, replies };
  const [roots, stats] = await Promise.all([
    client
      .from('plan_item_comments')
      .select(PLAN_COMMENT_COLUMNS)
      .in('id', missing)
      .is('deleted_at', null),
    planReplyCountsFor(client, missing),
  ]);
  return { replies, roots: (roots.data ?? []) as PlanCommentLite[], ...stats };
}

/** One message row per thread reply, its root attached (gone root: none). Pure. */
export function threadReplyRows(
  workspaceId: string,
  parts: Pick<BodyParts, 'threadReplies' | 'threadRoots' | 'counts' | 'replyInfo'>,
): CatchUpMessageRow[] {
  return (parts.threadReplies ?? []).flatMap((c) => {
    const root = parts.threadRoots?.get(c.parent_comment_id ?? '');
    if (root === undefined) return [];
    const row = messageOf(workspaceId, c, new Map());
    return [{ ...row, threadRoot: messageOf(workspaceId, root, parts.counts, parts.replyInfo) }];
  });
}

/** Plan / idea: one message row per thread reply, its root attached (gone root: none). Pure. */
export function planThreadReplyRows(
  workspaceId: string,
  parts: Pick<BodyParts, 'planThreadReplies' | 'planThreadRoots' | 'counts' | 'replyInfo'>,
): CatchUpMessageRow[] {
  return (parts.planThreadReplies ?? []).flatMap((c) => {
    const root = parts.planThreadRoots?.get(c.parent_comment_id ?? '');
    if (root === undefined) return [];
    const row = planMessageOf(workspaceId, c, new Map());
    return [
      { ...row, threadRoot: planMessageOf(workspaceId, root, parts.counts, parts.replyInfo) },
    ];
  });
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
  // Each card reads from its first unread row (16 Nov 2026): its New line is always drawn.
  const since = new Map<string, string>();
  for (const i of items) {
    const at = unreadSinceOf(i);
    if (at !== null) since.set(i.entityId, at);
  }

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
          ? topLevelComments(client, commentEntityIds, since)
          : Promise.resolve(null),
        itemIds.length > 0 ? planTopLevelComments(client, itemIds, since) : Promise.resolve(null),
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
      ...new Set((planItems?.data ?? []).flatMap((r) => (r.plan_id !== null ? [r.plan_id] : []))),
    ];
    const commentRowsAll = (comments?.data ?? []) as CommentRowLite[];
    const planRowsAll = (planComments?.data ?? []) as PlanCommentLite[];
    const [plans, stats, inThread, planStats, planInThread, files] = await Promise.all([
      planIds.length > 0
        ? client.from('plans').select('id, title').in('id', planIds)
        : Promise.resolve(null),
      replyCountsFor(
        client,
        'comments',
        commentRowsAll.map((c) => c.id),
      ),
      threadRepliesFor(client, threadReplyIds(items, commentRowsAll), commentRowsAll),
      planReplyCountsFor(
        client,
        planRowsAll.map((c) => c.id),
      ),
      planThreadRepliesFor(
        client,
        threadReplyIds(items, planRowsAll, ['plan-item', 'idea']),
        planRowsAll,
      ),
      // Every shown comment's files in ONE IN read, beside the reply counts (no new wave).
      fetchCommentFiles(
        client,
        [...commentRowsAll, ...planRowsAll].flatMap((c) => c.attachment_asset_ids ?? []),
      ),
    ]);
    // Comment and plan comment ids are distinct uuids: one map serves both.
    const { counts, info: replyInfo } = stats;
    for (const more of [inThread, planStats, planInThread]) {
      for (const [id, n] of more.counts) counts.set(id, n);
      for (const [id, got] of more.info) replyInfo.set(id, got);
    }
    const authors = [
      ...new Set([
        ...[...replyInfo.values()].flatMap((r) => r.repliers),
        ...[...commentRowsAll, ...inThread.replies, ...inThread.roots].flatMap((c) => [
          c.author_user_id,
          ...parseMentions(c.body),
        ]),
        ...[...planRowsAll, ...planInThread.replies, ...planInThread.roots].flatMap((c) => [
          ...(c.author_user_id !== null ? [c.author_user_id] : []),
          ...parseMentions(c.body),
        ]),
      ]),
    ];
    // Thread replies' and roots' files arrive with their rows: read only the
    // ones not asked yet, beside the names (no new wave; usually none).
    const fileMap = new Map(files ?? []);
    const replyFileIds = [
      ...inThread.replies,
      ...inThread.roots,
      ...planInThread.replies,
      ...planInThread.roots,
    ]
      .flatMap((c) => c.attachment_asset_ids ?? [])
      .filter((id) => !fileMap.has(id));
    const [moreFiles] = await Promise.all([
      replyFileIds.length > 0 ? fetchCommentFiles(client, replyFileIds) : Promise.resolve(null),
      resolvePeople(client, workspaceId, authors),
    ]);
    for (const [id, f] of moreFiles ?? []) fileMap.set(id, f);

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
          threadReplies: inThread.replies.filter((c) => c.entity_id === item.entityId),
          threadRoots: new Map(
            [...commentRowsAll, ...inThread.roots].map((c) => [c.id, c] as const),
          ),
          planComments: planRowsAll.filter((c) => c.item_id === item.entityId),
          planThreadReplies: planInThread.replies.filter((c) => c.item_id === item.entityId),
          planThreadRoots: new Map(
            [...planRowsAll, ...planInThread.roots].map((c) => [c.id, c] as const),
          ),
          counts,
          replyInfo,
          olderFull: (item.kind === 'plan-item' || item.kind === 'idea'
            ? planComments?.olderFull
            : comments?.olderFull
          )?.has(item.entityId),
        }),
      );
      const got = out.get(item.key);
      if (got !== undefined && got !== 'skip' && got !== 'error') {
        out.set(item.key, { ...got, rows: withFiles(got.rows, fileMap) });
      }
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
  post:
    | {
        title: string | null;
        caption: string | null;
        format: string | null;
        target_date: string | null;
        stage: string;
        deleted_at: string | null;
      }
    | undefined;
  brief:
    | {
        title: string;
        objective: string | null;
        target_date: string | null;
        status: string;
        deleted_at: string | null;
      }
    | undefined;
  planItem:
    | {
        title: string | null;
        description: string | null;
        target_date: string | null;
        plan_id: string | null;
        show_to_client: boolean;
        deleted_at: string | null;
      }
    | undefined;
  planTitle: ReadonlyMap<string, string>;
  pictures: { images: string[]; video: string | null };
  comments: CommentRowLite[];
  planComments: PlanCommentLite[];
  counts: ReadonlyMap<string, number>;
  /** Per parent: repliers and the last reply time (the replies row). */
  replyInfo?: ReadonlyMap<string, ReplyInfo>;
  /** Unread thread replies and their roots by id. */
  threadReplies?: readonly CommentRowLite[];
  threadRoots?: ReadonlyMap<string, CommentRowLite>;
  /** Plan / idea: unread thread replies and their roots by id. */
  planThreadReplies?: readonly PlanCommentLite[];
  planThreadRoots?: ReadonlyMap<string, PlanCommentLite>;
  /** The page before the unread rows came back full (more above); absent: by count. */
  olderFull?: boolean | undefined;
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
    rows = commentRows(workspaceId, [...parts.comments].reverse(), parts.counts, parts.replyInfo);
    rows.push(...threadReplyRows(workspaceId, parts));
    hasOlder = parts.olderFull ?? parts.comments.length >= CATCH_UP_PAGE;
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
    rows = commentRows(workspaceId, [...parts.comments].reverse(), parts.counts, parts.replyInfo);
    rows.push(...threadReplyRows(workspaceId, parts));
    hasOlder = parts.olderFull ?? parts.comments.length >= CATCH_UP_PAGE;
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
        planTitle:
          planItem.plan_id !== null ? (parts.planTitle.get(planItem.plan_id) ?? null) : null,
      }),
      pictures: [],
      video: null,
      due: dueWords(planItem.target_date, parts.zone),
      text: foldNewlines(stripFormat(planItem.description ?? '')),
    };
    const visible = parts.planComments.filter((c) => !(approver && c.visibility === 'team'));
    rows = [...visible]
      .reverse()
      .map((c) => planMessageOf(workspaceId, c, parts.counts, parts.replyInfo));
    rows.push(
      ...planThreadReplyRows(workspaceId, {
        ...parts,
        planThreadReplies: (parts.planThreadReplies ?? []).filter(
          (c) => !(approver && c.visibility === 'team'),
        ),
      }),
    );
    hasOlder = parts.olderFull ?? parts.planComments.length >= CATCH_UP_PAGE;
  }
  rows = [...rows, ...eventRows(item, rows)].sort(byTime);
  if (rows.length === 0 && context === null) return 'skip';
  return {
    title: title !== '' ? title : (item.lead.title ?? ''),
    context,
    rows,
    firstNewId: firstNewOf(item, rows),
    hasOlder,
    threads: true,
    latestReplyId: null,
  };
}

/**
 * A chat card's oldest unread card entry that names a message (its New line
 * sits there); else the lead (the newest). Pure.
 */
export function firstUnreadEntry(item: CatchUpItem): CatchUpItem['lead'] {
  const lead = chatPointOf(item.lead);
  // Same chat and same thread as the lead only (a thread-started entry points elsewhere).
  const unread = item.cardEntries.filter((e) => {
    if (e.readAt !== null || isOwnEntry(e, null)) return false;
    const point = chatPointOf(e);
    return point !== null && lead !== null && point.rootId === lead.rootId;
  });
  return [...unread].sort(byTime)[0] ?? item.lead;
}

/** Chat cards through readCatchUpChat (from the first unread entry), as card bodies. */
async function readCatchUpChatItems(
  client: Client,
  workspaceId: string,
  items: readonly CatchUpItem[],
): Promise<Map<string, CatchUpBodyResult>> {
  const out = new Map<string, CatchUpBodyResult>();
  // Each card reads from its oldest unread message, which carries the New line.
  const points = new Map(items.map((i) => [i.key, firstUnreadEntry(i)] as const));
  const since = new Map<string, string>();
  for (const item of items) {
    const at = unreadSinceOf(item);
    const point = points.get(item.key);
    if (at !== null && point !== undefined) since.set(point.id, at);
  }
  const got = await readCatchUpChat(client, workspaceId, [...points.values()], since);
  for (const item of items) {
    const chat = got.get(points.get(item.key)?.id ?? item.lead.id);
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
      ...repliesOf(workspaceId, chat.replyInfo?.get(m.id)),
      ...(m.files !== undefined ? { files: m.files } : {}),
    });
    const cardRoot = chat.root !== null ? toRow(chat.root) : undefined;
    const rows: CatchUpRow[] = [
      ...(cardRoot !== undefined ? [cardRoot] : []),
      ...chat.messages.map(toRow),
    ];
    if (rows.length === 0) {
      out.set(item.key, 'skip');
      continue;
    }
    out.set(item.key, {
      title:
        item.kind === 'chat-thread'
          ? (chat.threadName ?? 'Thread')
          : (item.lead.chatName ?? item.lead.actorName ?? 'Chat'),
      context: null,
      rows,
      firstNewId: chat.firstNewId,
      hasOlder: chat.hasOlder,
      threads: true,
      latestReplyId: chat.latestReplyId,
      ...(item.kind === 'chat-thread' && cardRoot !== undefined ? { cardRoot } : {}),
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
      const [stats, files] = await Promise.all([
        replyCountsFor(
          client,
          'comments',
          list.map((c) => c.id),
        ),
        fetchCommentFiles(
          client,
          list.flatMap((c) => c.attachment_asset_ids ?? []),
        ),
        resolvePeople(
          client,
          workspaceId,
          list.map((c) => c.author_user_id),
        ),
      ]);
      await resolvePeople(
        client,
        workspaceId,
        [...stats.info.values()].flatMap((r) => r.repliers),
      );
      return {
        rows: withFiles(
          commentRows(workspaceId, [...list].reverse(), stats.counts, stats.info),
          files ?? new Map(),
        ),
        hasOlder: list.length >= CATCH_UP_PAGE,
      };
    }
    if (item.kind === 'plan-item' || item.kind === 'idea') {
      const res = await client
        .from('plan_item_comments')
        .select(PLAN_COMMENT_COLUMNS)
        .eq('item_id', item.entityId)
        .is('parent_comment_id', null)
        .is('deleted_at', null)
        .lt('created_at', beforeAt)
        .order('created_at', { ascending: false })
        .limit(CATCH_UP_PAGE);
      if (res.error !== null) return null;
      const list = ((res.data ?? []) as PlanCommentLite[]).filter(
        (c) => !(input.side === 'client' && c.visibility === 'team'),
      );
      const [stats, files] = await Promise.all([
        planReplyCountsFor(
          client,
          list.map((c) => c.id),
        ),
        fetchCommentFiles(
          client,
          list.flatMap((c) => c.attachment_asset_ids ?? []),
        ),
        resolvePeople(
          client,
          workspaceId,
          list.flatMap((c) => (c.author_user_id !== null ? [c.author_user_id] : [])),
        ),
      ]);
      await resolvePeople(
        client,
        workspaceId,
        [...stats.info.values()].flatMap((r) => r.repliers),
      );
      return {
        rows: withFiles(
          [...list].reverse().map((c) => planMessageOf(workspaceId, c, stats.counts, stats.info)),
          files ?? new Map(),
        ),
        hasOlder: (res.data ?? []).length >= CATCH_UP_PAGE,
      };
    }
    if (item.kind === 'chat-main') {
      const res = await client
        .from('chat_messages')
        .select('id, sender_user_id, body, created_at, attachment_asset_ids, attachment_meta')
        .eq('channel_id', item.entityId)
        .is('thread_root_message_id', null)
        .is('deleted_at', null)
        .lt('created_at', beforeAt)
        .order('created_at', { ascending: false })
        .limit(CATCH_UP_PAGE);
      if (res.error !== null) return null;
      const list = res.data ?? [];
      const [counts] = await Promise.all([
        chatReplyCounts(
          client,
          list.map((m) => m.id),
        ),
        resolvePeople(
          client,
          workspaceId,
          list.flatMap((m) => (m.sender_user_id !== null ? [m.sender_user_id] : [])),
        ),
      ]);
      return {
        rows: [...list].reverse().map((m) => ({
          kind: 'message' as const,
          id: m.id,
          author: nameOf(workspaceId, m.sender_user_id),
          createdAt: m.created_at,
          ...catchUpText(workspaceId, m.body ?? ''),
          replyCount: counts.get(m.id) ?? 0,
          ...chatFilesOf(m.attachment_meta, m.attachment_asset_ids),
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

/** A comment's files from its stored ids and the read details (none: nothing). Pure. */
function commentFilesOf(
  ids: readonly string[] | null | undefined,
  files: ReadonlyMap<string, CommentFile> | null,
): { files?: MessageAttachment[] } {
  return ids != null && ids.length > 0
    ? { files: toCommentFileAttachments(ids, files ?? new Map()) }
    : {};
}

/** A chat row's files as the card draws them (none: nothing). Pure. */
export function chatFilesOf(
  meta: unknown,
  ids: readonly string[] | null | undefined,
): { files?: MessageAttachment[] } {
  return ids != null && ids.length > 0 ? { files: parseAttachmentMeta(meta, ids) } : {};
}

/** Reply counts of chat roots: one IN read. */
export async function chatReplyCounts(
  client: Client,
  rootIds: string[],
): Promise<Map<string, number>> {
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
 * A thread opened full screen inside a card: a chat root and its replies, a
 * comment (or feedback point) and its replies (parent_comment_id), or a plan /
 * idea comment and its replies (plan_item_comments.parent_comment_id; one
 * level). Replies oldest first. Null on a failed read.
 */
export async function readCatchUpThread(
  client: Client,
  input: {
    workspaceId: string;
    kind: 'chat' | 'comment' | 'plan';
    root: CatchUpMessageRow;
    channelId?: string | null;
  },
): Promise<CatchUpThread | null> {
  const { workspaceId, root } = input;
  try {
    if (input.kind === 'chat') {
      const res = await client
        .from('chat_messages')
        .select('id, sender_user_id, body, created_at, attachment_asset_ids, attachment_meta')
        .eq('thread_root_message_id', root.id)
        .is('deleted_at', null)
        .order('created_at', { ascending: true })
        .limit(200);
      if (res.error !== null) return null;
      const list = res.data ?? [];
      await resolvePeople(
        client,
        workspaceId,
        list.flatMap((m) =>
          m.sender_user_id !== null ? [m.sender_user_id, ...parseMentions(m.body ?? '')] : [],
        ),
      );
      return {
        root,
        replies: list.map((m) => ({
          kind: 'message',
          id: m.id,
          author: nameOf(workspaceId, m.sender_user_id),
          createdAt: m.created_at,
          ...catchUpText(workspaceId, m.body ?? ''),
          replyCount: 0,
          ...chatFilesOf(m.attachment_meta, m.attachment_asset_ids),
        })),
      };
    }
    if (input.kind === 'plan') {
      const res = await client
        .from('plan_item_comments')
        .select('id, author_user_id, body, created_at, attachment_asset_ids')
        .eq('parent_comment_id', root.id)
        .is('deleted_at', null)
        .order('created_at', { ascending: true })
        .limit(200);
      if (res.error !== null) return null;
      const list = res.data ?? [];
      const [files] = await Promise.all([
        fetchCommentFiles(
          client,
          list.flatMap((c) => c.attachment_asset_ids ?? []),
        ),
        resolvePeople(
          client,
          workspaceId,
          list.flatMap((c) => [
            ...(c.author_user_id !== null ? [c.author_user_id] : []),
            ...parseMentions(c.body),
          ]),
        ),
      ]);
      return {
        root,
        replies: list.map((c) => ({
          kind: 'message',
          id: c.id,
          author: nameOf(workspaceId, c.author_user_id),
          createdAt: c.created_at,
          ...catchUpText(workspaceId, c.body),
          replyCount: 0,
          ...commentFilesOf(c.attachment_asset_ids, files),
        })),
      };
    }
    const res = await client
      .from('comments')
      .select('id, author_user_id, body, created_at, attachment_asset_ids')
      .eq('parent_comment_id', root.id)
      .is('deleted_at', null)
      .order('created_at', { ascending: true })
      .limit(200);
    if (res.error !== null) return null;
    const list = res.data ?? [];
    const [files] = await Promise.all([
      fetchCommentFiles(
        client,
        list.flatMap((c) => c.attachment_asset_ids ?? []),
      ),
      resolvePeople(
        client,
        workspaceId,
        list.flatMap((c) => [c.author_user_id, ...parseMentions(c.body)]),
      ),
    ]);
    return {
      root,
      replies: list.map((c) => ({
        kind: 'message',
        id: c.id,
        author: nameOf(workspaceId, c.author_user_id),
        createdAt: c.created_at,
        ...catchUpText(workspaceId, c.body),
        replyCount: 0,
        ...commentFilesOf(c.attachment_asset_ids, files),
      })),
    };
  } catch (error) {
    logger.warn('catch-up: thread read threw', { error: String(error) });
    return null;
  }
}
