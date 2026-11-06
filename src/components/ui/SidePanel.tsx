import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { IconButton } from '@/components/ui/IconButton';
import { ICON_SIZE, IconX } from '@/components/ui/icons';
import { TRAILING_PULL } from '@/components/ui/layout';
import { cn } from '@/lib/cn';
import { useEscapeLayer } from '@/lib/escape-stack';

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

/**
 * A laptop right side panel: 380px wide, fixed under the top bar to the
 * bottom of the screen; while it is on screen it sets --side-panel-w, which
 * the page pads by, so the page beside it shrinks and stays usable. Nothing dims and focus is not trapped (it is not
 * a dialog). Title left, X right; Esc closes and returns focus to whatever
 * had it when the panel opened. Motion: none. A laptop pane opens and closes
 * at once (docs/motion.md, laptop: pane switches are instant); it renders at
 * its final place from the first frame. Phone uses Sheet (rise).
 */
export function SidePanel({ open, onClose, title, headerExtra, children }: SidePanelProps) {
  const rendered = open;
  const panelRef = useRef<HTMLElement>(null);
  const returnRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (open) {
      const was = document.activeElement;
      returnRef.current = was instanceof HTMLElement && was !== document.body ? was : null;
      return;
    }
    const back = returnRef.current;
    returnRef.current = null;
    if (back !== null && back.isConnected) back.focus({ preventScroll: true });
  }, [open]);

  // While on screen the page makes room: main pads by --side-panel-w (AppLayout).
  useEffect(() => {
    if (!rendered) return;
    const root = document.documentElement;
    root.style.setProperty('--side-panel-w', SIDE_PANEL_WIDTH_PX);
    return () => {
      root.style.removeProperty('--side-panel-w');
    };
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
        // Fixed, so it never scrolls with the page in page mode on a touch
        // tablet; there the top bar also covers the status bar strip, so its
        // top is --shell-sticky-top (unset everywhere else: 3.5rem, the old top-14).
        'lit-overlay fixed bottom-0 right-0 top-[var(--shell-sticky-top,3.5rem)] z-20 overflow-hidden border-l bg-panel focus:outline-none',
        SIDE_PANEL_WIDTH_CLASS,
      )}
    >
      <div className="flex h-full flex-col">
        {/* Header 56 on the 16 edge; the X is pulled out by 12 (the trailing rule). */}
        <div className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4">
          <h2 className="min-w-0 truncate text-lg font-semibold">{title}</h2>
          {headerExtra}
          <span className="ml-auto flex items-center">
            <IconButton label="Close" onClick={onClose} className={TRAILING_PULL}>
              <IconX size={ICON_SIZE.control} />
            </IconButton>
          </span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      </div>
    </aside>
  );
}
