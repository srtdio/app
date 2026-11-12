import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { IconButton } from '@/components/ui/IconButton';
import { ICON_SIZE, IconChevronLeft } from '@/components/ui/icons';
import { LEADING_PULL } from '@/components/ui/layout';
import { cn } from '@/lib/cn';
import { useEscapeLayer } from '@/lib/escape-stack';

interface SidePanelProps {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Beside the title (a status pill, a stamp). */
  headerExtra?: ReactNode;
  children: ReactNode;
  /**
   * The child brings its own header with the one "<" exit (a thread view's
   * HeaderBar): the panel draws no header of its own, the child fills it.
   */
  bare?: boolean;
  /**
   * Fill beside content (opt-in; the post page's comment thread): returns the
   * x (px) of the content's right edge beside the panel, or null to fall back
   * to the default. The panel then runs from that edge + 24 to the window
   * edge, never under 380, and the page is NOT padded (the content keeps its
   * size and place). Below 380 the content gives up the difference through
   * --side-panel-squeeze. While it fills, --side-panel-cover holds how much of
   * the page's width the panel covers, so a pinned bar on the page can end at
   * the panel's left edge instead of running over its header. Must be stable
   * (useCallback).
   */
  fillBeside?: () => number | null;
}

/** The laptop side panel's one width. */
export const SIDE_PANEL_WIDTH_CLASS = 'w-side-panel';
const SIDE_PANEL_WIDTH_PX = '380px';

/** The panel's floor, default and fill-beside alike. */
export const SIDE_PANEL_MIN_PX = 380;
/** Fill beside: the gap between the content's right edge and the panel. */
export const FILL_BESIDE_GAP_PX = 24;
/** Fill beside: how much the content beside gives up when the room is under 380. */
export const SIDE_PANEL_SQUEEZE_VAR = '--side-panel-squeeze';
/**
 * Fill beside: the width of the page (the scrolling main) under the panel,
 * set only while a panel fills. A pinned bar on the page takes it as its
 * right margin, so the bar ends at the panel's left edge and the panel's own
 * header is never covered. Unset everywhere else (0).
 */
export const SIDE_PANEL_COVER_VAR = '--side-panel-cover';

/**
 * Fill beside: how much of the page the panel covers, from the page's right
 * content edge (its scrollbar excluded) back to the panel's left. Pure.
 */
export function fillBesideCover(pageRight: number, panelLeft: number): number {
  return Math.max(0, pageRight - panelLeft);
}

/**
 * Fill beside: the panel's left and width for a content right edge (as laid
 * out with no squeeze) in a window, and how much the content must give up so
 * the panel is never under 380. Pure.
 */
export function fillBesidePlan(
  contentRight: number,
  windowWidth: number,
): { left: number; width: number; squeeze: number } {
  const left = Math.round(contentRight) + FILL_BESIDE_GAP_PX;
  const room = windowWidth - left;
  if (room >= SIDE_PANEL_MIN_PX) return { left, width: room, squeeze: 0 };
  return {
    left: windowWidth - SIDE_PANEL_MIN_PX,
    width: SIDE_PANEL_MIN_PX,
    squeeze: SIDE_PANEL_MIN_PX - room,
  };
}

/**
 * A laptop right side panel: 380px wide (or, with fillBeside, from the
 * content's right edge + 24 to the window edge, never under 380), fixed under the top bar to the
 * bottom of the screen; while it is on screen it sets --side-panel-w, which
 * the page pads by, so the page beside it shrinks and stays usable. Nothing dims and focus is not trapped (it is not
 * a dialog). "<" back leading, then the title; Esc closes and returns focus to whatever
 * had it when the panel opened. Motion: none. A laptop pane opens and closes
 * at once (docs/motion.md, laptop: pane switches are instant); it renders at
 * its final place from the first frame. Phone uses Sheet (rise).
 */
