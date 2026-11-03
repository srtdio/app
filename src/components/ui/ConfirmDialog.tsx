import { useRef } from 'react';
import type { MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/Button';
import { useEscapeLayer } from '@/lib/escape-stack';
import { useModalFocus } from '@/lib/modal-focus';
import { dialogIn, dialogOut, riseIn, riseOut, trackDim, useMoveOnMount } from '@/lib/motion';
import { useIsLaptop } from '@/lib/use-is-laptop';

interface ConfirmDialogProps {
  title: string;
  /** Body line under the title. Omit it for a title-only confirm: no body element and no gap. */
  message?: string;
  confirmLabel: string;
  /** Label for the dismiss action. Default "Cancel". */
  cancelLabel?: string;
  /** Render the confirm action in destructive styling via the `bad` token. */
  destructive?: boolean;
  /** Disables both actions and switches the confirm label to its busy form. */
  busy?: boolean;
  busyLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

// A small, reusable confirm modal. The repo has no dialog primitive (only Sheet,
// which is a side panel), so this is the shared confirm surface. Colours come
// entirely from theme tokens (panel / border / fg / bad), giving light+dark
// parity for free; both actions are 44px tall (Button size lg) for touch. Enter
// and exit match the Sheet (docs/motion.md, rise): phone rises from the bottom
// edge with the dim tracking it; laptop grows 95% to 100%. Never a fade. Focus
// lands on the dismiss action, Tab stays inside, and the opener gets focus back
// when the dialog goes. It does not guard Back: the layer under it does.
export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  cancelLabel = 'Cancel',
  destructive = false,
  busy = false,
  busyLabel,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  // The dialog is mount-controlled by its parent, so it owns a closing phase:
  // a dismiss plays the exit, then calls onCancel (which unmounts it). With
  // motion off (or no Web Animations) onCancel runs at once.
  const closingRef = useRef(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const dimRef = useRef<HTMLDivElement>(null);
  const isLaptop = useIsLaptop();
  const laptopRef = useRef(isLaptop);
  laptopRef.current = isLaptop;

  // Rendered at rest; the move starts on the first frame.
  useMoveOnMount(panelRef, (el) => {
    if (laptopRef.current) return dialogIn(el);
    const played = riseIn(el);
    trackDim(el, dimRef.current, played);
    return played;
  });

  function requestClose(): void {
    if (busy || closingRef.current) return;
    closingRef.current = true;
    const el = panelRef.current;
    const played = laptopRef.current ? dialogOut(el) : riseOut(el);
    if (played.instant) {
      onCancel();
      return;
    }
    if (!laptopRef.current) trackDim(el, dimRef.current, played);
    void played.done.then(onCancel);
  }

  // Escape reaches this dialog only while it is the top layer (escape-stack).
  useEscapeLayer(true, requestClose);

  useModalFocus(panelRef, true);

  function onOverlayClick(event: MouseEvent<HTMLDivElement>): void {
    if (event.target === event.currentTarget) requestClose();
  }

  return createPortal(
    <div
      onClick={onOverlayClick}
      // The bottom padding clears the iPhone home bar where the box sits low.
      className="fixed inset-0 z-50 flex items-end justify-center px-4 pt-4 pb-[max(16px,env(safe-area-inset-bottom))] sm:items-center"
    >
      {/* The dim: full scrim at rest, tracking the box per frame on phone. */}
      <div
        ref={dimRef}
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-scrim"
      />
      <div
        ref={panelRef}
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        // Rendered at rest; rise (phone, Y) or grow (laptop, scale) is laid over it.
        className="relative lit-overlay w-full max-w-sm rounded-2xl border bg-panel p-5 outline-none will-change-transform"
      >
        <h2 className="text-lg font-semibold text-fg">{title}</h2>
        {message !== undefined && message !== '' ? (
          <p data-confirm-message="" className="mt-2 whitespace-pre-line text-base text-fg-2">
            {message}
          </p>
        ) : null}
        {/* Cancel is ghost, left of the primary. */}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" disabled={busy} onClick={requestClose}>
            {cancelLabel}
          </Button>
          <Button disabled={busy} onClick={onConfirm} variant={destructive ? 'danger' : 'primary'}>
            {busy ? (busyLabel ?? confirmLabel) : confirmLabel}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
