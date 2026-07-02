import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

interface MenuPopoverProps {
  open: boolean;
  onClose: () => void;
  align?: 'left' | 'right';
  children: ReactNode;
}

// Exit transition length; mirrors --dur-fast so the menu stays mounted for its
// fade/scale-out, then unmounts. Fires under prefers-reduced-motion too (CSS
// collapses to 1ms), so the closing phase always completes.
const EXIT_MS = 120;

/**
 * A lightweight anchored dropdown. Render it inside a `relative` wrapper next to
 * its trigger. Closes on outside click (transparent backdrop) and Escape. Enter
 * and exit fade and scale from the trigger corner (transform-origin); no
 * translation.
 */
export function MenuPopover({ open, onClose, align = 'right', children }: MenuPopoverProps) {
  // `rendered` keeps the menu mounted through its exit; `entered` drives the
  // enter/exit transition.
  const [rendered, setRendered] = useState(open);
  const [entered, setEntered] = useState(false);

  useEffect(() => {
    if (open) {
      setRendered(true);
      const raf = requestAnimationFrame(() => setEntered(true));
      return () => cancelAnimationFrame(raf);
    }
    setEntered(false);
    const timer = setTimeout(() => setRendered(false), EXIT_MS);
    return () => clearTimeout(timer);
  }, [open]);

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

  if (!rendered) {
    return null;
  }

  return (
    <>
      <div className="fixed inset-0 z-40" aria-hidden="true" onClick={onClose} />
      <div
        role="menu"
        className={cn(
          // Axis: scale only, anchored to the trigger corner. No translation.
          'absolute z-50 mt-2 min-w-[220px] rounded-xl border border-border-strong bg-panel p-1.5 shadow-2xl transition-[opacity,transform] duration-fast will-change-transform',
          align === 'right' ? 'right-0 origin-top-right' : 'left-0 origin-top-left',
          entered ? 'scale-100 opacity-100 ease-enter' : 'scale-[0.96] opacity-0 ease-exit',
        )}
      >
        {children}
      </div>
    </>
  );
}
