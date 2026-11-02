// Reply privately: the quote a DM message carries of someone's words in a
// group chat, a post or brief comment, or a plan item comment. One Zod schema
// reads chat_messages.private_reply at every read boundary (history read, open
// bundle, live receive); a malformed value throws (crash early), null is none.
// The composer's pending quote (PrivateReplyDraft) lives on the channel's draft
// (src/lib/chat/drafts.ts), so it survives a reload like the text does.

import { z } from 'zod';
import { chatMessageHref, planHref } from '@/lib/inbox/bell-types';

export const PRIVATE_REPLY_KINDS = ['chat', 'comment', 'plan_comment'] as const;
export type PrivateReplyKind = (typeof PRIVATE_REPLY_KINDS)[number];

const chatLink = z.object({ channel_id: z.string().min(1), message_id: z.string().min(1) });
const commentLink = z.object({
  entity_type: z.string().min(1),
  entity_id: z.string().min(1),
  comment_id: z.string().min(1),
});
const planLink = z.object({
  plan_id: z.string().min(1),
  item_id: z.string().min(1),
  comment_id: z.string().min(1),
});

/** chat_messages.private_reply as the server writes it. */
export const privateReplySchema = z.object({
  kind: z.enum(PRIVATE_REPLY_KINDS),
  source_id: z.string().min(1),
  author_user_id: z.string().min(1),
  excerpt: z.string(),
  where_label: z.string(),
  source_created_at: z.string().nullable().optional(),
  link: z.union([chatLink, commentLink, planLink]),
});

export type PrivateReplyRow = z.infer<typeof privateReplySchema>;

/** The quote as the app uses it (camelCase, link narrowed by kind). */
export type PrivateReplyLink =
  | { kind: 'chat'; channelId: string; messageId: string }
  | { kind: 'comment'; entityType: string; entityId: string; commentId: string }
  | { kind: 'plan_comment'; planId: string; itemId: string; commentId: string };

export interface PrivateReply {
  kind: PrivateReplyKind;
  sourceId: string;
  authorUserId: string;
  excerpt: string;
  whereLabel: string;
  sourceCreatedAt: string | null;
  link: PrivateReplyLink;
}

/**
 * Read private_reply: undefined or null is none; a valid value maps to
 * PrivateReply; anything else throws (a ZodError, or an Error for a link that
 * does not match its kind).
 */
export function parsePrivateReply(value: unknown): PrivateReply | null {
  if (value === null || value === undefined) return null;
  const row = privateReplySchema.parse(value);
  const link = row.link;
  let mapped: PrivateReplyLink;
  if (row.kind === 'chat' && 'channel_id' in link) {
    mapped = { kind: 'chat', channelId: link.channel_id, messageId: link.message_id };
  } else if (row.kind === 'comment' && 'entity_type' in link) {
    mapped = {
      kind: 'comment',
      entityType: link.entity_type,
      entityId: link.entity_id,
      commentId: link.comment_id,
    };
  } else if (row.kind === 'plan_comment' && 'plan_id' in link) {
    mapped = {
      kind: 'plan_comment',
      planId: link.plan_id,
      itemId: link.item_id,
      commentId: link.comment_id,
    };
  } else {
    throw new Error(`private_reply: link does not match kind ${row.kind}`);
  }
  return {
    kind: row.kind,
    sourceId: row.source_id,
    authorUserId: row.author_user_id,
    excerpt: row.excerpt,
    whereLabel: row.where_label,
    sourceCreatedAt: row.source_created_at ?? null,
    link: mapped,
  };
}

/** The wire shape again (the live Agora payload carries the row's jsonb as is). */
export function privateReplyToRow(reply: PrivateReply): PrivateReplyRow {
  const l = reply.link;
  const link =
    l.kind === 'chat'
      ? { channel_id: l.channelId, message_id: l.messageId }
      : l.kind === 'comment'
        ? { entity_type: l.entityType, entity_id: l.entityId, comment_id: l.commentId }
        : { plan_id: l.planId, item_id: l.itemId, comment_id: l.commentId };
  return {
    kind: reply.kind,
    source_id: reply.sourceId,
    author_user_id: reply.authorUserId,
    excerpt: reply.excerpt,
    where_label: reply.whereLabel,
    source_created_at: reply.sourceCreatedAt,
    link,
  };
}

/**
 * The composer's pending quote, set by Reply privately before the DM opens.
 * The send passes kind + sourceId to chat_private_reply_send; the server
 * snapshots the excerpt and where label itself. The rest paints the strip and
 * the optimistic bubble.
 */
export interface PrivateReplyDraft {
  kind: PrivateReplyKind;
  sourceId: string;
  authorUserId: string;
  /** The author's full name as the source screen showed it. */
  authorName: string;
  /** One line of their words. */
  excerpt: string;
  /** Group name, post/brief title or plan item title. */
  whereLabel: string;
  link: PrivateReplyLink;
}

