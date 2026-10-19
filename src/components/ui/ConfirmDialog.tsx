import { useEffect, useRef, useState } from 'react';
import type { MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/cn';
import { useEscapeLayer } from '@/lib/escape-stack';
import { useModalFocus } from '@/lib/modal-focus';
import { DUR_BASE_MS } from '@/lib/motion';

interface ConfirmDialogProps {
  title: string;
  message: string;
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

// Exit transition length; mirrors --dur-base so the dialog stays mounted for the
// full fade-out before its parent unmounts it. Timer still fires under
// prefers-reduced-motion (CSS collapses to 1ms), so onCancel always runs.
const EXIT_MS = DUR_BASE_MS;

// A small, reusable confirm modal. The repo has no dialog primitive (only Sheet,
// which is a side panel), so this is the shared confirm surface. Colours come
// entirely from theme tokens (panel / border / fg / bad), giving light+dark
// parity for free; both actions are 44px tall (Button size lg) for touch. Enter
// and exit match the desktop Sheet: fade + 8px rise, translateY only. Focus
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
  // a dismiss plays the exit, then calls onCancel (which unmounts it).
  const [entered, setEntered] = useState(false);
  const closingRef = useRef(false);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const raf = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  function requestClose(): void {
    if (busy || closingRef.current) return;
    closingRef.current = true;
    setEntered(false);
    setTimeout(onCancel, EXIT_MS);
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
      className={cn(
        // The bottom padding clears the iPhone home bar where the box sits low.
        'fixed inset-0 z-50 flex items-end justify-center bg-black/45 px-4 pt-4 pb-[max(16px,env(safe-area-inset-bottom))] transition-opacity duration-base sm:items-center',
        entered ? 'opacity-100 ease-enter' : 'opacity-0 ease-exit',
      )}
    >
      <div
        ref={panelRef}
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={cn(
          // Axis: translateY only (8px rise) with a crossfade. No X, no rotate.
          'w-full max-w-sm rounded-2xl border border-border bg-panel p-5 shadow-lg outline-none transition-[opacity,transform] duration-base will-change-transform',
          entered ? 'translate-y-0 opacity-100 ease-enter' : 'translate-y-2 opacity-0 ease-exit',
        )}
      >
        <h2 className="text-sm font-semibold text-fg">{title}</h2>
        <p className="mt-2 text-sm text-fg-2">{message}</p>
        <div className="mt-5 flex justify-end gap-2">
          <Button size="lg" disabled={busy} onClick={requestClose}>
            {cancelLabel}
          </Button>
          <Button
            size="lg"
            disabled={busy}
            onClick={onConfirm}
            variant={destructive ? 'danger' : 'primary'}
          >
            {busy ? (busyLabel ?? confirmLabel) : confirmLabel}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
