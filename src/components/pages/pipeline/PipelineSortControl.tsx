// The Pipeline header controls. PipelineFilterControl is the one the page
// mounts: a single 44x44 icon button opening one sheet (popover on a laptop)
// that holds the due-date filter rows and the sort rows. PipelineSortControl
// and PipelineDateControl remain as the standalone buttons the combined body
// is composed from. Rows share SortMenu's radio-row markup
// (role="menuitemradio", aria-checked, an IconCheck on the active row) and stay
// 44px on every screen. The date filter's "Custom" row opens the floating range
// calendar, which paints ON TOP and never pushes page content down.

import { useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Sheet } from '@/components/ui/Sheet';
import { Button } from '@/components/ui/Button';
import {
  ICON_SIZE,
  IconCalendar,
  IconCheck,
  IconChevronDown,
  IconFilterLines,
  IconSort,
} from '@/components/ui/icons';
import { useMediaQuery } from '@/lib/use-media-query';
import { PipelineDateRangeCalendar } from '@/components/pages/pipeline/PipelineDateRangeCalendar';
import {
  DATE_WINDOW_OPTIONS,
  POST_SORT_DEFAULT,
  POST_SORT_OPTIONS,
  type DateWindow,
  type PostSort,
} from '@/lib/list-sort';

interface DateRange {
  start: string;
  end: string;
}

interface PipelineSortControlProps {
  order: PostSort;
  onOrderChange: (order: PostSort) => void;
}

interface PipelineDateControlProps {
  dateWindow: DateWindow;
  onDateWindowChange: (window: DateWindow) => void;
  customRange: DateRange | null;
  onCustomRangeChange: (range: DateRange | null) => void;
  weekStartDay: number;
}

/**
 * The Pipeline's sort labels. Both update orders say what they sort by (the
 * post's last update), not just a direction.
 */
const SORT_LABEL: Record<PostSort, string> = {
  updated: 'Recently updated',
  oldest: 'Least recently updated',
  target: 'Due soonest first',
};

/** The sort menu rows, in menu order, with the Pipeline's labels. */
export const PIPELINE_SORT_OPTIONS: readonly { value: PostSort; label: string }[] =
  POST_SORT_OPTIONS.map((option) => ({ value: option.value, label: SORT_LABEL[option.value] }));

const MONTHS_SHORT = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/** Format an ISO 'YYYY-MM-DD' as "24 Jun"; an unparseable value yields ''. */
function formatRangeDay(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (match === null) return '';
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) return '';
  return `${day} ${MONTHS_SHORT[month - 1]}`;
}

/** The Custom row label: "24 Jun to 27 Jun", "24 Jun" for one day, or "Custom…". */
export function customRangeLabel(range: DateRange | null): string {
  if (range === null) return 'Custom…';
  const start = formatRangeDay(range.start);
  if (range.start === range.end) return start;
  return `${start} to ${formatRangeDay(range.end)}`;
}

/** A single radio row, sharing SortMenu's row markup (44px, check + label). */
function radioRow(
  key: string,
  label: ReactNode,
  selected: boolean,
  onClick: () => void,
  trailing?: ReactNode,
): ReactElement {
  return (
    <button
      key={key}
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      onClick={onClick}
      className={cn(
        'flex h-11 w-full items-center gap-2.5 rounded-lg px-3 text-left text-base transition-colors',
        selected ? 'text-fg' : 'text-fg-2 hover:bg-panel-2',
      )}
    >
      <span className="flex h-4 w-4 shrink-0 items-center justify-center text-accent">
        {selected ? <IconCheck size={ICON_SIZE.inline} /> : null}
      </span>
      <span className="flex-1">{label}</span>
      {trailing}
    </button>
  );
}

/** The Sort body: the order rows. Pure, so the rows are unit tested without a DOM. */
export function sortControlBody(props: {
  order: PostSort;
  onOrderChange: (order: PostSort) => void;
}): ReactElement {
  return (
    <div role="menu" aria-label="Sort" className="flex flex-col">
      {PIPELINE_SORT_OPTIONS.map((option) =>
        radioRow(option.value, option.label, option.value === props.order, () =>
          props.onOrderChange(option.value),
        ),
      )}
    </div>
  );
}

/** The date filter body: the preset windows plus Custom. Pure. */
export function dateControlBody(props: {
  dateWindow: DateWindow;
  onDateWindowChange: (window: DateWindow) => void;
  customRange: DateRange | null;
  onCustomOpen: () => void;
}): ReactElement {
  return (
    <div role="menu" aria-label="Due date" className="flex flex-col">
      {DATE_WINDOW_OPTIONS.map((option) =>
        radioRow(option.value, option.label, props.dateWindow === option.value, () =>
          props.onDateWindowChange(option.value),
        ),
      )}
      {radioRow(
        'custom',
        customRangeLabel(props.customRange),
        props.dateWindow === 'custom',
        props.onCustomOpen,
        <IconCalendar size={ICON_SIZE.inline} className="shrink-0 text-fg-3" />,
      )}
    </div>
  );
}

