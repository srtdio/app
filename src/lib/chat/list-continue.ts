// Numbered list continuation in the composer. Pure: the caller decides that a
// newline is about to be inserted (touch: Enter; laptop: Shift+Enter; never
// mid-IME or with the mention or hash picker open) and hands over the value and the
// selection; this says what the field becomes instead, or null to let the
// default newline through.
//
// - The caret line reads "N. text" or "N) text" (1 to 3 digits, then a space
//   and something): the newline carries the next marker, "\n{N+1}. " with the
//   same delimiter, and the caret lands after it.
// - The caret line is exactly "N. " or "N) " (an empty item): the marker is
//   removed and nothing is inserted, which ends the list.
// - Anything else (a paragraph, a line that only looks numbered mid-way): null.

/** The field after a list edit and where the caret goes. */
export interface ListEdit {
  value: string;
  caret: number;
}

const ITEM = /^(\d{1,3})([.)]) \S/;
const EMPTY_ITEM = /^\d{1,3}[.)] $/;

/** The list edit for a newline at the selection [start, end), or null. Pure. */
export function continueList(value: string, start: number, end: number = start): ListEdit | null {
  const from = Math.max(0, Math.min(start, end, value.length));
  const to = Math.max(from, Math.min(Math.max(start, end), value.length));
  const lineStart = value.lastIndexOf('\n', from - 1) + 1;
  const nextBreak = value.indexOf('\n', from);
  const lineEnd = nextBreak < 0 ? value.length : nextBreak;
  const line = value.slice(lineStart, lineEnd);
  if (from === to && EMPTY_ITEM.test(line)) {
    return { value: value.slice(0, lineStart) + value.slice(lineEnd), caret: lineStart };
  }
  const match = ITEM.exec(line);
  if (match === null) return null;
  const marker = `\n${Number(match[1]) + 1}${match[2] ?? '.'} `;
  return { value: value.slice(0, from) + marker + value.slice(to), caret: from + marker.length };
}

/**
 * Whether a composer keydown inserts a newline the list rule may take over:
 * Enter on touch, Shift+Enter on a laptop; never while composing (IME) or
 * while the mention picker is open. Pure.
 */
export function isListNewlineKeydown(input: {
  key: string;
  shiftKey: boolean;
  isComposing: boolean;
  coarsePointer: boolean;
  pickerOpen: boolean;
}): boolean {
  if (input.key !== 'Enter' || input.isComposing || input.pickerOpen) return false;
  return input.coarsePointer || input.shiftKey;
}

/** Whether a picker owns Enter: the mention picker has rows, or the hash picker is open. Pure. */
export function listPickerOpen(mentionRowCount: number, hashQuery: string | null): boolean {
  return mentionRowCount > 0 || hashQuery !== null;
}
