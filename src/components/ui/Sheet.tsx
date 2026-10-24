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
   * Unsaved input. While true, every close path (X, backdrop tap, Escape)
   * opens a discard confirm instead of closing. The caller's own actions (the
   * primary button) are never blocked.
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

// Exit transition length; mirrors --dur-base so the closing phase stays mounted
// exactly as long as the fade/slide-out takes, then unmounts. Under
// prefers-reduced-motion the CSS collapses to 1ms but this timer still fires,
// so unmount always happens.
const EXIT_MS = DUR_BASE_MS;

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
  // `rendered` keeps the panel mounted through its exit; `entered` drives the
  // enter/exit transition (false = offscreen/faded, true = resting).
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
        className={cn(
          // Axis: translateY only. Mobile slides from 100%; desktop rises 8px
          // and crossfades. No X, no rotate.
          // Phone height caps at 90dvh (the visible viewport under Safari's
          // bars); 90vh stays as the fallback where dvh is unknown.
          'flex w-full max-h-[90vh] supports-[height:1dvh]:max-h-[90dvh] flex-col overflow-hidden rounded-t-2xl focus:outline-none border border-border-strong bg-panel shadow-2xl transition-[opacity,transform] will-change-transform sm:w-[540px] sm:max-w-[92%] sm:max-h-[84vh] sm:rounded-xl',
          fixedHeight === true && 'sm:h-[min(640px,84vh)]',
          wide === true && 'lg:w-[960px]',
          entered
            ? 'translate-y-0 opacity-100 duration-slow ease-enter sm:duration-base'
            : 'translate-y-full opacity-100 duration-base ease-exit sm:translate-y-2 sm:opacity-0',
        )}
      >
        <div className="flex items-center gap-2.5 px-[18px] py-[15px] border-b border-border">
          <h2 className="line-clamp-2 min-w-0 font-semibold text-[15px] [overflow-wrap:anywhere]">
            {title}
          </h2>
          <span className="ml-auto flex items-center gap-2">
            {busy ? <span className="text-legacy-xs text-fg-3">{busyLabel}</span> : null}
            <IconButton
              label="Close"
              onClick={requestClose}
              {...(busy
                ? {
                    'aria-disabled': 'true' as const,
                    className: 'cursor-default !text-fg-3 hover:!bg-transparent active:!scale-100',
                  }
                : {})}
            >
              <IconX />
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
          // The footer's bottom padding clears the iPhone home bar.
          <div className="flex items-center gap-2.5 px-[18px] pt-3 pb-[max(12px,env(safe-area-inset-bottom))] border-t border-border">
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
