// The selection fill slide (docs/motion.md, small touches). One shared piece for
// every single-choice row: chip rows, segment switches and the nav. Each pick
// paints its own fill (bg-accent, lit-pill) as React renders it, so the first
// frame, a remount, Reduce Motion and tests always show the final state. When the
// pick moves inside the same row, a fill ghost is laid on the new pick and slides
// from the old pick's box (slideFill); the new pick hides its own fill while the
// ghost travels ([data-fill-slide] in index.css), then the ghost is removed.
//
// A row is the picks' shared parent element. A pick that becomes chosen while the
// old one still reads chosen (data-selected="true": a multi-select row) never
// slides. Rows whose picks do not share a parent simply never slide.

import { useCallback, useLayoutEffect, useRef } from 'react';
import { nudgeIcon, slideFill } from './moves';

/** The pick last chosen in each row (the slide's start). */
const lastPick = new WeakMap<Element, HTMLElement>();

function relativeBox(el: HTMLElement, row: HTMLElement): { left: number; top: number } {
  const r = row.getBoundingClientRect();
  const b = el.getBoundingClientRect();
  return {
    left: b.left - r.left + row.scrollLeft - row.clientLeft,
    top: b.top - r.top + row.scrollTop - row.clientTop,
  };
}

/** Lay the fill ghost on `to` and slide it from `from`. Cleans up on end, finish or cancel. */
function slideBetween(row: HTMLElement, from: HTMLElement, to: HTMLElement): void {
  const a = from.getBoundingClientRect();
  const b = to.getBoundingClientRect();
  if (b.width === 0 || a.width === 0) return;
  const restorePosition = getComputedStyle(row).position === 'static';
  if (restorePosition) row.style.position = 'relative';
  const at = relativeBox(to, row);
  const ghost = document.createElement('span');
  ghost.className = 'bg-accent lit-pill';
  ghost.setAttribute('aria-hidden', 'true');
  ghost.setAttribute('data-fill-ghost', '');
  Object.assign(ghost.style, {
    position: 'absolute',
    left: `${at.left}px`,
    top: `${at.top}px`,
    width: `${b.width}px`,
    height: `${b.height}px`,
    borderRadius: getComputedStyle(to).borderRadius,
    pointerEvents: 'none',
    zIndex: '1',
  });
  row.appendChild(ghost);
  to.setAttribute('data-fill-slide', '');
  const cleanup = (): void => {
    ghost.remove();
    to.removeAttribute('data-fill-slide');
    if (restorePosition) row.style.position = '';
  };
  const played = slideFill(
    ghost,
    { dx: a.left - b.left, dy: a.top - b.top, width: a.width },
    b.width,
  );
  if (played.instant) cleanup();
  else void played.done.then(cleanup);
}

/**
 * A pick in a single-choice row. Returns the ref callback for the pick's element;
 * the element must also carry data-selected="true" while chosen. The first paint
 * never slides; a later change of pick in the same row slides the fill over.
 */
export function useSelectionSlide(selected: boolean): (el: HTMLElement | null) => void {
  const node = useRef<HTMLElement | null>(null);
  const was = useRef<boolean | null>(null);
  useLayoutEffect(() => {
    const el = node.current;
    const before = was.current;
    was.current = selected;
    if (el === null || !selected) return;
    const row = el.parentElement;
    if (row === null) return;
    const prev = lastPick.get(row);
    lastPick.set(row, el);
    if (before !== false) return;
    if (prev === undefined || prev === el || !prev.isConnected) return;
    if (prev.getAttribute('data-selected') === 'true') return;
    slideBetween(row, prev, el);
  }, [selected]);
  return useCallback((el: HTMLElement | null) => {
    node.current = el;
  }, []);
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
  useLayoutEffect(() => {
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