/** The date button's label: the active window ("This week", "24 Jun to 27 Jun"). */
export function dateButtonLabel(dateWindow: DateWindow, customRange: DateRange | null): string {
  if (dateWindow === 'custom')
    return customRange === null ? 'Any time' : customRangeLabel(customRange);
  return DATE_WINDOW_OPTIONS.find((option) => option.value === dateWindow)?.label ?? 'Any time';
}

// 44x44 at least on every screen: h-11 tall, and min-w-11 so the icon-only
// phone date button is never narrower than its target.
// Layout for the shared secondary Button used as a menu trigger.
const TRIGGER = 'min-w-11 shrink-0';

/** The responsive shell: a popover on desktop, the shared bottom Sheet on mobile. */
function MenuShell(props: {
  isDesktop: boolean;
  open: boolean;
  onClose: () => void;
  title: string;
  trigger: ReactElement;
  body: ReactElement;
  extra?: ReactNode;
}): ReactElement {
  if (props.isDesktop) {
    return (
      <div className="relative">
        {props.trigger}
        {props.open ? (
          <>
            <div className="fixed inset-0 z-40" aria-hidden="true" onClick={props.onClose} />
            <div className="absolute right-0 top-full z-50 mt-1.5 w-64 rounded-xl border border-border-strong bg-panel p-1.5 shadow-2xl">
              {props.body}
            </div>
          </>
        ) : null}
        {props.extra}
      </div>
    );
  }
  return (
    <>
      {props.trigger}
      <Sheet open={props.open} onClose={props.onClose} title={props.title}>
        {props.body}
      </Sheet>
      {props.extra}
    </>
  );
}

export function PipelineSortControl({
  order,
  onOrderChange,
}: PipelineSortControlProps): ReactElement {
  const [open, setOpen] = useState(false);
  const isDesktop = useMediaQuery('(min-width: 768px)');
  const activeOrder = PIPELINE_SORT_OPTIONS.find((option) => option.value === order);
  const trigger = (
    <Button
      type="button"
      variant="secondary"
      aria-haspopup="menu"
      aria-expanded={open}
      aria-label="Sort"
      onClick={() => setOpen((prev) => !prev)}
      className={cn(TRIGGER, 'text-fg-2')}
    >
      <IconSort size={ICON_SIZE.inline} />
      <span className="hidden sm:inline">{activeOrder?.label ?? 'Sort'}</span>
      <IconChevronDown size={ICON_SIZE.inline} className="text-fg-3" />
    </Button>
  );
  return (
    <MenuShell
      isDesktop={isDesktop}
      open={open}
      onClose={() => setOpen(false)}
      title="Sort"
      trigger={trigger}
      body={sortControlBody({
        order,
        onOrderChange: (next) => {
          onOrderChange(next);
          setOpen(false);
        },
      })}
    />
  );
}

/**
 * The date filter as its own button: the calendar icon, and on a laptop the
 * active window's label. While a window is on it carries the accent outline.
 */
export function PipelineDateControl({
  dateWindow,
  onDateWindowChange,
  customRange,
  onCustomRangeChange,
  weekStartDay,
}: PipelineDateControlProps): ReactElement {
  const [open, setOpen] = useState(false);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const isDesktop = useMediaQuery('(min-width: 768px)');
  const active = dateFilterActive(dateWindow, customRange);
  const label = dateButtonLabel(dateWindow, customRange);
  const trigger = (
    <Button
      type="button"
      variant="secondary"
      aria-haspopup="menu"
      aria-expanded={open}
      aria-label={`Due date: ${label}`}
      data-date-filter=""
      onClick={() => setOpen((prev) => !prev)}
      className={cn(
        TRIGGER,
        active ? 'border-accent-line bg-accent-soft text-accent' : 'text-fg-2',
      )}
    >
      <IconCalendar size={ICON_SIZE.inline} />
      <span className="hidden md:inline">{label}</span>
    </Button>
  );
  // Always mounted so it floats above the sheet/popover; its own `open` prop
  // gates the portal. Applying closes both the calendar and the sheet/popover,
  // so the user lands straight back on the filtered board.
  const calendar = (
    <PipelineDateRangeCalendar
      open={calendarOpen}
      initialRange={customRange}
      weekStartDay={weekStartDay}
      onApply={(range) => {
        onCustomRangeChange(range);
        onDateWindowChange('custom');
        setCalendarOpen(false);
        setOpen(false);
      }}
      onClear={() => {
        onCustomRangeChange(null);
        if (dateWindow === 'custom') onDateWindowChange('any');
        setCalendarOpen(false);
      }}
      onClose={() => setCalendarOpen(false)}
    />
  );
  return (
    <MenuShell
      isDesktop={isDesktop}
      open={open}
      onClose={() => setOpen(false)}
      title="Due date"
      trigger={trigger}
      body={dateControlBody({
        dateWindow,
        onDateWindowChange: (next) => {
          onDateWindowChange(next);
          setOpen(false);
        },
        customRange,
        onCustomOpen: () => setCalendarOpen(true),
      })}
      extra={calendar}
    />
  );
}

