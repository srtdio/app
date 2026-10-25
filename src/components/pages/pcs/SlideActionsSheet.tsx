// The agency-only slide actions for one gallery image, opened by a right-click
// on a gallery tile. It is presentational only: it renders the actions and
// reports the intent; the page owns the pure transform + the single gallerySet
// write (so versioning and annotation re-staling stay server-side). #26: no
// per-tap move rows (each tap saved a version); reordering happens only in the
// gallery's Reorder mode, one save. Remove is the danger action and the page
// allows it down to the last image (an empty gallery is valid). Remove asks
// nothing (PR B delete rule): the sheet closes and the page removes it behind
// its UNDO_MS Undo strip. A gallery write in flight blocks Remove behind
// "Saving…".

import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { PressableRow } from '@/components/ui/PressableRow';
import { Sheet } from '@/components/ui/Sheet';
import { ICON_SIZE, IconPlus, IconTrash } from '@/components/ui/icons';

interface SlideActionsSheetProps {
  open: boolean;
  onClose: () => void;
  /** Zero-based position of the slide these actions apply to. */
  index: number;
  /** Total slides, for the title. */
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
  function run(action: () => void): void {
    action();
    onClose();
  }

  return (
    <Sheet open={open} onClose={onClose} title={`Image ${index + 1} of ${count}`}>
      <div className="flex flex-col gap-1">
        <SlideRow
          icon={<IconPlus size={ICON_SIZE.tray} />}
          label="Add image after this"
          onClick={() => run(onAddAfter)}
        />
        <SlideRow
          icon={<IconTrash size={ICON_SIZE.tray} />}
          label="Remove image"
          danger
          disabled={saving}
          onClick={() => run(onRemove)}
        />
        {saving ? (
          <p aria-live="polite" className="px-3 pt-1 text-sm text-fg-3">
            Saving…
          </p>
        ) : null}
      </div>
    </Sheet>
  );
}
