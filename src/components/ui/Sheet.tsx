import { mark } from '@/lib/perf-marks';
import { useEffect, useRef, useState } from 'react';
import type { MouseEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { IconButton } from '@/components/ui/IconButton';
import { ICON_SIZE, IconX } from '@/components/ui/icons';
import { useBackGuard } from '@/lib/back-guard';
import { cn } from '@/lib/cn';
import { useEscapeLayer } from '@/lib/escape-stack';
import { useModalFocus } from '@/lib/modal-focus';
import {
  SHEET_CLOSE_PX,
  dialogIn,
  dialogOut,
  dimFor,
  riseIn,
  riseOut,
  useDragDismiss,
  usePresence,
} from '@/lib/motion';
import { dimWith } from '@/lib/motion/overlays';
import { bottomAnchorProps } from '@/lib/bottom-inset';
import { useIsLaptop } from '@/lib/use-is-laptop';

interface SheetProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  /**
   * At sm+ the box keeps one fixed height, min(640px, 84vh), from its first
   * paint (a list that loads or filters inside never grows it); the body
   * fills it. Phone and the default (content height) are unchanged.
   */
  fixedHeight?: boolean;
  /** At lg+ the box widens to 960px so a side column fits beside the form. */
  wide?: boolean;
  /**
   * Unsaved input. While true, every close path (X, backdrop tap, Escape,
   * drag down) opens a discard confirm instead of closing. The caller's own
   * actions (the primary button) are never blocked.
   */
  dirty?: boolean;
  /** Discard confirm copy, passed by the caller, e.g. "Discard this post?". */
  discard?: { title: string; message: string };
  /** A save is in flight: every close path does nothing and the header shows busyLabel. */
  busy?: boolean;
  /** Header text while busy. Default "Saving…". */
  busyLabel?: string;
}

const DEFAULT_DISCARD = { title: 'Discard changes?', message: 'Your changes will be lost.' };