interface PipelineFilterControlProps extends PipelineSortControlProps, PipelineDateControlProps {}

/** True when a due-date window other than Any time is applied (Custom needs a range). */
export function dateFilterActive(dateWindow: DateWindow, customRange: DateRange | null): boolean {
  return dateWindow !== 'any' && !(dateWindow === 'custom' && customRange === null);
}

/**
 * The combined body: the due-date rows, a divider, then the sort rows. Each
 * section keeps its own role="menu" and label so the rows stay as they were.
 * Pure.
 */
export function filterControlBody(props: {
  order: PostSort;
  onOrderChange: (order: PostSort) => void;
  dateWindow: DateWindow;
  onDateWindowChange: (window: DateWindow) => void;
  customRange: DateRange | null;
  onCustomOpen: () => void;
}): ReactElement {
  return (
    <div data-filter-body="" className="flex flex-col">
      <p className="px-3 pb-1 pt-1.5 text-sm font-semibold uppercase tracking-[0.06em] text-fg-2">
        Due date
      </p>
      {dateControlBody({
        dateWindow: props.dateWindow,
        onDateWindowChange: props.onDateWindowChange,
        customRange: props.customRange,
        onCustomOpen: props.onCustomOpen,
      })}
      <div className="my-1.5 border-t border-border" aria-hidden="true" />
      <p className="px-3 pb-1 pt-1.5 text-sm font-semibold uppercase tracking-[0.06em] text-fg-2">
        Sort
      </p>
      {sortControlBody({ order: props.order, onOrderChange: props.onOrderChange })}
    </div>
  );
}

/**
 * One 44x44 icon button in place of the separate date and sort buttons: it
 * opens a single sheet (popover on a laptop) holding both. While a date window
 * or a non-default sort is on, a small accent dot sits on the button's corner.
 * The floating range calendar still paints on top via the Custom row.
 */
export function PipelineFilterControl({
  order,
  onOrderChange,
  dateWindow,
  onDateWindowChange,
  customRange,
  onCustomRangeChange,
  weekStartDay,
}: PipelineFilterControlProps): ReactElement {
  const [open, setOpen] = useState(false);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const isDesktop = useMediaQuery('(min-width: 768px)');
  const active = dateFilterActive(dateWindow, customRange) || order !== POST_SORT_DEFAULT;
  const trigger = (
    <Button
      type="button"
      variant="secondary"
      aria-haspopup="menu"
      aria-expanded={open}
      aria-label="Filter and sort"
      data-filter-control=""
      {...(active ? { 'data-active': '' } : {})}
      onClick={() => setOpen((prev) => !prev)}
      className={cn(TRIGGER, 'relative w-11 !px-0 text-fg-2')}
    >
      <IconFilterLines size={ICON_SIZE.control} />
      {active ? (
        <span
          aria-hidden="true"
          data-filter-dot=""
          className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-accent ring-2 ring-panel"
        />
      ) : null}
    </Button>
  );
  const calendar = (
    <PipelineDateRangeCalendar
      open={calendarOpen}
      initialRange={customRange}
      weekStartDay={weekStartDay}
      onApply={(range) => {
        onCustomRangeChange(range);
        onDateWindowChange('custom');
        setCalendarOpen(false);
        setOpen(false);
      }}
      onClear={() => {
        onCustomRangeChange(null);
        if (dateWindow === 'custom') onDateWindowChange('any');
        setCalendarOpen(false);
      }}
      onClose={() => setCalendarOpen(false)}
    />
  );
  return (
    <MenuShell
      isDesktop={isDesktop}
      open={open}
      onClose={() => setOpen(false)}
      title="Filter and sort"
      trigger={trigger}
      body={filterControlBody({
        order,
        onOrderChange: (next) => {
          onOrderChange(next);
          setOpen(false);
        },
        dateWindow,
        onDateWindowChange: (next) => {
          onDateWindowChange(next);
          setOpen(false);
        },
        customRange,
        onCustomOpen: () => setCalendarOpen(true),
      })}
      extra={calendar}
    />
  );
}
