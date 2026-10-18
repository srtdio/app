// The Pipeline filters live in the URL query so Back (from a post, or any other
// page) lands on the same stage, search and date window. Pure helpers: the page
// reads and writes through useSearchParams; the feed keys its Show more depth
// in sessionStorage by the same query string.

import { DATE_WINDOW_DEFAULT, DATE_WINDOW_OPTIONS, type DateWindow } from '@/lib/list-sort';
import { customRangeLabel } from '@/components/pages/pipeline/PipelineSortControl';

export interface DateRange {
  start: string;
  end: string;
}

export interface PipelineQuery {
  /** The active chip: 'all' or a Stage. */
  stage: string;
  search: string;
  dateWindow: DateWindow;
  customRange: DateRange | null;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const WINDOWS: readonly DateWindow[] = ['week', 'month', 'any', 'custom'];

/** Read the filters from the query; anything missing or malformed takes its default. */
export function parsePipelineQuery(params: URLSearchParams, initialStage: string): PipelineQuery {
  const rawWindow = params.get('date');
  const dateWindow = WINDOWS.find((w) => w === rawWindow) ?? DATE_WINDOW_DEFAULT;
  const start = params.get('from');
  const end = params.get('to');
  const customRange =
    start !== null && end !== null && ISO_DAY.test(start) && ISO_DAY.test(end)
      ? { start, end }
      : null;
  return {
    stage: params.get('stage') ?? initialStage,
    search: params.get('q') ?? '',
    dateWindow,
    customRange,
  };
}

/** Write the filters back; defaults are left out so a clean board has a clean URL. */
export function pipelineQueryParams(query: PipelineQuery, initialStage: string): URLSearchParams {
  const params = new URLSearchParams();
  if (query.stage !== initialStage) params.set('stage', query.stage);
  if (query.search !== '') params.set('q', query.search);
  if (query.dateWindow !== DATE_WINDOW_DEFAULT) params.set('date', query.dateWindow);
  if (query.customRange !== null) {
    params.set('from', query.customRange.start);
    params.set('to', query.customRange.end);
  }
  return params;
}

/** Whether the date window actually narrows the list ('custom' needs a range). */
export function dateFilterActive(
  query: Pick<PipelineQuery, 'dateWindow' | 'customRange'>,
): boolean {
  if (query.dateWindow === 'custom') return query.customRange !== null;
  return query.dateWindow !== DATE_WINDOW_DEFAULT;
}

/** Search or date narrowing is on: an empty list is "No matches", not "No posts". */
export function filtersActive(query: PipelineQuery): boolean {
  return query.search.trim() !== '' || dateFilterActive(query);
}

/** The active date chip's label: the preset name or the custom range. */
export function dateChipLabel(query: Pick<PipelineQuery, 'dateWindow' | 'customRange'>): string {
  if (query.dateWindow === 'custom') return customRangeLabel(query.customRange);
  return DATE_WINDOW_OPTIONS.find((o) => o.value === query.dateWindow)?.label ?? '';
}

/** The sessionStorage key for the feed's Show more depth under this query. */
export function showMoreKey(query: string): string {
  return `pipeline:shown:${query}`;
}

/** Read a remembered Show more depth; storage off or junk falls back. */
export function readShown(key: string, fallback: number): number {
  try {
    const raw = globalThis.sessionStorage?.getItem(key) ?? null;
    const value = raw === null ? NaN : Number(raw);
    return Number.isInteger(value) && value >= fallback ? value : fallback;
  } catch {
    return fallback;
  }
}

/** Remember a Show more depth; storage off is a no-op. */
export function writeShown(key: string, value: number): void {
  try {
    globalThis.sessionStorage?.setItem(key, String(value));
  } catch {
    // Private mode or blocked storage: the depth just is not remembered.
  }
}
