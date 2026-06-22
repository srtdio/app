import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/Button';
import { SortMenu, type SortOption } from '@/components/ui/SortMenu';
import { IconSearch, IconX } from '@/components/ui/icons';

interface SectionHeaderSearch {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

interface SectionHeaderSort<S extends string> {
  options: SortOption<S>[];
  value: S;
  onChange: (value: S) => void;
  /** Accessible label for the sort trigger. Defaults to the SortMenu default. */
  label?: string;
}

/**
 * The primary "+"/create control. Either a declarative accent button (the
 * common create action, e.g. Pipeline/Briefs) or a custom control for pages
 * whose primary action needs more than a single onClick (e.g. the Assets add
 * menu). Command/query: the button form owns no logic, it only calls onClick.
 */
type SectionHeaderPrimaryAction =
  | { label: string; onClick: () => void; icon?: ReactNode }
  | { node: ReactNode };

interface SectionHeaderProps<S extends string = string> {
  /** Optional left-aligned label. Omitted pages start the row with search. */
  title?: string;
  /** Controlled search field. Presentational: it calls onChange, never filters. */
  search?: SectionHeaderSearch;
  /** Reuses the canonical SortMenu primitive and its option typing. */
  sort?: SectionHeaderSort<S>;
  /** Accent "+"/create action. */
  primaryAction?: SectionHeaderPrimaryAction;
  /** Page-specific filter chips, rendered on the row below the controls. */
  children?: ReactNode;
  /**
   * Opt-in: pin ONLY the children action-bar to the top of the scroll area
   * (below the app top bar, which lives outside the scroll container), with a
   * solid token background so scrolled grid content does not show through. The
   * title/search row is never sticky. Default false keeps every other caller
   * rendering identically.
   */
  stickyChildren?: boolean;
}

function renderPrimaryAction(action: SectionHeaderPrimaryAction): ReactNode {
  if ('node' in action) return action.node;
  return (
    <Button variant="primary" size="lg" aria-label={action.label} onClick={action.onClick}>
      {action.icon}
      {action.label}
    </Button>
  );
}

/**
 * Shared page-header chrome extracted from Assets: a single row holding an
 * optional title, a controlled search field, a sort control, and a primary
 * "+"/create action, with an optional slot below for page-specific filter
 * chips. Token classes only; every interactive control is at least 44x44.
 * The component owns no data and no filtering/create logic (command/query
 * separation) so each page wires its own state and handlers.
 */
export function SectionHeader<S extends string = string>({
  title,
  search,
  sort,
  primaryAction,
  children,
  stickyChildren = false,
}: SectionHeaderProps<S>) {
  const searching = search !== undefined && search.value.trim() !== '';
  // The scroll container is the shell <main>, so top-0 pins to just below the
  // app top bar. z-20 sits above the grid (z-0) and below the top bar (z-30).
  const childRowClass = cn(
    'px-4 md:px-6 flex gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
    stickyChildren ? 'sticky top-0 z-20 border-b border-border bg-bg py-3' : 'mt-3',
  );
  return (
    <>
      <div className="px-4 md:px-6 mt-3 flex items-center gap-2">
        {title !== undefined ? (
          <h2 className="shrink-0 text-[15px] font-semibold text-fg">{title}</h2>
        ) : null}
        {search !== undefined ? (
          <div className="relative min-w-0 flex-1">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-3">
              <IconSearch size={16} />
            </span>
            <input
              type="search"
              value={search.value}
              onChange={(e) => search.onChange(e.target.value)}
              placeholder={search.placeholder}
              className="h-11 w-full rounded-md border border-border bg-panel pl-9 pr-11 text-sm text-fg placeholder:text-fg-3 focus:border-border-strong focus:outline-none"
            />
            {searching ? (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => search.onChange('')}
                className="absolute right-0 top-1/2 -translate-y-1/2 inline-flex h-11 w-11 items-center justify-center rounded-md text-fg-3 hover:bg-panel-2 hover:text-fg"
              >
                <IconX size={16} />
              </button>
            ) : null}
          </div>
        ) : null}
        {sort !== undefined ? (
          <SortMenu
            options={sort.options}
            value={sort.value}
            onChange={sort.onChange}
            {...(sort.label !== undefined ? { label: sort.label } : {})}
          />
        ) : null}
        {primaryAction !== undefined ? renderPrimaryAction(primaryAction) : null}
      </div>
      {children !== undefined ? <div className={childRowClass}>{children}</div> : null}
    </>
  );
}
