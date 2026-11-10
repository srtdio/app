import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/Button';
import { IconCheckCircle, ICON_SIZE } from '@/components/ui/icons';
import { SHELL_STICKY_TOP_CLASS } from '@/lib/scroll-mode';

interface SectionHeaderProps {
  /** Page-specific filter chips. They scroll sideways under the pinned Select. */
  children?: ReactNode;
  /**
   * Decision E (7 Nov): the visible Select control at the right end of the
   * chip row (SectionSelect). It stays pinned while the chips scroll under it.
   */
  select?: ReactNode;
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
 * the header is one row of filter chips with Select pinned at its end. Token
 * classes only; every interactive control is at least 44x44. The component
 * owns no data and no filtering logic (command/query separation).
 */
export function SectionHeader({
  children,
  select,
  stickyChildren = false,
  topClass,
  padClass,
}: SectionHeaderProps) {
  if (children === undefined && select === undefined) return null;
  return (
    <div
      data-chip-row=""
      className={cn(
        // z-sticky sits above the grid (z-base) and below the top bar (z-nav).
        padClass === undefined
          ? cn(
              'flex items-center gap-2 pl-4 md:pl-6',
              // The pinned Select's 44 box is pulled out to the edge like a trailing control.
              select !== undefined ? 'pr-1 md:pr-3' : 'pr-4 md:pr-6',
            )
          : cn('flex items-center gap-2', padClass),
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
      {select !== undefined ? (
        <div data-chip-row-select="" className="shrink-0">
          {select}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The visible Select control (decision E): IconCheckCircle + the word
 * "Select", a 44-tall ghost Button. A tap starts select mode (long-press and
 * right-click still start it too); while select mode is on it is pressed and a
 * second tap ends it. The bottom SelectBar is unchanged.
 */
export function SectionSelect({
  active,
  onToggle,
  induction,
}: {
  active: boolean;
  onToggle: () => void;
  induction?: string | undefined;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      aria-pressed={active}
      data-section-select={active ? 'on' : 'off'}
      {...(induction !== undefined ? { 'data-induction': induction } : {})}
      onClick={onToggle}
      className={cn('shrink-0 px-3', active && 'lit-selected')}
    >
      <IconCheckCircle size={ICON_SIZE.inline} />
      Select
    </Button>
  );
}
