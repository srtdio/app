// The chat send rule, shared by the chat Composer and the Plan item screen's
// comment box: plain Enter sends on a fine pointer; Shift+Enter, Enter during
// IME composition, and every Enter on a coarse (touch) pointer make a newline.

/**
 * Whether a composer keydown should send rather than insert a newline: plain
 * Enter only. Shift+Enter (newline) and Enter mid-IME-composition are excluded,
 * and a coarse (touch-primary) pointer never sends on Enter so phones and
 * touch-only tablets keep the newline and tap Send instead.
 */
export function isSendKeydown(input: {
  key: string;
  shiftKey: boolean;
  isComposing: boolean;
  coarsePointer: boolean;
}): boolean {
  return input.key === 'Enter' && !input.shiftKey && !input.isComposing && !input.coarsePointer;
}
