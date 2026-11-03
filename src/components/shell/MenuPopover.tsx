import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { useDismissLayer } from '@/lib/modal-focus';
import { menuMoves } from '@/components/ui/popover-classes';
import { usePresence } from '@/lib/motion';

interface MenuPopoverProps {
  open: boolean;
  onClose: () => void;
  align?: 'left' | 'right';
  /**
   * Viewport point the menu grows from (the trigger centre or a right-click
   * cursor point). Default: the centre of the menu's wrapper, which holds the
   * trigger.
   */
  origin?: { x: number; y: number } | null;
  children: ReactNode;
}

/**
 * A lightweight anchored dropdown. Render it inside a `relative` wrapper next to
 * its trigger. Closes on outside click (transparent backdrop) and Escape (the
 * top layer only), and hands focus back to its trigger on close. Motion
 * (docs/motion.md, growFromTrigger): rendered at rest, it grows .90 to 1 from
 * the trigger and shrinks back on close. Scale only, never a fade.
 */
export function MenuPopover({ open, onClose, align = 'right', origin, children }: MenuPopoverProps) {
  const presence = usePresence<HTMLDivElement>(open, menuMoves(() => origin, align));
  const panelRef = presence.ref;
  useDismissLayer(open, onClose, panelRef);

  if (!presence.rendered) {
    return null;
  }

  return (
    <>
      {open ? <div className="fixed inset-0 z-40" aria-hidden="true" onClick={onClose} /> : null}
      <div
        ref={panelRef}
        role="menu"
        className={cn(
          // Rendered at rest; the grow from the trigger is laid over it.
          'absolute z-50 mt-2 min-w-[220px] rounded-xl border bg-panel p-1.5 lit-overlay will-change-transform',
          align === 'right' ? 'right-0' : 'left-0',
        )}
      >
        {children}
      </div>
    </>
  );
}
