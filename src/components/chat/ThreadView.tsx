// The thread view's frame: full screen over the chat on the opaque canvas
// token (no blur, no translucency), the 56px ui/HeaderBar with "Close thread"
// (the back "<") on the left and the thread's title (the root card's title
// for any card kind, else "Thread") over the chat's name (sans, secondary
// role), then the
// thread's list and its composer (the caller's). Close and Escape (while the view has focus) close
// it. Motion (docs/motion.md, push): on a phone the view enters from the
// right (280 ms) and goes back the same way (240 ms); a drag from the left
// 28 px follows the finger and closes past 130 px or on a flick, else springs
// back. Back skips the move when the browser already animated it (iPhone
// swipe, hasUAVisualTransition). Laptop: instant. Never a fade. The incoming
// edge is a 1px ring, no shadow. The chat pane (behindRef) shifts left under
// the push and returns on Back. The header carries the rows' long-press
// guard. Tokens only; light and dark at parity.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent, ReactElement, ReactNode, RefObject } from 'react';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/cn';
import { useCoarsePointer, useIsLaptop } from '@/lib/use-is-laptop';
import { NO_TOUCH_SELECT } from '@/components/chat/chat-type';
import { useModalFocus } from '@/lib/modal-focus';
import { HeaderBar } from '@/components/ui/HeaderBar';
import { textRole } from '@/components/ui/Text';
import {
  Bone,
  DUR_BACK_MS,
  EASE,
  EDGE_BACK_CLOSE_PX,
  EDGE_BACK_ZONE_PX,
  PUSH,
  PUSH_BEHIND_SHIFT,
  play,
  pushBack,
  pushIn,
  pushSettle,
  skipForUATransition,
  useDragDismiss,
} from '@/lib/motion';

/**
 * Whether a keydown in the view closes it: Escape, not already handled, while
 * no menu or sheet is open over it and the thread is not selecting (Escape
 * then leaves selection first). Pure.
 */
export function escapeCloses(input: {
  key: string;
  defaultPrevented: boolean;
  overlayOpen: boolean;
  selecting: boolean;
}): boolean {
  return (
    input.key === 'Escape' && !input.defaultPrevented && !input.overlayOpen && !input.selecting
  );
}

