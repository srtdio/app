import { useEffect, useRef, useState } from 'react';
import type { MouseEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { IconButton } from '@/components/ui/IconButton';
import { IconX } from '@/components/ui/icons';
import { useBackGuard } from '@/lib/back-guard';
import { cn } from '@/lib/cn';
import { useEscapeLayer } from '@/lib/escape-stack';
import { useModalFocus } from '@/lib/modal-focus';
import { DUR_BASE_MS } from '@/lib/motion';

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
}

const EXIT_MS = DUR_BASE_MS;

/**
 * The full New post sheet's frame: the shared Sheet's panel, motion, focus,
 * Escape and Back handling, with its own header (X left, the title, then the
 * save buttons top right) and no footer. The shared Sheet's header holds only
 * a title and its X on the right, so this frame lives here.
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
}: ComposerSheetProps) {
  const [rendered, setRendered] = useState(open);
  const [entered, setEntered] = useState(false);

  useEffect(() => {
    if (open) {
      setRendered(true);
      const raf = requestAnimationFrame(() => setEntered(true));
      return () => cancelAnimationFrame(raf);
    }
    setEntered(false);
    const timer = setTimeout(() => setRendered(false), EXIT_MS);
    return () => clearTimeout(timer);
  }, [open]);

  const [confirming, setConfirming] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

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
      className={cn(
        'fixed inset-0 z-50 flex items-end bg-scrim transition-opacity duration-base sm:items-center sm:justify-center',
        entered ? 'opacity-100 ease-enter' : 'opacity-0 ease-exit',
      )}
      onClick={onOverlayClick}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        aria-label={title}
        data-composer-sheet=""
        className={cn(
          // Axis: translateY only, as the shared Sheet.
          'flex w-full max-h-[90vh] supports-[height:1dvh]:max-h-[90dvh] flex-col overflow-hidden rounded-t-2xl focus:outline-none border border-border-strong bg-panel shadow-2xl transition-[opacity,transform] will-change-transform sm:w-[540px] sm:max-w-[92%] sm:max-h-[84vh] sm:rounded-xl lg:w-[960px]',
          entered
            ? 'translate-y-0 opacity-100 duration-slow ease-enter sm:duration-base'
            : 'translate-y-full opacity-100 duration-base ease-exit sm:translate-y-2 sm:opacity-0',
        )}
      >
        <div
          data-composer-header=""
          className="flex min-w-0 items-center gap-1.5 border-b border-border py-2 pl-1.5 pr-3 sm:gap-2.5 sm:pl-2.5 sm:pr-[18px]"
        >
          <IconButton
            label="Close"
            onClick={requestClose}
            className={cn(
              'shrink-0',
              busy && 'cursor-default !text-fg-3 hover:!bg-transparent active:!scale-100',
            )}
            {...(busy ? { 'aria-disabled': 'true' as const } : {})}
          >
            <IconX />
          </IconButton>
          <h2 className="min-w-0 flex-1 truncate text-[15px] font-semibold text-fg">{title}</h2>
          <div className="flex shrink-0 items-center gap-1.5 sm:gap-2.5">{actions}</div>
        </div>
        <div className="overflow-y-auto px-[18px] py-4 pb-[max(16px,env(safe-area-inset-bottom))]">
          {children}
        </div>
      </div>
      {confirming ? (
        <ConfirmDialog
          title={COMPOSER_DISCARD_TITLE}
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
