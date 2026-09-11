import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { cn } from '@/lib/cn';
import { StageDot } from '@/components/pages/pipeline/stage-meta';
import type { Stage } from '@srtdio/posts';

export interface StageChipItem {
  /** The chip's filter key: a Stage, or a UI-only key such as 'plan' / 'all'. */
  key: string;
  label: string;
  /** Trailing count badge; omitted entirely for a chip that carries no count. */
  count?: number;
  /** The stage whose dot this chip shows; omitted for the non-stage chips. */
  stage?: Stage;
}

export interface StageChipsProps {
  items: StageChipItem[];
  active: string;
  onChange: (key: string) => void;
}

// Edge-cut fade applied only while the row overflows; alpha-based so it is
// colour-agnostic and correct in light and dark with no token. Replicated from
// ActivityFilterBar rather than imported, so the two surfaces stay decoupled.
const OVERFLOW_MASK = 'linear-gradient(to right, #000 0, #000 calc(100% - 26px), transparent 100%)';

/**
 * The Pipeline stage switcher: one horizontally scrollable, non-wrapping row of
 * chip-pill buttons (the stages plus the UI-only Plan and All) mirroring the
 * Activity filter row. A chip shows its dot only when it carries a stage and its
 * count only when one is supplied, so a non-stage chip renders label-only.
 * Runs full-bleed to the right edge with an edge-cut fade applied only when the
 * row overflows. Each chip is a 44px touch target; the active chip carries the
 * accent treatment and aria-current.
 */
export function StageChips({ items, active, onChange }: StageChipsProps): ReactElement {
  const rowRef = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState(false);

  useEffect(() => {
    const row = rowRef.current;
    if (row === null) return;
    const measure = () => setOverflowing(row.scrollWidth - row.clientWidth > 2);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    return () => observer.disconnect();
  }, []);

  const mask = overflowing ? OVERFLOW_MASK : 'none';

  return (
    <div
      ref={rowRef}
      className="mt-3 flex flex-nowrap items-center gap-2 overflow-x-auto pb-1 pl-4 -mr-4 md:pl-6 md:-mr-6"
      style={{ paddingRight: 0, WebkitMaskImage: mask, maskImage: mask }}
    >
      {items.map((item) => {
        const isActive = item.key === active;
        return (
          <button
            key={item.key}
            type="button"
            aria-current={isActive ? 'true' : undefined}
            onClick={() => onChange(item.key)}
            className={cn(
              'inline-flex min-h-[44px] flex-none items-center gap-1.5 whitespace-nowrap rounded-full border px-4 text-sm transition-colors',
              isActive
                ? 'border-accent-line bg-accent-soft text-accent'
                : 'border-border text-fg-2 hover:bg-panel-2',
            )}
          >
            {item.stage !== undefined ? <StageDot stage={item.stage} /> : null}
            {item.label}
            {item.count !== undefined ? (
              <span className={cn('text-xs tabular-nums', isActive ? 'text-accent' : 'text-fg-3')}>
                {item.count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
