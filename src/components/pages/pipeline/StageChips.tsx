import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/Button';
import { StageDot } from '@/components/pages/pipeline/stage-meta';
import type { Stage } from '@srtdio/posts';

export interface StageChipItem {
  /** The chip's filter key: a Stage, or the UI-only 'all'. */
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

// The scroll hint: a fade at each edge that still has chips past it. A mask is
// alpha only (the keyword colours carry no hue), so it reads the same in light
// and dark with no token.
const FADE = '24px';

/** The mask for the row's scroll position; 'none' when nothing is cut off. */
export function chipRowMask(fadeStart: boolean, fadeEnd: boolean): string {
  if (!fadeStart && !fadeEnd) return 'none';
  const left = fadeStart ? `transparent 0, black ${FADE}` : 'black 0';
  const right = fadeEnd ? `black calc(100% - ${FADE}), transparent 100%` : 'black 100%';
  return `linear-gradient(to right, ${left}, ${right})`;
}

/**
 * The Pipeline stage switcher: one horizontally scrollable, non-wrapping row of
 * chip-pill buttons (the stages plus the UI-only All) mirroring the
 * Activity filter row. A chip shows its dot only when it carries a stage and its
 * count only when one is supplied, so a non-stage chip renders label-only.
 * Runs full-bleed to the right edge with an edge-cut fade applied only when the
 * row overflows. Each chip is a 44px touch target; the active chip carries the
 * accent treatment and aria-current.
 */
export function StageChips({ items, active, onChange }: StageChipsProps): ReactElement {
  const rowRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: false, end: false });

  useEffect(() => {
    const row = rowRef.current;
    if (row === null) return;
    const measure = (): void => {
      const max = row.scrollWidth - row.clientWidth;
      const next = {
        start: max > 2 && row.scrollLeft > 2,
        end: max > 2 && row.scrollLeft < max - 2,
      };
      setEdges((prev) => (prev.start === next.start && prev.end === next.end ? prev : next));
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(row);
    row.addEventListener('scroll', measure, { passive: true });
    return () => {
      observer?.disconnect();
      row.removeEventListener('scroll', measure);
    };
  }, []);

  const mask = chipRowMask(edges.start, edges.end);

  return (
    <div
      ref={rowRef}
      data-chip-row=""
      className="mt-3 flex flex-nowrap items-center gap-2 overflow-x-auto pb-1 pl-4 -mr-4 md:pl-6 md:-mr-6"
      style={{ paddingRight: 0, WebkitMaskImage: mask, maskImage: mask }}
    >
      {items.map((item) => {
        const isActive = item.key === active;
        return (
          <Button
            key={item.key}
            type="button"
            variant="ghost"
            aria-current={isActive ? 'true' : undefined}
            onClick={() => onChange(item.key)}
            className={cn(
              'flex-none whitespace-nowrap border',
              isActive
                ? 'border-accent-line bg-accent-soft text-accent hover:bg-accent-soft hover:text-accent'
                : 'border-border',
            )}
          >
            {item.stage !== undefined ? <StageDot stage={item.stage} /> : null}
            {item.label}
            {item.count !== undefined ? (
              <span
                className={cn(
                  'text-legacy-xs tabular-nums',
                  isActive ? 'text-accent' : 'text-fg-3',
                )}
              >
                {item.count}
              </span>
            ) : null}
          </Button>
        );
      })}
    </div>
  );
}
