// Activity's loading boxes (sweepBoxes, docs/motion.md): ui/ListCardBox, the
// ListCard's own frame and slots (the 72 picture, title, two preview lines,
// the meta line), under one bucket label, so nothing moves when the cards land.
// Rendered ONLY when the device or session holds nothing for the list; a kept
// list paints at once.
import type { ReactElement } from 'react';
import { Bone, BoxSkeleton } from '@/lib/motion';
import { cn } from '@/lib/cn';
import { GUTTER } from '@/components/ui/layout';
import { LIST_CARD_GRID, ListCardBox } from '@/components/ui/ListCard';
import { LOADING_NOTIFICATIONS } from '@/components/pages/activity/data';

/** Cards drawn: about one phone screen. */
export const ACTIVITY_BOX_CARDS = 4;

/** Stable keys for the fixed placeholder cards. */
const CARD_KEYS = Array.from({ length: ACTIVITY_BOX_CARDS }, (_unused, n) => `card-${n}`);

/** The Activity list's boxes; the label is the screen reader's "Loading activity". */
export function ActivityBoxes(): ReactElement {
  return (
    <BoxSkeleton lit="flat" label={LOADING_NOTIFICATIONS} data-activity-boxes="" className="pb-6">
      <section className="mt-2">
        {/* The day line's own 44 (NotificationsPage), so nothing moves when the cards land. */}
        <div className="flex h-11 items-center px-4 md:px-6">
          <Bone lit="flat" className="h-3 w-20 rounded" />
        </div>
        <div className={cn(LIST_CARD_GRID, GUTTER)}>
          {CARD_KEYS.map((key) => (
            <ListCardBox key={key} data-activity-box="" />
          ))}
        </div>
      </section>
    </BoxSkeleton>
  );
}
