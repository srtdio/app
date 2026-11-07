// The chat home chip views (Photos, Videos, Files, Links, Voice notes) select
// ITEMS, keyed by message: a message carrying three photos is one selection
// (all three tiles show checked), Delete for me hides the whole message and
// Forward forwards it. Plus the photo viewer's next item once a message is
// hidden, and its Delete rule (deleteChoices with no Delete for everyone where
// the caller has no path for it). Pure.

import { deleteChoices } from '@/lib/chat/delete-flow';
import type { HideItem } from '@/lib/chat/use-delete-for-me';

/** The selected messages: message id to its chat id. */
export type MediaSelection = ReadonlyMap<string, string>;

export const EMPTY_MEDIA_SELECTION: MediaSelection = new Map<string, string>();

/** Toggle one item's message in the selection (a new Map). Pure. */
export function toggleMediaSelection(
  selection: MediaSelection,
  item: { messageId: string; channelId: string },
): Map<string, string> {
  const next = new Map(selection);
  if (next.has(item.messageId)) next.delete(item.messageId);
  else next.set(item.messageId, item.channelId);
  return next;
}

/** The selection as Delete for me / Forward items, in selection order. Pure. */
export function mediaSelectionItems(selection: MediaSelection): HideItem[] {
  return [...selection].map(([messageId, channelId]) => ({ messageId, channelId }));
}

/**
 * The viewer's next item once the message at `index` is hidden (every item of
 * that message leaves): the first later item of another message, else the
 * nearest earlier one, else null (close). Pure.
 */
export function keyAfterHide(
  items: readonly { key: string; messageId: string }[],
  index: number,
): string | null {
  const gone = items[index]?.messageId;
  if (gone === undefined) return null;
  for (let i = index + 1; i < items.length; i += 1) {
    const item = items[i];
    if (item !== undefined && item.messageId !== gone) return item.key;
  }
  for (let i = index - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item !== undefined && item.messageId !== gone) return item.key;
  }
  return null;
}

/**
 * The viewer's Delete rule for one item: deleteChoices on the item (own,
 * age on `nowMs`, Personal notes), with "Delete for everyone" only when the
 * caller has that path (`canEveryone`). Notes keeps Delete for me here (its
 * own Delete lives in the thread). Pure.
 */
export function mediaDeleteEveryone(input: {
  senderId: string | null;
  currentUserId: string | null;
  createdAt: string;
  nowMs: number;
  notes: boolean;
  canEveryone: boolean;
}): boolean {
  if (!input.canEveryone) return false;
  const created = Date.parse(input.createdAt);
  const choices = deleteChoices({
    mine: input.senderId !== null && input.senderId === input.currentUserId,
    ageMs: Number.isNaN(created) ? null : input.nowMs - created,
    notes: input.notes,
    failed: false,
  });
  return choices.kind === 'sheet' && choices.everyone;
}
