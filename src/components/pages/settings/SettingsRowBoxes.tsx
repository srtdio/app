import { Bone, BoxSkeleton } from '@/lib/motion';
import { Row } from '@/components/ui/Row';
import { cardSurface } from '@/components/ui/Card';
import { cn } from '@/lib/cn';

/** What the members boxes say to screen readers. */
export const LOADING_MEMBERS = 'Loading members';

/**
 * Settings rows while nothing is held for them (sweepBoxes): the group's label
 * on the page edge, then a card of ui/Rows holding Bones in the real row's
 * layout (a 32px avatar circle and two lines). A kept or session list paints at
 * once and never shows these.
 */
export function SettingsRowBoxes({ label, rows = 3 }: { label: string; rows?: number }) {
  return (
    <BoxSkeleton
      lit="flat"
      label={label}
      data-settings-row-boxes=""
      className="flex flex-col gap-2"
    >
      <div className="flex h-5 items-center">
        <Bone lit="flat" className="h-3 w-24 rounded" />
      </div>
      <div className={cn('overflow-hidden', cardSurface())}>
        {Array.from({ length: rows }, (_unused, index) => (
          <Row
            key={`row-${index}`}
            leading={<Bone lit="lit-avatar" as="span" className="h-8 w-8 rounded-full" />}
            title={<Bone lit="flat" as="span" className="my-1 h-3 w-1/3 rounded" />}
            secondary={<Bone lit="flat" as="span" className="my-1 h-3 w-1/2 rounded" />}
            divider={index < rows - 1}
          />
        ))}
      </div>
    </BoxSkeleton>
  );
}
