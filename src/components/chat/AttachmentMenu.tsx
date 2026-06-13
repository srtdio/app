// The paperclip pop-up menu. Purely presentational: it renders whatever items
// the config (attachment-menu.ts) hands it, so PR6 adds "Share a post" by
// appending one config entry, never by editing this render. Each row is a 44px
// touch target (Button size lg); the panel closes after a selection.

import { useEffect, useRef } from 'react';
import type { ReactElement } from 'react';
import { Button } from '@/components/ui/Button';
import type { AttachmentMenuItem } from '@/lib/chat/attachment-menu';

interface AttachmentMenuProps {
  open: boolean;
  items: readonly AttachmentMenuItem[];
  onClose: () => void;
}

export function AttachmentMenu({ open, items, onClose }: AttachmentMenuProps): ReactElement | null {
  const ref = useRef<HTMLDivElement>(null);

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
      className="absolute bottom-full left-0 z-10 mb-2 min-w-[176px] rounded-xl border border-border-strong bg-panel p-1.5 shadow-2xl"
    >
      {items.map((item) => {
        const Icon = item.Icon;
        return (
          <Button
            key={item.id}
            type="button"
            variant="ghost"
            size="lg"
            role="menuitem"
            className="w-full justify-start"
            onClick={() => {
              item.onSelect();
              onClose();
            }}
          >
            <Icon size={18} />
            {item.label}
          </Button>
        );
      })}
    </div>
  );
}
