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
import type { KeyboardEvent, PointerEvent, ReactElement, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { buttonClass } from '@/components/ui/Button';
import { IconAlertTriangle } from '@/components/ui/icons';
import { cn } from '@/lib/cn';
import { useModalFocus } from '@/lib/modal-focus';
import { DUR_BASE_MS } from '@/lib/motion';

export interface UnsafeLinkSheetProps {
  open: boolean;
  url: string;
  reasons: readonly string[];
  onClose: () => void;
}

/** Drag distance (px) past which a released swipe closes the sheet. */
export const SWIPE_CLOSE_PX = 80;

export function UnsafeLinkSheet(props: UnsafeLinkSheetProps): ReactElement | null {
  const { open, url, reasons, onClose } = props;
  const [rendered, setRendered] = useState(open);
  const [entered, setEntered] = useState(false);
  const [drag, setDrag] = useState(0);
  const panelRef = useRef<HTMLDivElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const dragStart = useRef<number | null>(null);

  useEffect(() => {
    if (open) {
      setRendered(true);
      setDrag(0);
      const raf = requestAnimationFrame(() => setEntered(true));
      return () => cancelAnimationFrame(raf);
    }
    setEntered(false);
    const timer = setTimeout(() => setRendered(false), DUR_BASE_MS);
    return () => clearTimeout(timer);
  }, [open]);

  // "Don't open" takes focus as soon as the sheet is on screen; Tab stays
  // inside; whatever opened the sheet gets focus back on close.
  useModalFocus(panelRef, open && rendered, { initial: () => primaryRef.current });

  if (!rendered) return null;

  function stop(event: { stopPropagation: () => void }): void {
    event.stopPropagation();
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    // Keys stay in the sheet (a chat bubble's own shortcuts never see them);
    // Tab is trapped by the shared modal focus, which listens in capture.
    event.stopPropagation();
    if (event.key === 'Escape') onClose();
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
        style={drag > 0 ? { transform: `translateY(${drag}px)` } : undefined}
        className={cn(
          'flex max-h-[90vh] w-full max-w-[480px] touch-pan-y flex-col gap-3 overflow-y-auto overscroll-contain rounded-t-[22px] border border-border-strong bg-panel px-4 pb-[calc(18px+env(safe-area-inset-bottom))] pt-2.5 font-sans text-fg shadow-2xl will-change-transform',
          drag > 0 ? 'transition-none' : 'transition-transform',
          entered
            ? 'translate-y-0 duration-slow ease-enter'
            : 'translate-y-full duration-base ease-exit',
        )}
      >
        {/* The swipe-down handle: grabber + title. The rest of the sheet
            scrolls normally when it is taller than the screen. */}
        <div
          data-sheet-drag=""
          className="flex touch-none flex-col gap-3"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={onPointerEnd}
        >
          <div aria-hidden="true" className="mx-auto mb-0.5 h-1 w-9 rounded-sm bg-border-strong" />
          <h2
            id="unsafe-link-title"
            className="flex items-center gap-2 text-[17px] font-semibold text-[color:var(--warn-ink)]"
          >
            <IconAlertTriangle size={22} />
            Check before opening
          </h2>
        </div>
        <p
          data-unsafe-url=""
          className="break-all rounded-lg border border-border bg-panel-2 px-2.5 py-2 font-mono text-xs text-fg"
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
            className={buttonClass(
              'primary',
              'default',
              'w-full focus:outline-none focus-visible:ring-2 focus-visible:ring-fg focus-visible:ring-offset-2 focus-visible:ring-offset-panel',
            )}
          >
            {"Don't open"}
          </button>
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            data-unsafe-open-anyway=""
            onClick={onClose}
            className={buttonClass(
              'secondary',
              'default',
              'w-full !text-[color:var(--warn-ink)] no-underline focus:outline-none focus-visible:ring-2 focus-visible:ring-fg focus-visible:ring-offset-2 focus-visible:ring-offset-panel',
            )}
          >
            Open anyway
          </a>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * An unsafe link inside running text (a chat body, a comment, a brief's other
 * links): looks like the surrounding link text, but a tap opens the check
 * sheet instead of the site, so the warning card cannot be bypassed.
 */
export function UnsafeLinkText(props: {
  url: string;
  reasons: readonly string[];
  className?: string;
  /** Mark it as a chat body link (data-msg-link) so a press acts like other links. */
  msgLink?: boolean;
  children: ReactNode;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const show = (event: { stopPropagation: () => void; preventDefault: () => void }): void => {
    event.stopPropagation();
    event.preventDefault();
    setOpen(true);
  };
  return (
    <>
      {/* A span (role=button), not a <button>: it wraps with the text around it. */}
      <span
        role="button"
        tabIndex={0}
        data-unsafe-link=""
        data-msg-link={props.msgLink === true ? '' : undefined}
        onClick={show}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') show(event);
        }}
        className={cn('cursor-pointer break-all', props.className ?? 'inline')}
      >
        {props.children}
      </span>
      <UnsafeLinkSheet
        open={open}
        url={props.url}
        reasons={props.reasons}
        onClose={() => setOpen(false)}
      />
    </>
  );
}

/**
 * LinkButton's place for an unsafe link (comments, brief links): the same 44px
 * button shape in the warning colours, labelled with the domain only, opening
 * the check sheet.
 */
export function UnsafeLinkButton(props: {
  url: string;
  reasons: readonly string[];
  domain: string;
  className?: string;
}): ReactElement {
  return (
    <UnsafeLinkText
      url={props.url}
      reasons={props.reasons}
      className={cn(
        'inline-flex h-11 min-h-[44px] max-w-full items-center gap-2 rounded-lg border border-[color:var(--warn-line)] bg-warn-soft px-4 text-sm font-medium text-[color:var(--warn-ink)] focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
        props.className,
      )}
    >
      <IconAlertTriangle size={16} className="shrink-0" />
      <span className="min-w-0 truncate">{props.domain}</span>
    </UnsafeLinkText>
  );
}
