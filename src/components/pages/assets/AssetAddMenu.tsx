import { useState } from 'react';
import { MenuPopover } from '@/components/shell/MenuPopover';
import { IconLink, IconUpload } from '@/components/ui/icons';
import { INDUCTION_KEYS } from '@/lib/induction';

interface AssetAddMenuProps {
  /** Open the upload sheet (the "Upload files" option). */
  onUploadFiles: () => void;
  /** Open the Add link sheet (the "Add link" option). */
  onAddLink: () => void;
}

/**
 * The Assets toolbar add control: a 44px-tall "New asset" accent trigger that
 * opens a small menu anchored beneath it. "Upload files" opens the upload sheet;
 * "Add link" opens the link sheet. Selecting starts from the round box on each
 * file card. Outside tap and Esc dismiss
 * via MenuPopover. Themed with tokens so light and dark match; no hover-only
 * behaviour (tap toggles the menu).
 */
export function AssetAddMenu({ onUploadFiles, onAddLink }: AssetAddMenuProps) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative shrink-0">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        data-induction={INDUCTION_KEYS.assetsAdd}
        onClick={() => setOpen((prev) => !prev)}
        className="inline-flex h-11 items-center justify-center whitespace-nowrap rounded-md bg-accent px-4 text-sm font-medium text-accent-fg transition-colors hover:bg-accent-hover"
      >
        New asset
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

        <button
          type="button"
          role="menuitem"
          onClick={() => {
            setOpen(false);
            onAddLink();
          }}
          className="flex min-h-[44px] w-full items-center gap-3 rounded-md px-3 text-left text-sm text-fg-2 transition-colors hover:bg-panel-2 hover:text-fg"
        >
          <span className="shrink-0 text-fg-3">
            <IconLink size={18} />
          </span>
          <span>Add link</span>
        </button>
      </MenuPopover>
    </div>
  );
}
