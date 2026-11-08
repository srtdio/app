// Catch up's words and card kinds. Every line here is the approved copy (8 Nov
// screens); non-chat cards reuse the Activity line for their kicker (no new
// copy). Pure.

import {
  activityLine,
  cardTitle,
  isChatMention,
  isThreadStarted,
  threadCardNoun,
  type ActivityItem,
} from '@/components/pages/activity/data';
import { CHAT_LABEL } from '@/lib/inbox/alerts';
import { THREAD_TITLE } from '@/lib/chat/thread-rail';

/**
 * What a card is: a chat mention in a thread, a chat mention in the main chat,
 * a thread's first reply on a card, a post or brief comment (it takes a
 * reply), or any other entry (no reply box).
 */
export type CatchUpCardKind = 'chat-thread' | 'chat-main' | 'thread-started' | 'comment' | 'entity';

/** The card kind of an entry. Pure. */
export function catchUpCardKind(item: ActivityItem): CatchUpCardKind {
  if (isThreadStarted(item)) return 'thread-started';
  if (isChatMention(item)) return item.threadRootId != null ? 'chat-thread' : 'chat-main';
  if (
    (item.eventType === 'comment' || item.eventType === 'mention') &&
    item.commentId !== null &&
    (item.entityType === 'post' || item.entityType === 'brief')
  ) {
    return 'comment';
  }
  return 'entity';
}

/** Whether a card is a chat card (chat messages in its body). Pure. */
export function isChatCard(kind: CatchUpCardKind): boolean {
  return kind === 'chat-thread' || kind === 'chat-main' || kind === 'thread-started';
}

/** The chat's name on a card: the group's, else (a DM) the person's, else "Chat". Pure. */
export function catchUpChatName(item: Pick<ActivityItem, 'chatName' | 'actorName'>): string {
  return item.chatName ?? item.actorName ?? CHAT_LABEL;
}

/** The small kicker line over a card's title. Pure. */
export function catchUpKicker(item: ActivityItem): string {
  const chat = catchUpChatName(item);
  switch (catchUpCardKind(item)) {
    case 'chat-thread':
      return `Thread in ${chat}`;
    case 'chat-main':
      return chat;
    case 'thread-started':
      return `Thread on ${threadCardNoun(item.cardKind)} · ${chat}`;
    default:
      return activityLine(item);
  }
}

/**
 * A card's title: a thread's name (its card title, else the first line of
 * its root, else "Thread"), the chat's name, a thread start's card title, or
 * the entity's title. `threadName` is the read root's name when known. Pure.
 */
export function catchUpTitle(item: ActivityItem, threadName: string | null = null): string {
  switch (catchUpCardKind(item)) {
    case 'chat-thread':
      return threadName ?? THREAD_TITLE;
    case 'chat-main':
      return catchUpChatName(item);
    case 'thread-started':
      return item.title !== null && item.title !== '' ? item.title : (threadName ?? THREAD_TITLE);
    default:
      if (item.title !== null && item.title !== '') return item.title;
      return item.planTitle ?? cardTitle(item);
  }
}

/** The reply box's hint, or null for a card with no box. Pure. */
export function catchUpReplyHint(item: ActivityItem): string | null {
  switch (catchUpCardKind(item)) {
    case 'chat-thread':
    case 'thread-started':
      return 'Reply in thread';
    case 'chat-main':
      return `Message ${catchUpChatName(item)}`;
    case 'comment':
      return 'Reply';
    default:
      return null;
  }
}

/** The top bar's count: "<N> left". Pure. */
export function leftLabel(n: number): string {
  return `${n} left`;
}

/** The end screen's title. */
export const END_TITLE = "Everything's sorted.";

/** The end screen's line: "You went through 1 update." / "... <N> updates." Pure. */
export function endLine(n: number): string {
  return `You went through ${n} ${n === 1 ? 'update' : 'updates'}.`;
}

/** The two decision labels and the screen's words. */
export const KEEP_UNREAD = 'Keep unread';
export const MARK_AS_READ = 'Mark as read';
export const CATCH_UP = 'Catch up';
export const UNDO = 'Undo';
export const DONE = 'Done';

/** The Activity bar's heading: "<N> unread". Pure. */
export function unreadHeading(n: number): string {
  return `${n} unread`;
}
