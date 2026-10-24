// The agency-only slide actions for one gallery image, opened by a right-click
// on a gallery tile. It is presentational only: it renders the actions and
// reports the intent; the page owns the pure transform + the single gallerySet
// write (so versioning and annotation re-staling stay server-side). #26: no
// per-tap move rows (each tap saved a version); reordering happens only in the
// gallery's Reorder mode, one save. Remove is the danger action and the page
// allows it down to the last image (an empty gallery is valid). Remove asks
// first with the lightbox's own confirm (same copy, Cancel / Remove), and a
// gallery write in flight blocks Remove behind "Saving…".

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/Button';
import { PressableRow } from '@/components/ui/PressableRow';
import { Sheet } from '@/components/ui/Sheet';
import { removeImageConfirmCopy } from '@/components/pages/pcs/PostLightbox';
import { ICON_SIZE, IconPlus, IconTrash } from '@/components/ui/icons';

interface SlideActionsSheetProps {
  open: boolean;
  onClose: () => void;
  /** Zero-based position of the slide these actions apply to. */
  index: number;
  /** Total slides, for the title and the remove confirm copy. */
  count: number;
  onAddAfter: () => void;
  onRemove: () => void;
  /** A gallery write is in flight: Remove is disabled. */
  saving?: boolean;
}

/** One full-width 44px action row; supports a disabled and a danger state. */
function SlideRow({
  icon,
  label,
  onClick,
  disabled = false,
  danger = false,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <PressableRow
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'flex items-center gap-3 px-3 py-2 text-base font-medium transition-colors',
        danger ? 'text-bad' : 'text-fg',
      )}
    >
      <span
        className={cn(
          'flex shrink-0 items-center justify-center',
          danger ? 'text-bad' : 'text-fg-2',
        )}
      >
        {icon}
      </span>
      <span className="truncate">{label}</span>
    </PressableRow>
  );
}

export function SlideActionsSheet({
  open,
  onClose,
  index,
  count,
  onAddAfter,
  onRemove,
  saving = false,
}: SlideActionsSheetProps) {
  const [confirming, setConfirming] = useState(false);

  // Every open starts on the action list, never a stale confirm.
  useEffect(() => {
    if (!open) setConfirming(false);
  }, [open]);

  function run(action: () => void): void {
    action();
    onClose();
  }

  const removeCopy = removeImageConfirmCopy(count);

  return (
    <Sheet open={open} onClose={onClose} title={`Image ${index + 1} of ${count}`}>
      {confirming ? (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <p className="text-base font-medium text-fg">{removeCopy.title}</p>
            {removeCopy.message !== null ? (
              <p className="text-base text-fg-2">{removeCopy.message}</p>
            ) : null}
          </div>
          <div className="flex justify-end gap-2">
            <Button onClick={() => setConfirming(false)}>Cancel</Button>
            <Button variant="danger" disabled={saving} onClick={() => run(onRemove)}>
              Remove
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          <SlideRow
            icon={<IconPlus size={ICON_SIZE.nav} />}
            label="Add image after this"
            onClick={() => run(onAddAfter)}
          />
          <SlideRow
            icon={<IconTrash size={ICON_SIZE.nav} />}
            label="Remove image"
            danger
            disabled={saving}
            onClick={() => setConfirming(true)}
          />
          {saving ? (
            <p aria-live="polite" className="px-3 pt-1 text-sm text-fg-3">
              Saving…
            </p>
          ) : null}
        </div>
      )}
    </Sheet>
  );
}
