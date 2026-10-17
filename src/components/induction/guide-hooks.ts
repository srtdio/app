// The guide's behaviour on the real DOM: what finishes a step (the tap, the
// next control appearing, this one disappearing, a filled field losing focus),
// the guard that keeps every other tap from reaching the app, the 4 s skip for
// a control that never shows, the once-per-route legend and element sizes.
// Every listener, observer and timer is removed on cleanup.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ABSENT_SKIP_MS } from '@/lib/induction';
import { fieldValue, inChrome, textFieldOf } from './guide-dom';

function targetNode(event: Event): Node | undefined {
  return event.target instanceof Node ? event.target : undefined;
}

function contains(el: HTMLElement | undefined, node: Node | undefined): boolean {
  return el !== undefined && node !== undefined && el.contains(node);
}

export interface CompletionInput {
  /** Changes per step; resets the detection. */
  stepKey: string;
  /** False for steps only the data finishes (gates, the last setup step of a group). */
  enabled: boolean;
  /** The step's control while it is found (boxed or not). */
  el: HTMLElement | undefined;
  /** The next step's control while it is found. */
  nextEl: HTMLElement | undefined;
}

/**
 * Calls onComplete once per step when the person did the step: a tap on the
 * control (a field instead finishes when it holds text and loses focus), the
 * next step's control appearing after being absent, this control disappearing
 * after it showed, or (on a field step) a tap on the next step's control.
 */
export function useStepCompletion(input: CompletionInput, onComplete: () => void): void {
  const { stepKey, enabled, el, nextEl } = input;
  const latest = useRef(onComplete);
  latest.current = onComplete;
  const seen = useRef({ key: '', done: false, found: false, nextAbsent: false });
  if (seen.current.key !== stepKey) {
    seen.current = { key: stepKey, done: false, found: false, nextAbsent: false };
  }
  const complete = useRef(() => {
    if (seen.current.done) return;
    seen.current.done = true;
    latest.current();
  });

  // DOM changes: read on every render (the live tick re-renders on any change).
  useEffect(() => {
    const now = seen.current;
    if (!enabled || now.done) return;
    if (el !== undefined) now.found = true;
    else if (now.found) complete.current();
    if (nextEl === undefined) now.nextAbsent = true;
    else if (now.nextAbsent) complete.current();
  });

  useEffect(() => {
    if (!enabled || el === undefined) return;
    const field = textFieldOf(el);
    const onClick = (event: Event): void => {
      const node = targetNode(event);
      if (field === undefined && contains(el, node)) complete.current();
      if (field !== undefined && contains(nextEl, node)) complete.current();
    };
    const onBlur = (): void => {
      if (field !== undefined && fieldValue(field) !== '') complete.current();
    };
    document.addEventListener('click', onClick, true);
    el.addEventListener('focusout', onBlur);
    return () => {
      document.removeEventListener('click', onClick, true);
      el.removeEventListener('focusout', onBlur);
    };
  }, [stepKey, enabled, el, nextEl]);
}

const GUARDED_EVENTS = ['pointerdown', 'mousedown', 'click'] as const;
export const NUDGE_MS = 300;

/**
 * While a control is boxed, a tap anywhere else (outside the control, outside
 * the guide's own bar and cards, outside `allowed`) is swallowed in the capture
 * phase and nudges the hand and label. The control itself is never touched:
 * its own tap does the real thing. Returns the nudge count (0: no nudge yet).
 */
export function useTapGuard(
  control: HTMLElement | undefined,
  allowed: HTMLElement | undefined,
): number {
  const [nudge, setNudge] = useState(0);
  useEffect(() => {
    if (control === undefined) return;
    const guard = (event: Event): void => {
      const node = targetNode(event);
      if (
        node === undefined ||
        contains(control, node) ||
        contains(allowed, node) ||
        inChrome(node)
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (event.type === 'pointerdown') setNudge((n) => n + 1);
    };
    for (const type of GUARDED_EVENTS) document.addEventListener(type, guard, true);
    return () => {
      for (const type of GUARDED_EVENTS) document.removeEventListener(type, guard, true);
    };
  }, [control, allowed]);
  return nudge;
}

/**
 * After ABSENT_SKIP_MS on a step whose control never showed, calls onAbsent
 * once (the caller decides where to go; it never blocks the app).
 */
export function useAbsentSkip(
  input: { stepKey: string; found: boolean },
  onAbsent: () => void,
): void {
  const { stepKey, found } = input;
  const latest = useRef(onAbsent);
  latest.current = onAbsent;
  const seen = useRef({ key: '', found: false });
  if (seen.current.key !== stepKey) seen.current = { key: stepKey, found: false };
  if (found) seen.current.found = true;

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (!seen.current.found) latest.current();
    }, ABSENT_SKIP_MS);
    return () => window.clearTimeout(timer);
  }, [stepKey]);
}

function legendKey(route: string): string {
  return `sorted:guide-legend:${route}`;
}

function legendSeen(route: string): boolean {
  try {
    return window.localStorage.getItem(legendKey(route)) === '1';
  } catch {
    return false;
  }
}

function markLegendSeen(route: string): void {
  try {
    window.localStorage.setItem(legendKey(route), '1');
  } catch {
    // Private mode: the legend may show again, which is fine.
  }
}

/** Whether the legend shows on this step: once per route, on the first step the guide shows. */
export function useLegend(route: string, stepId: string): boolean {
  const [legendStep] = useState(() => (legendSeen(route) ? '' : stepId));
  useEffect(() => {
    if (legendStep !== '') markLegendSeen(route);
  }, [legendStep, route]);
  return legendStep !== '' && legendStep === stepId;
}

/** An element's live size (its offset box), with a fallback before it renders. */
export function useElementSize(
  el: HTMLElement | null,
  fallback: { width: number; height: number },
): { width: number; height: number } {
  const [size, setSize] = useState(fallback);
  useLayoutEffect(() => {
    if (el === null) return;
    const measure = (): void => {
      if (el.offsetHeight > 0 || el.offsetWidth > 0) {
        setSize((prev) =>
          prev.width === el.offsetWidth && prev.height === el.offsetHeight
            ? prev
            : { width: el.offsetWidth, height: el.offsetHeight },
        );
      }
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const sizes = new ResizeObserver(measure);
    sizes.observe(el);
    return () => sizes.disconnect();
  }, [el]);
  return size;
}
