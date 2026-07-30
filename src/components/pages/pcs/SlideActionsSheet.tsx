// The agency-only slide actions for one gallery image, opened by a long-press or
// right-click on a grid thumbnail and by the lightbox kebab. It is presentational
// only: it renders the four actions and reports the intent; the page owns the
// pure transform + the single gallerySet write (so versioning and annotation
// re-staling stay server-side). The move actions are disabled at the ends; Remove
// is the danger action and the page now allows it down to the last image (an
// empty gallery is valid, so the post is simply left with no artwork).

import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Sheet } from '@/components/ui/Sheet';
import { IconChevronLeft, IconChevronRight, IconPlus, IconTrash } from '@/components/ui/icons';

interface SlideActionsSheetProps {
  open: boolean;
  onClose: () => void;
  /** Zero-based position of the slide these actions apply to. */
  index: number;
  /** Total slides, so the move actions know the ends. */
  count: number;
  onMoveLeft: () => void;
  onMoveRight: () => void;
  onAddAfter: () => void;
  onRemove: () => void;
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
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'flex w-full min-h-[44px] items-center gap-3 rounded-lg px-3 py-2 text-left text-sm font-medium transition-colors',
        'hover:bg-panel-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
        'disabled:pointer-events-none disabled:opacity-40',
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
    </button>
  );
}

export function SlideActionsSheet({
  open,
  onClose,
  index,
  count,
  onMoveLeft,
  onMoveRight,
  onAddAfter,
  onRemove,
}: SlideActionsSheetProps) {
  function run(action: () => void): void {
    action();
    onClose();
  }

  return (
    <Sheet open={open} onClose={onClose} title={`Image ${index + 1} of ${count}`}>
      <div className="flex flex-col gap-1">
        <SlideRow
          icon={<IconChevronLeft size={18} />}
          label="Move left"
          disabled={index <= 0}
          onClick={() => run(onMoveLeft)}
        />
        <SlideRow
          icon={<IconChevronRight size={18} />}
          label="Move right"
          disabled={index >= count - 1}
          onClick={() => run(onMoveRight)}
        />
        <SlideRow
          icon={<IconPlus size={18} />}
          label="Add image after this"
          onClick={() => run(onAddAfter)}
        />
        <SlideRow
          icon={<IconTrash size={18} />}
          label="Remove image"
          danger
          onClick={() => run(onRemove)}
        />
      </div>
    </Sheet>
  );
}
