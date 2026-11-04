import { Bone, BoxSkeleton } from '@/lib/motion';

/** What the members boxes say to screen readers. */
export const LOADING_MEMBERS = 'Loading members';

/**
 * Settings rows while nothing is held for them (sweepBoxes): a section card
 * with row-shaped Bones in the real row's layout (a 40px avatar circle and two
 * lines). A kept or session list paints at once and never shows these.
 */
export function SettingsRowBoxes({ label, rows = 3 }: { label: string; rows?: number }) {
  return (
    <BoxSkeleton
      lit="flat"
      label={label}
      data-settings-row-boxes=""
      className="overflow-hidden rounded-xl border bg-panel lit-card"
    >
      <div className="flex h-11 items-center border-b lit-header px-4">
        <Bone lit="flat" className="h-3 w-24 rounded" />
      </div>
      <div className="divide-y divide-border">
        {Array.from({ length: rows }, (_unused, index) => (
          <div key={index} className="flex items-center gap-3 px-4 py-3">
            <Bone lit="lit-avatar" className="h-10 w-10 shrink-0 rounded-full" />
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <Bone lit="flat" className="h-3.5 w-1/3 rounded" />
              <Bone lit="flat" className="h-3 w-1/2 rounded" />
            </div>
          </div>
        ))}
      </div>
    </BoxSkeleton>
  );
}