export function SidePanel({
  open,
  onClose,
  title,
  headerExtra,
  children,
  bare = false,
  fillBeside,
}: SidePanelProps) {
  const rendered = open;
  const panelRef = useRef<HTMLElement>(null);
  const returnRef = useRef<HTMLElement | null>(null);
  // Fill beside: measured before paint (a layout read, no wait), again on resize.
  const [fill, setFill] = useState<{ left: number; width: number } | null>(null);
  useLayoutEffect(() => {
    if (!rendered || fillBeside === undefined) {
      setFill(null);
      return;
    }
    const root = document.documentElement;
    const measure = (): void => {
      const right = fillBeside();
      if (right === null) {
        root.style.removeProperty(SIDE_PANEL_SQUEEZE_VAR);
        root.style.removeProperty(SIDE_PANEL_COVER_VAR);
        setFill(null);
        return;
      }
      // The edge as laid out without the squeeze in force now.
      const squeezed = Number.parseFloat(root.style.getPropertyValue(SIDE_PANEL_SQUEEZE_VAR)) || 0;
      const plan = fillBesidePlan(right + squeezed, document.documentElement.clientWidth);
      if (plan.squeeze > 0) root.style.setProperty(SIDE_PANEL_SQUEEZE_VAR, `${plan.squeeze}px`);
      else root.style.removeProperty(SIDE_PANEL_SQUEEZE_VAR);
      // The page under the panel: its pinned bar ends at the panel's left edge.
      const page = panelRef.current?.closest('main') ?? null;
      const pageRight =
        page !== null
          ? page.getBoundingClientRect().left + page.clientLeft + page.clientWidth
          : document.documentElement.clientWidth;
      root.style.setProperty(SIDE_PANEL_COVER_VAR, `${fillBesideCover(pageRight, plan.left)}px`);
      setFill({ left: plan.left, width: plan.width });
    };
    measure();
    window.addEventListener('resize', measure);
    return () => {
      window.removeEventListener('resize', measure);
      root.style.removeProperty(SIDE_PANEL_SQUEEZE_VAR);
      root.style.removeProperty(SIDE_PANEL_COVER_VAR);
    };
  }, [rendered, fillBeside]);
  const filling = fill !== null;

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
  // Fill beside never pads the page: the content keeps its size and place.
  useEffect(() => {
    if (!rendered) return;
    if (fillBeside !== undefined && fillBeside() !== null) return;
    const root = document.documentElement;
    root.style.setProperty('--side-panel-w', SIDE_PANEL_WIDTH_PX);
    return () => {
      root.style.removeProperty('--side-panel-w');
    };
  }, [rendered, fillBeside]);

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
      data-side-panel-fill={filling ? '' : undefined}
      style={fill !== null ? { left: fill.left, width: fill.width } : undefined}
      className={cn(
        // Fixed under the 56px top bar, right edge; the page pads by its width.
        // Fixed, so it never scrolls with the page in page mode on a touch
        // tablet; there the top bar also covers the status bar strip, so its
        // top is --shell-sticky-top (unset everywhere else: 3.5rem, the old top-14).
        'lit-overlay fixed bottom-0 right-0 top-[var(--shell-sticky-top,3.5rem)] z-sticky overflow-hidden border-l bg-panel focus:outline-none',
        // Fill beside: left and width from the measure; visible even when the
        // content it replaces is hidden around it.
        filling ? 'visible' : SIDE_PANEL_WIDTH_CLASS,
      )}
    >
      {bare ? (
        <div data-side-panel-bare="" className="relative h-full">
          {children}
        </div>
      ) : (
        <div className="flex h-full flex-col">
          {/* Header 56 on the 16 edge; the one exit is the "<" back leading,
            pulled out by 12 (LEADING_PULL) so its glyph sits on the edge. */}
          <div className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4">
            <IconButton label="Back" onClick={onClose} className={LEADING_PULL}>
              <IconChevronLeft size={ICON_SIZE.control} />
            </IconButton>
            {/* Phone: 4 more, so the title starts on the 64 text column (4 + 44 + 12 + 4). */}
            <h2 className="min-w-0 truncate text-lg font-semibold max-md:ml-1">{title}</h2>
            {headerExtra}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
        </div>
      )}
    </aside>
  );
}
