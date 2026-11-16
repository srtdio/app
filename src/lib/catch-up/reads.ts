// Catch up's chat card reads: only what the current and the next card need, one
// batched read per kind, never one per card and never a full table. Chat
// cards: the messages by id IN (the entry's message and its thread root), the
// newest replies by thread root IN, the root cards' titles (posts, briefs,
// plans, plan items by id IN) and the senders' names (the shared name
// registry, one read). Non-chat cards paint from what Activity already holds
// (title, Activity line, comment or plan note text), so they read nothing.
// Every read is best-effort: a failure leaves the card on what it holds.

import type { Client } from '@srtdio/rpc';
import type { ActivityItem } from '@/components/pages/activity/data';
import { loadMessagesByIds } from '@/lib/chat/history';
import type { ChatMessageRow } from '@/lib/chat/thread';
import { personAvatar, personName, resolvePeople } from '@/lib/people-names';
import { parseMentions, stripFormat } from '@srtdio/comments';
import { mentionNamesIn, resolveMentionPreview } from '@/lib/chat/mentions';
import { logger } from '@/lib/logger';
import { chatPointOf } from '@/lib/catch-up/writes';
import { replyStatsOf, type ReplyInfo } from '@/lib/catch-up/types';
import { parseAttachmentMeta, type MessageAttachment } from '@/lib/chat/attachments';

/** One message as a catch-up card draws it (the chat's work layout). */
export interface CatchUpMessage {
  id: string;
  senderId: string | null;
  senderName: string;
  senderAvatarUrl: string | null;
  createdAt: string;
  /** The text, mentions resolved to @names. */
  text: string;
  /** Its photos and files (16 Nov 2026); absent when it has none. */
  files?: MessageAttachment[];
}

/** A chat card's body. */
export interface CatchUpChatContent {
  /** The thread's root (thread cards), drawn first. */
  root: CatchUpMessage | null;
  /** The replies (thread cards) or the message (main chat), oldest first. */
  messages: CatchUpMessage[];
  /** The "New" line sits before this message (the first unread one). */
  firstNewId: string | null;
  /** The thread's name: its card title, else its root's first line; null for the main chat. */
  threadName: string | null;
  /** The newest reply id (a thread is marked read up to it). */
  latestReplyId: string | null;
  /** Main chat: replies under each top-level message (its threads row). */
  replyCounts: ReadonlyMap<string, number>;
  /** Main chat: each top-level message's repliers and last reply time (same read). */
  replyInfo?: ReadonlyMap<string, ReplyInfo>;
  /** Older messages exist above (scroll up loads them). */
  hasOlder: boolean;
}

/** Most replies a thread card draws (the newest ones). */
export const CATCH_UP_REPLIES = 20;

/** Longest thread name taken from a root's first line before it truncates. */
const THREAD_NAME_MAX = 60;

const REPLY_COLUMNS =
  'id, channel_id, sender_user_id, body, created_at, deleted_at, thread_root_message_id, shared_post_ids, shared_brief_ids, shared_plan_ids, shared_plan_item_ids, attachment_asset_ids, attachment_meta';

/** Most unread messages a card reads from its first unread one (body.ts CATCH_UP_UNREAD_MAX). */
const UNREAD_MAX = 200;

type ReplyRow = Pick<
  ChatMessageRow,
  | 'id'
  | 'channel_id'
  | 'sender_user_id'
  | 'body'
  | 'created_at'
  | 'deleted_at'
  | 'thread_root_message_id'
  | 'shared_post_ids'
  | 'shared_brief_ids'
  | 'shared_plan_ids'
  | 'shared_plan_item_ids'
  | 'attachment_asset_ids'
  | 'attachment_meta'
>;

/** A root's first line as a thread name, truncated; null when it has no text. Pure. */
export function rootFirstLine(text: string): string | null {
  const first = text.trim().split('\n')[0]?.trim() ?? '';
  if (first === '') return null;
  return first.length <= THREAD_NAME_MAX ? first : `${first.slice(0, THREAD_NAME_MAX).trimEnd()}…`;
}

function cardRef(row: ReplyRow): { kind: 'post' | 'brief' | 'plan' | 'item'; id: string } | null {
  const post = row.shared_post_ids?.[0];
  if (post !== undefined) return { kind: 'post', id: post };
  const brief = row.shared_brief_ids?.[0];
  if (brief !== undefined) return { kind: 'brief', id: brief };
  const plan = row.shared_plan_ids?.[0];
  if (plan !== undefined) return { kind: 'plan', id: plan };
  const item = row.shared_plan_item_ids?.[0];
  if (item !== undefined) return { kind: 'item', id: item };
  return null;
}

