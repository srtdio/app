// Formatting actions on a writing box (ui/WritingBox rows and shortcuts): a
// textarea (ui/Textarea) or a contentEditable (comments/MentionInput). Inline
// styles wrap the selection in WhatsApp markers (*bold* _italic_ ~strike~
// +underline+ ```mono```); lists and quotes toggle line prefixes ("1. ",
// "- ", "> "); links insert [text](url). Text goes in through
// document.execCommand('insertText') so native Undo works.
//
// Shortcuts (any formatting box, never captions): Cmd/Ctrl+B bold, +I italic,
// +U underline, +Shift+X strike, +Shift+C mono, +Shift+7 numbered list,
// +Shift+8 bullet list, +Shift+9 quote, Cmd/Ctrl+K link (WritingBox opens the
// Add link sheet).
//
// A live box (ui/Textarea with formatting, comments/MentionInput: markers
// held hidden, src/lib/format-live.ts) registers itself; every edit here then
// goes through its replace (the hidden markers stay right), and a format key
// pressed with no selection holds that style for the next typed text instead
// of typing an empty marker pair.
//
// Nothing here adds a listener: the box's own key and select events call in.

import { useCallback } from 'react';
import type { KeyboardEvent } from 'react';
import { decodeMarkers, liveFieldOf, type LiveFieldApi } from '@/lib/format-live';
import {
  continueBlock,
  linePrefix,
  stylesAt,
  toggleBlock,
  toggleFormat,
  STYLE_MARKER,
  type BlockKind,
  type FormatStyle,
  type TextEdit,
} from '@srtdio/comments';

export type FormatAction = FormatStyle | BlockKind | 'link';

export type Field = HTMLTextAreaElement | HTMLElement;

/** The style a key press asks for, or null. Pure. */
export function shortcutStyle(e: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}): FormatStyle | null {
  const a = shortcutAction(e);
  return a === 'bold' || a === 'italic' || a === 'underline' || a === 'strike' || a === 'mono'
    ? a
    : null;
}

/** The format action a key press asks for (inline, list, quote, link), or null. Pure. */
export function shortcutAction(e: {
  key: string;
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}): FormatAction | null {
  if (!(e.metaKey || e.ctrlKey) || e.altKey) return null;
  const key = e.key.toLowerCase();
  if (e.shiftKey) {
    if (key === 'x') return 'strike';
    if (key === 'c') return 'mono';
    // Shift+7/8/9 give "&", "*", "(" on US layouts: read the physical key too.
    if (key === '7' || key === '&' || e.code === 'Digit7') return 'ol';
    if (key === '8' || key === '*' || e.code === 'Digit8') return 'ul';
    if (key === '9' || key === '(' || e.code === 'Digit9') return 'quote';
    return null;
  }
  if (key === 'k') return 'link';
  if (key === 'b') return 'bold';
  if (key === 'i') return 'italic';
  if (key === 'u') return 'underline';
  return null;
}

function isTextarea(el: Field): el is HTMLTextAreaElement {
  return el.tagName === 'TEXTAREA';
}

/** insertText through the editing stack (native Undo); false when unsupported. */
function execInsert(text: string): boolean {
  try {
    return typeof document.execCommand === 'function'
      ? document.execCommand('insertText', false, text)
      : false;
  } catch {
    return false;
  }
}

/** Delete the selection through the editing stack (native Undo). */
function execDelete(): void {
  try {
    if (typeof document.execCommand === 'function') document.execCommand('delete', false);
  } catch {
    // Nothing to undo into; the selection stays.
  }
}

