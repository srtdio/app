// "Check before opening": the bottom sheet a warning card opens. Shows the full
// link in mono, the plain-English reasons from the shared check, a primary
// "Don't open" (focused by default) and a secondary "Open anyway" that opens the
// link in a new tab with noopener noreferrer.
//
// Closes on Esc, a tap on the scrim, the header's "<" back, "Don't open", or a
// downward swipe on the sheet. Motion (docs/motion.md, rise): rendered at rest,
// it rises from the bottom edge and leaves the same way, the dim tracking it;
// translateY only, never a fade. Focus is trapped
// inside while open and handed back to the card on close. Colours are tokens
// only, so light and dark parity comes from the theme.

import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent, ReactElement, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { buttonClass } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { IconAlertTriangle, IconChevronLeft, ICON_SIZE } from '@/components/ui/icons';
import { LEADING_PULL } from '@/components/ui/layout';
import { cn } from '@/lib/cn';
import { useModalFocus } from '@/lib/modal-focus';
import { dimFor, riseIn, riseOut, usePresence } from '@/lib/motion';
import { dimWith } from '@/lib/motion/overlays';

interface UnsafeLinkSheetProps {
  open: boolean;
  url: string;
  reasons: readonly string[];
  onClose: () => void;
}

/** Drag distance (px) past which a released swipe closes the sheet. */
export const SWIPE_CLOSE_PX = 80;

export function UnsafeLinkSheet(props: UnsafeLinkSheetProps): ReactElement | null {
  const { open, url, reasons, onClose } = props;
  const [drag, setDrag] = useState(0);
  const dimRef = useRef<HTMLDivElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const dragStart = useRef<number | null>(null);
  // The drag offset the sheet closed from: the exit starts there.
  const dragRef = useRef(0);
  dragRef.current = drag;
  const presence = usePresence<HTMLDivElement>(open, {
    enter: (el) => {
      return dimWith(el, dimRef.current, riseIn(el));
    },
    exit: (el) => {
      return dimWith(el, dimRef.current, riseOut(el, dragRef.current));
    },
  });
  const rendered = presence.rendered;
  const panelRef = presence.ref;

  useEffect(() => {
    if (open) setDrag(0);
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
    const next = Math.max(0, event.clientY - dragStart.current);
    setDrag(next);
    // The dim follows the sheet's position, never a timed fade.
    const panel = panelRef.current;
    if (dimRef.current !== null && panel !== null) {
      dimRef.current.style.opacity = dimFor(next, panel.offsetHeight);
    }
  }

  function onPointerEnd(): void {
    if (dragStart.current === null) return;
    dragStart.current = null;
    if (drag > SWIPE_CLOSE_PX) {
      onClose();
      return;
    }
    // Short: spring back from where the finger left it.
    setDrag(0);
    if (drag > 0) dimWith(panelRef.current, dimRef.current, riseIn(panelRef.current, drag));
    else if (dimRef.current !== null) dimRef.current.style.opacity = '';
  }

  return createPortal(
    <div
      data-unsafe-sheet=""
      className="fixed inset-0 z-sheet flex items-end justify-center"
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
      {/* The dim: full scrim at rest, tracking the sheet per frame as it moves. */}
      <div
        ref={dimRef}
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-scrim"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="unsafe-link-title"
        // Follows the finger while dragged (and holds there until the exit takes over).
        style={drag > 0 ? { transform: `translateY(${drag}px)` } : undefined}
        className="relative flex max-h-[90svh] w-full max-w-lg touch-pan-y flex-col gap-3 overflow-y-auto overscroll-contain rounded-t-2xl border bg-panel px-4 font-sans text-fg lit-overlay will-change-transform"
      >
        {/* The swipe-down handle: grabber, then the "<" back leading and the
            title (every sheet header). The rest of the sheet scrolls normally
            when it is taller than the screen. */}
        <div
          data-sheet-drag=""
          className="flex touch-none flex-col gap-3 pt-3"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={onPointerEnd}
        >
          <div aria-hidden="true" className="mx-auto mb-1 h-1 w-9 rounded-sm bg-border-strong" />
          <div className="flex items-center gap-2">
            <IconButton label="Back" onClick={onClose} className={cn(LEADING_PULL, 'shrink-0')}>
              <IconChevronLeft size={ICON_SIZE.control} />
            </IconButton>
            <h2
              id="unsafe-link-title"
              className="flex min-w-0 flex-1 items-center gap-2 text-lg font-semibold text-warn-ink"
            >
              <IconAlertTriangle size={ICON_SIZE.tray} />
              Check before opening
            </h2>
          </div>
        </div>
        <p
          data-unsafe-url=""
          className="break-all rounded-lg border border-border bg-panel-2 lit-well-soft px-3 py-2 font-mono text-sm text-fg"
        >
          {url}
        </p>
        {reasons.length > 0 ? (
          <ul className="flex flex-col gap-2 text-base">
            {reasons.map((reason) => (
              <li key={reason} className="flex gap-2">
                <span aria-hidden="true" className="flex h-5 shrink-0 items-center">
                  <span className="h-2 w-2 rounded-full bg-warn-ink" />
                </span>
                {reason}
              </li>
            ))}
          </ul>
        ) : null}
        {/* The sheet's bottom inset (16 + the home bar) rides on its last block. */}
        <div className="mt-1 flex flex-col gap-2 pb-[calc(16px+env(safe-area-inset-bottom))]">
          <button
            ref={primaryRef}
            type="button"
            data-unsafe-dont-open=""
            onClick={onClose}
            className={buttonClass('primary', 'default', 'w-full')}
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
              'w-full data-[unsafe-open-anyway]:text-warn-ink no-underline',
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
        className={cn(
          'cursor-pointer break-all focus-visible:lit-focus',
          props.className ?? 'inline',
        )}
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
        'inline-flex h-11 min-h-11 max-w-full items-center gap-2 rounded-lg border border-warn-line bg-warn-soft lit-tint px-4 text-base font-medium text-warn-ink focus-visible:lit-focus',
        props.className,
      )}
    >
      <IconAlertTriangle size={ICON_SIZE.inline} className="shrink-0" />
      <span className="min-w-0 truncate">{props.domain}</span>
    </UnsafeLinkText>
  );
}
