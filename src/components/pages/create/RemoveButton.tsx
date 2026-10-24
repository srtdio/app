import type { ReactElement } from 'react';
import { IconButton } from '@/components/ui/IconButton';
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
    <IconButton
      type="button"
      label={label}
      onClick={onRemove}
      data-remove-button=""
      className="absolute right-0 top-0 z-10"
    >
      {/* Pinned to the tap area's top-right corner (IconButton centres its content). */}
      <span
        aria-hidden="true"
        className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-black/60 text-white"
      >
        <IconX size={ICON_SIZE.inline} />
      </span>
    </IconButton>
  );
}
