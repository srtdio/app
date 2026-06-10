import { useEffect } from 'react';
import type { MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/Button';

interface ConfirmDialogProps {
  title: string;
  message: string;
  confirmLabel: string;
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
// parity for free; both actions are 44px tall (Button size lg) for touch.
export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  destructive = false,
  busy = false,
  busyLabel,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape' && !busy) onCancel();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onCancel, busy]);

  function onOverlayClick(event: MouseEvent<HTMLDivElement>): void {
    if (event.target === event.currentTarget && !busy) onCancel();
  }

  return createPortal(
    <div
      onClick={onOverlayClick}
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/45 p-4 sm:items-center"
    >
      <div
        role="alertdialog"
        aria-label={title}
        className="w-full max-w-sm rounded-2xl border border-border bg-panel p-5 shadow-lg"
      >
        <h2 className="text-sm font-semibold text-fg">{title}</h2>
        <p className="mt-2 text-sm text-fg-2">{message}</p>
        <div className="mt-5 flex justify-end gap-2">
          <Button size="lg" disabled={busy} onClick={onCancel}>
            Cancel
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