export function ThreadViewFrame(props: {
  title: string;
  /** The second line of every thread: the chat's name. */
  subtitle?: string | undefined;
  selecting: boolean;
  /** The close finished (after the push back): unmount the view. */
  onClosed: () => void;
  /** The chat pane under the view: shifts left on the push, returns on Back. */
  behindRef?: RefObject<HTMLElement | null>;
  /** The thread's list, then its composer (or the selection bar). */
  children: ReactNode;
}): ReactElement {
  const laptop = useIsLaptop();
  const coarse = useCoarsePointer();
  const [closing, setClosing] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  // FB2: focus moves in (Close), Tab stays inside the view, and returns to
  // the opener when it goes. No aria-modal: the view's own Escape reads
  // aria-modal as "another overlay is up".
  useModalFocus(rootRef, true, { initial: () => closeRef.current });
  const onClosedRef = useRef(props.onClosed);
  onClosedRef.current = props.onClosed;
  const behind = (): HTMLElement | null => props.behindRef?.current ?? null;
  const returnedRef = useRef(false);
  // Push in from the first frame (the view is already painted at rest; the
  // move is laid over it). Its height is held until the push is done, so a
  // rising keyboard never reflows it mid-move. Laptop: instant.
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (laptop || el === null) return;
    el.style.height = `${el.offsetHeight}px`;
    el.style.bottom = 'auto';
    const release = (): void => {
      el.style.height = '';
      el.style.bottom = '';
    };
    const played = pushIn(el, behind());
    if (played.instant) release();
    else void played.done.then(release);
    // Mount only: the push runs once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Unmounted without a push back (instant close, chat switch): return the
  // pane, before a next view's push (layout phase).
  useLayoutEffect(
    () => () => {
      const pane = behind();
      if (pane === null || returnedRef.current) return;
      pane.style.translate = '';
      pushBack(null, pane);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  // Focus lands on Close so Escape reaches the view, unless the composer
  // already took it (a Reply opened the thread, L3).
  useEffect(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && rootRef.current?.contains(active) === true) return;
    closeRef.current?.focus({ preventScroll: true });
  }, []);
  /**
   * Leave from `fromX` px (0, or where an edge drag let go): push back, then
   * unmount. Instant on a laptop, under Reduce Motion, or when the browser
   * already animated this back (iPhone swipe).
   */
  const close = (fromX = 0): void => {
    if (closing) return;
    setClosing(true);
    const el = rootRef.current;
    if (el !== null) el.style.transform = '';
    const pane = behind();
    if (pane !== null) pane.style.translate = '';
    if (laptop || skipForUATransition()) {
      onClosedRef.current();
      return;
    }
    returnedRef.current = pane !== null;
    const played = pushBack(el, pane, fromX);
    if (played.instant) onClosedRef.current();
    else void played.done.then(() => onClosedRef.current());
  };
  // Edge back: a drag from the left edge follows the finger.
  const edgeBack = useDragDismiss({
    axis: 'x',
    direction: 1,
    closeAt: EDGE_BACK_CLOSE_PX,
    edgeZone: EDGE_BACK_ZONE_PX,
    enabled: !laptop && !closing,
    onMove: (offset) => {
      const el = rootRef.current;
      if (el !== null) el.style.transform = `translateX(${offset}px)`;
      // translate composes with the held shift: -w * SHIFT * (1 - offset / w).
      const pane = behind();
      if (pane !== null) pane.style.translate = `${offset * PUSH_BEHIND_SHIFT}px 0`;
    },
    onDismiss: (offset) => close(offset),
    onCancel: (offset) => {
      const el = rootRef.current;
      if (el === null) return;
      el.style.transform = '';
      pushSettle(el, offset);
      const pane = behind();
      if (pane === null) return;
      pane.style.translate = '';
      const held = -el.getBoundingClientRect().width * PUSH_BEHIND_SHIFT;
      play(
        pane,
        PUSH,
        [
          { transform: `translateX(${held + offset * PUSH_BEHIND_SHIFT}px)` },
          { transform: `translateX(${held}px)` },
        ],
        { duration: DUR_BACK_MS, easing: EASE.ios },
      );
    },
  });
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const overlayOpen = document.querySelector('[aria-modal="true"], [role="menu"]') !== null;
    if (
      !escapeCloses({
        key: event.key,
        defaultPrevented: event.defaultPrevented,
        overlayOpen,
        selecting: props.selecting,
      })
    ) {
      return;
    }
    event.preventDefault();
    close();
  };
  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-label={props.title}
      data-thread-view=""
      onKeyDown={onKeyDown}
      {...edgeBack}
      // Flat look: an in-content pane over the thread, no card height or ring.
      className="absolute inset-0 z-nav flex flex-col bg-bg"
    >
      {/* The header carries the rows' long-press guard (no callout on touch). */}
      <div
        data-thread-view-header=""
        className={cn('shrink-0', NO_TOUCH_SELECT)}
        {...(coarse
          ? { onContextMenu: (e: { preventDefault: () => void }) => e.preventDefault() }
          : {})}
      >
        {/* FN23: the dismiss is a chevron, like every other chat layer's back. */}
        {/* 8 Nov 2026: the chat's name under the title reads in the sans
            secondary role (HeaderBar's own subtitle is the mono meta role),
            through the bar's title slot. */}
        <HeaderBar
          compact
          title={<span data-thread-view-title="">{props.title}</span>}
          titleSlot={
            <>
              <h1 className={textRole('title', 'truncate')}>
                <span data-thread-view-title="">{props.title}</span>
              </h1>
              {props.subtitle !== undefined ? (
                <span data-thread-view-subtitle="" className={textRole('secondary')}>
                  {props.subtitle}
                </span>
              ) : null}
            </>
          }
          onBack={() => close()}
          backProps={{
            label: 'Close thread',
            buttonRef: closeRef,
            'data-thread-view-close': '',
          }}
        />
      </div>
      {props.children}
    </div>
  );
}

/** Placeholder rows (photo, name, line) sized like message rows. */
export const THREAD_FILL_ROWS = ['w-48', 'w-36', 'w-56'];
export const THREAD_LOAD_FAILED = "Couldn't load this thread.";

/** Under the root: placeholder rows while the first page reads, or the failure + Retry. */
export function ThreadViewFill(props: {
  loading: boolean;
  failed: boolean;
  onRetry: () => void;
}): ReactElement | null {
  if (props.failed) {
    return (
      <div
        data-thread-load-failed=""
        role="alert"
        className="flex shrink-0 items-center justify-between gap-3 px-4 py-2"
      >
        <span className={textRole('secondary')}>{THREAD_LOAD_FAILED}</span>
        <Button variant="ghost" className="min-w-11" onClick={props.onRetry}>
          Retry
        </Button>
      </div>
    );
  }
  if (!props.loading) return null;
  return (
    <ul data-thread-fill="" aria-busy="true" className="flex shrink-0 flex-col gap-3 px-4 py-2">
      <li className="sr-only">Loading replies</li>
      {THREAD_FILL_ROWS.map((width) => (
        <li key={width} className="flex gap-3" aria-hidden="true">
          <Bone lit="lit-avatar" as="span" className="h-8 w-8 shrink-0 rounded-lg" />
          <span className="flex min-w-0 flex-1 flex-col gap-2">
            <Bone lit="flat" className="h-3 w-24 rounded" />
            <Bone lit="flat" className={cn('h-4 rounded', width)} />
          </span>
        </li>
      ))}
    </ul>
  );
}
