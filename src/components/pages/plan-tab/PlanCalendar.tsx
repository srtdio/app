// The laptop Plan tab's Month | Week calendar retired on 7 Nov 2026: both
// widths now show the chips over the ListCard grid (PlanTabList). Only this
// pure helper stays, because a chat test still imports it
// (src/components/chat/__tests__/plan-comment-unread.test.tsx); move it with
// that test and delete this file.

import type { CalendarEntry } from '@/lib/plan-tab';

/** The unread props for an entry's comment count: the item id for plan items only. Pure. */
export function entryUnreadProps(entry: CalendarEntry): { itemId?: string } {
  return entry.kind === 'item' ? { itemId: entry.item.id } : {};
}
