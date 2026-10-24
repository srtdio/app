// The thread view's frame: full screen over the chat on the opaque canvas
// token (no blur, no translucency), a 56px header with "Close" on the left and
// the thread's post title centred on one line, then the thread's list and its
// composer (the caller's). Close and Escape (while the view has focus) close
// it. Motion: opacity only, 150ms in and out, instant under
// prefers-reduced-motion; nothing translates, scales or rotates. The header
// carries the rows' long-press guard. Tokens only; light and dark at parity.

import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, ReactElement, ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { useMediaQuery } from '@/lib/use-media-query';
import { COARSE_POINTER_QUERY, NO_TOUCH_SELECT } from '@/components/chat/chat-type';
import { useModalFocus } from '@/lib/modal-focus';
import { ICON_SIZE, IconChevronLeft } from '@/components/ui/icons';

/** The view's fade, in and out (opacity only). */
const THREAD_VIEW_FADE_MS = 150;

/** Users who asked for less motion: the view appears and goes at once. */
const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

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
  /** The close finished (after the fade): unmount the view. */
  onClosed: () => void;
  /** The thread's list, then its composer (or the selection bar). */
  children: ReactNode;
}): ReactElement {
  const reduced = useMediaQuery(REDUCED_MOTION);
  const coarse = useMediaQuery(COARSE_POINTER_QUERY);
  const [shown, setShown] = useState(reduced);
  const [closing, setClosing] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  // FB2: focus moves in (Close), Tab stays inside the view, and returns to
  // the opener when it goes. No aria-modal: the view's own Escape reads
  // aria-modal as "another overlay is up".
  useModalFocus(rootRef, true, { initial: () => closeRef.current });
  const onClosedRef = useRef(props.onClosed);
  onClosedRef.current = props.onClosed;
  // Fade in from the first frame; focus lands on Close so Escape reaches the view.
  useEffect(() => {
    closeRef.current?.focus({ preventScroll: true });
    if (reduced) return;
    const frame = window.requestAnimationFrame(() => setShown(true));
    return () => window.cancelAnimationFrame(frame);
    // Mount only: the fade runs once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!closing) return;
    if (reduced) {
      onClosedRef.current();
      return;
    }
    const timer = window.setTimeout(() => onClosedRef.current(), THREAD_VIEW_FADE_MS);
    return () => window.clearTimeout(timer);
  }, [closing, reduced]);
  const close = (): void => setClosing(true);
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
      className={cn(
        'absolute inset-0 z-30 flex flex-col bg-bg transition-opacity duration-150 motion-reduce:transition-none',
        shown && !closing ? 'opacity-100' : 'opacity-0',
      )}
    >
      <div
        data-thread-view-header=""
        className={cn(
          'grid h-14 shrink-0 grid-cols-[88px_minmax(0,1fr)_88px] items-center border-b border-border bg-panel',
          NO_TOUCH_SELECT,
        )}
        {...(coarse
          ? { onContextMenu: (e: { preventDefault: () => void }) => e.preventDefault() }
          : {})}
      >
        <button
          ref={closeRef}
          type="button"
          data-thread-view-close=""
          aria-label="Close thread"
          onClick={close}
          className={cn(
            // FN23: the dismiss is a chevron, like every other chat layer's back.
            'ml-1 flex h-11 w-11 items-center justify-center justify-self-start rounded-lg text-fg-2 hover:bg-panel-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
            NO_TOUCH_SELECT,
          )}
        >
          <IconChevronLeft size={ICON_SIZE.control} />
        </button>
        <span
          data-thread-view-title=""
          className="truncate text-center text-base font-semibold text-fg"
        >
          {props.title}
        </span>
        <span aria-hidden="true" />
      </div>
      {props.children}
    </div>
  );
}
