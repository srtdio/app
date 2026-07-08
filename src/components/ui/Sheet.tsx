import { useEffect, useState } from 'react';
import type { MouseEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { IconButton } from '@/components/ui/IconButton';
import { IconX } from '@/components/ui/icons';
import { cn } from '@/lib/cn';
import { DUR_BASE_MS } from '@/lib/motion';

interface SheetProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
}

// Exit transition length; mirrors --dur-base so the closing phase stays mounted
// exactly as long as the fade/slide-out takes, then unmounts. Under
// prefers-reduced-motion the CSS collapses to 1ms but this timer still fires,
// so unmount always happens.
const EXIT_MS = DUR_BASE_MS;

export function Sheet({ open, onClose, title, children, footer }: SheetProps) {
  // `rendered` keeps the panel mounted through its exit; `entered` drives the
  // enter/exit transition (false = offscreen/faded, true = resting).
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
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        onClose();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  if (!rendered) {
    return null;
  }

  function onOverlayClick(event: MouseEvent<HTMLDivElement>): void {
    if (event.target === event.currentTarget) {
      onClose();
    }
  }

  return createPortal(
    <div
      className={cn(
        'fixed inset-0 z-50 flex items-end bg-black/45 transition-opacity duration-base sm:items-center sm:justify-center',
        entered ? 'opacity-100 ease-enter' : 'opacity-0 ease-exit',
      )}
      onClick={onOverlayClick}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cn(
          // Axis: translateY only. Mobile slides from 100%; desktop rises 8px
          // and crossfades. No X, no rotate.
          'flex w-full max-h-[90vh] flex-col overflow-hidden rounded-t-2xl border border-border-strong bg-panel shadow-2xl transition-[opacity,transform] will-change-transform sm:w-[540px] sm:max-w-[92%] sm:max-h-[84vh] sm:rounded-xl',
          entered
            ? 'translate-y-0 opacity-100 duration-slow ease-enter sm:duration-base'
            : 'translate-y-full opacity-100 duration-base ease-exit sm:translate-y-2 sm:opacity-0',
        )}
      >
        <div className="flex items-center gap-2.5 px-[18px] py-[15px] border-b border-border">
          <h2 className="font-semibold text-[15px]">{title}</h2>
          <span className="ml-auto">
            <IconButton label="Close" onClick={onClose}>
              <IconX />
            </IconButton>
          </span>
        </div>
        <div className="px-[18px] py-4 overflow-y-auto">{children}</div>
        {footer !== undefined ? (
          <div className="flex items-center gap-2.5 px-[18px] py-3 border-t border-border">
            {footer}
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
