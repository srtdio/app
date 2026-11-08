// WYSIWYG formatting in a writing box (ui/Textarea, comments/MentionInput),
// pure and framework-free.
//
// Saved text keeps the WhatsApp marker format (*bold* _italic_ ~strike~
// +underline+ ```mono```, @srtdio/comments parseFormat, unchanged). While a
// person types, the box holds the same text with every PAIRED marker swapped
// for an invisible, zero-width code point of the same length (one UTF-16 unit
// each), so a marker never shows and the caret, the selection, maxLength and
// every offset stay exactly the text's own:
//
//   *  U+2061   _  U+2062   ~  U+2063   +  U+2064   `  U+2060
//
// decodeMarkers gives the saved text back (the box's value); encodeMarkers is
// the box's text for a saved value. Two rules keep it honest:
//   * a marker that forms a pair hides (typing the closing "*" of "*ship*"
//     hides both stars, Slack style);
//   * a hidden marker whose pair breaks goes away (never shows as a star).
// An unpaired star a person typed ("2*3", or the start of "*ship") stays a
// plain, visible character.
//
// Text typed right beside hidden markers lands on whichever side keeps every
// pair (a letter after a bold word stays bold, a space after it does not):
// liveEdit. Only ever runs on an edit, never on paint.

import { parseFormatRuns, STYLE_MARKER, type FormatStyle } from '@srtdio/comments';

/** The hidden code point for each marker character. */
export const HIDDEN_MARKER: Readonly<Record<string, string>> = {
  '*': '\u2061',
  _: '\u2062',
  '~': '\u2063',
  '+': '\u2064',
  '`': '\u2060',
};

const SHOWN_MARKER: Readonly<Record<string, string>> = {
  '\u2061': '*',
  '\u2062': '_',
  '\u2063': '~',
  '\u2064': '+',
  '\u2060': '`',
};

const HIDDEN_ANY = /[\u2060-\u2064]/;
const HIDDEN_ALL = /[\u2060-\u2064]/g;

/** Whether `ch` is a hidden marker. Pure. */
export function isHiddenMarker(ch: string | undefined): boolean {
  return ch !== undefined && ch.length === 1 && SHOWN_MARKER[ch] !== undefined;
}

/** The saved text for a box's text: hidden markers back to their characters. Pure. */
export function decodeMarkers(text: string): string {
  if (!HIDDEN_ANY.test(text)) return text;
  return text.replace(HIDDEN_ALL, (ch) => SHOWN_MARKER[ch] ?? ch);
}

/** The text without its hidden markers (what a reader sees). Pure. */
export function stripHiddenMarkers(text: string): string {
  return HIDDEN_ANY.test(text) ? text.replace(HIDDEN_ALL, '') : text;
}

/** Per index of `decoded`: 1 where a marker of a formed pair sits. Pure. */
function markerMask(decoded: string): Uint8Array {
  const mask = new Uint8Array(decoded.length);
  let at = 0;
  for (const run of parseFormatRuns(decoded)) {
    if (run.kind === 'marker') mask.fill(1, at, at + run.text.length);
    at += run.text.length;
  }
  return mask;
}

