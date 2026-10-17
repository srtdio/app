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
  /** The step's control while it is on screen (shown, not covered by a modal). */
  el: HTMLElement | undefined;
  /** The next step's control while it is on screen. */
  nextEl: HTMLElement | undefined;
  /** Where the tap moves on without the next control: no next step, or the next step lives on another place. */
  nextElsewhere: boolean;
  /** The current location (pathname + search); a change after a tap confirms it. */
  where: string;
}

/** How long after a tap the DOM may confirm it; after that the step stays. */
export const TAP_CONFIRM_MS = 4000;

export interface Seen {
  key: string;
  done: boolean;
  /** This step's own control has been on screen at least once. */
  found: boolean;
  /** The next control was absent while this one was on screen. */
  nextAbsent: boolean;
  /** When the control was tapped (0: no tap waiting for confirmation). */
  tappedAt: number;
  /** The location at the tap. */
  tappedWhere: string;
}

export function freshSeen(key: string): Seen {
  return { key, done: false, found: false, nextAbsent: false, tappedAt: 0, tappedWhere: '' };
}

/** Whether a pending tap is confirmed: the next control on screen, no next step here, or the location moved. */
function tapConfirmed(now: Seen, input: CompletionInput): boolean {
  if (now.tappedAt === 0) return false;
  if (performance.now() - now.tappedAt > TAP_CONFIRM_MS) {
    now.tappedAt = 0;
    return false;
  }
  return input.nextEl !== undefined || input.nextElsewhere || input.where !== now.tappedWhere;
}

/** One DOM read of a step: whether it is finished now. Mutates the seen record. */
export function domConfirms(now: Seen, input: CompletionInput): boolean {
  const { el, nextEl } = input;
  if (el !== undefined) now.found = true;
  else if (now.found) return true;
  // Until this step's own control has shown, the next control appearing
  // means nothing: a sheet mounts its fields a frame after it opens.
  if (!now.found) return false;
  if (nextEl === undefined) now.nextAbsent = true;
  else if (now.nextAbsent) return true;
  return tapConfirmed(now, input);
}

/**
 * Calls onComplete once per step when the DOM shows the person did it: this
 * control disappearing (or a modal covering it) after it showed, the next
 * step's control appearing after being absent, or, after a tap on the
 * control, the next step's control on screen within TAP_CONFIRM_MS (a tap
 * whose action failed leaves the step up). A field finishes when it holds
 * text and loses focus, or when the next step's control is tapped. Every
 * check runs after the control's own handler, so its navigation lands first.
 */
export function useStepCompletion(input: CompletionInput, onComplete: () => void): void {
  const { stepKey, enabled, el, nextEl } = input;
  const live = useRef(input);
  live.current = input;
  const [, setTick] = useState(0);
  const latest = useRef(onComplete);
  latest.current = onComplete;
  const seen = useRef<Seen>(freshSeen(''));
  if (seen.current.key !== stepKey) seen.current = freshSeen(stepKey);
  const complete = useRef(() => {
    if (seen.current.done) return;
    seen.current.done = true;
    latest.current();
  });

  // DOM changes: read on every render (the live tick re-renders on any change).
  useEffect(() => {
    if (!enabled || seen.current.done) return;
    if (domConfirms(seen.current, live.current)) complete.current();
  });

  useEffect(() => {
    if (!enabled || el === undefined) return;
    const field = textFieldOf(el);
    const timers: number[] = [];
    const later = (fn: () => void): void => {
      timers.push(window.setTimeout(fn, 0));
    };
    const onClick = (event: Event): void => {
      const node = targetNode(event);
      if (field === undefined && contains(el, node)) {
        seen.current.tappedAt = performance.now();
        seen.current.tappedWhere = live.current.where;
        later(() => setTick((t) => t + 1));
      }
      if (field !== undefined && contains(nextEl, node)) later(() => complete.current());
    };
    const onBlur = (): void => {
      if (field !== undefined && fieldValue(field) !== '') complete.current();
    };
    document.addEventListener('click', onClick, true);
    el.addEventListener('focusout', onBlur);
    return () => {
      for (const timer of timers) window.clearTimeout(timer);
      document.removeEventListener('click', onClick, true);
      el.removeEventListener('focusout', onBlur);
    };
  }, [stepKey, enabled, el, nextEl]);
}

const GUARDED_EVENTS = ['pointerdown', 'mousedown', 'click'] as const;
export const NUDGE_MS = 300;

/** Whether an event came from the person; injectable so tests can mark synthetic taps as theirs. */
export const eventTrust = { isTrusted: (event: Event): boolean => event.isTrusted };

/** Regions besides the control that take taps: the next control (field steps), the control's form. */
export interface GuardAllowed {
  next: HTMLElement | undefined;
  form: HTMLElement | undefined;
}

/**
 * While a control is boxed, a tap anywhere else (outside the control, outside
 * the guide's own bar and cards, outside the allowed regions) is swallowed in
 * the capture phase and nudges the hand and label. The control itself is never
 * touched: its own tap does the real thing. Programmatic events (a button
 * clicking a hidden file input) pass. Returns the nudge count (0: none yet).
 */
export function useTapGuard(control: HTMLElement | undefined, allowed: GuardAllowed): number {
  const [nudge, setNudge] = useState(0);
  const { next, form } = allowed;
  useEffect(() => {
    if (control === undefined) return;
    const guard = (event: Event): void => {
      if (!eventTrust.isTrusted(event)) return;
      const node = targetNode(event);
      if (
        node === undefined ||
        contains(control, node) ||
        contains(next, node) ||
        contains(form, node) ||
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
  }, [control, next, form]);
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
