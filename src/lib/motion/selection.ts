// The selection fill slide (docs/motion.md, small touches). One shared piece for
// every single-choice row: chip rows, segment switches, tabs and the nav. Each
// pick paints its own fill (bg-accent, lit-pill) as React renders it, so the
// first frame, a remount, Reduce Motion and tests always show the final state.
// When the pick moves inside the same row, a fill ghost glides there from the
// old pick (slideFill) and the two picks hand over their look on the same
// clock (tintPick); then the ghost is removed and nothing else changes.
//
// What makes it smooth (each was a visible jerk before):
// - Boxes are layout boxes (offsetLeft/Top/Width/Height), never
//   getBoundingClientRect: the tapped pick is mid press (scaled), and a box
//   read from that would land the ghost a few px off and snap at the end.
// - The ghost moves by transform only (compositor), so it keeps gliding while
//   the tap renders the next list or screen on the main thread.
// - The ghost sits behind the row's picks (z -1 in an isolated row): labels
//   stay on top the whole way, never covered by ink.
// - Both picks drop their own fill while the ghost travels; their ink colour
//   and the old pick's grey fill colour follow the ghost (tintPick), so no label is
//   ever white on grey or ink on ink, and no fill pops in at the end.
//
// A row is the picks' shared parent element. A pick that becomes chosen while
// the old one still reads chosen (data-selected="true": a multi-select row)
// never slides. Rows whose picks do not share a parent simply never slide.

import { useCallback, useEffect, useRef } from 'react';
import { fillHandover, nudgeIcon, slideFill, tintPick, type FillBox } from './moves';

/** The pick last chosen in each row (the slide's start). */
const lastPick = new WeakMap<Element, HTMLElement>();

/** The slide running in each row; a newer pick finishes it first. */
const running = new WeakMap<Element, () => void>();

/** A pick's layout box inside its row (the row must be positioned). */
function layoutBox(el: HTMLElement, row: HTMLElement): FillBox {
  if (el.offsetParent === row) {
    return {
      left: el.offsetLeft,
      top: el.offsetTop,
      width: el.offsetWidth,
      height: el.offsetHeight,
    };
  }
  // Not laid out against the row (rare): fall back to the drawn box.
  const r = row.getBoundingClientRect();
  const b = el.getBoundingClientRect();
  return {
    left: b.left - r.left + row.scrollLeft - row.clientLeft,
    top: b.top - r.top + row.scrollTop - row.clientTop,
    width: b.width,
    height: b.height,
  };
}

/** The look a pick hands over: its ink and its fill colour. */
interface PickLook {
  color: string;
  backgroundColor: string;
}

function lookOf(el: HTMLElement): PickLook {
  const cs = getComputedStyle(el);
  return { color: cs.color, backgroundColor: cs.backgroundColor };
}

/**
 * Keyframes from (progress, partial look) points: points at the same progress
 * merge, offsets stay in order. Pure.
 */
export function handoverFrames(points: Array<[number, Keyframe]>): Keyframe[] {
  const merged = new Map<number, Keyframe>();
  for (const [at, look] of points) {
    const offset = Math.round(Math.min(Math.max(at, 0), 1) * 1000) / 1000;
    merged.set(offset, { ...(merged.get(offset) ?? {}), ...look });
  }
  return [...merged.entries()]
    .sort((x, y) => x[0] - y[0])
    .map(([offset, look]) => ({ ...look, offset }));
}