/** A box's text for a saved value: every paired marker hidden. Same length. Pure. */
export function encodeMarkers(decoded: string): string {
  if (!/[*_~+`]/.test(decoded)) return decoded;
  const mask = markerMask(decoded);
  let out = '';
  for (let i = 0; i < decoded.length; i += 1) {
    const ch = decoded[i] ?? '';
    out += mask[i] === 1 ? (HIDDEN_MARKER[ch] ?? ch) : ch;
  }
  return out;
}

/** How many marker characters form pairs in a saved text (a pair counts its markers). Pure. */
export function pairedMarkerCount(decoded: string): number {
  let n = 0;
  for (const run of parseFormatRuns(decoded)) if (run.kind === 'marker') n += 1;
  return n;
}

export interface LiveText {
  text: string;
  start: number;
  end: number;
}

/**
 * Bring a box's text back to the rule: paired markers hidden, hidden markers
 * with no pair dropped (the selection follows every drop). Settles in a few
 * passes (a drop can change what pairs). Pure.
 */
export function normalizeLive(text: string, start: number, end: number): LiveText {
  let t = text;
  let s = start;
  let e = end;
  for (let pass = 0; pass < 4; pass += 1) {
    const decoded = decodeMarkers(t);
    if (!/[*_~+`]/.test(decoded)) break;
    const mask = markerMask(decoded);
    let out = '';
    let changed = false;
    let ns = s;
    let ne = e;
    for (let i = 0; i < t.length; i += 1) {
      const ch = t[i] ?? '';
      if (mask[i] === 1) {
        const hidden = HIDDEN_MARKER[decoded[i] ?? ''] ?? ch;
        if (hidden !== ch) changed = true;
        out += hidden;
      } else if (isHiddenMarker(ch)) {
        // A hidden marker whose pair broke: it goes, never shows.
        changed = true;
        if (i < s) ns -= 1;
        if (i < e) ne -= 1;
      } else {
        out += ch;
      }
    }
    t = out;
    s = ns;
    e = ne;
    if (!changed) break;
  }
  return { text: t, start: s, end: e };
}

/** Canonical opening order for several styles at once (mono innermost). */
const STYLE_ORDER: readonly FormatStyle[] = ['bold', 'italic', 'underline', 'strike', 'mono'];

/** The marker text that opens and closes `styles` around a run. Pure. */
export function wrapMarkers(styles: readonly FormatStyle[]): { open: string; close: string } {
  const ordered = STYLE_ORDER.filter((s) => styles.includes(s));
  const open = ordered.map((s) => STYLE_MARKER[s]).join('');
  const close = [...ordered]
    .reverse()
    .map((s) => STYLE_MARKER[s])
    .join('');
  return { open, close };
}

/**
 * One edit in a box, settled: `prev` is the text before the edit, `next` the
 * text the browser left, `sel` its selection. Text typed beside hidden
 * markers moves to the side that keeps every pair (ties stay where typed);
 * `pending` styles (a format key pressed with no selection) wrap the typed
 * text once it starts with a non-space. Then normalizeLive. Pure.
 */
export function liveEdit(
  prev: string,
  next: string,
  sel: { start: number; end: number },
  pending: readonly FormatStyle[] = [],
): LiveText & { usedPending: boolean } {
  let a = 0;
  const maxA = Math.min(prev.length, next.length);
  while (a < maxA && prev[a] === next[a]) a += 1;
  let b = 0;
  while (
    b < prev.length - a &&
    b < next.length - a &&
    prev[prev.length - 1 - b] === next[next.length - 1 - b]
  ) {
    b += 1;
  }
  const removed = prev.slice(a, prev.length - b);
  const inserted = next.slice(a, next.length - b);
  let text = next;
  let start = sel.start;
  let end = sel.end;
  let usedPending = false;
  if (removed === '' && inserted !== '' && !HIDDEN_ANY.test(inserted)) {
    let lo = a;
    while (lo > 0 && isHiddenMarker(prev[lo - 1])) lo -= 1;
    let hi = a;
    while (hi < prev.length && isHiddenMarker(prev[hi])) hi += 1;
    let insert = inserted;
    let caretIn = inserted.length;
    if (pending.length > 0 && /^\S/.test(inserted)) {
      const w = wrapMarkers(pending);
      insert = `${w.open}${inserted}${w.close}`;
      caretIn = w.open.length + inserted.length;
      usedPending = true;
    }
    if (lo !== hi || usedPending) {
      const base = decodeMarkers(prev);
      let best = a;
      let bestScore = -1;
      for (let c = lo; c <= hi; c += 1) {
        const score = pairedMarkerCount(base.slice(0, c) + insert + base.slice(c));
        if (score > bestScore || (score === bestScore && c === a)) {
          best = c;
          bestScore = score;
        }
      }
      text = prev.slice(0, best) + insert + prev.slice(best);
      start = best + caretIn;
      end = start;
    }
  }
  return { ...normalizeLive(text, start, end), usedPending };
}

