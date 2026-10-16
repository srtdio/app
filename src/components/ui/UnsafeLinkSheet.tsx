// "Check before opening": the bottom sheet a warning card opens. Shows the full
// link in mono, the plain-English reasons from the shared check, a primary
// "Don't open" (focused by default) and a secondary "Open anyway" that opens the
// link in a new tab with noopener noreferrer.
//
// Closes on Esc, a tap on the scrim, "Don't open", or a downward swipe on the
// sheet. Motion is translateY only (no X button, no rotate); focus is trapped
// inside while open and handed back to the card on close. Colours are tokens
// only, so light and dark parity comes from the theme.

import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent, ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { IconAlertTriangle } from '@/components/ui/icons';
import { cn } from '@/lib/cn';
import { DUR_BASE_MS } from '@/lib/motion';

export interface UnsafeLinkSheetProps {
  open: boolean;
  url: string;
  reasons: readonly string[];
  onClose: () => void;
}

/** Drag distance (px) past which a released swipe closes the sheet. */
export const SWIPE_CLOSE_PX = 80;

const FOCUSABLE = 'a[href], button:not([disabled])';

export function UnsafeLinkSheet(props: UnsafeLinkSheetProps): ReactElement | null {
  const { open, url, reasons, onClose } = props;
  const [rendered, setRendered] = useState(open);
  const [entered, setEntered] = useState(false);
  const [drag, setDrag] = useState(0);
  const panelRef = useRef<HTMLDivElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const dragStart = useRef<number | null>(null);
  const returnFocus = useRef<Element | null>(null);

  useEffect(() => {
    if (open) {
      returnFocus.current = typeof document !== 'undefined' ? document.activeElement : null;
      setRendered(true);
      setDrag(0);
      const raf = requestAnimationFrame(() => setEntered(true));
      return () => cancelAnimationFrame(raf);
    }
    setEntered(false);
    const timer = setTimeout(() => setRendered(false), DUR_BASE_MS);
    return () => clearTimeout(timer);
  }, [open]);

  // "Don't open" takes focus as soon as the sheet is on screen.
  useEffect(() => {
    if (open && rendered) primaryRef.current?.focus();
  }, [open, rendered]);

  // Hand focus back to whatever opened the sheet.
  useEffect(() => {
    if (open || rendered) return;
    const target = returnFocus.current;
    returnFocus.current = null;
    if (target instanceof HTMLElement) target.focus();
  }, [open, rendered]);

  if (!rendered) return null;

  function stop(event: { stopPropagation: () => void }): void {
    event.stopPropagation();
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    event.stopPropagation();
    if (event.key === 'Escape') {
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const nodes = Array.from(panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (first === undefined || last === undefined) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function onPointerDown(event: PointerEvent<HTMLDivElement>): void {
    dragStart.current = event.clientY;
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>): void {
    if (dragStart.current === null) return;
    setDrag(Math.max(0, event.clientY - dragStart.current));
  }

  function onPointerEnd(): void {
    if (dragStart.current === null) return;
    dragStart.current = null;
    if (drag > SWIPE_CLOSE_PX) onClose();
    else setDrag(0);
  }

  return createPortal(
    <div
      data-unsafe-sheet=""
      className={cn(
        'fixed inset-0 z-50 flex items-end justify-center bg-scrim transition-opacity duration-base',
        entered ? 'opacity-100 ease-enter' : 'opacity-0 ease-exit',
      )}
      onClick={(event) => {
        // React events from a portal still bubble through the card's parents
        // (a chat bubble's long-press, a clickable brief card): stop them here.
        event.stopPropagation();
        if (event.target === event.currentTarget) onClose();
      }}
      onKeyDown={onKeyDown}
      onPointerDown={stop}
      onPointerUp={stop}
      onPointerMove={stop}
      onContextMenu={stop}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="unsafe-link-title"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        style={drag > 0 ? { transform: `translateY(${drag}px)` } : undefined}
        className={cn(
          'flex max-h-[90vh] w-full max-w-[480px] touch-pan-x flex-col gap-3 overflow-y-auto rounded-t-[22px] border border-border-strong bg-panel px-4 pb-[calc(18px+env(safe-area-inset-bottom))] pt-2.5 font-sans text-fg shadow-2xl will-change-transform',
          drag > 0 ? 'transition-none' : 'transition-transform',
          entered
            ? 'translate-y-0 duration-slow ease-enter'
            : 'translate-y-full duration-base ease-exit',
        )}
      >
        <div aria-hidden="true" className="mx-auto mb-0.5 h-1 w-9 rounded-sm bg-border-strong" />
        <h2
          id="unsafe-link-title"
          className="flex items-center gap-2 text-[17px] font-semibold text-[color:var(--warn-ink)]"
        >
          <IconAlertTriangle size={22} />
          Check before opening
        </h2>
        <p
          data-unsafe-url=""
          className="break-all rounded-[10px] border border-border bg-panel-2 px-2.5 py-2 font-mono text-xs text-fg"
        >
          {url}
        </p>
        {reasons.length > 0 ? (
          <ul className="flex flex-col gap-1.5 text-[13.5px] leading-[18px]">
            {reasons.map((reason) => (
              <li key={reason} className="flex gap-2">
                <span
                  aria-hidden="true"
                  className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[color:var(--warn-ink)]"
                />
                {reason}
              </li>
            ))}
          </ul>
        ) : null}
        <div className="mt-0.5 flex flex-col gap-2">
          <button
            ref={primaryRef}
            type="button"
            data-unsafe-dont-open=""
            onClick={onClose}
            className="h-[46px] rounded-xl bg-accent text-[15px] font-medium text-accent-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-fg focus-visible:ring-offset-2 focus-visible:ring-offset-panel"
          >
            {"Don't open"}
          </button>
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            data-unsafe-open-anyway=""
            onClick={onClose}
            className="grid h-[46px] place-items-center rounded-xl border border-border text-[15px] font-medium text-[color:var(--warn-ink)] no-underline focus:outline-none focus-visible:ring-2 focus-visible:ring-fg focus-visible:ring-offset-2 focus-visible:ring-offset-panel"
          >
            Open anyway
          </a>
        </div>
      </div>
    </div>,
    document.body,
  );
}
