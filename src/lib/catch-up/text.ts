// Catch-up text hygiene (messages, comments, captions, briefs, notes): fold 3+
// newlines to one blank line and trim; links found, tappable and shown short
// (host without www + "/…/" + the last path part, at most 18 characters then
// "…"); the >6 line clamp; day lines between rows of different days; the fill
// rule (open at the "New" line when what follows it is taller than the body,
// else at the bottom). Pure.

/** Lines a body shows before it clamps with "more". */
export const CLAMP_LINES = 6;

/** Most characters of a link's last path part before it ends in "…". */
export const LINK_TAIL_MAX = 18;

/** Fold 3+ newlines (with blank space between) to one blank line, trim the ends. Pure. */
export function foldNewlines(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** A link as shown: host without www, then "/…/" and the last path part (18 + "…"). Pure. */
export function shortLink(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url.length > LINK_TAIL_MAX ? `${url.slice(0, LINK_TAIL_MAX)}…` : url;
  }
  const host = parsed.hostname.replace(/^www\./, '');
  const parts = parsed.pathname.split('/').filter((p) => p !== '');
  const last = parts[parts.length - 1];
  if (last === undefined) return host;
  const tail = last.length > LINK_TAIL_MAX ? `${last.slice(0, LINK_TAIL_MAX)}…` : last;
  return parts.length > 1 ? `${host}/…/${tail}` : `${host}/${tail}`;
}

/** One run of a text: plain words or a link. */
export type TextRun = { kind: 'text'; text: string } | { kind: 'link'; href: string; label: string };

const LINK_RE = /\bhttps?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/gi;

/** A text split into plain runs and links (http/https only). Pure. */
export function linkRuns(text: string): TextRun[] {
  const out: TextRun[] = [];
  let at = 0;
  for (const match of text.matchAll(LINK_RE)) {
    const start = match.index ?? 0;
    if (start > at) out.push({ kind: 'text', text: text.slice(at, start) });
    out.push({ kind: 'link', href: match[0], label: shortLink(match[0]) });
    at = start + match[0].length;
  }
  if (at < text.length) out.push({ kind: 'text', text: text.slice(at) });
  return out;
}

/** Whether a text is longer than the clamp by line count alone (a cheap first pass). Pure. */
export function overClampLines(text: string, lines = CLAMP_LINES): boolean {
  return text.split('\n').length > lines;
}

/** The local day key (YYYY-MM-DD) of a time in `timeZone`. Pure. */
export function dayKey(at: string, timeZone?: string): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/**
 * Where day lines go: the indexes of rows that start a new day, only when the
 * rows span more than one day (never before the first row of a one-day card). Pure.
 */
export function dayBreaks(rows: ReadonlyArray<{ createdAt: string }>, timeZone?: string): Set<number> {
  const keys = rows.map((r) => dayKey(r.createdAt, timeZone));
  const distinct = new Set(keys.filter((k) => k !== ''));
  const out = new Set<number>();
  if (distinct.size <= 1) return out;
  keys.forEach((key, i) => {
    if (i === 0 || key !== keys[i - 1]) out.add(i);
  });
  return out;
}

/**
 * The fill rule's scroll position: at the "New" line (`newTop`, px from the
 * content top) when what follows it is taller than the body, else at the
 * bottom so earlier rows fill the space above. No "New" line: the bottom. Pure.
 */
export function fillScrollTop(input: {
  newTop: number | null;
  contentHeight: number;
  bodyHeight: number;
}): number {
  const bottom = Math.max(0, input.contentHeight - input.bodyHeight);
  if (input.newTop === null) return bottom;
  const after = input.contentHeight - input.newTop;
  return after > input.bodyHeight ? Math.min(bottom, Math.max(0, input.newTop)) : bottom;
}

/** "m:ss" for a recording's length in seconds. Pure. */
export function clockLength(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
