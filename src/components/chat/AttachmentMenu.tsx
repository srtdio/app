// The paperclip pop-up menu. Purely presentational: it renders whatever items
// the config (attachment-menu.ts) hands it, so PR6 adds "Share a post" by
// appending one config entry, never by editing this render. Each row is the
// shared ActionRow (the row MessageActionMenu uses): icon and label left-aligned
// on one line, a 44px touch target; the panel closes after a selection.

import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { ActionRow } from '@/components/ui';
import { ICON_SIZE } from '@/components/ui/icons';
import { popoverClass } from '@/components/ui/popover-classes';
import { cn } from '@/lib/cn';
import type { AttachmentMenuItem } from '@/lib/chat/attachment-menu';

interface AttachmentMenuProps {
  open: boolean;
  items: readonly AttachmentMenuItem[];
  onClose: () => void;
}

export function AttachmentMenu({ open, items, onClose }: AttachmentMenuProps): ReactElement | null {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);

  // Enter motion: flip to shown the frame after mount (opacity + scale only).
  useEffect(() => {
    if (!open) {
      setShown(false);
      return;
    }
    const raf = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(raf);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onDocPointer(event: MouseEvent): void {
      if (ref.current !== null && !ref.current.contains(event.target as Node)) onClose();
    }
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('mousedown', onDocPointer);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onDocPointer);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      ref={ref}
      role="menu"
      aria-label="Add attachment"
      className={cn(
        'absolute bottom-full left-0 z-10 mb-2 min-w-[220px] origin-bottom-left whitespace-nowrap',
        popoverClass(shown),
      )}
    >
      {attachmentMenuRows(items, onClose)}
    </div>
  );
}

/**
 * The menu rows, in config order. Pure (no hooks) so the unit job asserts the
 * rows are ActionRows without a DOM. Each row carries role="menuitem" on a
 * wrapper so ActionRow stays the shared, unmodified component.
 */
export function attachmentMenuRows(
  items: readonly AttachmentMenuItem[],
  onClose: () => void,
): ReactElement[] {
  return items.map((item) => {
    const Icon = item.Icon;
    return (
      <div key={item.id} role="menuitem">
        <ActionRow
          icon={<Icon size={ICON_SIZE.nav} />}
          label={item.label}
          onClick={() => {
            item.onSelect();
            onClose();
          }}
        />
      </div>
    );
  });
}
