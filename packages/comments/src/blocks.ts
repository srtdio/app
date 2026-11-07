// Slack-style block formatting for saved free text: lists and quotes, stored
// as plain text line prefixes, plus [text](url) links and the composer edits
// that write them. Pure, framework-free, one pass per body, memoised.
//
//   1. numbered   (a line "N. " with N of 1..9 digits; the list starts at the first N)
//   - bullet      (a line "- ", shown as "•")
//   > quote       (a line "> ", or a bare ">")
//
// Consecutive lines of one kind form one block; anything else is a paragraph
// (its lines keep their breaks). Inline styles, mentions and links work inside
// every block; ``` mono stays literal.

import { MD_LINK_AT, parseFormatRuns, type FormatStyle } from './format';

export type BlockKind = 'ol' | 'ul' | 'quote';

export type Block =
  | { kind: 'para'; text: string }
  | { kind: 'ol'; start: number; items: string[] }
  | { kind: 'ul'; items: string[] }
  | { kind: 'quote'; text: string };

const OL_LINE = /^(\d{1,9})\. /;

/** The block kind a line belongs to, with the prefix length, or null. Pure. */
export function linePrefix(line: string): { kind: BlockKind; len: number; n?: number } | null {
  const ol = OL_LINE.exec(line);
  if (ol !== null && ol[1] !== undefined) {
    return { kind: 'ol', len: ol[0].length, n: Number(ol[1]) };
  }
  if (line.startsWith('- ')) return { kind: 'ul', len: 2 };
  if (line.startsWith('> ')) return { kind: 'quote', len: 2 };
  if (line === '>') return { kind: 'quote', len: 1 };
  return null;
}

/** Fast check: does any line carry a block prefix. Pure. */
export function hasBlocks(body: string): boolean {
  return /(^|\n)(?:\d{1,9}\. |- |>)/.test(body);
}

const blockCache = new Map<string, Block[]>();
const BLOCK_CACHE_MAX = 500;

/** The body as blocks, in order. Memoised per body. Pure. */
export function parseBlocks(body: string): readonly Block[] {
  const hit = blockCache.get(body);
  if (hit !== undefined) return hit;
  const out: Block[] = [];
  const lines = body.split('\n');
  let para: string[] | null = null;
  const flushPara = (): void => {
    if (para !== null) out.push({ kind: 'para', text: para.join('\n') });
    para = null;
  };
  for (const line of lines) {
    const p = linePrefix(line);
    const last = out[out.length - 1];
    if (p === null) {
      if (para === null) para = [];
      para.push(line);
      continue;
    }
    const rest = line.slice(p.len);
    if (p.kind === 'ol') {
      if (para === null && last?.kind === 'ol') last.items.push(rest);
      else {
        flushPara();
        out.push({ kind: 'ol', start: p.n ?? 1, items: [rest] });
      }
    } else if (p.kind === 'ul') {
      if (para === null && last?.kind === 'ul') last.items.push(rest);
      else {
        flushPara();
        out.push({ kind: 'ul', items: [rest] });
      }
    } else if (para === null && last?.kind === 'quote') {
      last.text += `\n${rest}`;
    } else {
      flushPara();
      out.push({ kind: 'quote', text: rest });
    }
  }
  flushPara();
  if (blockCache.size >= BLOCK_CACHE_MAX) blockCache.clear();
  blockCache.set(body, out);
  return out;
}

/** One [text](url) or bare text run inside a line. Pure. */
export type LinkSegment = { kind: 'text'; text: string } | { kind: 'link'; text: string; url: string };

/** Split text into [text](url) links and the text between. Pure, linear. */
export function splitLinks(text: string): LinkSegment[] {
  if (!text.includes('](')) return [{ kind: 'text', text }];
  const out: LinkSegment[] = [];
  let last = 0;
  for (let i = text.indexOf('['); i !== -1; i = text.indexOf('[', i + 1)) {
    MD_LINK_AT.lastIndex = i;
    const m = MD_LINK_AT.exec(text);
    if (m === null || m[1] === undefined || m[2] === undefined) continue;
    if (i > last) out.push({ kind: 'text', text: text.slice(last, i) });
    out.push({ kind: 'link', text: m[1], url: m[2] });
    last = i + m[0].length;
    i = last - 1;
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) });
  return out;
}

/**
 * The link url a person typed into "Add link": http(s) kept, a bare domain
 * gets https://, anything else (other schemes, spaces) is null. Pure.
 */
