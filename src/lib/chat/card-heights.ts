// The outer height each shared post card painted at, this tab session, by chat
// layout and post id: size only, never data (each open still reads its own
// cards). A card's loading placeholder reserves this height when it is known,
// so a card with a cover image or a two-line title fills in place on a reopen
// and never moves a row. Unknown: the placeholder is built as the plain card
// (no media, one title line, footer), the common card's exact box. Cleared
// with the chat memory (open-cache.ts: sign-out, account or workspace switch).

const heights = new Map<string, number>();

function heightKey(layout: string, postId: string): string {
  return `${layout}\n${postId}`;
}

/** Note a post card's painted outer height (px, whole) in this layout. */
export function noteCardHeight(layout: string, postId: string, px: number): void {
  if (px > 0) heights.set(heightKey(layout, postId), Math.round(px));
}

/** The height this post card last painted at in this layout, or undefined. */
export function knownCardHeight(layout: string, postId: string): number | undefined {
  return heights.get(heightKey(layout, postId));
}

/** Forget every height (the chat memory was cleared; tests). */
export function clearCardHeights(): void {
  heights.clear();
}
