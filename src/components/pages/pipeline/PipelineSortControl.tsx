// The consolidated Pipeline sort control. It folds the date-window presets and a
// custom range INTO one sort surface, replacing the standalone segmented window
// row. The responsive shell mirrors SortMenu exactly (a popover under the trigger
// on desktop, the shared bottom Sheet on mobile) without importing it. The body
// is identical on both surfaces: two labelled groups built from the same
// radio-row markup SortMenu uses (role="menuitemradio", aria-checked, an
// IconCheck on the active row). The "Custom" row opens the floating range
// calendar, which paints ON TOP and never pushes page content down.

import { useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Sheet } from '@/components/ui/Sheet';
import { IconCalendar, IconCheck, IconChevronDown, IconSort } from '@/components/ui/icons';
import { useMediaQuery } from '@/lib/use-media-query';
import { PipelineDateRangeCalendar } from '@/components/pages/pipeline/PipelineDateRangeCalendar';
import {
  DATE_WINDOW_OPTIONS,
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
  dateWindow: DateWindow;
  onDateWindowChange: (window: DateWindow) => void;
  customRange: DateRange | null;
  onCustomRangeChange: (range: DateRange | null) => void;
  weekStartDay: number;
}

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
export function formatRangeDay(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (match === null) return '';
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) return '';
  return `${day} ${MONTHS_SHORT[month - 1]}`;
}

/** The Custom row label: "24 Jun – 27 Jun", "24 Jun" for one day, or "Custom…". */
export function customRangeLabel(range: DateRange | null): string {
  if (range === null) return 'Custom…';
  const start = formatRangeDay(range.start);
  if (range.start === range.end) return start;
  return `${start} – ${formatRangeDay(range.end)}`;
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
        'flex min-h-[44px] w-full items-center gap-2.5 rounded-md px-3 text-left text-sm transition-colors md:min-h-0 md:h-9',
        selected ? 'text-fg' : 'text-fg-2 hover:bg-panel-2',
      )}
    >
      <span className="flex h-4 w-4 shrink-0 items-center justify-center text-accent">
        {selected ? <IconCheck size={16} /> : null}
      </span>
      <span className="flex-1">{label}</span>
      {trailing}
    </button>
  );
}

/** A labelled group header (uppercase token caption above its rows). */
function groupLabel(text: string): ReactElement {
  return (
    <div className="px-3 pb-1 pt-1 text-xs font-medium uppercase tracking-wide text-fg-3">
      {text}
    </div>
  );
}

/**
 * The grouped body, identical in the desktop popover and the mobile Sheet. Pure
 * (no hooks) so the two groups, the Order/Target-date rows, and the Custom row's
 * open handler are unit-testable without a DOM, mirroring SortMenu's pure
 * `sortOptionButtons`.
 */
export function sortControlBody(props: {
  order: PostSort;
  onOrderChange: (order: PostSort) => void;
  dateWindow: DateWindow;
  onDateWindowChange: (window: DateWindow) => void;
  customRange: DateRange | null;
  onCustomOpen: () => void;
}): ReactElement {
  return (
    <div className="flex flex-col gap-3">
      <div role="group" aria-label="Order" className="flex flex-col">
        {groupLabel('Order')}
        {POST_SORT_OPTIONS.map((option) =>
          radioRow(option.value, option.label, option.value === props.order, () =>
            props.onOrderChange(option.value),
          ),
        )}
      </div>
      <div role="group" aria-label="Target date" className="flex flex-col">
        {groupLabel('Target date')}
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
          <IconCalendar size={16} className="shrink-0 text-fg-3" />,
        )}
      </div>
    </div>
  );
}

export function PipelineSortControl({
  order,
  onOrderChange,
  dateWindow,
  onDateWindowChange,
  customRange,
  onCustomRangeChange,
  weekStartDay,
}: PipelineSortControlProps): ReactElement {
  // Declaration order matters: `open` is the first useState, `calendarOpen` the
  // second. The shell renders the trigger + the active ORDER label, exactly like
  // SortMenu's trigger.
  const [open, setOpen] = useState(false);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const isDesktop = useMediaQuery('(min-width: 768px)');
  const activeOrder = POST_SORT_OPTIONS.find((option) => option.value === order);

  const trigger = (
    <button
      type="button"
      aria-haspopup="menu"
      aria-expanded={open}
      aria-label="Sort"
      onClick={() => setOpen((prev) => !prev)}
      className="inline-flex h-11 shrink-0 items-center gap-2 rounded-md border border-border bg-panel px-3 text-sm text-fg-2 transition-colors hover:bg-panel-2 hover:text-fg md:h-9"
    >
      <IconSort size={16} />
      <span className="hidden sm:inline">{activeOrder?.label ?? 'Sort'}</span>
      <IconChevronDown size={14} className="text-fg-3" />
    </button>
  );

  const body = sortControlBody({
    order,
    onOrderChange,
    dateWindow,
    onDateWindowChange,
    customRange,
    onCustomOpen: () => setCalendarOpen(true),
  });

  // Always mounted so it floats above the sheet/popover; its own `open` prop
  // gates the portal. Applying keeps the sheet/popover open (only the calendar
  // closes), so the user lands back on the grouped rows with 'Custom' active.
  const calendar = (
    <PipelineDateRangeCalendar
      open={calendarOpen}
      initialRange={customRange}
      weekStartDay={weekStartDay}
      onApply={(range) => {
        onCustomRangeChange(range);
        onDateWindowChange('custom');
        setCalendarOpen(false);
      }}
      onClear={() => {
        onCustomRangeChange(null);
        if (dateWindow === 'custom') onDateWindowChange('any');
        setCalendarOpen(false);
      }}
      onClose={() => setCalendarOpen(false)}
    />
  );

  if (isDesktop) {
    return (
      <div className="relative">
        {trigger}
        {open ? (
          <>
            <div className="fixed inset-0 z-40" aria-hidden="true" onClick={() => setOpen(false)} />
            <div className="absolute right-0 top-full z-50 mt-1.5 w-64 rounded-xl border border-border-strong bg-panel p-1.5 shadow-2xl">
              {body}
            </div>
          </>
        ) : null}
        {calendar}
      </div>
    );
  }

  return (
    <>
      {trigger}
      <Sheet open={open} onClose={() => setOpen(false)} title="Sort">
        {body}
      </Sheet>
      {calendar}
    </>
  );
}
