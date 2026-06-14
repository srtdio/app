// The read-only old-version view: the PCS main column while READ-ONLY MODE is
// active. It renders only what the snapshot carries (caption + gallery), both
// strictly read-only: no edit affordances and no write wrappers are reachable
// from here. A historical gallery is shown as a summary count because no existing
// repo read resolves bare asset_version_ids to thumbnails (and adding one is out
// of scope). The page owns entering/leaving this mode; Back returns to the live,
// editable current version.

import { Button } from '@/components/ui/Button';

interface ReadOnlyVersionViewProps {
  versionNumber: number;
  currentVersionNumber: number;
  caption: string | null;
  /** Count of asset_version_ids in this version's snapshot gallery. */
  imageCount: number;
  onBack: () => void;
}

export function ReadOnlyVersionView({
  versionNumber,
  currentVersionNumber,
  caption,
  imageCount,
  onBack,
}: ReadOnlyVersionViewProps) {
  const hasCaption = caption !== null && caption.trim() !== '';

  return (
    <div className="px-4 md:px-6 py-6 flex flex-col gap-6">
      <div
        role="status"
        className="flex flex-wrap items-center gap-2 rounded-xl border border-warn px-4 py-3 text-sm text-warn"
      >
        <span className="font-medium">Versions are immutable</span>
        <span aria-hidden>·</span>
        <span>Read only, viewing v{versionNumber}</span>
        <Button variant="default" size="lg" className="ml-auto" onClick={onBack}>
          Back to v{currentVersionNumber}
        </Button>
      </div>

      <section>
        <div className="text-xs font-medium uppercase tracking-wide text-fg-3 mb-2">Gallery</div>
        <div className="rounded-lg border border-border bg-panel-2 px-4 py-6 text-center text-sm text-fg-3">
          {imageCount} image(s)
        </div>
      </section>

      <section>
        <div className="text-xs font-medium uppercase tracking-wide text-fg-3 mb-2">Caption</div>
        {hasCaption ? (
          <p className="whitespace-pre-wrap text-sm text-fg">{caption}</p>
        ) : (
          <p className="text-sm text-fg-3">No caption in this version.</p>
        )}
      </section>
    </div>
  );
}
