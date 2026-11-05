// The format strip: when words are selected in a formatting box (ui/Textarea
// formatting, comments/MentionInput), four buttons, "Bold", "Italic", "Strike",
// "Underline", each label drawn in its own style. With an on-screen keyboard
// the strip is pinned just above it; with none (laptop, iPad with a keyboard)
// it is attached to the box on the side facing the screen centre. A tap wraps
// the selection in WhatsApp markers (*bold* _italic_ ~strike~ +underline+);
// tapping again on wrapped words unwraps them. Text goes in through
// document.execCommand('insertText') so native Undo works, and the selection
// stays on the same words. pointerdown is prevented so the box keeps focus and
// the keyboard stays up. Mono has no button (typed, or Cmd/Ctrl+Shift+C).
//
// Shortcuts (any formatting box): Cmd/Ctrl+B bold, +I italic, +U underline,
// +Shift+X strike, +Shift+C mono.
//
// Nothing here runs until the box is focused with a selection: the strip
// state flips from the box's own select / blur events, no listener is added
// at mount, and the keyboard inset is read only while the strip is open.

import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode, RefObject, SyntheticEvent } from 'react';
import { createPortal } from 'react-dom';
import { toggleFormat, type FormatStyle } from '@srtdio/comments';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/cn';
import { useKeyboardInset } from '@/lib/use-keyboard-inset';

type Field = HTMLTextAreaElement | HTMLElement;

/** The four strip buttons, in order. Labels are the only new visible copy. */
export const STRIP_BUTTONS: readonly { style: FormatStyle; label: string; className: string }[] = [
  { style: 'bold', label: 'Bold', className: 'font-semibold' },
  { style: 'italic', label: 'Italic', className: 'italic' },
  { style: 'strike', label: 'Strike', className: 'line-through' },
  { style: 'underline', label: 'Underline', className: 'underline' },
];

/** The style a key press asks for, or null. Pure. */
export function shortcutStyle(e: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}): FormatStyle | null {
  if (!(e.metaKey || e.ctrlKey) || e.altKey) return null;
  const key = e.key.toLowerCase();
  if (e.shiftKey) {
    if (key === 'x') return 'strike';
    if (key === 'c') return 'mono';
    return null;
  }
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
      text += '\n';
      return;
    }
    if ((el.tagName === 'DIV' || el.tagName === 'P') && text !== '' && !text.endsWith('\n')) {
      text += '\n';
    }
    el.childNodes.forEach(walk);
  };
  root.childNodes.forEach(walk);
  return { pieces, text };
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

const STRIP_H = 52;

interface FormatStripProps {
  field: RefObject<Field | null>;
  open: boolean;
}

/** The strip itself, portalled; fixed, never moves on X/Y (no motion). */
export function FormatStrip({ field, open }: FormatStripProps): ReactNode {
  const inset = useKeyboardInset(open);
  const [pos, setPos] = useState<{ top?: number; bottom?: number; left: number; width: number }>();
  const stripRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const el = field.current;
    if (el === null || typeof window === 'undefined') return;
    const r = el.getBoundingClientRect();
    const vh = window.innerHeight;
    const coarse = window.matchMedia?.('(pointer: coarse)').matches === true;
    // A gap above the box leaves room for iPhone's own Cut/Copy/Paste menu,
    // which sits just above the selection: the two never overlap.
    const gap = coarse ? 56 : 8;
    if (inset > 0) {
      const kbTop = vh - inset;
      // Pinned just above the keyboard, unless that would cover the box (a
      // bottom composer): then above the box.
      const bottom = r.bottom > kbTop - STRIP_H - gap ? vh - r.top + gap : inset + 8;
      setPos({ bottom, left: 0, width: window.innerWidth });
      return;
    }
    const centre = vh / 2;
    const middle = r.top + r.height / 2;
    if (middle > centre) setPos({ bottom: vh - r.top + gap, left: r.left, width: r.width });
    else setPos({ top: r.bottom + 8, left: r.left, width: r.width });
  }, [open, inset, field]);

  if (!open || pos === undefined || typeof document === 'undefined') return null;
  return createPortal(
    <div
      className="pointer-events-none fixed z-50 flex justify-center px-4"
      style={{
        left: pos.left,
        width: pos.width,
        ...(pos.top !== undefined ? { top: pos.top } : { bottom: pos.bottom }),
      }}
    >
      <div
        ref={stripRef}
        role="toolbar"
        aria-label="Format"
        data-format-strip=""
        className="pointer-events-auto flex items-center gap-1 rounded-xl border border-border bg-panel px-1 lit-float"
        onPointerDown={(e) => e.preventDefault()}
        onMouseDown={(e) => e.preventDefault()}
      >
        {STRIP_BUTTONS.map((b) => (
          <Button
            key={b.style}
            type="button"
            variant="ghost"
            data-format={b.style}
            className={cn('min-w-[44px] px-3', b.className)}
            onPointerDown={(e) => e.preventDefault()}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              const el = field.current;
              if (el !== null) applyFormat(el, b.style);
            }}
          >
            {b.label}
          </Button>
        ))}
      </div>
    </div>,
    document.body,
  );
}

/**
 * Wire a formatting box: field event handlers (merge them with the caller's)
 * and the strip node to render beside the box. `enabled` false returns inert
 * handlers and no strip, so a box with formatting off is exactly as before.
 */
export function useFormatStrip(
  field: RefObject<Field | null>,
  enabled: boolean,
): {
  onSelect: (e: SyntheticEvent) => void;
  onBlur: () => void;
  onKeyDown: (e: KeyboardEvent) => boolean;
  strip: ReactNode;
} {
  const [open, setOpen] = useState(false);
  const onSelect = useCallback((): void => {
    if (!enabled) return;
    const el = field.current;
    const next = el !== null && document.activeElement === el && hasSelection(el);
    setOpen((prev) => (prev === next ? prev : next));
  }, [enabled, field]);
  const onBlur = useCallback((): void => {
    if (enabled) setOpen(false);
  }, [enabled]);
  const onKeyDown = useCallback(
    (e: KeyboardEvent): boolean => {
      if (!enabled) return false;
      const style = shortcutStyle(e);
      const el = field.current;
      if (style === null || el === null || !hasSelection(el)) return false;
      e.preventDefault();
      applyFormat(el, style);
      return true;
    },
    [enabled, field],
  );
  return {
    onSelect,
    onBlur,
    onKeyDown,
    strip: enabled ? <FormatStrip field={field} open={open} /> : null,
  };
}

// Live styling in a contentEditable box (MentionInput): CSS Custom Highlights
// paint the styles without touching the DOM, so the caret never moves. Width
// neutral: bold is a hairline text-shadow, italic shows faded markers only,
// mono a faint token fill. Injected once, on first use.
let highlightCssDone = false;
export const HIGHLIGHT_NAMES: Readonly<Record<FormatStyle | 'marker', string>> = {
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
