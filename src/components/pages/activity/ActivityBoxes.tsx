// Activity's loading boxes (sweepBoxes, docs/motion.md) in Plan's list frame
// (PlanTabList / PlanTabBoxes): one section heading bone on the heading's own
// 16 line, then ui/ListCardBox rows (the density row, picture and lines) in
// LIST_CARD_GRID, so the first heading and the first row land on the same
// pixel (0 delta) in every density.
// Rendered ONLY when the device or session holds nothing for the list; a kept
// list paints at once.
import type { ReactElement } from 'react';
import { Bone, BoxSkeleton } from '@/lib/motion';
import { cn } from '@/lib/cn';
import { GUTTER } from '@/components/ui/layout';
import { LIST_CARD_GRID, ListCardBox } from '@/components/ui/ListCard';
import { LOADING_NOTIFICATIONS } from '@/components/pages/activity/data';
import { getFillCount } from '@/lib/use-fill-count';

/**
 * The list's frame, Plan's own values (PlanTabList): 16 under the chip row,
 * 24 between sections, 32 under the last; the page gutter.
 */
export const ACTIVITY_LIST = cn('flex flex-col gap-6 pb-8 pt-4', GUTTER);

/** One section: its heading, 16, then its rows (PlanTabList's section). */
export const ACTIVITY_SECTION = 'flex flex-col gap-4';

/** Stable keys for the placeholder rows: the screen's fill count (one first page). */
function cardKeys(): string[] {
  return Array.from({ length: getFillCount() }, (_unused, n) => `card-${n}`);
}

/** The Activity list's boxes; the label is the screen reader's "Loading activity". */
export function ActivityBoxes(): ReactElement {
  return (
    <BoxSkeleton
      lit="flat"
      label={LOADING_NOTIFICATIONS}
      data-activity-boxes=""
      className={ACTIVITY_LIST}
    >
      <section className={ACTIVITY_SECTION}>
        {/* The section heading's own 16 line (PlanTabBoxes). */}
        <div data-activity-heading-box="" className="flex h-4 items-center">
          <Bone lit="flat" className="h-3 w-20 rounded" />
        </div>
        <div className={LIST_CARD_GRID}>
          {cardKeys().map((key) => (
            <ListCardBox key={key} data-activity-box="" />
          ))}
        </div>
      </section>
    </BoxSkeleton>
  );
}