export function normalizeLinkUrl(raw: string): string | null {
  const v = raw.trim();
  if (v === '' || /\s/.test(v)) return null;
  const safe = v.replace(/\)/g, '%29');
  if (/^https?:\/\/[^/?#]+/i.test(v)) return safe;
  // Another scheme (mailto:, javascript:, ftp:) is refused; host:port is not a scheme.
  if (/^[a-z][a-z0-9+.-]*:/i.test(v) && !/^[^:/]+:\d/.test(v)) return null;
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d{1,5})?([/?#]\S*)?$/i.test(v)) return `https://${safe}`;
  return null;
}

/** The stored form of a link: [text](url); text falls back to the url. Pure. */
export function linkMarkup(text: string, url: string): string {
  const label = text.replace(/[\]\n]/g, ' ').trim();
  return `[${label === '' ? url.replace(/^https?:\/\//i, '') : label}](${url})`;
}

/** A splice: replace [from, to) with insert, then select [selStart, selEnd). */
export interface TextEdit {
  from: number;
  to: number;
  insert: string;
  selStart: number;
  selEnd: number;
}

function lineStartOf(value: string, i: number): number {
  return value.lastIndexOf('\n', i - 1) + 1;
}

function lineEndOf(value: string, i: number): number {
  const n = value.indexOf('\n', i);
  return n === -1 ? value.length : n;
}

/**
 * Toggle a list or quote prefix on every line touched by [start, end). When
 * every touched line already has that kind, the prefixes come off; otherwise
 * each line gets it (replacing another kind; numbered lines count 1, 2, 3).
 * Returns one splice over the whole lines, so it is a single Undo step. Pure.
 */
export function toggleBlock(value: string, start: number, end: number, kind: BlockKind): TextEdit {
  const from = lineStartOf(value, start);
  // A selection ending at a line start does not touch that line.
  const endAt = end > start && value[end - 1] === '\n' ? end - 1 : end;
  const to = lineEndOf(value, Math.max(endAt, from));
  const lines = value.slice(from, to).split('\n');
  const all = lines.every((l) => linePrefix(l)?.kind === kind);
  let delta0 = 0;
  let deltaEnd = 0;
  const outLines = lines.map((line, idx) => {
    const p = linePrefix(line);
    const bare = p !== null ? line.slice(p.len) : line;
    const next = all ? bare : `${kind === 'ol' ? `${idx + 1}. ` : kind === 'ul' ? '- ' : '> '}${bare}`;
    const d = next.length - line.length;
    if (idx === 0) delta0 = d;
    deltaEnd += d;
    return next;
  });
  const insert = outLines.join('\n');
  const firstPrefixOld = linePrefix(lines[0] ?? '')?.len ?? 0;
  const clamp = (v: number): number => Math.max(from, v);
  if (start === end) {
    // Caret: keep it on the same word.
    const offsetInLine = start - from;
    const caret =
      offsetInLine <= firstPrefixOld
        ? from + (outLines[0]?.length ?? 0) - (lines[0]?.length ?? 0) + firstPrefixOld
        : start + delta0;
    const c = clamp(Math.min(caret, from + insert.length));
    return { from, to, insert, selStart: c, selEnd: c };
  }
  return {
    from,
    to,
    insert,
    selStart: clamp(start + delta0),
    selEnd: clamp(Math.min(end + deltaEnd, from + insert.length)),
  };
}

/**
 * Return pressed with the caret at `caret` (no selection): in a list item
 * with text, the next item's prefix; on an empty item, the list ends (the
 * prefix is removed). Quote lines continue "> " the same way. Null means a
 * plain line break (the caller lets the key through). Pure.
 */
export function continueBlock(value: string, caret: number): TextEdit | null {
  const from = lineStartOf(value, caret);
  const line = value.slice(from, lineEndOf(value, caret));
  const p = linePrefix(line);
  if (p === null || caret - from < p.len) return null;
  const bare = line.slice(p.len);
  if (bare.trim() === '') {
    return { from, to: from + line.length, insert: '', selStart: from, selEnd: from };
  }
  const prefix = p.kind === 'ol' ? `${(p.n ?? 0) + 1}. ` : p.kind === 'ul' ? '- ' : '> ';
  const insert = `\n${prefix}`;
  return { from: caret, to: caret, insert, selStart: caret + insert.length, selEnd: caret + insert.length };
}

/** The block kind of the line the caret sits on, or null. Pure. */
export function blockAt(value: string, caret: number): BlockKind | null {
  const from = lineStartOf(value, caret);
  return linePrefix(value.slice(from, lineEndOf(value, caret)))?.kind ?? null;
}

/**
 * The inline styles in force at the caret or across the selection (the Aa
 * row's "on" state), plus 'link' when inside a [text](url). Pure.
 */
export function stylesAt(value: string, start: number, end: number): Set<FormatStyle | 'link'> {
  const on = new Set<FormatStyle | 'link'>();
  let at = 0;
  for (const run of parseFormatRuns(value)) {
    const runEnd = at + run.text.length;
    const inside = start === end ? start > at && start <= runEnd : start < runEnd && end > at;
    if (inside && run.kind === 'text') run.styles.forEach((s) => on.add(s));
    at = runEnd;
    if (at > end) break;
  }
  const from = lineStartOf(value, start);
  for (const seg of splitLinksWithOffsets(value.slice(from, lineEndOf(value, start)), from)) {
    if (start >= seg.from && start <= seg.to) on.add('link');
  }
  return on;
}

function splitLinksWithOffsets(line: string, base: number): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  for (let i = line.indexOf('['); i !== -1; i = line.indexOf('[', i + 1)) {
    MD_LINK_AT.lastIndex = i;
    const m = MD_LINK_AT.exec(line);
    if (m === null) continue;
    out.push({ from: base + i + 1, to: base + i + m[0].length - 1 });
    i += m[0].length - 1;
  }
  return out;
}
