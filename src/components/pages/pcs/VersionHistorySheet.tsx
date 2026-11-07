// The PCS version-history sheet: every immutable version, newest first. Each row
// shows v{n}, the author display name (resolved by the page from the same members
// read PCS already uses, falling back to "Former member"), and a localized timestamp.
// The current version carries a marker and just closes the sheet on tap; tapping
// any older row asks the page to enter the read-only old-version view. The sheet
// holds no state, no reads and no writes.
// At 360px a row holds: at most two 32px-tall thumbs then "+n" (the thumbs give
// way first), a text column that never drops below 120px (the author name
// truncates, the date stays), and the list clips sideways overflow so the
// sheet never pans on the X axis.

import type { ReactNode } from 'react';
import { Sheet } from '@/components/ui/Sheet';
import { ICON_SIZE, IconCheck, IconChevronRight } from '@/components/ui/icons';
import { PressableRow } from '@/components/ui/PressableRow';
import { parseSnapshot, sortVersionsDesc, type PostVersionView } from '@/lib/post-versions';
import type { PresignCache } from '@/lib/asset-presign';
import type { GalleryItem } from '@srtdio/posts';
import { SnapshotThumbs } from '@/components/pages/pcs/PostGallery';
import { snapshotItems } from '@/components/pages/pcs/gallery-transforms';
import { formatAgo } from '@/lib/time';
import { useMinuteClock } from '@/components/ui/use-minute-clock';

interface VersionHistorySheetProps {
  open: boolean;
  onClose: () => void;
  versions: readonly PostVersionView[];
  /** The current (highest) version number, or null when there are none. */
  currentVersionNumber: number | null;
  /** Resolve a createdBy uuid (with its legacy author name) to a display name,
   *  falling back to the legacy name then "Former member". */
  resolveAuthor: (userId: string | null, legacyName: string | null) => string;
  /** Enter the read-only view for a non-current version. */
  onSelectVersion: (id: string) => void;
  /**
   * #35: each row's pictures, from that version's snapshot gallery. Absent
   * keeps the text-only rows.
   */
  thumbs?: VersionThumbs | undefined;
}

/** What the rows need to draw a version's pictures. */
export interface VersionThumbs {
  /** The live gallery, reused for metadata of versions still attached. */
  gallery: readonly GalleryItem[];
  cache: PresignCache;
  presignEnabled: boolean;
  /** The post's platform frame ratio (w / h), so thumbnails are platform-shaped. */
  ratio: number;
}

// The pure render model: the props above plus the clock the wrapper reads. Kept
// hookless so the unit env can call it directly and walk the tree.
interface VersionHistorySheetModel extends VersionHistorySheetProps {
  /** The shared minute clock's instant; times read relative to it. Absent: the current instant. */
  now?: Date;
}

// Layout only: PressableRow brings the width, 44px height, radius, hover and focus ring.
const ROW_BASE = 'flex min-w-0 items-center gap-3 px-3 py-2 mv-tint';

/** Thumbs per row before the "+n" count. */
export const VERSION_THUMBS_MAX = 2;

/**
 * The row's thumbs: shrinkable and clipped so they give way before the text
 * column; the tiles are 32px tall (SnapshotThumbs size 'xs', h-8).
 */
export const VERSION_THUMBS_CLASS = 'min-w-0 shrink overflow-hidden';

/** The text column: fills the row and never squeezes below 128px. */
export const VERSION_TEXT_CLASS = 'flex min-w-32 flex-1 flex-col';

// When it happened, short (formatAgo): "just now", "5m", "Yesterday",
// "Mon". Falls back to the raw value if unparseable.
function formatTimestamp(value: string, now: Date): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return formatAgo(value, now);
}

export function versionHistorySheet({
  open,
  onClose,
  versions,
  currentVersionNumber,
  resolveAuthor,
  onSelectVersion,
  thumbs,
  now = new Date(),
}: VersionHistorySheetModel): ReactNode {
  const ordered = sortVersionsDesc(versions);
  return (
    <Sheet open={open} onClose={onClose} title="Versions">
      <ul data-version-list="" className="flex min-w-0 flex-col gap-1 overflow-x-hidden">
        {ordered.map((version) => {
          const isCurrent = version.versionNumber === currentVersionNumber;
          return (
            <li key={version.id}>
              <PressableRow
                type="button"
                onClick={() => (isCurrent ? onClose() : onSelectVersion(version.id))}
                aria-current={isCurrent ? 'true' : undefined}
                className={ROW_BASE}
              >
                {thumbs !== undefined ? (
                  <span className={VERSION_THUMBS_CLASS}>
                    <SnapshotThumbs
                      items={snapshotItems(
                        parseSnapshot(version.snapshot).galleryVersionIds,
                        thumbs.gallery,
                      )}
                      cache={thumbs.cache}
                      presignEnabled={thumbs.presignEnabled}
                      ratio={thumbs.ratio}
                      size="xs"
                      max={VERSION_THUMBS_MAX}
                    />
                  </span>
                ) : null}
                <span data-version-text="" className={VERSION_TEXT_CLASS}>
                  <span className="text-base font-medium tabular-nums text-fg">
                    v{version.versionNumber}
                  </span>
                  <span className="flex min-w-0 items-center text-sm text-fg-3">
                    <span data-version-author="" className="min-w-0 truncate">
                      {resolveAuthor(version.createdBy, version.legacyAuthorName)}
                    </span>
                    <span aria-hidden className="shrink-0 whitespace-pre">
                      {' · '}
                    </span>
                    <span data-version-date="" className="shrink-0 tabular-nums">
                      {formatTimestamp(version.createdAt, now)}
                    </span>
                  </span>
                </span>
                {isCurrent ? (
                  <span className="ml-auto inline-flex shrink-0 items-center gap-1 text-sm font-medium text-accent">
                    <IconCheck size={ICON_SIZE.inline} />
                    Current
                  </span>
                ) : (
                  <span className="ml-auto shrink-0 text-fg-3">
                    <IconChevronRight size={ICON_SIZE.inline} />
                  </span>
                )}
              </PressableRow>
            </li>
          );
        })}
      </ul>
    </Sheet>
  );
}

export function VersionHistorySheet(props: VersionHistorySheetProps) {
  const nowMs = useMinuteClock();
  return versionHistorySheet({ ...props, now: new Date(nowMs) });
}
