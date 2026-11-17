import { useRef } from 'react';
import type { ReactElement } from 'react';
import { Chip } from '@/components/ui/Chip';
import type { Stage } from '@srtdio/posts';
import { StageDot } from '@/components/pages/pipeline/stage-meta';
import { chipRowMask, useChipRowFade } from '@/components/ui/use-chip-row-fade';

export interface StageChipItem {
  /** The chip's filter key: a Stage, or the UI-only 'all'. */
  key: string;
  label: string;
  /** The chip's count, shown after the label only when above 0. */
  count?: number;
  /** The stage this chip filters to; omitted for the non-stage chips. */
  stage?: Stage;
}

interface StageChipsProps {
  items: StageChipItem[];
  active: string;
  onChange: (key: string) => void;
}

// The row's scroll-aware fade lives in ui/use-chip-row-fade; re-exported so
// existing imports of chipRowMask still resolve.
export { chipRowMask };

/**
 * The Pipeline stage switcher: one horizontally scrollable, non-wrapping row of
 * the shared ui/Chip (the stages, each with its stage dot, plus the UI-only All), the same chip and
 * selected style as Briefs, Activity and Help. A chip shows its count only when
 * above 0. The SectionHeader row already pads it, so the first chip lines up
 * with the cards; an edge-cut fade applies only when the
 * row overflows. Each chip is a 44px touch target; the active chip is
 * selected and carries aria-current.
 */
export function StageChips({ items, active, onChange }: StageChipsProps): ReactElement {
  const rowRef = useRef<HTMLDivElement>(null);
  const mask = useChipRowFade(rowRef);

  return (
    <div
      ref={rowRef}
      data-chip-row=""
      className="flex flex-nowrap items-center gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      style={{ paddingRight: 0, WebkitMaskImage: mask, maskImage: mask }}
    >
      {items.map((item) => {
        const isActive = item.key === active;
        return (
          <Chip
            key={item.key}
            label={item.label}
            {...(item.stage !== undefined ? { dot: <StageDot stage={item.stage} /> } : {})}
            {...(item.count !== undefined ? { count: item.count } : {})}
            selected={isActive}
            size="tap"
            aria-current={isActive ? 'true' : undefined}
            onClick={() => onChange(item.key)}
            className="flex-none whitespace-nowrap"
          />
        );
      })}
    </div>
  );
}
