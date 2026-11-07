// The thread view's frame: full screen over the chat on the opaque canvas
// token (no blur, no translucency), the 56px ui/HeaderBar with "Close thread"
// (the back "<") on the left and the thread's post title on one line, then the
// thread's list and its composer (the caller's). Close and Escape (while the view has focus) close
// it. Motion (docs/motion.md, push): on a phone the view enters from the
// right (280 ms) and goes back the same way (240 ms); a drag from the left
// 28 px follows the finger and closes past 130 px or on a flick, else springs
// back. Back skips the move when the browser already animated it (iPhone
// swipe, hasUAVisualTransition). Laptop: instant. Never a fade. The incoming
// edge is a 1px ring, no shadow. The header carries the rows' long-press
// guard. Tokens only; light and dark at parity.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent, ReactElement, ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { useCoarsePointer, useIsLaptop } from '@/lib/use-is-laptop';
import { NO_TOUCH_SELECT } from '@/components/chat/chat-type';
import { useModalFocus } from '@/lib/modal-focus';
import { HeaderBar } from '@/components/ui/HeaderBar';
import {
  EDGE_BACK_CLOSE_PX,
  EDGE_BACK_ZONE_PX,
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
  selecting: boolean;
  /** The close finished (after the push back): unmount the view. */
  onClosed: () => void;
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
  // Push in from the first frame (the view is already painted at rest; the
  // move is laid over it). Laptop: instant.
  useLayoutEffect(() => {
    if (!laptop) pushIn(rootRef.current);
    // Mount only: the push runs once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Focus lands on Close so Escape reaches the view.
  useEffect(() => {
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
    if (laptop || skipForUATransition()) {
      onClosedRef.current();
      return;
    }
    const played = pushBack(el, null, fromX);
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
    },
    onDismiss: (offset) => close(offset),
    onCancel: (offset) => {
      const el = rootRef.current;
      if (el === null) return;
      el.style.transform = '';
      pushSettle(el, offset);
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
      // The incoming edge: the card height's lit edge, no ring.
      className="absolute inset-0 z-nav flex flex-col bg-bg lit-card"
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
        <HeaderBar
          compact
          title={<span data-thread-view-title="">{props.title}</span>}
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
