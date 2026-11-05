// WhatsApp-style text formatting for saved free text (chat messages, comments,
// brief fields, plan descriptions). Pure, framework-free, one pass per line.
//
//   *bold*  _italic_  ~strike~  +underline+  ```mono```
//
// Text is stored exactly as typed; display hides the markers and styles the
// words. Rules (WhatsApp):
//   * An opening marker sits at the start of the text or after whitespace or
//     punctuation, and the next character is not whitespace.
//   * A closing marker follows a non-whitespace character and is followed by the
//     end, whitespace or punctuation. So a marker is never mid-word
//     (snake_case_name, 2*3*4 stay plain).
//   * Same line only. Unclosed or empty markers stay literal.
//   * Styles nest (*_both_*). Inside ```mono``` everything is literal.
//   * Protected spans (http(s) urls and @[uuid] / @[all] mention tokens): a
//     marker never opens or closes inside one. A styled span may contain one.
//     A closing marker right after a url is not part of the url.

export type FormatStyle = 'bold' | 'italic' | 'strike' | 'underline' | 'mono';

/** One styled run of display text (markers removed). `styles` is outer to inner. */
export interface FormatSegment {
  text: string;
  styles: readonly FormatStyle[];
}

/** One run of the raw text, markers included (the composer's live mirror). */
export interface FormatRun {
  kind: 'text' | 'marker';
  text: string;
  styles: readonly FormatStyle[];
}

/** Single-character markers and the style each draws. */
export const FORMAT_MARKERS: Readonly<Record<string, Exclude<FormatStyle, 'mono'>>> = {
  '*': 'bold',
  _: 'italic',
  '~': 'strike',
  '+': 'underline',
};

/** The marker typed for each style (mono is three backticks). */
export const STYLE_MARKER: Readonly<Record<FormatStyle, string>> = {
  bold: '*',
  italic: '_',
  strike: '~',
  underline: '+',
  mono: '```',
};

