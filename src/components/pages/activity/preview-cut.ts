// Activity previews (locked 9 Nov 2026, Instagram route): line 2 of a row
// shows up to 2 lines of the newest entry's text. Longer text is cut at the
// last WHOLE word that fits 2 lines with a muted "… more" after it; never
// mid-word, never CSS line-clamp or text-overflow. Pure: the caller hands the
// width and a text measure (canvas, the preview's own font).

/** The marker after a cut: one ellipsis glyph, then " more". */
export const PREVIEW_MORE = '… more';
/** The marker on an unfolded row. */
export const PREVIEW_LESS = ' less';

export interface PreviewCut {
  /** The text to show (the whole text, or the cut text without the marker). */
  text: string;
  /** The text was cut: "… more" follows it. */
  cut: boolean;
  /** Lines the shown text (with its marker) takes: 1 or 2. */
  lines: 1 | 2;
}

/**
 * Greedy word wrap: how many lines `words` take in `width`. A word wider than
 * the line (a long link) breaks across lines (the preview wraps with
 * break-words), so it takes as many lines as its width needs.
 */
function lineCount(
  words: readonly string[],
  width: number,
  measure: (s: string) => number,
): number {
  let lines = 0;
  let line = '';
  for (const word of words) {
    const next = line === '' ? word : `${line} ${word}`;
    if (line !== '' && measure(next) > width) {
      lines += 1;
      line = word;
    } else line = next;
    while (measure(line) > width) {
      // The overflowing long word: whole lines of it, the rest carries on.
      let fit = 1;
      while (fit < line.length && measure(line.slice(0, fit + 1)) <= width) fit += 1;
      lines += 1;
      line = line.slice(fit);
    }
  }
  return line === '' ? lines : lines + 1;
}

/** Trailing space and punctuation off a cut (before the ellipsis). */
export function stripCutEnd(text: string): string {
  return text.replace(/[\s.,;:!?…\-–—'"“”‘’()]+$/u, '');
}

/**
 * Cut `text` to 2 lines of `width` at a whole word, leaving room for "… more"
 * on the second line. Text that fits 2 lines shows whole (no marker), so a
 * marker never hides a word or two the lines could hold. Pure.
 */
export function cutPreview(
  text: string,
  width: number,
  measure: (s: string) => number,
): PreviewCut {
  const clean = text.replace(/\s+/g, ' ').trim();
  const words = clean === '' ? [] : clean.split(' ');
  if (width <= 0 || words.length === 0) return { text: clean, cut: false, lines: 1 };
  const whole = lineCount(words, width, measure);
  if (whole <= 2) return { text: clean, cut: false, lines: whole <= 1 ? 1 : 2 };
  // The most words that still fit 2 lines with the marker after them.
  for (let k = words.length - 1; k > 0; k -= 1) {
    const kept = stripCutEnd(words.slice(0, k).join(' '));
    if (kept === '') continue;
    const withMarker = `${kept}${PREVIEW_MORE}`.split(' ');
    if (lineCount(withMarker, width, measure) <= 2) return { text: kept, cut: true, lines: 2 };
  }
  // The first word alone is longer than 2 lines (a long link): cut that one
  // token by characters, the only cut a single unbroken token allows.
  const first = words[0] ?? '';
  let n = first.length - 1;
  while (n > 1 && lineCount([`${first.slice(0, n)}${PREVIEW_MORE}`], width, measure) > 2) n -= 1;
  return { text: first.slice(0, n), cut: true, lines: 2 };
}
