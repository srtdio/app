// Reply privately from a post or brief comment, or a plan item comment: who
// offers it and the quote it writes on the DM's draft. Pure: the screens pass
// what they already hold (the row's author, the name it shows, the title on the
// page); nothing here reads the network.

import { FORMER_MEMBER } from '@/lib/chat/mentions';
import type { PrivateReplyDraft } from '@/lib/chat/private-reply';

/** What a comment row knows about its author. */
export interface ReplyPrivatelyAuthor {
  /** The author's user id; null for a legacy (imported) author. */
  authorUserId: string | null;
  /** The viewer; null while unknown (then the row cannot tell it is not mine). */
  me: string | null;
  /** The full name the row shows ('' while it is still unknown). */
  authorName: string;
  /** A legacy author (an imported name with no account). */
  legacy?: boolean;
  /** The screen knows this person is no longer a member. */
  former?: boolean;
}

/**
 * Whether a comment row offers Reply privately: only on someone else's comment
 * whose author is a known, current member. Never mine, never a legacy author,
 * never a former member, never while the name is still unknown. Pure.
 */
export function canReplyPrivately(author: ReplyPrivatelyAuthor): boolean {
  const id = author.authorUserId;
  if (id === null || id === '') return false;
  if (author.me === null || id.toLowerCase() === author.me.toLowerCase()) return false;
  if (author.legacy === true || author.former === true) return false;
  const name = author.authorName.trim();
  return name !== '' && name !== FORMER_MEMBER;
}

/** The quote for a post or brief comment. `excerpt` is its body as plain text. Pure. */
export function commentPrivateReplyDraft(input: {
  commentId: string;
  authorUserId: string;
  authorName: string;
  excerpt: string;
  whereLabel: string;
  entityType: 'post' | 'brief';
  entityId: string;
}): PrivateReplyDraft {
  return {
    kind: 'comment',
    sourceId: input.commentId,
    authorUserId: input.authorUserId,
    authorName: input.authorName,
    excerpt: input.excerpt,
    whereLabel: input.whereLabel,
    link: {
      kind: 'comment',
      entityType: input.entityType,
      entityId: input.entityId,
      commentId: input.commentId,
    },
  };
}

/** The quote for a plan item comment. `excerpt` is its body as plain text. Pure. */
export function planCommentPrivateReplyDraft(input: {
  commentId: string;
  authorUserId: string;
  authorName: string;
  excerpt: string;
  whereLabel: string;
  planId: string;
  itemId: string;
}): PrivateReplyDraft {
  return {
    kind: 'plan_comment',
    sourceId: input.commentId,
    authorUserId: input.authorUserId,
    authorName: input.authorName,
    excerpt: input.excerpt,
    whereLabel: input.whereLabel,
    link: {
      kind: 'plan_comment',
      planId: input.planId,
      itemId: input.itemId,
      commentId: input.commentId,
    },
  };
}
