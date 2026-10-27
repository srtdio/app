import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { IconButton } from '@/components/ui/IconButton';
import { ICON_SIZE, IconX } from '@/components/ui/icons';
import { cn } from '@/lib/cn';
import { useEscapeLayer } from '@/lib/escape-stack';
import { DUR_BASE_MS } from '@/lib/motion';

interface SidePanelProps {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Beside the title, before the X (a status pill, a stamp). */
  headerExtra?: ReactNode;
  children: ReactNode;
}

/** The laptop side panel's one width. */
export const SIDE_PANEL_WIDTH_CLASS = 'w-[380px]';
const SIDE_PANEL_WIDTH_PX = '380px';

// Exit length; mirrors --dur-base so the panel stays mounted through its slide out.
const EXIT_MS = DUR_BASE_MS;

/**
 * A laptop right side panel: 380px wide, fixed under the top bar to the
 * bottom of the screen; while it is on screen it sets --side-panel-w, which
 * the page pads by, so the page beside it shrinks and stays usable. Nothing dims and focus is not trapped (it is not
 * a dialog). Title left, X right; Esc closes and returns focus to whatever
 * had it when the panel opened. Motion: translateX only. Phone uses Sheet.
 */
export function SidePanel({ open, onClose, title, headerExtra, children }: SidePanelProps) {
  const [rendered, setRendered] = useState(open);
  const [entered, setEntered] = useState(false);
  const panelRef = useRef<HTMLElement>(null);
  const returnRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (open) {
      const was = document.activeElement;
      returnRef.current = was instanceof HTMLElement && was !== document.body ? was : null;
      setRendered(true);
      const raf = requestAnimationFrame(() => setEntered(true));
      return () => cancelAnimationFrame(raf);
    }
    setEntered(false);
    const back = returnRef.current;
    returnRef.current = null;
    if (back !== null && back.isConnected) back.focus({ preventScroll: true });
    const timer = setTimeout(() => setRendered(false), EXIT_MS);
    return () => clearTimeout(timer);
  }, [open]);

  // While on screen the page makes room: main pads by --side-panel-w (AppLayout).
  useEffect(() => {
    if (!rendered) return;
    const root = document.documentElement;
    root.style.setProperty('--side-panel-w', SIDE_PANEL_WIDTH_PX);
    return () => root.style.removeProperty('--side-panel-w');
  }, [rendered]);

  // Focus lands in the panel once it is on screen.
  useEffect(() => {
    if (open && rendered) panelRef.current?.focus({ preventScroll: true });
  }, [open, rendered]);

  useEscapeLayer(open, onClose);

  if (!rendered) return null;

  return (
    <aside
      ref={panelRef}
      aria-label={title}
      tabIndex={-1}
      data-side-panel=""
      className={cn(
        // Fixed under the 56px top bar, right edge; the page pads by its width.
        'fixed bottom-0 right-0 top-14 z-20 overflow-hidden border-l border-border bg-panel focus:outline-none',
        SIDE_PANEL_WIDTH_CLASS,
      )}
    >
      <div
        className={cn(
          // Axis: translateX only. No fade, no rotate.
          'flex h-full flex-col transition-transform will-change-transform',
          entered
            ? 'translate-x-0 duration-slow ease-enter'
            : 'translate-x-full duration-base ease-exit',
        )}
      >
        <div className="flex items-center gap-2.5 border-b border-border px-[18px] py-1.5">
          <h2 className="min-w-0 truncate text-lg font-semibold">{title}</h2>
          {headerExtra}
          <span className="ml-auto flex items-center">
            <IconButton label="Close" onClick={onClose}>
              <IconX size={ICON_SIZE.control} />
            </IconButton>
          </span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      </div>
    </aside>
  );
}
