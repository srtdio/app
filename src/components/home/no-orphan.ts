// Homepage and /demo line breaks (13 Nov 2026): no word sits alone on the last
// line of a heading or paragraph at any screen width. The last two words are
// joined with a no-break space in the copy itself, so the server render and the
// browser agree (no layout script). The hero headline is the one exception:
// "WhatsApp." alone on its line is deliberate.

export const NBSP = ' ';

/** `text` with its last two words joined by a no-break space. Pure. */
export function keepLastWords(text: string): string {
  return text.replace(/\s+(\S+)\s*$/u, `${NBSP}$1`);
}
