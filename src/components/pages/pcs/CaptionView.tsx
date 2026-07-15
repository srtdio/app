import { useCallback, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import { IconChat } from '@/components/ui/icons';

// F4 caption-highlight annotations: render a post caption with its caption_span
// annotations as amber highlights, and let a fresh text selection start a new
// caption comment. Image pins are F5 and live elsewhere; this file is caption
// only. Colour comes exclusively from the F1 annotation tokens (annotation-bg /
// annotation-line), so light and dark flip automatically.

/** Marks the superscript number node so the offset walker skips its text. */
export const CAPTION_MARKER_ATTR = 'data-caption-marker';

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

/** One current-version, in-bounds caption_span highlight to draw. */
export interface CaptionAnnotationView {
  id: string;
  /** Stable display number shown as the superscript and in the comment chip. */
  n: number;
  captionStart: number;
  captionEnd: number;
  commentId: string;
}

interface CaptionViewProps {
  caption: string;
  annotations: CaptionAnnotationView[];
  onHighlightClick: (commentId: string) => void;
  onAnnotate: (captionStart: number, captionEnd: number, quote: string) => void;
  readOnly?: boolean;
}

/** The minimal shape of a DOM Selection the span math reads from. */
export interface SelectionLike {
  anchorNode: Node | null;
  anchorOffset: number;
  focusNode: Node | null;
  focusOffset: number;
  isCollapsed: boolean;
}

// nodeType === 1 guards the Element cast; getAttribute is the only Element
// member used, and a non-null value means this subtree is a superscript marker.
function isMarker(node: Node): boolean {
  return (
    node.nodeType === ELEMENT_NODE && (node as Element).getAttribute(CAPTION_MARKER_ATTR) !== null
  );
}

/** Sum the caption-text length of a subtree, skipping superscript markers. */
function subtreeTextLength(node: Node): number {
  if (isMarker(node)) return 0;
  if (node.nodeType === TEXT_NODE) return (node.nodeValue ?? '').length;
  let total = 0;
  const kids = node.childNodes;
  for (let i = 0; i < kids.length; i += 1) {
    const child = kids[i];
    if (child !== undefined) total += subtreeTextLength(child);
  }
  return total;
}

/**
 * Absolute caption offset of (`target`, `targetOffset`) by walking `root`'s text
 * nodes in document order and summing their lengths, skipping any superscript
 * marker subtree. Never uses indexOf, so repeated caption text is unambiguous.
 * Returns null when the target is not reachable under `root` (e.g. it lies
 * inside a marker), so a selection touching a marker is ignored rather than
 * mis-sliced.
 */
function captionOffset(root: Node, target: Node, targetOffset: number): number | null {
  let acc = 0;
  let found = false;
  function walk(node: Node): boolean {
    if (isMarker(node)) return false;
    if (node === target) {
      if (node.nodeType === TEXT_NODE) {
        acc += Math.min(targetOffset, (node.nodeValue ?? '').length);
      } else {
        const kids = node.childNodes;
        for (let i = 0; i < targetOffset && i < kids.length; i += 1) {
          const child = kids[i];
          if (child !== undefined) acc += subtreeTextLength(child);
        }
      }
      found = true;
      return true;
    }
    if (node.nodeType === TEXT_NODE) {
      acc += (node.nodeValue ?? '').length;
      return false;
    }
    const kids = node.childNodes;
    for (let i = 0; i < kids.length; i += 1) {
      const child = kids[i];
      if (child !== undefined && walk(child)) return true;
    }
    return false;
  }
  walk(root);
  return found ? acc : null;
}

/** The selected caption range, or null when it is empty, collapsed, touches a
 *  marker, or falls outside the live caption. */
export function captionSpanFromSelection(
  root: Node,
  selection: SelectionLike,
  captionLength: number,
): { start: number; end: number } | null {
  if (selection.isCollapsed) return null;
  if (selection.anchorNode === null || selection.focusNode === null) return null;
  const a = captionOffset(root, selection.anchorNode, selection.anchorOffset);
  const b = captionOffset(root, selection.focusNode, selection.focusOffset);
  if (a === null || b === null) return null;
  const start = Math.min(a, b);
  const end = Math.max(a, b);
  if (start >= end) return null;
  if (start < 0 || end > captionLength) return null;
  return { start, end };
}

/** Resolve a selection straight to the onAnnotate payload, or null to ignore. */
export function selectionToAnnotation(
  root: Node,
  selection: SelectionLike,
  caption: string,
): { start: number; end: number; quote: string } | null {
  const span = captionSpanFromSelection(root, selection, caption.length);
  if (span === null) return null;
  return { start: span.start, end: span.end, quote: caption.slice(span.start, span.end) };
}

interface CaptionViewModel {
  caption: string;
  annotations: CaptionAnnotationView[];
  onHighlightClick: (commentId: string) => void;
}

/**
 * Hookless renderer for the caption body: plain text with the annotated ranges
 * wrapped in an amber <mark> plus an unselectable superscript number. Every
 * highlight is bounds-guarded against the live caption and out-of-range or
 * inverted ranges are skipped (never mis-sliced); overlapping ranges keep the
 * first. Returned as a walkable element tree so it can be unit-tested without a
 * DOM, mirroring the gallery view helper.
 */
export function captionView({
  caption,
  annotations,
  onHighlightClick,
}: CaptionViewModel): ReactNode {
  const valid = annotations
    .filter(
      (a) => a.captionStart >= 0 && a.captionEnd <= caption.length && a.captionStart < a.captionEnd,
    )
    .sort((a, b) => a.captionStart - b.captionStart);

  const out: ReactNode[] = [];
  let cursor = 0;
  for (const a of valid) {
    if (a.captionStart < cursor) continue; // overlap: keep the earlier highlight
    if (a.captionStart > cursor) {
      out.push(<span key={`t-${cursor}`}>{caption.slice(cursor, a.captionStart)}</span>);
    }
    const quote = caption.slice(a.captionStart, a.captionEnd);
    out.push(
      <mark
        key={`m-${a.id}`}
        id={`caption-mark-${a.commentId}`}
        role="button"
        tabIndex={0}
        aria-label={`Comment on "${quote}"`}
        className="rounded-[3px] bg-annotation-bg px-0.5 text-fg cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-annotation-line"
        onClick={() => onHighlightClick(a.commentId)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onHighlightClick(a.commentId);
          }
        }}
      >
        {quote}
        <sup
          {...{ [CAPTION_MARKER_ATTR]: '' }}
          className="ml-0.5 align-super select-none text-[10px] font-semibold text-annotation-line"
          style={{ userSelect: 'none' }}
        >
          {a.n}
        </sup>
      </mark>,
    );
    cursor = a.captionEnd;
  }
  if (cursor < caption.length) {
    out.push(<span key={`t-${cursor}`}>{caption.slice(cursor)}</span>);
  }
  return out;
}

