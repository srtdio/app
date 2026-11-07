import { useEffect, useRef, useState } from 'react';
import type { MouseEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Text } from '@/components/ui/Text';
import { IconButton } from '@/components/ui/IconButton';
import { SHEET_FRAME, SHEET_WIDE } from '@/components/ui/Sheet';
import { ICON_SIZE, IconChevronLeft } from '@/components/ui/icons';
import { LEADING_PULL } from '@/components/ui/layout';
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
  /** Any change: every close path ("<" back, backdrop, Escape, system Back) asks first. */
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
 * Escape and Back handling, with its own header (the "<" back leading, as
 * every sheet header, then the title, then the save buttons on the right) and
 * no footer. The shared Sheet's header holds one header verb at most, so this
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
      className="fixed inset-0 z-sheet flex items-end sm:items-center sm:justify-center"
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
          'relative flex flex-col overflow-hidden focus:outline-none will-change-transform',
          SHEET_FRAME,
          wide && SHEET_WIDE,
        )}
      >
        <div
          data-composer-header=""
          className="flex min-w-0 items-center gap-2 border-b border-border px-4 py-2 sm:gap-3"
        >
          {/* The one exit: "<" back leading, pulled out by 12 (LEADING_PULL). */}
          <IconButton
            label="Back"
            onClick={requestClose}
            className={cn(
              LEADING_PULL,
              'shrink-0',
              // fg-3 sorts after IconButton's fg-2 / hover fg, so it wins unforced.
              busy && 'cursor-default text-fg-3 hover:text-fg-3',
            )}
            {...(busy ? { 'aria-disabled': 'true' as const } : {})}
          >
            <IconChevronLeft size={ICON_SIZE.control} />
          </IconButton>
          <Text as="h2" role="title" className="min-w-0 flex-1 truncate text-fg">
            {title}
          </Text>
          <div className="flex shrink-0 items-center gap-2 sm:gap-3">{actions}</div>
        </div>
        <div className="overflow-y-auto px-4 py-4 pb-[max(16px,env(safe-area-inset-bottom))]">
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
