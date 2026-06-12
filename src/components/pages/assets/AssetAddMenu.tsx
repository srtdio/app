import { useState } from 'react';
import { MenuPopover } from '@/components/shell/MenuPopover';
import { IconLink, IconPlus, IconUpload } from '@/components/ui/icons';

interface AssetAddMenuProps {
  /** Open the upload sheet (the "Upload files" option). */
  onUploadFiles: () => void;
}

/**
 * The Assets toolbar add control: a 44x44 accent trigger that opens a small
 * two-option menu anchored beneath it. "Upload files" opens the upload sheet;
 * "Add link" is a disabled, Coming soon item until a later PR wires it. Outside
 * tap and Esc dismiss via MenuPopover. Themed with tokens so light and dark
 * match; no hover-only behaviour (tap toggles the menu).
 */
export function AssetAddMenu({ onUploadFiles }: AssetAddMenuProps) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative shrink-0">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Add asset"
        onClick={() => setOpen((prev) => !prev)}
        className="inline-flex h-11 w-11 items-center justify-center rounded-md bg-accent text-accent-fg transition-colors hover:bg-accent-hover"
      >
        <IconPlus size={18} />
      </button>

      <MenuPopover open={open} onClose={() => setOpen(false)} align="right">
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            setOpen(false);
            onUploadFiles();
          }}
          className="flex min-h-[44px] w-full items-center gap-3 rounded-md px-3 text-left text-sm text-fg-2 transition-colors hover:bg-panel-2 hover:text-fg"
        >
          <span className="shrink-0 text-fg-3">
            <IconUpload size={18} />
          </span>
          <span>Upload files</span>
        </button>

        <div
          role="menuitem"
          aria-disabled="true"
          className="flex min-h-[44px] w-full cursor-not-allowed items-center gap-3 rounded-md px-3 text-left text-sm text-fg-3 opacity-60"
        >
          <span className="shrink-0">
            <IconLink size={18} />
          </span>
          <span className="flex flex-col leading-tight">
            <span>Add link</span>
            <span className="text-[11px] text-fg-3">Coming soon</span>
          </span>
        </div>
      </MenuPopover>
    </div>
  );
}