/** Toggle a style on a textarea's selection. One edit, one Undo step. */
export function applyToTextarea(el: HTMLTextAreaElement, style: FormatStyle): boolean {
  const start = el.selectionStart;
  const end = el.selectionEnd;
  if (start === end) return false;
  const t = toggleFormat(el.value, start, end, style);
  const live = liveFieldOf(el);
  if (live !== undefined) {
    live.replace(t.from, t.to, t.insert, t.selStart, t.selEnd);
    return true;
  }
  el.focus({ preventScroll: true });
  el.setSelectionRange(t.from, t.to);
  if (!execInsert(t.insert)) {
    // No execCommand (tests, old engines): splice and tell React.
    el.setRangeText(t.insert, t.from, t.to, 'end');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  el.setSelectionRange(t.selStart, t.selEnd);
  return true;
}

// contentEditable (MentionInput): text offsets over its text nodes, line
// breaks and mention chips, the same walk serializeComposer does. A chip is
// atomic (its @[uuid] token length); edits only ever touch the edges of the
// selection so chips inside it survive.

interface Piece {
  node: Node;
  start: number;
  len: number;
  atomic: boolean;
}

function piecesOf(root: HTMLElement): { pieces: Piece[]; text: string } {
  const pieces: Piece[] = [];
  let text = '';
  const walk = (node: Node): void => {
    if (node.nodeType === 3) {
      const v = (node.nodeValue ?? '').replace(/\u00a0/g, ' ');
      pieces.push({ node, start: text.length, len: v.length, atomic: false });
      text += v;
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node as HTMLElement;
    const id = el.dataset?.mentionId;
    if (id !== undefined && id !== '') {
      const token = `@[${id}]`;
      pieces.push({ node, start: text.length, len: token.length, atomic: true });
      text += token;
      return;
    }
    if (el.tagName === 'BR') {
      // A live editor's trailing <br> only holds the last empty line open.
      if (el.dataset?.trail === undefined) text += '\n';
      return;
    }
    if ((el.tagName === 'DIV' || el.tagName === 'P') && text !== '' && !text.endsWith('\n')) {
      text += '\n';
    }
    el.childNodes.forEach(walk);
  };
  root.childNodes.forEach(walk);
  // Hidden markers (a live box) read as their characters: same length.
  return { pieces, text: decodeMarkers(text) };
}

function offsetOf(root: HTMLElement, pieces: Piece[], node: Node, offset: number): number {
  if (node.nodeType === 3) {
    const p = pieces.find((x) => x.node === node);
    if (p !== undefined) return p.start + Math.min(offset, p.len);
  }
  // An element point: the end of the last piece wholly before it.
  const range = document.createRange();
  range.selectNodeContents(root);
  range.setEnd(node, offset);
  let best = 0;
  for (const p of pieces) {
    const endOffset = p.atomic ? p.node.childNodes.length : p.len;
    if (range.comparePoint(p.node, endOffset) !== 0) break;
    best = p.start + p.len;
  }
  return best;
}

function pointAt(pieces: Piece[], offset: number): { node: Node; offset: number } | null {
  for (const p of pieces) {
    if (offset < p.start || offset > p.start + p.len) continue;
    if (p.atomic) {
      const parent = p.node.parentNode;
      if (parent === null) continue;
      const idx = Array.prototype.indexOf.call(parent.childNodes, p.node) as number;
      return { node: parent, offset: offset === p.start ? idx : idx + 1 };
    }
    return { node: p.node, offset: offset - p.start };
  }
  return null;
}

function selectOffsets(root: HTMLElement, from: number, to: number): boolean {
  const { pieces } = piecesOf(root);
  const a = pointAt(pieces, from);
  const b = pointAt(pieces, to);
  const sel = window.getSelection();
  if (a === null || b === null || sel === null) return false;
  const range = document.createRange();
  range.setStart(a.node, a.offset);
  range.setEnd(b.node, b.offset);
  sel.removeAllRanges();
  sel.addRange(range);
  return true;
}

/** Toggle a style on a contentEditable's selection; chips inside are kept. */
export function applyToEditable(root: HTMLElement, style: FormatStyle): boolean {
  const sel = window.getSelection();
  if (sel === null || sel.rangeCount === 0) return false;
  const range = sel.getRangeAt(0);
  if (range.collapsed || !root.contains(range.startContainer)) return false;
  const { pieces, text } = piecesOf(root);
  const start = offsetOf(root, pieces, range.startContainer, range.startOffset);
  const end = offsetOf(root, pieces, range.endContainer, range.endOffset);
  if (start >= end) return false;
  const t = toggleFormat(text, start, end, style);
  const live = liveFieldOf(root);
  if (live !== undefined) {
    live.replace(t.from, t.to, t.insert, t.selStart, t.selEnd);
    return true;
  }
  const m = t.marker.length;
  root.focus({ preventScroll: true });
  // The end edge first, so the start offsets stay valid.
  if (t.mode === 'wrap') {
    if (selectOffsets(root, t.to, t.to)) execInsert(t.marker);
    if (selectOffsets(root, t.from, t.from)) execInsert(t.marker);
  } else {
    if (selectOffsets(root, t.to - m, t.to)) execDelete();
    if (selectOffsets(root, t.from, t.from + m)) execDelete();
  }
  selectOffsets(root, t.selStart, t.selEnd);
  root.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
}

/** Toggle a style on whatever box `el` is. */
export function applyFormat(el: Field, style: FormatStyle): boolean {
  return isTextarea(el) ? applyToTextarea(el, style) : applyToEditable(el, style);
}

/** Whether `el` holds a non-empty selection right now. */
function hasSelection(el: Field): boolean {
  if (isTextarea(el)) return el.selectionStart !== el.selectionEnd;
  const sel = typeof window !== 'undefined' ? window.getSelection() : null;
  if (sel === null || sel.rangeCount === 0 || sel.isCollapsed) return false;
  return el.contains(sel.anchorNode) && el.contains(sel.focusNode);
}

function isBlockKind(a: FormatAction): a is BlockKind {
  return a === 'ol' || a === 'ul' || a === 'quote';
}

/** The box's text and selection as plain offsets (chips count as their token). */
export function fieldSelection(el: Field): { text: string; start: number; end: number } {
  if (isTextarea(el)) return { text: el.value, start: el.selectionStart, end: el.selectionEnd };
  const { pieces, text } = piecesOf(el);
  const sel = typeof window !== 'undefined' ? window.getSelection() : null;
  if (sel === null || sel.rangeCount === 0 || !el.contains(sel.anchorNode)) {
    return { text, start: text.length, end: text.length };
  }
  const range = sel.getRangeAt(0);
  const start = offsetOf(el, pieces, range.startContainer, range.startOffset);
  const end = offsetOf(el, pieces, range.endContainer, range.endOffset);
  return { text, start: Math.min(start, end), end: Math.max(start, end) };
}

/** Splice a textarea through the editing stack (one Undo step). */
function spliceTextarea(el: HTMLTextAreaElement, edit: TextEdit): void {
  const live = liveFieldOf(el);
  if (live !== undefined) {
    liveSplice(live, edit);
    return;
  }
  el.focus({ preventScroll: true });
  if (edit.from !== edit.to || edit.insert !== '') {
    el.setSelectionRange(edit.from, edit.to);
    const ok = edit.insert === '' ? execDeleteOk() : execInsert(edit.insert);
    if (!ok) {
      // No execCommand (tests, old engines): splice and tell React.
      el.setRangeText(edit.insert, edit.from, edit.to, 'end');
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }
  el.setSelectionRange(edit.selStart, edit.selEnd);
}

/** One edit on a live box, through its own rules. */
function liveSplice(live: LiveFieldApi, edit: TextEdit): void {
  live.replace(edit.from, edit.to, edit.insert, edit.selStart, edit.selEnd);
}

function execDeleteOk(): boolean {
  try {
    return typeof document.execCommand === 'function'
      ? document.execCommand('delete', false)
      : false;
  } catch {
    return false;
  }
}

/**
 * A splice on a contentEditable, line prefixes only: each line's old prefix is
 * replaced by its new one, so chips inside the lines are never touched.
 */
function spliceEditablePrefixes(root: HTMLElement, text: string, edit: TextEdit): void {
  const oldLines = text.slice(edit.from, edit.to).split('\n');
  const newLines = edit.insert.split('\n');
  root.focus({ preventScroll: true });
  // Bottom-up so earlier offsets stay valid.
  const starts: number[] = [];
  let at = edit.from;
  for (const l of oldLines) {
    starts.push(at);
    at += l.length + 1;
  }
  for (let i = oldLines.length - 1; i >= 0; i -= 1) {
    const oldLine = oldLines[i] ?? '';
    const newLine = newLines[i] ?? '';
    const oldLen = linePrefix(oldLine)?.len ?? 0;
    const newLen = linePrefix(newLine)?.len ?? 0;
    const s = starts[i] ?? edit.from;
    if (selectOffsets(root, s, s + oldLen)) {
      const nextPrefix = newLine.slice(0, newLen);
      if (nextPrefix === '') {
        if (oldLen > 0) execDelete();
      } else execInsert(nextPrefix);
    }
  }
  selectOffsets(root, edit.selStart, edit.selEnd);
  root.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Apply a list / quote toggle to the box's selection. */
export function applyBlock(el: Field, kind: BlockKind): boolean {
  const { text, start, end } = fieldSelection(el);
  const edit = toggleBlock(text, start, end, kind);
  const live = liveFieldOf(el);
  if (live !== undefined) liveSplice(live, edit);
  else if (isTextarea(el)) spliceTextarea(el, edit);
  else spliceEditablePrefixes(el, text, edit);
  return true;
}

/** Put the selection back on [start, end) (after a sheet took focus). */
export function restoreSelection(el: Field, start: number, end: number): void {
  el.focus({ preventScroll: true });
  if (isTextarea(el)) el.setSelectionRange(start, end);
  else selectOffsets(el, start, end);
}

/** Insert text at the box's caret, replacing the selection. */
export function insertText(el: Field, insert: string): void {
  const live = liveFieldOf(el);
  if (isTextarea(el) || live !== undefined) {
    const { start, end } = fieldSelection(el);
    const edit = {
      from: start,
      to: end,
      insert,
      selStart: start + insert.length,
      selEnd: start + insert.length,
    };
    if (live !== undefined) liveSplice(live, edit);
    else if (isTextarea(el)) spliceTextarea(el, edit);
    return;
  }
  el.focus({ preventScroll: true });
  if (!execInsert(insert)) {
    el.appendChild(document.createTextNode(insert));
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

/** The selected text right now (the Add link sheet's Text). */
export function selectedText(el: Field): string {
  const { text, start, end } = fieldSelection(el);
  return text.slice(start, end);
}

/**
 * Return in a list or quote line: the next prefix, or the list ends on an
 * empty item. True when it handled the key (the caller stops the newline).
 */
export function applyContinue(el: Field): boolean {
  const { text, start, end } = fieldSelection(el);
  if (start !== end) return false;
  const edit = continueBlock(text, start);
  if (edit === null) return false;
  const live = liveFieldOf(el);
  if (live !== undefined) liveSplice(live, edit);
  else if (isTextarea(el)) spliceTextarea(el, edit);
  else {
    el.focus({ preventScroll: true });
    if (selectOffsets(el, edit.from, edit.to)) {
      if (edit.insert === '') execDelete();
      else execInsert(edit.insert);
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  return true;
}

/** Run one format action (Aa row button or shortcut). Link is the caller's (it opens a sheet). */
export function applyAction(el: Field, action: Exclude<FormatAction, 'link'>): boolean {
  if (isBlockKind(action)) return applyBlock(el, action);
  if (applyFormat(el, action)) return true;
  // No selection in a live box: the style waits for the next typed text
  // (markers never show, so an empty pair would be invisible and stuck).
  const live = liveFieldOf(el);
  if (live !== undefined) {
    live.togglePending(action);
    return true;
  }
  // No selection: the marker pair goes in at the caret, the caret between.
  const marker = STYLE_MARKER[action];
  if (isTextarea(el)) {
    const { start } = fieldSelection(el);
    spliceTextarea(el, {
      from: start,
      to: start,
      insert: marker + marker,
      selStart: start + marker.length,
      selEnd: start + marker.length,
    });
    return true;
  }
  return false;
}

/** The actions "on" at the caret / selection: inline styles, link, the line's block kind. */
export function activeActions(el: Field): Set<FormatAction> {
  const { text, start, end } = fieldSelection(el);
  const on = new Set<FormatAction>(stylesAt(text, start, end));
  const from = text.lastIndexOf('\n', start - 1) + 1;
  const nl = text.indexOf('\n', start);
  const kind = linePrefix(text.slice(from, nl === -1 ? text.length : nl))?.kind;
  if (kind !== undefined) on.add(kind);
  // A live box's held styles (a format key with no selection) read as on.
  for (const style of liveFieldOf(el)?.pending() ?? []) {
    if (on.has(style)) on.delete(style);
    else on.add(style);
  }
  return on;
}

/**
 * A formatting box's key handler (ui/Textarea, comments/MentionInput): the
 * shortcuts and, with `listEnter`, Return continuing a list or quote. `link`
 * is told about Cmd/Ctrl+K (the WritingBox opens Add link); with no handler
 * the key passes through. Returns true when it handled the key.
 */
export function useFormatKeys(
  field: { current: Field | null },
  enabled: boolean,
  opts: { listEnter?: boolean } = {},
): (e: KeyboardEvent) => boolean {
  const listEnter = opts.listEnter ?? true;
  return useCallback(
    (e: KeyboardEvent): boolean => {
      if (!enabled) return false;
      const el = field.current;
      if (el === null) return false;
      if (
        listEnter &&
        e.key === 'Enter' &&
        !e.shiftKey &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !e.nativeEvent.isComposing
      ) {
        if (applyContinue(el)) {
          e.preventDefault();
          return true;
        }
        return false;
      }
      const action = shortcutAction(e);
      if (action === null || action === 'link') return false;
      if (!isBlockKind(action) && !hasSelection(el) && liveFieldOf(el) === undefined) {
        return false;
      }
      e.preventDefault();
      applyAction(el, action);
      return true;
    },
    [enabled, field, listEnter],
  );
}

// Live styling in a contentEditable box (MentionInput): CSS Custom Highlights
// paint the styles without touching the DOM, so the caret never moves. Width
// neutral: bold is a hairline text-shadow, italic shows faded markers only,
// mono a faint token fill. Injected once, on first use.
let highlightCssDone = false;
export const HIGHLIGHT_NAMES: Readonly<Record<FormatStyle | 'marker' | 'quote', string>> = {
  quote: 'srt-fmt-quote',
  bold: 'srt-fmt-bold',
  italic: 'srt-fmt-italic',
  strike: 'srt-fmt-strike',
  underline: 'srt-fmt-underline',
  mono: 'srt-fmt-mono',
  marker: 'srt-fmt-marker',
};

export function ensureFormatHighlightCss(): void {
  if (highlightCssDone || typeof document === 'undefined') return;
  highlightCssDone = true;
  const style = document.createElement('style');
  style.dataset.formatHighlights = '';
  style.textContent = [
    `::highlight(${HIGHLIGHT_NAMES.bold}){text-shadow:0.03em 0 0 rgb(var(--fg-rgb)),-0.03em 0 0 rgb(var(--fg-rgb))}`,
    `::highlight(${HIGHLIGHT_NAMES.strike}){text-decoration:line-through}`,
    `::highlight(${HIGHLIGHT_NAMES.underline}){text-decoration:underline}`,
    `::highlight(${HIGHLIGHT_NAMES.mono}){background-color:rgb(var(--fg-rgb) / 0.08)}`,
    `::highlight(${HIGHLIGHT_NAMES.marker}){color:rgb(var(--fg-3-rgb))}`,
    `::highlight(${HIGHLIGHT_NAMES.quote}){color:rgb(var(--fg-2-rgb))}`,
  ].join('');
  document.head.appendChild(style);
}

/** Offsets -> DOM ranges for a contentEditable root (MentionInput's live styling). */
export function rangesForOffsets(root: HTMLElement, from: number, to: number): Range[] {
  const { pieces } = piecesOf(root);
  const out: Range[] = [];
  for (const p of pieces) {
    if (p.atomic) continue;
    const s = Math.max(from, p.start);
    const e = Math.min(to, p.start + p.len);
    if (s >= e) continue;
    const r = document.createRange();
    r.setStart(p.node, s - p.start);
    r.setEnd(p.node, e - p.start);
    out.push(r);
  }
  return out;
}
