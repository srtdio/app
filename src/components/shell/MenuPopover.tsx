import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

interface MenuPopoverProps {
  open: boolean;
  onClose: () => void;
  align?: 'left' | 'right';
  children: ReactNode;
}

/**
 * A lightweight anchored dropdown. Render it inside a `relative` wrapper next to
 * its trigger. Closes on outside click (transparent backdrop) and Escape.
 */
export function MenuPopover({ open, onClose, align = 'right', children }: MenuPopoverProps) {
  useEffect(() => {
    if (!open) {
      return;
    }
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        onClose();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, onClose]);

  if (!open) {
    return null;
  }

  return (
    <>
      <div className="fixed inset-0 z-40" aria-hidden="true" onClick={onClose} />
      <div
        role="menu"
        className={cn(
          'absolute z-50 mt-2 min-w-[220px] rounded-xl border border-border-strong bg-panel p-1.5 shadow-2xl',
          align === 'right' ? 'right-0' : 'left-0',
        )}
      >
        {children}
      </div>
    </>
  );
}
