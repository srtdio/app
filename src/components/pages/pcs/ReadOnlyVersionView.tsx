// The read-only old-version view: the PCS main column while READ-ONLY MODE is
// active. It renders only what the snapshot carries (caption + gallery), both
// strictly read-only: no edit affordances and no write wrappers are reachable
// from here. #35: the snapshot's pictures render as platform-shaped thumbnails
// (each asset_version_id resolves through the same presign cache the live
// gallery uses); without thumbnail wiring it falls back to a count. The banner
// is neutral (panel-2 / fg-2): viewing an old version is not a warning. The page
// owns entering/leaving this mode; Back returns to the live, editable current
// version.

import { Button } from '@/components/ui/Button';
import { SnapshotThumbs } from '@/components/pages/pcs/PostGallery';
import { snapshotItems } from '@/components/pages/pcs/gallery-transforms';
import type { VersionThumbs } from '@/components/pages/pcs/VersionHistorySheet';

/** "1 image" / "3 images" / "No images". Pure. */
export function imageCountLabel(count: number): string {
  if (count <= 0) return 'No images';
  return count === 1 ? '1 image' : `${count} images`;
}

interface ReadOnlyVersionViewProps {
  versionNumber: number;
  currentVersionNumber: number;
  caption: string | null;
  /** Count of asset_version_ids in this version's snapshot gallery. */
  imageCount: number;
  /** #35: the snapshot's asset_version_ids, in order. */
  galleryVersionIds?: readonly string[];
  /** #35: how to draw them; absent keeps the count. */
  thumbs?: VersionThumbs | undefined;
  onBack: () => void;
}

export function ReadOnlyVersionView({
  versionNumber,
  currentVersionNumber,
  caption,
  imageCount,
  galleryVersionIds = [],
  thumbs,
  onBack,
}: ReadOnlyVersionViewProps) {
  const hasCaption = caption !== null && caption.trim() !== '';
  const showPictures = thumbs !== undefined && galleryVersionIds.length > 0;

  return (
    <div className="px-4 md:px-6 py-6 flex flex-col gap-6">
      <div
        role="status"
        data-version-banner=""
        className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-panel-2 px-4 py-3 text-legacy-sm text-fg-2"
      >
        <span className="font-medium text-fg">Versions can&apos;t be changed</span>
        <span aria-hidden>·</span>
        <span>Read only, viewing v{versionNumber}</span>
        <Button variant="default" className="ml-auto" onClick={onBack}>
          Back to v{currentVersionNumber}
        </Button>
      </div>

      <section>
        <div className="text-legacy-xs font-medium text-fg-3 mb-2">Gallery</div>
        {showPictures && thumbs !== undefined ? (
          <SnapshotThumbs
            items={snapshotItems(galleryVersionIds, thumbs.gallery)}
            cache={thumbs.cache}
            presignEnabled={thumbs.presignEnabled}
            ratio={thumbs.ratio}
            size="lg"
          />
        ) : (
          <div className="rounded-lg border border-border bg-panel-2 px-4 py-6 text-center text-legacy-sm text-fg-3">
            {imageCountLabel(imageCount)}
          </div>
        )}
      </section>

      <section>
        <div className="text-legacy-xs font-medium text-fg-3 mb-2">Caption</div>
        {hasCaption ? (
          <p className="whitespace-pre-wrap text-legacy-sm text-fg">{caption}</p>
        ) : (
          <p className="text-legacy-sm text-fg-3">No caption in this version.</p>
        )}
      </section>
    </div>
  );
}