/** Intl.Segmenter where the engine has it (every current browser). */
interface GraphemeSegmenter {
  segment(input: string): Iterable<{ index: number; segment: string }>;
}
function segmenter(): GraphemeSegmenter | null {
  const Ctor = (
    Intl as unknown as {
      Segmenter?: new (locale?: string, opts?: { granularity: 'grapheme' }) => GraphemeSegmenter;
    }
  ).Segmenter;
  return Ctor === undefined ? null : new Ctor(undefined, { granularity: 'grapheme' });
}

/** The grapheme boundary before `pos` (or 0). Pure. */
export function prevGraphemeStart(text: string, pos: number): number {
  if (pos <= 0) return 0;
  const seg = segmenter();
  if (seg !== null) {
    let last = 0;
    for (const s of seg.segment(text.slice(0, pos))) last = s.index;
    return last;
  }
  const lo = text.charCodeAt(pos - 1);
  if (lo >= 0xdc00 && lo <= 0xdfff && pos >= 2) {
    const hi = text.charCodeAt(pos - 2);
    if (hi >= 0xd800 && hi <= 0xdbff) return pos - 2;
  }
  return pos - 1;
}

/** The grapheme boundary after `pos` (or the end). Pure. */
export function nextGraphemeEnd(text: string, pos: number): number {
  if (pos >= text.length) return text.length;
  const seg = segmenter();
  if (seg !== null) {
    for (const s of seg.segment(text.slice(pos))) return pos + s.segment.length;
    return text.length;
  }
  const cp = text.codePointAt(pos);
  return pos + (cp !== undefined && cp > 0xffff ? 2 : 1);
}

/**
 * An arrow key beside hidden markers: past every hidden marker in that
 * direction, then one visible character (a caret never stops on nothing).
 * Pure.
 */
export function stepOverHidden(text: string, pos: number, dir: -1 | 1): number {
  let p = pos;
  if (dir < 0) {
    while (p > 0 && isHiddenMarker(text[p - 1])) p -= 1;
    return prevGraphemeStart(text, p);
  }
  while (p < text.length && isHiddenMarker(text[p])) p += 1;
  return nextGraphemeEnd(text, p);
}

/**
 * Backspace (dir -1) or Delete (dir 1) at a collapsed caret beside hidden
 * markers: the visible character past them, never the marker itself. Null
 * when no hidden marker is beside the caret (the browser's own delete runs).
 * Pure.
 */
export function deleteBesideHidden(
  text: string,
  pos: number,
  dir: -1 | 1,
): { from: number; to: number } | null {
  if (dir < 0) {
    if (!isHiddenMarker(text[pos - 1])) return null;
    let p = pos;
    while (p > 0 && isHiddenMarker(text[p - 1])) p -= 1;
    if (p === 0) return null;
    return { from: prevGraphemeStart(text, p), to: p };
  }
  if (!isHiddenMarker(text[pos])) return null;
  let p = pos;
  while (p < text.length && isHiddenMarker(text[p])) p += 1;
  if (p === text.length) return null;
  return { from: p, to: nextGraphemeEnd(text, p) };
}

/** One styled run of a box's text: the characters as held (hidden markers included). */
export interface LiveSegment {
  text: string;
  styles: readonly FormatStyle[];
  /** A run of hidden markers (zero width, never styled). */
  marker: boolean;
}

/**
 * A box's text as runs for drawing it: the styles from the saved text's
 * pairs, the characters as the box holds them (same length, so the runs line
 * up with every offset). Pure.
 */
