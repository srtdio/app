import type { FocusEvent, ReactNode, SyntheticEvent } from 'react';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Input } from '@/components/ui/Input';
import { SortMenu, type SortOption } from '@/components/ui/SortMenu';
import { IconPlus, IconSearch, IconX, ICON_SIZE } from '@/components/ui/icons';
import { glideAside } from '@/lib/motion';
import { SHELL_STICKY_TOP_CLASS } from '@/lib/scroll-mode';
import { isLaptopNow } from '@/lib/use-is-laptop';

interface SectionHeaderSearch {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** The field's accessible name, from the screen ("Search posts"). Required: a placeholder is not a name. */
  label: string;
}

interface SectionHeaderSort<S extends string> {
  options: SortOption<S>[];
  value: S;
  onChange: (value: S) => void;
  /** Accessible label for the sort trigger. Defaults to the SortMenu default. */
  label?: string;
}

/**
 * The primary "+"/create control: the list page's New button, last on the row
 * after search and sort/filter. Either a declarative accent button (IconPlus
 * at ICON_SIZE.inline before the label unless `icon` is given; the
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
  /**
   * Either the declarative SortMenu form (the common case, e.g. Assets/Briefs)
   * or a custom control node for pages whose sort needs more than a single
   * option list (e.g. Pipeline's consolidated order + date-window control).
   * Mirrors the primaryAction union.
   */
  sort?: SectionHeaderSort<S> | { node: ReactNode };
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
  /**
   * Opt-in, md and up: the actions take the first row (right-aligned) and the
   * search the full width of a second row, for a narrow pane (the 288px chat
   * list) where actions beside the box would squeeze it. Below md the single
   * row is unchanged. Default false keeps every other caller identical.
   */
  stackSearchMd?: boolean;
}

// Phone search focus (no state: the shape is CSS, the glide runs from the
// field's own focus events). The sort and New controls rest past the row's
// right edge while the search is the centre; the row clips them on X only.
function controlsOf(target: Element): Element | null {
  return target.closest('[data-search-row]')?.querySelector('[data-search-controls]') ?? null;
}

function insideGroup(e: FocusEvent<HTMLElement>): boolean {
  const next = e.relatedTarget;
  return (
    next instanceof Node &&
    (e.currentTarget.closest('[data-search-group]')?.contains(next) ?? false)
  );
}

function onSearchFocus(e: FocusEvent<HTMLInputElement>, searching: boolean): void {
  if (isLaptopNow() || searching || insideGroup(e)) return;
  glideAside(controlsOf(e.currentTarget), true);
}

function onSearchBlur(e: FocusEvent<HTMLInputElement>): void {
  // With text the row stays grown until Cancel or clear.
  if (isLaptopNow() || e.currentTarget.value !== '' || insideGroup(e)) return;
  glideAside(controlsOf(e.currentTarget), false);
}

/** Clear and Cancel: the controls glide back unless the field keeps focus. */
function glideBack(e: SyntheticEvent<HTMLElement>, blur: boolean): void {
  if (isLaptopNow()) return;
  const group = e.currentTarget.closest('[data-search-group]');
  const input = group?.querySelector('input') ?? null;
  const focused = input !== null && document.activeElement === input;
  if (blur && input !== null) {
    // Text cleared by Cancel: the blur handler still reads the old value, so
    // the glide runs here; an empty field glides from its own blur.
    const hadText = input.value !== '';
    input.blur();
    if (hadText) glideAside(controlsOf(e.currentTarget), false);
    return;
  }
  if (!focused) glideAside(controlsOf(e.currentTarget), false);
}

function renderPrimaryAction(action: SectionHeaderPrimaryAction): ReactNode {
  if ('node' in action) return action.node;
  return (
    <Button variant="primary" aria-label={action.label} onClick={action.onClick}>
      {action.icon ?? <IconPlus size={ICON_SIZE.inline} />}
      {action.label}
    </Button>
  );
}