async function readTitles(
  client: Client,
  ids: { post: string[]; brief: string[]; plan: string[]; item: string[] },
): Promise<Map<string, string>> {
  const titles = new Map<string, string>();
  const [posts, briefs, plans, items] = await Promise.all([
    ids.post.length > 0
      ? client.from('posts').select('id, title').in('id', ids.post)
      : Promise.resolve(null),
    ids.brief.length > 0
      ? client.from('briefs').select('id, title').in('id', ids.brief)
      : Promise.resolve(null),
    ids.plan.length > 0
      ? client.from('plans').select('id, title').in('id', ids.plan)
      : Promise.resolve(null),
    ids.item.length > 0
      ? client.from('plan_items').select('id, title').in('id', ids.item)
      : Promise.resolve(null),
  ]);
  for (const res of [posts, briefs, plans, items]) {
    if (res === null || res.error !== null) continue;
    for (const r of res.data ?? []) {
      if (typeof r.title === 'string' && r.title.trim() !== '') titles.set(r.id, r.title);
    }
  }
  return titles;
}

/**
 * The chat bodies of `items` (the current and next cards), keyed by entry id.
 * Non-chat entries are skipped. Three waves at most: messages + replies, then
 * titles + names, all batched.
 */
export async function readCatchUpChat(
  client: Client,
  workspaceId: string,
  items: readonly ActivityItem[],
  /** By entry id: where its card's unread messages start (16 Nov 2026); absent: newest page only. */
  since: ReadonlyMap<string, string> = new Map(),
): Promise<Map<string, CatchUpChatContent>> {
  const out = new Map<string, CatchUpChatContent>();
  const points = items.flatMap((item) => {
    const point = chatPointOf(item);
    return point !== null ? [{ item, point }] : [];
  });
  if (points.length === 0) return out;
  const messageIds = [
    ...new Set(
      points.flatMap(({ point }) => [
        point.messageId,
        ...(point.rootId !== null ? [point.rootId] : []),
      ]),
    ),
  ];
  const rootIds = [
    ...new Set(points.flatMap(({ point }) => (point.rootId !== null ? [point.rootId] : []))),
  ];
  const mainChannels = [
    ...new Set(points.flatMap(({ point }) => (point.rootId === null ? [point.channelId] : []))),
  ];
  // Every message from a card's first unread one (16 Nov 2026), one read per
  // card (<= 2), beside the pages below: the New line is always drawn, so 50
  // new messages open with it on top, never mid-way.
  const unreadReads = points.flatMap(({ item, point }) => {
    const from = since.get(item.id);
    if (from === undefined) return [];
    const base = client.from('chat_messages').select(REPLY_COLUMNS).is('deleted_at', null);
    const scoped =
      point.rootId !== null
        ? base.eq('thread_root_message_id', point.rootId)
        : base.eq('channel_id', point.channelId).is('thread_root_message_id', null);
    return [
      scoped.gte('created_at', from).order('created_at', { ascending: true }).limit(UNREAD_MAX),
    ];
  });
  const [byId, replies, mains, ...unread] = await Promise.all([
    loadMessagesByIds(client, messageIds),
    rootIds.length > 0
      ? client
          .from('chat_messages')
          .select(REPLY_COLUMNS)
          .in('thread_root_message_id', rootIds)
          .is('deleted_at', null)
          .order('created_at', { ascending: false })
          .limit(CATCH_UP_REPLIES * rootIds.length)
      : Promise.resolve(null),
    // The main chat's newest top-level messages, so earlier ones fill the card.
    mainChannels.length > 0
      ? client
          .from('chat_messages')
          .select(REPLY_COLUMNS)
          .in('channel_id', mainChannels)
          .is('thread_root_message_id', null)
          .is('deleted_at', null)
          .order('created_at', { ascending: false })
          .limit(CATCH_UP_REPLIES * mainChannels.length)
      : Promise.resolve(null),
    ...unreadReads,
  ]);
  const rows = new Map<string, ReplyRow>();
  if (byId.ok) for (const r of byId.data) rows.set(r.id, r);
  else logger.warn('catch-up: messages read failed', { error: byId.error.message });
  const repliesByRoot = new Map<string, ReplyRow[]>();
  if (replies !== null && replies.error === null) {
    for (const r of (replies.data ?? []) as ReplyRow[]) {
      const root = r.thread_root_message_id;
      if (root === null) continue;
      const list = repliesByRoot.get(root) ?? [];
      if (list.length < CATCH_UP_REPLIES) list.push(r);
      repliesByRoot.set(root, list);
      rows.set(r.id, r);
    }
  } else if (replies !== null) {
    logger.warn('catch-up: replies read failed', { error: replies.error.message });
  }
  const mainByChannel = new Map<string, ReplyRow[]>();
  if (mains !== null && mains.error === null) {
    for (const r of (mains.data ?? []) as ReplyRow[]) {
      const list = mainByChannel.get(r.channel_id) ?? [];
      if (list.length < CATCH_UP_REPLIES) list.push(r);
      mainByChannel.set(r.channel_id, list);
      rows.set(r.id, r);
    }
  } else if (mains !== null) {
    logger.warn('catch-up: main chat read failed', { error: mains.error.message });
  }
  for (const res of unread) {
    if (res.error !== null) {
      logger.warn('catch-up: unread read failed', { error: res.error.message });
      continue;
    }
    for (const r of (res.data ?? []) as ReplyRow[]) {
      if (rows.has(r.id)) continue;
      rows.set(r.id, r);
      const root = r.thread_root_message_id;
      const map = root !== null ? repliesByRoot : mainByChannel;
      const key = root ?? r.channel_id;
      map.set(key, [...(map.get(key) ?? []), r]);
    }
  }
  const mainIds = [...mainByChannel.values()].flat().map((r) => r.id);
  const countsRes =
    mainIds.length > 0
      ? await client
          .from('chat_messages')
          .select('thread_root_message_id, sender_user_id, created_at')
          .in('thread_root_message_id', mainIds)
          .is('deleted_at', null)
          .order('created_at', { ascending: false })
      : null;
  const { counts: replyCounts, info: replyInfo } = replyStatsOf(
    countsRes !== null && countsRes.error === null
      ? (countsRes.data ?? []).map((r) => ({
          parent: r.thread_root_message_id,
          author: r.sender_user_id,
          at: r.created_at,
        }))
      : [],
  );
  const cards = rootIds.flatMap((id) => {
    const row = rows.get(id);
    const card = row !== undefined ? cardRef(row) : null;
    return card !== null ? [card] : [];
  });
  const of = (kind: 'post' | 'brief' | 'plan' | 'item'): string[] => [
    ...new Set(cards.filter((c) => c.kind === kind).map((c) => c.id)),
  ];
  const senders = [
    ...new Set(
      [...rows.values()].flatMap((r) => [
        ...(r.sender_user_id !== null ? [r.sender_user_id] : []),
        ...parseMentions(r.body ?? ''),
      ]),
    ),
    ...[...replyInfo.values()].flatMap((r) => r.repliers),
  ];
  const [titles] = await Promise.all([
    readTitles(client, {
      post: of('post'),
      brief: of('brief'),
      plan: of('plan'),
      item: of('item'),
    }),
    resolvePeople(client, workspaceId, senders),
  ]);
  const names = mentionNamesIn(workspaceId);
  const toMessage = (r: ReplyRow): CatchUpMessage => ({
    id: r.id,
    senderId: r.sender_user_id,
    senderName:
      (r.sender_user_id !== null ? personName(workspaceId, r.sender_user_id) : null) ?? 'Member',
    senderAvatarUrl: r.sender_user_id !== null ? personAvatar(workspaceId, r.sender_user_id) : null,
    createdAt: r.created_at,
    text: stripFormat(resolveMentionPreview(r.body ?? '', names)),
    ...(r.attachment_asset_ids != null && r.attachment_asset_ids.length > 0
      ? { files: parseAttachmentMeta(r.attachment_meta, r.attachment_asset_ids) }
      : {}),
  });
  for (const { item, point } of points) {
    const target = rows.get(point.messageId);
    if (point.rootId === null) {
      const recent = [...(mainByChannel.get(point.channelId) ?? [])];
      if (target !== undefined && !recent.some((r) => r.id === target.id)) recent.push(target);
      recent.sort((a, b) =>
        a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0,
      );
      out.set(item.id, {
        root: null,
        messages: recent.map(toMessage),
        firstNewId: target !== undefined ? target.id : null,
        threadName: null,
        latestReplyId: null,
        replyCounts,
        replyInfo,
        hasOlder: (mainByChannel.get(point.channelId) ?? []).length >= CATCH_UP_REPLIES,
      });
      continue;
    }
    const rootRow = rows.get(point.rootId);
    const thread = [...(repliesByRoot.get(point.rootId) ?? [])];
    if (target !== undefined && !thread.some((r) => r.id === target.id)) thread.push(target);
    thread.sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
    const card = rootRow !== undefined ? cardRef(rootRow) : null;
    const root = rootRow !== undefined ? toMessage(rootRow) : null;
    out.set(item.id, {
      root,
      messages: thread.map(toMessage),
      firstNewId: target?.id ?? null,
      threadName:
        (card !== null ? (titles.get(card.id) ?? null) : null) ??
        (root !== null ? rootFirstLine(root.text) : null),
      latestReplyId: thread[thread.length - 1]?.id ?? null,
      replyCounts: new Map(),
      hasOlder: false,
    });
  }
  return out;
}
