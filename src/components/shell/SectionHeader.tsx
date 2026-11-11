import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { SHELL_STICKY_TOP_CLASS } from '@/lib/scroll-mode';

interface SectionHeaderProps {
  /** Page-specific filter chips. They scroll sideways. */
  children?: ReactNode;
  /**
   * Opt-in: pin the chip row to the top of the scroll area (below the app top
   * bar), with a solid token background so scrolled content does not show
   * through. Default false keeps every other caller rendering identically.
   */
  stickyChildren?: boolean;
  /**
   * shell/ListScreen passes the row's top gap and side pads (its own literal
   * classes, the same values). Absent: the defaults below, so every direct
   * caller renders as before.
   */
  topClass?: string;
  padClass?: string;
}

/**
 * The list page's chip row (decisions A, B, E): search lives only in the top
 * bar's CommandPalette and sort / "+" in the top bar (useTopbarActions), so
 * the header is one row of filter chips and nothing else (no Select key, 10
 * Nov 2026: long-press or right-click a row selects). Token classes only;
 * every interactive control is at least 44x44. The component owns no data and no filtering logic (command/query separation).
 */
export function SectionHeader({
  children,
  stickyChildren = false,
  topClass,
  padClass,
}: SectionHeaderProps) {
  if (children === undefined) return null;
  return (
    <div
      data-chip-row=""
      className={cn(
        // z-sticky sits above the grid (z-base) and below the top bar (z-nav).
        'flex items-center gap-2',
        padClass ?? 'px-4 md:px-6',
        stickyChildren
          ? cn('sticky z-sticky border-b bg-bg py-3 lit-header', SHELL_STICKY_TOP_CLASS)
          : (topClass ?? 'mt-3'),
      )}
    >
      <div
        data-chip-scroll=""
        className="flex min-w-0 flex-1 gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {children}
      </div>
    </div>
  );
}
