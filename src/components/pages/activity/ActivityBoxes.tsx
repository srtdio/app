// Activity's loading boxes (sweepBoxes, docs/motion.md): card-shaped Bones in
// ActivityCard's own layout (accent bar, actor line, title, body line, the 96px
// tile, then the rule and the 44px footer) under one bucket label, so nothing
// moves when the cards land. Rendered ONLY when the device or session holds
// nothing for the list; a kept list paints at once.
import type { ReactElement } from 'react';
import { Bone, BoxSkeleton } from '@/lib/motion';
import { LOADING_NOTIFICATIONS } from '@/components/pages/activity/data';

/** Cards drawn: about one phone screen. */
export const ACTIVITY_BOX_CARDS = 4;

function ActivityBoxCard(): ReactElement {
  return (
    <div data-activity-box="" className="lit-card flex overflow-hidden rounded-xl border bg-panel">
      <div aria-hidden="true" className="w-[3px] shrink-0 bg-border-strong" />
      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-3 p-[14px]">
          <div className="min-w-0 flex-1">
            <div className="mb-1.5 flex h-5 items-center gap-[7px]">
              <Bone className="h-5 w-5 shrink-0 rounded-full" />
              <Bone className="h-3 w-28 rounded" />
            </div>
            <div className="flex h-5 items-center">
              <Bone className="h-3.5 w-3/4 rounded" />
            </div>
            <div className="mt-[3px] flex h-5 items-center">
              <Bone className="h-3 w-1/2 rounded" />
            </div>
          </div>
          <Bone className="aspect-square w-24 shrink-0 rounded-lg" />
        </div>
        <div className="h-px bg-border" />
        <div className="flex min-h-[44px] items-center px-[14px]">
          <Bone className="h-3 w-16 rounded" />
        </div>
      </div>
    </div>
  );
}

/** The Activity list's boxes; the label is the screen reader's "Loading activity". */
export function ActivityBoxes(): ReactElement {
  return (
    <BoxSkeleton label={LOADING_NOTIFICATIONS} data-activity-boxes="" className="pb-6">
      <section className="mt-4">
        <div className="flex h-5 items-center px-4 md:px-6">
          <Bone className="h-3 w-20 rounded" />
        </div>
        <div className="mt-2 flex flex-col gap-2 px-4 md:px-6">
          {Array.from({ length: ACTIVITY_BOX_CARDS }, (_unused, index) => (
            <ActivityBoxCard key={index} />
          ))}
        </div>
      </section>
    </BoxSkeleton>
  );
}

/** The Upcoming list's boxes: one-line rows in UpcomingCard's place. */
export function UpcomingBoxes(): ReactElement {
  return (
    <BoxSkeleton
      label={LOADING_NOTIFICATIONS}
      data-activity-boxes="upcoming"
      className="mt-4 flex flex-col gap-2 px-4 pb-6 md:px-6"
    >
      {Array.from({ length: 3 }, (_unused, index) => (
        <div
          key={index}
          className="lit-card flex min-h-[64px] items-center gap-3 rounded-xl border bg-panel px-[14px]"
        >
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <Bone className="h-3.5 w-2/3 rounded" />
            <Bone className="h-3 w-1/3 rounded" />
          </div>
        </div>
      ))}
    </BoxSkeleton>
  );
}