/**
 * Caption with live highlights and selection-to-comment. Selecting caption text
 * surfaces a Comment affordance that calls onAnnotate with the captured span;
 * clicking a highlight calls onHighlightClick. readOnly (empty caption) disables
 * the selection affordance.
 */
export function CaptionView({
  caption,
  annotations,
  onHighlightClick,
  onAnnotate,
  readOnly = false,
}: CaptionViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [pending, setPending] = useState<{ start: number; end: number; quote: string } | null>(
    null,
  );

  const captureSelection = useCallback((): void => {
    if (readOnly) return;
    const root = containerRef.current;
    if (root === null) return;
    const selection = window.getSelection();
    if (selection === null) {
      setPending(null);
      return;
    }
    setPending(selectionToAnnotation(root, selection, caption));
  }, [readOnly, caption]);

  return (
    <div className="relative">
      <div
        ref={containerRef}
        onMouseUp={captureSelection}
        onTouchEnd={captureSelection}
        className="text-sm leading-relaxed whitespace-pre-wrap text-fg"
      >
        {captionView({ caption, annotations, onHighlightClick })}
      </div>
      {!readOnly && pending !== null ? (
        <div className="mt-2">
          <Button
            size="lg"
            variant="primary"
            className="min-h-[44px] min-w-[44px]"
            onClick={() => {
              onAnnotate(pending.start, pending.end, pending.quote);
              setPending(null);
              window.getSelection()?.removeAllRanges();
            }}
          >
            <IconChat size={16} inline />
            Comment
          </Button>
        </div>
      ) : null}
    </div>
  );
}
