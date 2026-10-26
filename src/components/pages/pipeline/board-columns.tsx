import { Children, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { HTMLAttributes, ReactElement, ReactNode } from 'react';
import { cn } from '@/lib/cn';

/** The narrowest a laptop card column may get. */
export const BOARD_COLUMN_MIN_PX = 220;
/** The gap between columns and between cards in a column (gap-4). */
export const BOARD_COLUMN_GAP_PX = 16;

/**
 * How many card columns fit a board of this inner width (padding excluded):
 * N = max(1, floor((width + gap) / (min + gap))). Pure.
 */
export function columnsFor(width: number): number {
  if (!Number.isFinite(width) || width <= 0) return 1;
  return Math.max(
    1,
    Math.floor((width + BOARD_COLUMN_GAP_PX) / (BOARD_COLUMN_MIN_PX + BOARD_COLUMN_GAP_PX)),
  );
}

/**
 * Deal items into n column stacks in reading order: item i goes to column
 * i % n, so the newest card stays top left and order runs left to right. Pure.
 */
export function splitIntoColumns<T>(items: readonly T[], n: number): T[][] {
  const count = Math.max(1, Math.floor(n));
  const columns: T[][] = Array.from({ length: count }, () => []);
  items.forEach((item, index) => {
    columns[index % count]!.push(item);
  });
  return columns;
}

// Measure before the first paint in the browser; plain effect on the server
// (SSR has no layout and warns on useLayoutEffect).
const useBeforePaint = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/** The element's content-box width (its padding taken off). */
function contentWidth(el: HTMLElement): number {
  const style = window.getComputedStyle(el);
  const pad = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
  return el.clientWidth - pad;
}

type BoardColumnsProps = Omit<HTMLAttributes<HTMLDivElement>, 'children'> & {
  /** The card wrappers, newest first. */
  children: ReactNode;
  /** Rendered ahead of the columns (an sr-only status line); takes no flex space. */
  before?: ReactNode;
};

/**
 * The laptop card board: N independent column stacks (no shared grid rows), so
 * every card is as tall as its own content. N comes from the board's width,
 * measured before the first paint and kept current by a ResizeObserver.
 */
export function BoardColumns({
  children,
  before,
  className,
  ...rest
}: BoardColumnsProps): ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  const [count, setCount] = useState<number>(1);
  useBeforePaint(() => {
    const el = ref.current;
    if (el === null) return;
    const measure = (): void => {
      const next = columnsFor(contentWidth(el));
      setCount((prev) => (prev === next ? prev : next));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const columns = splitIntoColumns(Children.toArray(children), count);
  return (
    <div ref={ref} className={cn('flex items-start gap-4', className)} {...rest}>
      {before}
      {columns.map((column, index) => (
        <div key={index} data-board-column="" className="flex min-w-0 flex-1 flex-col gap-4">
          {column}
        </div>
      ))}
    </div>
  );
}