const MONO = '```';
// Same url rule as src/lib/chat/message-links.ts tokenize (copied, packages
// never import from src): http(s) up to whitespace or '<', trailing sentence
// punctuation trimmed.
const URL_AT = /https?:\/\/[^\s<]+/iy;
const URL_TRAILING = /[.,;:!?)\]}'"]+$/;
const MENTION_AT =
  /@\[(?:all|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\]/iy;
const PUNCT = /^[\p{P}\p{S}]$/u;
const SPACE = /^\s$/u;

function isMarkerChar(ch: string): boolean {
  return ch === '*' || ch === '_' || ch === '~' || ch === '+';
}

/** The code point ending just before index i (surrogate-pair aware), or ''. */
function charBefore(s: string, i: number): string {
  if (i <= 0) return '';
  const lo = s.charCodeAt(i - 1);
  if (lo >= 0xdc00 && lo <= 0xdfff && i >= 2) {
    const hi = s.charCodeAt(i - 2);
    if (hi >= 0xd800 && hi <= 0xdbff) return s.slice(i - 2, i);
  }
  return s[i - 1] ?? '';
}

/** The code point starting at index i, or ''. */
function charAt(s: string, i: number): string {
  if (i >= s.length) return '';
  const cp = s.codePointAt(i);
  return cp === undefined ? '' : String.fromCodePoint(cp);
}

/** Opening marker of length `len` at i: start/space/punct before, non-space after. */
function canOpen(s: string, i: number, len: number): boolean {
  const before = charBefore(s, i);
  if (before !== '' && !SPACE.test(before) && !PUNCT.test(before)) return false;
  const after = charAt(s, i + len);
  return after !== '' && !SPACE.test(after);
}

/** Closing marker of length `len` at i: non-space before, end/space/punct after. */
function canClose(s: string, i: number, len: number): boolean {
  const before = charBefore(s, i);
  if (before === '' || SPACE.test(before)) return false;
  const after = charAt(s, i + len);
  return after === '' || SPACE.test(after) || PUNCT.test(after);
}

/**
 * The url starting at `start` in `line` (sticky), with trailing sentence
 * punctuation trimmed and, when `isOpen(ch)` says that marker is open, trailing
 * closing markers trimmed too. Returns its length, or 0 when no url starts here.
 */
function urlLengthAt(line: string, start: number, isOpen: (ch: string) => boolean): number {
  URL_AT.lastIndex = start;
  const m = URL_AT.exec(line);
  if (m === null) return 0;
  let url = m[0];
  for (;;) {
    const trail = url.match(URL_TRAILING);
    if (trail !== null) url = url.slice(0, url.length - trail[0].length);
    const last = url[url.length - 1] ?? '';
    if (isMarkerChar(last) && isOpen(last)) {
      url = url.slice(0, -1);
      continue;
    }
    if (trail === null) break;
  }
  return /^https?:\/\/./i.test(url) ? url.length : 0;
}

interface Pair {
  open: number;
  close: number;
  len: number;
  style: FormatStyle;
}

/** The matched marker pairs on one line, properly nested. */
function pairsForLine(line: string): Pair[] {
  const pairs: Pair[] = [];
  const stack: { ch: string; at: number }[] = [];
  const isOpen = (ch: string): boolean => stack.some((e) => e.ch === ch);
  let i = 0;
  const n = line.length;
  while (i < n) {
    const ch = line[i] ?? '';
    // Protected spans: skip urls and mention tokens whole.
    if (ch === 'h' || ch === 'H') {
      const len = urlLengthAt(line, i, isOpen);
      if (len > 0) {
        i += len;
        continue;
      }
    } else if (ch === '@') {
      MENTION_AT.lastIndex = i;
      const m = MENTION_AT.exec(line);
      if (m !== null) {
        i += m[0].length;
        continue;
      }
    } else if (ch === '`' && line.startsWith(MONO, i) && canOpen(line, i, 3)) {
      // Mono: the nearest valid closing ``` on the line; the inside is literal.
      let j = line.indexOf(MONO, i + 4);
      while (j !== -1 && !canClose(line, j, 3)) j = line.indexOf(MONO, j + 1);
      if (j !== -1) {
        pairs.push({ open: i, close: j, len: 3, style: 'mono' });
        i = j + 3;
        continue;
      }
      i += 3;
      continue;
    } else if (isMarkerChar(ch)) {
      let k = -1;
      if (canClose(line, i, 1)) {
        for (let s = stack.length - 1; s >= 0; s -= 1) {
          if (stack[s]?.ch === ch) {
            k = s;
            break;
          }
        }
      }
      const opener = k >= 0 ? stack[k] : undefined;
      if (opener !== undefined && i > opener.at + 1) {
        const style = FORMAT_MARKERS[ch];
        if (style !== undefined) pairs.push({ open: opener.at, close: i, len: 1, style });
        // Openers above the match never closed: they stay literal.
        stack.length = k;
      } else if (canOpen(line, i, 1)) {
        stack.push({ ch, at: i });
      }
    }
    i += 1;
  }
  return pairs;
}

function pushRun(runs: FormatRun[], kind: FormatRun['kind'], text: string, styles: FormatStyle[]): void {
  if (text === '') return;
  const prev = runs[runs.length - 1];
  if (
    prev !== undefined &&
    prev.kind === kind &&
    prev.styles.length === styles.length &&
    prev.styles.every((s, idx) => s === styles[idx])
  ) {
    prev.text += text;
    return;
  }
  runs.push({ kind, text, styles: [...styles] });
}

function runsForLine(line: string, runs: FormatRun[]): void {
  const pairs = pairsForLine(line);
  if (pairs.length === 0) {
    pushRun(runs, 'text', line, []);
    return;
  }
  // Marker events by index: opens and closes.
  const events = new Map<number, { len: number; style: FormatStyle; open: boolean }>();
  for (const p of pairs) {
    events.set(p.open, { len: p.len, style: p.style, open: true });
    events.set(p.close, { len: p.len, style: p.style, open: false });
  }
  const styles: FormatStyle[] = [];
  let textStart = 0;
  let i = 0;
  while (i < line.length) {
    const ev = events.get(i);
    if (ev === undefined) {
      i += 1;
      continue;
    }
    pushRun(runs, 'text', line.slice(textStart, i), styles);
    if (ev.open) {
      pushRun(runs, 'marker', line.slice(i, i + ev.len), styles);
      styles.push(ev.style);
    } else {
      styles.pop();
      pushRun(runs, 'marker', line.slice(i, i + ev.len), styles);
    }
    i += ev.len;
    textStart = i;
  }
  pushRun(runs, 'text', line.slice(textStart), styles);
}

/**
 * The raw text as runs, markers included and flagged, each with the styles in
 * force (a marker carries the styles around its pair). Joined, the runs give
 * back the input exactly. Pure.
 */
export function parseFormatRuns(body: string): FormatRun[] {
  const runs: FormatRun[] = [];
  const lines = body.split('\n');
  lines.forEach((line, idx) => {
    if (idx > 0) pushRun(runs, 'text', '\n', []);
    runsForLine(line, runs);
  });
  return runs;
}

const parseCache = new Map<string, FormatSegment[]>();
const PARSE_CACHE_MAX = 500;

/**
 * The body as styled display segments, markers removed. Adjacent runs with the
 * same styles merge. Memoised per body string (bubble and comment rows re-render
 * with the same body). Pure.
 */
export function parseFormat(body: string): readonly FormatSegment[] {
  const hit = parseCache.get(body);
  if (hit !== undefined) return hit;
  const out: FormatSegment[] = [];
  for (const run of parseFormatRuns(body)) {
    if (run.kind === 'marker') continue;
    const prev = out[out.length - 1];
    if (
      prev !== undefined &&
      prev.styles.length === run.styles.length &&
      prev.styles.every((s, idx) => s === run.styles[idx])
    ) {
      prev.text += run.text;
    } else {
      out.push({ text: run.text, styles: run.styles });
    }
  }
  if (parseCache.size >= PARSE_CACHE_MAX) parseCache.clear();
  parseCache.set(body, out);
  return out;
}

/** Whether a body has any formatting at all (fast path for renderers). */
export function hasFormat(body: string): boolean {
  const segs = parseFormat(body);
  return segs.some((s) => s.styles.length > 0);
}

/** The body as plain text with the markers removed (one-line previews, email). Pure. */
export function stripFormat(body: string): string {
  if (!/[*_~+`]/.test(body)) return body;
  return parseFormat(body)
    .map((s) => s.text)
    .join('');
}

/**
 * For src/lib/chat/message-links.ts tokenize: how many trailing characters of a
 * url found at `start` in `body` are closing markers (an opening marker of the
 * same character sits earlier on the same line). Those leave the url. Pure.
 */
export function closingMarkerTail(body: string, start: number, url: string): number {
  const lineStart = body.lastIndexOf('\n', start - 1) + 1;
  const prefix = body.slice(lineStart, start);
  let tail = 0;
  for (let k = url.length - 1; k > 0; k -= 1) {
    const ch = url[k] ?? '';
    if (!isMarkerChar(ch)) break;
    let opened = false;
    for (let p = prefix.indexOf(ch); p !== -1; p = prefix.indexOf(ch, p + 1)) {
      if (canOpen(prefix + 'x', p, 1)) {
        opened = true;
        break;
      }
    }
    if (!opened) break;
    tail += 1;
  }
  return tail;
}

/**
 * Toggle a style around [start, end) of `value` (the format strip and the
 * keyboard shortcuts). Words already wrapped in that marker are unwrapped.
 * Returns the replaced range, its new text and the new selection on the same
 * words. Pure.
 */
export function toggleFormat(
  value: string,
  start: number,
  end: number,
  style: FormatStyle,
): {
  mode: 'wrap' | 'unwrap';
  marker: string;
  from: number;
  to: number;
  insert: string;
  selStart: number;
  selEnd: number;
} {
  const marker = STYLE_MARKER[style];
  const m = marker.length;
  // Keep surrounding spaces out of the wrap (WhatsApp markers hug the words).
  let s = start;
  let e = end;
  while (s < e && /\s/.test(value[s] ?? '')) s += 1;
  while (e > s && /\s/.test(value[e - 1] ?? '')) e -= 1;
  const inner = value.slice(s, e);
  // Markers just outside the selection: unwrap.
  if (s - m >= 0 && value.slice(s - m, s) === marker && value.slice(e, e + m) === marker) {
    return { mode: 'unwrap', marker, from: s - m, to: e + m, insert: inner, selStart: s - m, selEnd: e - m };
  }
  // Markers inside the selection edges: unwrap.
  if (inner.length >= 2 * m + 1 && inner.startsWith(marker) && inner.endsWith(marker)) {
    const bare = inner.slice(m, inner.length - m);
    return { mode: 'unwrap', marker, from: s, to: e, insert: bare, selStart: s, selEnd: s + bare.length };
  }
  return {
    mode: 'wrap',
    marker,
    from: s,
    to: e,
    insert: `${marker}${inner}${marker}`,
    selStart: s + m,
    selEnd: e + m,
  };
}
