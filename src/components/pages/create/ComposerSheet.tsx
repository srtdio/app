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
import { dialogIn, dialogOut, riseIn, riseOut, trackDim, usePresence } from '@/lib/motion';
import { useIsLaptop } from '@/lib/use-is-laptop';

/** The question every close path asks while the New post sheet holds a change. */
export const COMPOSER_DISCARD_TITLE = 'Discard changes?';

interface ComposerSheetProps {
  open: boolean;
  onClose: () => void;
  /** The header text and the dialog's accessible name ("New post"). */
  title: string;
  /** The header's right side: the save buttons. No footer exists. */
  actions: ReactNode;
  children: ReactNode;
  /** Any change: every close path (X, backdrop, Escape, Back) asks first. */
  dirty?: boolean;
  /** A save is in flight: every close path does nothing. */
  busy?: boolean;
  /** Where focus lands on open (the Title field), phone and laptop. */
  initialFocus?: () => HTMLElement | null;
  /** Discard confirm copy. Default: "Discard changes?" with no message (New post). */
  discard?: { title: string; message: string };
  /** At lg+ the box widens to 960px for the side preview. Default true (New post). */
  wide?: boolean;
}

/**
 * The full New post sheet's frame (New brief uses it too, narrow): the shared Sheet's panel, motion, focus,
 * Escape and Back handling, with its own header (the title left, then the
 * save buttons, then the close X far right, as every sheet header) and no
 * footer. The shared Sheet's header holds only a title and its X, so this
 * frame lives here.
 */
export function ComposerSheet({
  open,
  onClose,
  title,
  actions,
  children,
  dirty = false,
  busy = false,
  initialFocus,
  discard,
  wide = true,
}: ComposerSheetProps) {
  // Motion (docs/motion.md, rise), as the shared Sheet: the panel renders at
  // its resting place from the first frame and the move is laid over it.
  // Phone: rises from 100% and leaves to 100%; the dim tracks the panel.
  // Laptop: the centre box grows 95% to 100%. Never a fade.
  const isLaptop = useIsLaptop();
  const laptopRef = useRef(isLaptop);
  laptopRef.current = isLaptop;
  const dimRef = useRef<HTMLDivElement>(null);
  const presence = usePresence<HTMLDivElement>(open, {
    enter: (el) => {
      if (laptopRef.current) return dialogIn(el);
      const played = riseIn(el);
      trackDim(el, dimRef.current, played);
      return played;
    },
    exit: (el) => {
      if (laptopRef.current) return dialogOut(el);
      const played = riseOut(el);
      trackDim(el, dimRef.current, played);
      return played;
    },
  });
  const rendered = presence.rendered;
  const panelRef = presence.ref;

  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (!open) setConfirming(false);
  }, [open]);

  function requestClose(): void {
    if (busy) return;
    if (dirty) {
      setConfirming(true);
      return;
    }
    onClose();
  }

  useEscapeLayer(open, requestClose);

  useModalFocus(
    panelRef,
    open && rendered,
    initialFocus !== undefined ? { initial: initialFocus } : {},
  );

  // The modal focus keeps text fields out on touch; this sheet's first field
  // takes focus on phone too, so it is focused here once the panel is in.
  const initialRef = useRef(initialFocus);
  initialRef.current = initialFocus;
  const focusNow = open && rendered;
  useEffect(() => {
    if (!focusNow) return;
    initialRef.current?.()?.focus({ preventScroll: true });
  }, [focusNow]);

  const guard = useBackGuard({
    active: open && (dirty || busy),
    onBack: () => {
      if (busy) return;
      setConfirming(true);
    },
  });

  if (!rendered) return null;

  function onOverlayClick(event: MouseEvent<HTMLDivElement>): void {
    if (event.target === event.currentTarget) requestClose();
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center sm:justify-center"
      onClick={onOverlayClick}
    >
      {/* The dim: its own layer (so it never dims the panel), tracking the
          panel's position; a tap on it falls through to the overlay's close. */}
      <div
        ref={dimRef}
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-scrim"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        aria-label={title}
        data-composer-sheet=""
        className={cn(
          // Axis: rise (translateY) on phone, scale on laptop, as the shared Sheet.
          'relative flex w-full max-h-[90svh] supports-[height:1dvh]:max-h-[90dvh] flex-col overflow-hidden rounded-t-2xl focus:outline-none border bg-panel lit-overlay will-change-transform sm:w-[540px] sm:max-w-[92%] sm:max-h-[84svh] sm:rounded-xl',
          wide && 'lg:w-[960px]',
        )}
      >
        <div
          data-composer-header=""
          className="flex min-w-0 items-center gap-1.5 border-b border-border py-2 pl-[18px] pr-1.5 sm:gap-2.5 sm:pr-2.5"
        >
          <h2 className="min-w-0 flex-1 truncate text-lg font-semibold text-fg">{title}</h2>
          <div className="flex shrink-0 items-center gap-1.5 sm:gap-2.5">{actions}</div>
          <IconButton
            label="Close"
            onClick={requestClose}
            className={cn(
              'shrink-0',
              // fg-3 sorts after IconButton's fg-2 / hover fg, so it wins unforced.
              busy && 'cursor-default text-fg-3 hover:text-fg-3',
            )}
            {...(busy ? { 'aria-disabled': 'true' as const } : {})}
          >
            <IconX size={ICON_SIZE.control} />
          </IconButton>
        </div>
        <div className="overflow-y-auto px-[18px] py-4 pb-[max(16px,env(safe-area-inset-bottom))]">
          {children}
        </div>
      </div>
      {confirming ? (
        <ConfirmDialog
          title={discard?.title ?? COMPOSER_DISCARD_TITLE}
          {...(discard !== undefined ? { message: discard.message } : {})}
          confirmLabel="Discard"
          cancelLabel="Keep editing"
          destructive
          onConfirm={() => {
            setConfirming(false);
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
