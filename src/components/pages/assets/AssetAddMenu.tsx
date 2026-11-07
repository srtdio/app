import { useState } from 'react';
import { MenuPopover } from '@/components/shell/MenuPopover';
import { TopbarPlus } from '@/components/shell/topbar-actions';
import { PressableRow } from '@/components/ui/PressableRow';
import { ICON_SIZE, IconLink, IconUpload } from '@/components/ui/icons';
import { INDUCTION_KEYS } from '@/lib/induction';

/** A menu row: the shared pressable row, full width, text from the left. */
const MENU_ITEM =
  'flex items-center gap-3 px-4 text-base font-medium text-fg-2 mv-tint hover:text-fg';

interface AssetAddMenuProps {
  /** Open the upload sheet (the "Upload files" option). */
  onUploadFiles: () => void;
  /** Open the Add link sheet (the "Add link" option). */
  onAddLink: () => void;
}

/**
 * The Assets "+" in the app top bar (decision A): the filled TopbarPlus,
 * labelled "New file" (aria-haspopup="menu"), carrying the old add control's
 * tour key, that opens a small menu anchored beneath it. "Upload files" opens
 * the upload sheet; "Add link" opens the link sheet. Outside tap and Esc
 * dismiss via MenuPopover. Themed with tokens so light and dark match; no
 * hover-only behaviour (tap toggles the menu). The page publishes it with
 * useTopbarActions({ primary }).
 */
export function AssetAddMenu({ onUploadFiles, onAddLink }: AssetAddMenuProps) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative shrink-0">
      <TopbarPlus
        label="New file"
        aria-haspopup="menu"
        aria-expanded={open}
        induction={INDUCTION_KEYS.assetsAdd}
        onClick={() => setOpen((prev) => !prev)}
      />

      <MenuPopover open={open} onClose={() => setOpen(false)} align="right" label="New file">
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
            <IconUpload size={ICON_SIZE.tray} />
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
            <IconLink size={ICON_SIZE.tray} />
          </span>
          <span>Add link</span>
        </PressableRow>
      </MenuPopover>
    </div>
  );
}