/** Lay the fill ghost behind `to` and glide it from `from`. Cleans up on end, finish or cancel. */
function slideBetween(row: HTMLElement, from: HTMLElement, to: HTMLElement): void {
  running.get(row)?.();
  const restorePosition = getComputedStyle(row).position === 'static';
  if (restorePosition) row.style.position = 'relative';
  const a = layoutBox(from, row);
  const b = layoutBox(to, row);
  if (b.width === 0 || a.width === 0) {
    if (restorePosition) row.style.position = '';
    return;
  }
  // Final looks, read before the handover hides the picks' own fills.
  const oldLook = lookOf(from);
  const newLook = lookOf(to);
  const restoreIsolation = row.style.isolation;
  row.style.isolation = 'isolate';
  const ghost = document.createElement('span');
  ghost.className = 'bg-accent lit-pill';
  ghost.setAttribute('aria-hidden', 'true');
  ghost.setAttribute('data-fill-ghost', '');
  Object.assign(ghost.style, {
    position: 'absolute',
    left: `${b.left}px`,
    top: `${b.top}px`,
    width: `${b.width}px`,
    height: `${b.height}px`,
    borderRadius: getComputedStyle(to).borderRadius,
    transformOrigin: '0 0',
    pointerEvents: 'none',
    zIndex: '-1',
  });
  row.insertBefore(ghost, row.firstChild);
  to.setAttribute('data-fill-slide', '');
  const at = fillHandover(a, b);
  // The old pick's own fill sits above the travelling one, so it stays clear
  // until the fill has left (held back from the very end when the fill only
  // leaves at the end), then grows back in.
  const clearAt = Math.min(at.clear, 0.85);
  const clearIn = Math.min(1, clearAt + 0.15);
  // The new pick keeps the rest look it had a frame ago (the old pick's rest
  // fill and ink) while the fill slides in under it, like under any chip; as
  // the fill covers it the grey gives way in one quick step (a slow fade over
  // the ink reads as mud) and the ink turns to the pick's own.
  const inkIn = tintPick(
    to,
    handoverFrames([
      [0, { color: oldLook.color, backgroundColor: oldLook.backgroundColor }],
      [at.cover * 0.9, { color: oldLook.color, backgroundColor: oldLook.backgroundColor }],
      [at.cover, { color: newLook.color, backgroundColor: 'rgba(0, 0, 0, 0)' }],
      [1, { color: newLook.color, backgroundColor: 'rgba(0, 0, 0, 0)' }],
    ]),
  );
  // The old pick keeps the pick's ink while the fill is under its label and
  // turns back to its own as the trailing edge crosses the label.
  const inkOut = tintPick(
    from,
    handoverFrames([
      [0, { color: newLook.color, backgroundColor: 'rgba(0, 0, 0, 0)' }],
      [at.labelFrom, { color: newLook.color }],
      [at.labelTo, { color: oldLook.color }],
      [clearAt, { backgroundColor: 'rgba(0, 0, 0, 0)' }],
      [clearIn, { backgroundColor: oldLook.backgroundColor }],
      [1, { color: oldLook.color, backgroundColor: oldLook.backgroundColor }],
    ]),
  );
  const glide = slideFill(ghost, a, b);
  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    inkIn.finish();
    inkOut.finish();
    ghost.remove();
    to.removeAttribute('data-fill-slide');
    row.style.isolation = restoreIsolation;
    if (restorePosition) row.style.position = '';
    if (running.get(row) === finishNow) running.delete(row);
  };
  const finishNow = (): void => {
    glide.finish();
    cleanup();
  };
  running.set(row, finishNow);
  if (glide.instant) cleanup();
  else void glide.done.then(cleanup);
}

/** Whether each pick element was chosen at its last commit. */
const wasChosen = new WeakMap<HTMLElement, boolean>();

/** One commit of a pick: record it, and slide when it just became the row's pick. */
function notePick(el: HTMLElement, selected: boolean): void {
  const before = wasChosen.get(el);
  wasChosen.set(el, selected);
  if (!selected) return;
  const row = el.parentElement;
  if (row === null) return;
  const prev = lastPick.get(row);
  lastPick.set(row, el);
  if (before !== false) return;
  if (prev === undefined || prev === el || !prev.isConnected) return;
  if (prev.getAttribute('data-selected') === 'true') return;
  slideBetween(row, prev, el);
}

/**
 * A pick in a single-choice row, as a ref callback (no hooks, so a pick
 * component stays a plain function). Pass a fresh callback each render; React
 * calls it on every commit. The element must also carry data-selected="true"
 * while chosen. The first paint never slides; a later change of pick in the
 * same row slides the fill over.
 */
export function selectionSlideRef(selected: boolean): (el: HTMLElement | null) => void {
  return (el) => {
    if (el !== null) notePick(el, selected);
  };
}

/**
 * A nav icon whose unread count can rise: returns the ref callback for the icon's
 * own wrapper (never the badge or the link). When `count` rises on screen (not the
 * first paint, not a fall, not to zero) the icon nudges once (nudgeIcon); a newer
 * rise restarts it.
 */
export function useNudgeOnRise(count: number): (el: HTMLElement | null) => void {
  const node = useRef<HTMLElement | null>(null);
  const shown = useRef<number | null>(null);
  const playing = useRef<{ cancel: () => void } | null>(null);
  useEffect(() => {
    const before = shown.current;
    shown.current = count;
    if (before === null || !(count > before) || node.current === null) return;
    playing.current?.cancel();
    playing.current = nudgeIcon(node.current);
  }, [count]);
  return useCallback((el: HTMLElement | null) => {
    node.current = el;
  }, []);
}