export function liveSegments(text: string): LiveSegment[] {
  const decoded = decodeMarkers(text);
  const out: LiveSegment[] = [];
  let at = 0;
  for (const run of parseFormatRuns(decoded)) {
    const len = run.text.length;
    out.push({ text: text.slice(at, at + len), styles: run.styles, marker: run.kind === 'marker' });
    at += len;
  }
  return out;
}

/**
 * A box that formats live registers here (ui/Textarea, comments/MentionInput)
 * so ui/format-actions edits it through the same rules: replace a range of
 * the saved text (offsets are the box's own), and the styles a format key
 * pressed with no selection holds for the next typed text.
 */
export interface LiveFieldApi {
  replace: (from: number, to: number, insert: string, selStart: number, selEnd: number) => void;
  pending: () => readonly FormatStyle[];
  togglePending: (style: FormatStyle) => void;
}

const liveFields = new WeakMap<object, LiveFieldApi>();

/** Register a live box; returns the unregister. */
export function registerLiveField(el: object, api: LiveFieldApi): () => void {
  liveFields.set(el, api);
  return () => {
    if (liveFields.get(el) === api) liveFields.delete(el);
  };
}

/** The live box registered for `el`, if any. */
export function liveFieldOf(el: object): LiveFieldApi | undefined {
  return liveFields.get(el);
}

/** Toggle `style` in a pending list. Pure. */
export function togglePendingStyle(
  pending: readonly FormatStyle[],
  style: FormatStyle,
): FormatStyle[] {
  return pending.includes(style) ? pending.filter((s) => s !== style) : [...pending, style];
}

/** One undo step: the box's text and selection. */
export interface LiveSnapshot {
  text: string;
  start: number;
  end: number;
}

/**
 * The box's own undo (a script edit wipes the browser's): states in order,
 * the current one at `index`. Typing within a second merges into one step.
 * Pure: each call returns the next history.
 */
export interface LiveHistory {
  stack: readonly LiveSnapshot[];
  index: number;
  lastAt: number;
  lastKind: string;
}

const HISTORY_MAX = 200;
const MERGE_MS = 1000;

export function historyStart(snap: LiveSnapshot): LiveHistory {
  return { stack: [snap], index: 0, lastAt: 0, lastKind: '' };
}

/** Record a new state; `kind` "type" / "delete" merge within MERGE_MS. Pure. */
export function historyPush(
  h: LiveHistory,
  snap: LiveSnapshot,
  kind: string,
  at: number,
): LiveHistory {
  const current = h.stack[h.index];
  if (current !== undefined && current.text === snap.text) {
    const stack = h.stack.slice(0, h.index + 1);
    stack[h.index] = snap;
    return { stack, index: h.index, lastAt: h.lastAt, lastKind: h.lastKind };
  }
  const kept = h.stack.slice(0, h.index + 1);
  const merge =
    (kind === 'type' || kind === 'delete') &&
    kind === h.lastKind &&
    at - h.lastAt < MERGE_MS &&
    kept.length > 1;
  if (merge) {
    kept[kept.length - 1] = snap;
  } else {
    kept.push(snap);
  }
  const stack = kept.length > HISTORY_MAX ? kept.slice(kept.length - HISTORY_MAX) : kept;
  return { stack, index: stack.length - 1, lastAt: at, lastKind: kind };
}

/** Step back (-1) or forward (1); null when there is nothing there. Pure. */
export function historyStep(
  h: LiveHistory,
  dir: -1 | 1,
): { history: LiveHistory; snap: LiveSnapshot } | null {
  const index = h.index + dir;
  const snap = h.stack[index];
  if (snap === undefined) return null;
  return { history: { ...h, index, lastKind: '' }, snap };
}

/** The input kind a beforeinput / input type merges as. Pure. */
export function historyKind(inputType: string): string {
  if (inputType === 'insertText' || inputType === 'insertCompositionText') return 'type';
  if (inputType.startsWith('delete')) return 'delete';
  return inputType === '' ? 'edit' : inputType;
}