/** Read a persisted draft quote back; anything not a full quote is none. Pure. */
export function parsePrivateReplyDraft(value: unknown): PrivateReplyDraft | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  const str = (k: string): string | null => (typeof v[k] === 'string' ? (v[k] as string) : null);
  const kind = str('kind');
  const sourceId = str('sourceId');
  const authorUserId = str('authorUserId');
  const authorName = str('authorName');
  const excerpt = str('excerpt');
  const whereLabel = str('whereLabel');
  if (
    kind === null ||
    !(PRIVATE_REPLY_KINDS as readonly string[]).includes(kind) ||
    sourceId === null ||
    authorUserId === null ||
    authorName === null ||
    excerpt === null ||
    whereLabel === null
  ) {
    return null;
  }
  const link = v.link as PrivateReplyLink | undefined;
  if (typeof link !== 'object' || link === null || link.kind !== kind) return null;
  return {
    kind: kind as PrivateReplyKind,
    sourceId,
    authorUserId,
    authorName,
    excerpt,
    whereLabel,
    link,
  };
}

/** The quote header: "<Full name> · <where>" (the name alone when there is no where). Pure. */
export function privateReplyHeader(authorName: string, whereLabel: string): string {
  return whereLabel !== '' ? `${authorName} · ${whereLabel}` : authorName;
}

/** The excerpt on one line (newlines folded), for the strip and the bubble. Pure. */
export function privateReplyLine(excerpt: string): string {
  return excerpt.replace(/\s+/g, ' ').trim();
}

/** Approved copy (2 Nov 2026). */
export const REPLY_PRIVATELY = 'Reply privately';
export function replyPrivatelyTo(firstName: string): string {
  return `to ${firstName}`;
}

/**
 * A quote as the app stored it (the outbox's persisted send, camelCase) back
 * to a PrivateReply; null when absent or malformed (device storage is never
 * trusted, so this never throws). Pure.
 */
export function parseStoredPrivateReply(value: unknown): PrivateReply | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Partial<PrivateReply>;
  const l = v.link;
  if (typeof l !== 'object' || l === null) return null;
  try {
    const link =
      l.kind === 'chat'
        ? { channel_id: l.channelId, message_id: l.messageId }
        : l.kind === 'comment'
          ? { entity_type: l.entityType, entity_id: l.entityId, comment_id: l.commentId }
          : { plan_id: l.planId, item_id: l.itemId, comment_id: l.commentId };
    return parsePrivateReply({
      kind: v.kind,
      source_id: v.sourceId,
      author_user_id: v.authorUserId,
      excerpt: v.excerpt,
      where_label: v.whereLabel,
      source_created_at: v.sourceCreatedAt ?? null,
      link,
    });
  } catch {
    return null;
  }
}

/** The quote a send carries, from the composer's draft (the server's snapshot replaces it). Pure. */
export function privateReplyFromDraft(draft: PrivateReplyDraft): PrivateReply {
  return {
    kind: draft.kind,
    sourceId: draft.sourceId,
    authorUserId: draft.authorUserId,
    excerpt: draft.excerpt,
    whereLabel: draft.whereLabel,
    sourceCreatedAt: null,
    link: draft.link,
  };
}

/**
 * Whether a message offers Reply privately: someone else's recorded, live
 * message in a group chat, from a person who is still a member. Never on my
 * own message, in a DM or in Personal notes, and never with no known sender.
 * Pure.
 */
export function canReplyPrivatelyInChat(input: {
  mine: boolean;
  senderUserId: string | null;
  /** The chat is a group (not a DM, not notes). */
  isGroup: boolean;
  notes: boolean;
  /** The sender left or was removed (a former member). */
  senderRemoved: boolean;
  state: 'sending' | 'sent' | 'failed';
  deleted?: boolean;
}): boolean {
  if (input.mine || !input.isGroup || input.notes) return false;
  if (input.senderUserId === null || input.senderUserId === '') return false;
  if (input.senderRemoved) return false;
  return input.state === 'sent' && input.deleted !== true;
}

/** Reply privately's quote of a group chat message (what the DM's composer shows). Pure. */
export function chatPrivateReplyDraft(input: {
  channelId: string;
  messageId: string;
  authorUserId: string;
  authorName: string;
  /** One line of their words (the reply quote's preview: text, or the media label). */
  excerpt: string;
  /** The group's display name (chatDisplayName). */
  groupName: string;
}): PrivateReplyDraft {
  return {
    kind: 'chat',
    sourceId: input.messageId,
    authorUserId: input.authorUserId,
    authorName: input.authorName,
    excerpt: privateReplyLine(input.excerpt),
    whereLabel: input.groupName,
    link: { kind: 'chat', channelId: input.channelId, messageId: input.messageId },
  };
}

/**
 * Where a bubble's quote opens, by its link: the group message
 * (chatMessageHref, the thread's jump-to-message), the post or brief with the
 * comment (?comment=, landed by focus-target.ts, which toasts a deleted or
 * hidden one), or the plan item with the comment (&comment=, the Activity
 * plan comment link). Pure.
 */
export function privateReplyHref(link: PrivateReplyLink): string | null {
  switch (link.kind) {
    case 'chat':
      return chatMessageHref(link.channelId, link.messageId);
    case 'comment': {
      const id = encodeURIComponent(link.entityId);
      const comment = `?comment=${encodeURIComponent(link.commentId)}`;
      if (link.entityType === 'post') return `/posts/${id}${comment}`;
      if (link.entityType === 'brief') return `/briefs/${id}${comment}`;
      return null;
    }
    case 'plan_comment':
      return `${planHref(link.planId, link.itemId)}&comment=${encodeURIComponent(link.commentId)}`;
  }
}
