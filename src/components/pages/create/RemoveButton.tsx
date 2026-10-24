import type { ReactElement } from 'react';
import { ICON_SIZE, IconX } from '@/components/ui/icons';

/**
 * A remove control on a tile's corner: a 44x44 tap area with a small visible
 * circle in its top-right, so it never covers half the tile.
 */
export function RemoveButton({
  label,
  onRemove,
}: {
  label: string;
  onRemove: () => void;
}): ReactElement {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onRemove}
      data-remove-button=""
      className="absolute right-0 top-0 z-10 flex h-11 w-11 items-start justify-end p-1"
    >
      <span
        aria-hidden="true"
        className="flex h-5 w-5 items-center justify-center rounded-full bg-black/60 text-white"
      >
        <IconX size={ICON_SIZE.inline} />
      </span>
    </button>
  );
}