export function Sheet({
  open,
  onClose,
  title,
  children,
  footer,
  fixedHeight,
  wide,
  dirty = false,
  discard,
  busy = false,
  busyLabel = 'Saving…',
}: SheetProps) {
  // Motion (docs/motion.md, rise): the panel renders at its resting place from
  // the first frame and the move is laid over it. Phone: rises from 100%
  // (320 ms), leaves to 100% (240 ms); the dim tracks the panel's position.
  // Laptop (useIsLaptop): the centre box grows 95% to 100%. Never a fade.
  const isLaptop = useIsLaptop();
  const laptopRef = useRef(isLaptop);
  laptopRef.current = isLaptop;
  const dimRef = useRef<HTMLDivElement>(null);
  // Where a drag down left the panel when it closed: the exit starts there.
  const dragOffset = useRef(0);
  const presence = usePresence<HTMLDivElement>(open, {
    enter: (el) => {
      dragOffset.current = 0;
      el.style.transform = '';
      if (laptopRef.current) return dialogIn(el);
      return dimWith(el, dimRef.current, riseIn(el));
    },
    exit: (el) => {
      if (laptopRef.current) return dialogOut(el);
      const played = riseOut(el, dragOffset.current);
      // The exit move now holds the panel; drop the drag's inline offset.
      el.style.transform = '';
      return dimWith(el, dimRef.current, played);
    },
  });
  const rendered = presence.rendered;
  const panelRef = presence.ref;

  useEffect(() => {
    if (open) mark('sheet:open');
  }, [open]);

  const openRef = useRef(open);
  openRef.current = open;
  const wasOpen = useRef(open);

  const [confirming, setConfirming] = useState(false);

  // Drop a pending discard confirm when the caller closes the sheet itself.
  useEffect(() => {
    if (!open) setConfirming(false);
  }, [open]);

  // Every close path (X, backdrop, Escape) funnels here. Busy ignores it; dirty
  // asks first.
  function requestClose(): void {
    if (busy) return;
    if (dirty) {
      setConfirming(true);
      return;
    }
    onClose();
  }

  // Released short of the close line (or blocked by busy or dirty): the panel
  // springs back from where the finger left it and the dim follows.
  function springBack(offset: number): void {
    const panel = panelRef.current;
    if (panel === null) return;
    panel.style.transform = '';
    dimWith(panel, dimRef.current, riseIn(panel, offset));
  }

  // Phone: drag down from the top edge (the header) follows the finger and
  // closes past SHEET_CLOSE_PX or on a flick. Laptop has no drag.
  const drag = useDragDismiss({
    axis: 'y',
    direction: 1,
    closeAt: SHEET_CLOSE_PX,
    enabled: !isLaptop && open,
    onMove: (offset) => {
      const panel = panelRef.current;
      if (panel === null) return;
      panel.style.transform = `translateY(${offset}px)`;
      if (dimRef.current !== null)
        dimRef.current.style.opacity = dimFor(offset, panel.offsetHeight);
    },
    onDismiss: (offset) => {
      if (busy) {
        springBack(offset);
        return;
      }
      if (dirty) {
        springBack(offset);
        setConfirming(true);
        return;
      }
      dragOffset.current = offset;
      onClose();
      // A caller that keeps the sheet open (its own guard) gets it back at rest.
      requestAnimationFrame(() => {
        if (openRef.current) {
          dragOffset.current = 0;
          springBack(offset);
        }
      });
    },
    onCancel: (offset) => springBack(offset),
  });

  // Escape reaches the sheet only while it is the top layer, so Escape in a
  // Select or DatePicker inside it closes just that.
  useEscapeLayer(open, requestClose);

  // Focus moves into the panel on open, Tab stays inside, and the opener gets
  // it back on close. `rendered` lags `open` by one render on a reopen.
  useModalFocus(panelRef, open && rendered);

  // System or browser Back while there is something to lose: dirty asks (the
  // same discard confirm as the X), busy keeps the sheet as it is. The guard
  // is released right before a confirmed Discard, so that close pops cleanly;
  // an unmount while guarded releases it in the hook's own cleanup.
  const guard = useBackGuard({
    active: open && (dirty || busy),
    onBack: () => {
      if (busy) return;
      setConfirming(true);
    },
  });

  if (open && !rendered) mark(`sheet:open:${title}`);
  if (wasOpen.current && !open) mark(`sheet:close:${title}`);
  wasOpen.current = open;
  if (!rendered) {
    return null;
  }

  function onOverlayClick(event: MouseEvent<HTMLDivElement>): void {
    if (event.target === event.currentTarget) {
      requestClose();
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center sm:justify-center"
      onClick={onOverlayClick}
    >
      {/* The dim. Full scrim at rest; on phone its opacity is set per frame
          from the panel's position (trackDim, dimFor), never a timed fade.
          Taps pass through to the overlay, which closes. */}
      <div
        ref={dimRef}
        aria-hidden="true"
        data-sheet-dim=""
        className="pointer-events-none absolute inset-0 bg-scrim"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        aria-label={title}
        className={cn(
          // Rendered at rest; the rise (phone, Y) or grow (laptop, scale) is
          // laid over it by the motion module.
          // Phone height caps at 90dvh (the visible viewport under Safari's
          // bars); 90vh stays as the fallback where dvh is unknown.
          'relative flex w-full max-h-[90vh] supports-[height:1dvh]:max-h-[90dvh] flex-col overflow-hidden rounded-t-2xl focus:outline-none border bg-panel lit-overlay will-change-transform sm:w-[540px] sm:max-w-[92%] sm:max-h-[84vh] sm:rounded-xl',
          fixedHeight === true && 'sm:h-[min(640px,84vh)]',
          wide === true && 'lg:w-[960px]',
        )}
      >
        <div
          data-sheet-grab=""
          className="flex items-center gap-2.5 px-[18px] py-[15px] border-b border-border touch-none md:touch-auto"
          {...drag}
        >
          <h2 className="line-clamp-2 min-w-0 font-semibold text-lg [overflow-wrap:anywhere]">
            {title}
          </h2>
          <span className="ml-auto flex items-center gap-2">
            {busy ? <span className="text-sm text-fg-3">{busyLabel}</span> : null}
            <IconButton
              label="Close"
              onClick={requestClose}
              {...(busy
                ? {
                    'aria-disabled': 'true' as const,
                    // Muted and inert while busy: aria-disabled variants out-rank the
                    // IconButton's own ink, hover and press classes (no "!").
                    className:
                      'cursor-default aria-disabled:text-fg-3 aria-disabled:hover:bg-transparent aria-disabled:active:scale-100',
                  }
                : {})}
            >
              <IconX size={ICON_SIZE.control} />
            </IconButton>
          </span>
        </div>
        <div
          className={cn(
            'px-[18px] py-4 overflow-y-auto',
            // No footer: the body is the bottom edge, so it clears the home bar.
            footer === undefined && 'pb-[max(16px,env(safe-area-inset-bottom))]',
            fixedHeight === true && 'sm:flex sm:min-h-0 sm:flex-1 sm:flex-col',
          )}
        >
          {children}
        </div>
        {footer !== undefined ? (
          // The footer's bottom padding clears the iPhone home bar. It is an
          // bottom anchor: the phone Undo strip floats above it, never over it.
          <div
            {...bottomAnchorProps}
            className="flex items-center gap-2.5 px-[18px] pt-3 pb-[max(12px,env(safe-area-inset-bottom))] border-t border-border"
          >
            {footer}
          </div>
        ) : null}
      </div>
      {confirming ? (
        <ConfirmDialog
          title={(discard ?? DEFAULT_DISCARD).title}
          message={(discard ?? DEFAULT_DISCARD).message}
          confirmLabel="Discard"
          cancelLabel="Keep editing"
          destructive
          onConfirm={() => {
            setConfirming(false);
            // Release first: the guard's entry pops before the layer's own.
            guard.release();
            onClose();
          }}
          onCancel={() => {
            setConfirming(false);
            panelRef.current?.focus();
          }}
        />
      ) : null}
    </div>,
    document.body,
  );
}
