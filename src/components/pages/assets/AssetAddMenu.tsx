import { useState } from 'react';
import { MenuPopover } from '@/components/shell/MenuPopover';
import { Button } from '@/components/ui/Button';
import { PressableRow } from '@/components/ui/PressableRow';
import { ICON_SIZE, IconLink, IconUpload } from '@/components/ui/icons';
import { INDUCTION_KEYS } from '@/lib/induction';

/** A menu row: the shared pressable row, full width, text from the left. */
const MENU_ITEM =
  'flex items-center gap-3 px-4 text-base font-medium text-fg-2 transition-colors duration-fast hover:text-fg';

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
      <Button
        variant="primary"
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        data-induction={INDUCTION_KEYS.assetsAdd}
        onClick={() => setOpen((prev) => !prev)}
        className="whitespace-nowrap"
      >
        New asset
      </Button>

      <MenuPopover open={open} onClose={() => setOpen(false)} align="right">
        <PressableRow
          type="button"
          role="menuitem"
          onClick={() => {
            setOpen(false);
            onUploadFiles();
          }}
          className={MENU_ITEM}
        >
          <span className="shrink-0 text-fg-3">
            <IconUpload size={ICON_SIZE.inline} />
          </span>
          <span>Upload files</span>
        </PressableRow>

        <PressableRow
          type="button"
          role="menuitem"
          onClick={() => {
            setOpen(false);
            onAddLink();
          }}
          className={MENU_ITEM}
        >
          <span className="shrink-0 text-fg-3">
            <IconLink size={ICON_SIZE.inline} />
          </span>
          <span>Add link</span>
        </PressableRow>
      </MenuPopover>
    </div>
  );
}
