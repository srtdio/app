// The guide's behaviour on the real DOM: what finishes a step (the tap, the
// next control appearing, this one disappearing, a filled field losing focus),
// the guard that keeps every other tap from reaching the app, the 4 s skip for
// a control that never shows, and element sizes.
// Every listener, observer and timer is removed on cleanup.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ABSENT_SKIP_MS } from '@/lib/induction';
import { viewportSize } from '@/lib/use-is-laptop';

/** How long the first step after a load waits for its control before going back to an earlier one on screen. */
export const RESUME_BACK_MS = 700;
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
  /**
   * Only a tap on the control finishes the step: the next control being on
   * screen already (a Reply below a highlight) must not finish it by itself.
   */
  tapFirst?: boolean;
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

/** Whether a tap on the control is still waiting for confirmation. */
function tapPending(now: Seen): boolean {
  return now.tappedAt > 0 && performance.now() - now.tappedAt <= TAP_CONFIRM_MS;
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
  // The control going away counts only after a tap on it: a sheet closed by
  // its backdrop, Cancel or Escape leaves the step up.
  else if (now.found) return tapPending(now);
  // Until this step's own control has shown, the next control appearing
  // means nothing: a sheet mounts its fields a frame after it opens.
  if (!now.found) return false;
  if (nextEl === undefined) now.nextAbsent = true;
  else if (now.nextAbsent && input.tapFirst !== true) return true;
  return tapConfirmed(now, input);
}

/**
 * Calls onComplete once per step when the DOM shows the person did it: this
 * control disappearing (or a modal covering it) after a tap on it, the next
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
 *
 * The first step after a page load is the stored one: after a refresh its
 * control can sit in a sheet that is now closed (Continue in the workspace
 * form). When an earlier control of the same task is on screen instead
 * (`earlierShown`), that step moves after RESUME_BACK_MS, not ABSENT_SKIP_MS,
 * so the hand is back on the button that reopens it almost at once. Only the
 * first step: mid-tour, a sheet's next control can mount late on purpose.
 */
export function useAbsentSkip(
  input: { stepKey: string; found: boolean; earlierShown: boolean },
  onAbsent: () => void,
): void {
  const { stepKey, found, earlierShown } = input;
  const latest = useRef(onAbsent);
  latest.current = onAbsent;
  const seen = useRef({ key: '', found: false });
  if (seen.current.key !== stepKey) seen.current = { key: stepKey, found: false };
  if (found) seen.current.found = true;
  const firstKey = useRef(stepKey);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (!seen.current.found) latest.current();
    }, ABSENT_SKIP_MS);
    return () => window.clearTimeout(timer);
  }, [stepKey]);

  const resume = stepKey === firstKey.current && earlierShown && !found;
  useEffect(() => {
    if (!resume) return;
    const timer = window.setTimeout(() => {
      if (!seen.current.found) latest.current();
    }, RESUME_BACK_MS);
    return () => window.clearTimeout(timer);
  }, [resume]);
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

/** How long after the last keystroke the entry hand may show. */
export const TYPING_PAUSE_MS = 900;

/**
 * True while the person is typing (a keystroke in the last TYPING_PAUSE_MS),
 * re-rendering when the pause ends, so the hand never lands mid-word.
 */
export function useTypingNow(pauseMs: number = TYPING_PAUSE_MS): boolean {
  const [typing, setTyping] = useState(false);
  useEffect(() => {
    let timer: number | undefined;
    const onInput = (): void => {
      setTyping(true);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setTyping(false), pauseMs);
    };
    document.addEventListener('input', onInput, true);
    return () => {
      document.removeEventListener('input', onInput, true);
      window.clearTimeout(timer);
    };
  }, [pauseMs]);
  return typing;
}

/** In the app: how long typing must pause before a button step's box shows. */
export const APP_TYPING_PAUSE_MS = 1500;

/** The longest a step waits for the page behind it before it points anyway. */
export const PHOTOS_WAIT_CAP_MS = 5000;

/**
 * Something on screen is still arriving: a photo not yet painted, a list still
 * loading (data-guide-wait), or the sample week being seeded.
 */
function pagePending(): boolean {
  if (document.documentElement.hasAttribute('data-guide-seeding')) return true;
  const { height } = viewportSize();
  return Array.from(document.querySelectorAll('[data-thumb-loading], [data-guide-wait]')).some(
    (el) => {
      const r = el.getBoundingClientRect();
      return r.bottom > 0 && r.top < height && r.width > 0;
    },
  );
}

/**
 * True while the page behind the step has finished arriving (photos painted,
 * lists loaded), checked live for the first PHOTOS_WAIT_CAP_MS of a step: the
 * guide points at a control only once the page looks finished.
 */
export function usePhotosSettled(stepKey: string): boolean {
  const [state, setState] = useState<{ key: string; settled: boolean }>({
    key: stepKey,
    settled: false,
  });
  useEffect(() => {
    const started = Date.now();
    const check = (): boolean => {
      const capped = Date.now() - started >= PHOTOS_WAIT_CAP_MS;
      const settled = capped || !pagePending();
      setState((prev) =>
        prev.key === stepKey && prev.settled === settled ? prev : { key: stepKey, settled },
      );
      return capped;
    };
    if (check()) return;
    const id = window.setInterval(() => {
      if (check()) window.clearInterval(id);
    }, 100);
    return () => window.clearInterval(id);
  }, [stepKey]);
  return state.key === stepKey && state.settled;
}

/** A gap in the dim shorter than this stays dimmed: no bright flash between steps. */
export const DIM_HOLD_MS = 600;

let lastDimAt = 0;

/**
 * Keeps the screen dimmed across a short gap (a sheet sliding in, a button
 * enabling a moment later): returns true while the dim is off but was on within
 * DIM_HOLD_MS, and re-renders when that hold ends.
 */
export function useDimHold(dimmed: boolean): boolean {
  const [, setTick] = useState(0);
  const now = performance.now();
  if (dimmed) lastDimAt = now;
  const holding = !dimmed && lastDimAt > 0 && now - lastDimAt < DIM_HOLD_MS;
  useEffect(() => {
    if (!holding) return;
    const id = window.setTimeout(
      () => setTick((t) => t + 1),
      DIM_HOLD_MS - (performance.now() - lastDimAt) + 5,
    );
    return () => window.clearTimeout(id);
  });
  return holding;
}