function renderSort<S extends string>(sort: SectionHeaderSort<S> | { node: ReactNode }): ReactNode {
  if ('node' in sort) return sort.node;
  return (
    <SortMenu
      options={sort.options}
      value={sort.value}
      onChange={sort.onChange}
      {...(sort.label !== undefined ? { label: sort.label } : {})}
    />
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
  stackSearchMd = false,
}: SectionHeaderProps<S>) {
  const searching = search !== undefined && search.value.trim() !== '';
  // In locked mode (and on laptop) the scroll container is the shell <main>,
  // so top 0 pins to just below the app top bar; in page mode on a phone or a
  // touch tablet the window scrolls and SHELL_STICKY_TOP_CLASS pins it below
  // the sticky Topbar.
  // z-20 sits above the grid (z-0) and below the top bar (z-30).
  const childRowClass = cn(
    'px-4 md:px-6 flex gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
    stickyChildren
      ? cn('sticky z-20 border-b bg-bg py-3 lit-header', SHELL_STICKY_TOP_CLASS)
      : 'mt-3',
  );
  // Phone: with text the search keeps the row (controls aside, Cancel shown);
  // while the field has focus the same shape comes from peer/group focus-within.
  const aside = 'max-md:absolute max-md:right-4 max-md:translate-x-[calc(100%+1rem)]';
  const asideOnFocus =
    'max-md:peer-focus-within/srch:absolute max-md:peer-focus-within/srch:right-4 max-md:peer-focus-within/srch:translate-x-[calc(100%+1rem)]';
  const hasControls = sort !== undefined || primaryAction !== undefined;
  return (
    <>
      <div
        data-search-row={search !== undefined ? '' : undefined}
        className={cn(
          // One fixed 44px row on every list page (Pipeline, Briefs, Assets,
          // Plan, Activity), so the search and the chip row below it sit at
          // the same height on each tab and nothing jumps on switching. A
          // taller control (Plan's bordered Month | Week well) centres in the
          // row instead of growing it. The stacked chat-list pane wraps to two
          // rows at md, so it keeps its natural height there.
          'px-4 md:px-6 mt-3 flex h-11 items-center gap-2',
          // Phone: the controls glide out past the right edge; clip X only so
          // focus lines above and below still draw.
          search !== undefined && 'relative max-md:overflow-x-clip',
          stackSearchMd && 'md:h-auto md:flex-wrap md:gap-y-3',
        )}
      >
        {title !== undefined ? (
          <h2 className="shrink-0 text-lg font-semibold text-fg">{title}</h2>
        ) : null}
        {search !== undefined ? (
          <div
            data-search-group=""
            className={cn(
              'group/srch peer/srch flex min-w-0 flex-1 items-center gap-2',
              stackSearchMd && 'md:order-last md:basis-full',
            )}
          >
            <div className="group/sfield relative min-w-0 flex-1">
              {/* Tight insets so the placeholder fits a 360px phone row beside
                  sort and New: icon 8px in, text 4px after it, and the 44px
                  right inset is reserved only while the Clear button shows.
                  The icon is fg-3 at rest, full ink while the field is the centre. */}
              <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-fg-3 group-focus-within/sfield:text-fg">
                <IconSearch size={ICON_SIZE.inline} />
              </span>
              <Input
                tone="search"
                type="search"
                value={search.value}
                onChange={(e) => search.onChange(e.target.value)}
                onFocus={(e) => onSearchFocus(e, searching)}
                onBlur={onSearchBlur}
                placeholder={search.placeholder}
                aria-label={search.label}
                className={cn('min-w-0 pl-7', searching ? 'pr-11' : 'pr-2')}
              />
              {searching ? (
                <IconButton
                  type="button"
                  label="Clear search"
                  onClick={(e) => {
                    search.onChange('');
                    glideBack(e, false);
                  }}
                  className="absolute right-0 top-1/2 -translate-y-1/2"
                >
                  <IconX size={ICON_SIZE.inline} />
                </IconButton>
              ) : null}
            </div>
            {hasControls ? (
              // Phone only: ends the search, clears and blurs. pointerdown keeps
              // the field focused so the tap lands before the row returns.
              <Button
                type="button"
                variant="ghost"
                data-search-cancel=""
                onPointerDown={(e) => e.preventDefault()}
                onClick={(e) => {
                  search.onChange('');
                  glideBack(e, true);
                }}
                className={cn(
                  'shrink-0 md:hidden',
                  searching ? null : 'hidden group-focus-within/srch:inline-flex',
                )}
              >
                Cancel
              </Button>
            ) : null}
          </div>
        ) : null}
        {hasControls ? (
          <div
            data-search-controls=""
            className={cn(
              'flex shrink-0 items-center gap-2',
              stackSearchMd && 'md:ml-auto',
              search !== undefined && (searching ? aside : asideOnFocus),
            )}
          >
            {sort !== undefined ? renderSort(sort) : null}
            {primaryAction !== undefined ? renderPrimaryAction(primaryAction) : null}
          </div>
        ) : null}
      </div>
      {children !== undefined ? <div className={childRowClass}>{children}</div> : null}
    </>
  );
}
