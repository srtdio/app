// The PCS version-history sheet: every immutable version, newest first. Each row
// shows v{n}, the author display name (resolved by the page from the same members
// read PCS already uses, falling back to "Former member"), and a localized timestamp.
// The current version carries a marker and just closes the sheet on tap; tapping
// any older row asks the page to enter the read-only old-version view. When there
// are two or more versions, each row also gains a leading select control: pick any
// two and the footer confirms a word-level caption compare. The sheet owns only
// the transient compare selection; it holds no reads and no writes.
// At 360px a row holds: at most two 32px-tall thumbs then "+n" (the thumbs give
// way first), a text column that never drops below 120px (the author name
// truncates, the date stays), and the list clips sideways overflow so the
// sheet never pans on the X axis.

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Sheet } from '@/components/ui/Sheet';
import { ICON_SIZE, IconCheck, IconChevronRight } from '@/components/ui/icons';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { PressableRow } from '@/components/ui/PressableRow';
import { parseSnapshot, sortVersionsDesc, type PostVersionView } from '@/lib/post-versions';
import type { PresignCache } from '@/lib/asset-presign';
import type { GalleryItem } from '@srtdio/posts';
import { SnapshotThumbs } from '@/components/pages/pcs/PostGallery';
import { snapshotItems } from '@/components/pages/pcs/gallery-transforms';
import { browserTimeZone } from '@/lib/chat/time-format';
import { formatDay } from '@/lib/display-date';

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
  /** Enter compare mode for the two chosen versions (from = earlier). */
  onCompare: (fromId: string, toId: string) => void;
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

// The pure render model: the props above plus the transient selection the wrapper
// owns. Kept hookless so the unit env can call it directly and walk the tree.
interface VersionHistorySheetModel extends VersionHistorySheetProps {
  selectedIds: readonly string[];
  onToggleSelect: (id: string) => void;
}

// Layout only: PressableRow brings the width, 44px height, radius, hover and focus ring.
const ROW_BASE = 'flex min-w-0 items-center gap-3 px-3 py-2 transition-colors';

/** Thumbs per row before the "+n" count. */
export const VERSION_THUMBS_MAX = 2;

/**
 * The row's thumbs: shrinkable and clipped so they give way before the text
 * column; the tiles are 32px tall (SnapshotThumbs size 'xs', h-8).
 */
export const VERSION_THUMBS_CLASS = 'min-w-0 shrink overflow-hidden';

/** The text column: fills the row and never squeezes below about 120px. */
export const VERSION_TEXT_CLASS = 'flex min-w-[120px] flex-1 flex-col';

// The app's day formatter (FN7): "11 Jun", with the year once it differs from
// now's. The sheet has no workspace zone in hand, so it reads the browser's.
// Falls back to the raw value if unparseable.
function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return formatDay(value, browserTimeZone(), new Date());
}

/** Toggle an id in the compare selection, a max-two queue: re-picking a selected
 *  id clears it; picking a third replaces the oldest. Pure so the wrapper's
 *  setState stays a one-liner and the behaviour is unit-testable. */
export function toggleCompareSelection(current: readonly string[], id: string): string[] {
  if (current.includes(id)) return current.filter((existing) => existing !== id);
  const next = [...current, id];
  return next.length > 2 ? next.slice(next.length - 2) : next;
}

export function versionHistorySheet({
  open,
  onClose,
  versions,
  currentVersionNumber,
  resolveAuthor,
  onSelectVersion,
  onCompare,
  selectedIds,
  onToggleSelect,
  thumbs,
}: VersionHistorySheetModel): ReactNode {
  const ordered = sortVersionsDesc(versions);
  // Compare is only offered when there is more than one version to line up.
  const showSelect = versions.length >= 2;

  // The two picked versions, earlier first: the from side is always the lower
  // version_number so the diff reads old -> new regardless of pick order. Until
  // two are picked the footer offers the two newest (the latest change).
  const chosen = selectedIds
    .map((id) => versions.find((version) => version.id === id))
    .filter((version): version is PostVersionView => version !== undefined);
  const picked = (chosen.length === 2 ? chosen : ordered.slice(0, 2)).sort(
    (a, b) => a.versionNumber - b.versionNumber,
  );
  const fromVersion = picked[0];
  const toVersion = picked[1];
  const canCompare = fromVersion !== undefined && toVersion !== undefined;

  const footer = showSelect ? (
    <Button
      type="button"
      variant={canCompare ? 'primary' : 'secondary'}
      disabled={!canCompare}
      onClick={() => {
        if (fromVersion !== undefined && toVersion !== undefined) {
          onCompare(fromVersion.id, toVersion.id);
        }
      }}
      className="w-full focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      {canCompare
        ? `Compare v${fromVersion.versionNumber} and v${toVersion.versionNumber}`
        : 'Select two versions'}
    </Button>
  ) : undefined;

  return (
    <Sheet open={open} onClose={onClose} title="Versions" footer={footer}>
      <ul data-version-list="" className="flex min-w-0 flex-col gap-1 overflow-x-hidden">
        {ordered.map((version) => {
          const isCurrent = version.versionNumber === currentVersionNumber;
          const selected = selectedIds.includes(version.id);
          const rowButton = (
            <PressableRow
              type="button"
              onClick={() => (isCurrent ? onClose() : onSelectVersion(version.id))}
              aria-current={isCurrent ? 'true' : undefined}
              className={showSelect ? cn(ROW_BASE, 'min-w-0 flex-1') : ROW_BASE}
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
                    {formatTimestamp(version.createdAt)}
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
          );

          if (!showSelect) {
            return <li key={version.id}>{rowButton}</li>;
          }

          return (
            <li
              key={version.id}
              className={cn(
                'flex min-w-0 items-center gap-1 rounded-lg border border-transparent',
                selected && 'border-accent-line bg-accent-soft',
              )}
            >
              <IconButton
                type="button"
                aria-pressed={selected}
                label={`Select v${version.versionNumber} to compare`}
                onClick={() => onToggleSelect(version.id)}
                className="shrink-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                <span
                  className={cn(
                    'flex h-[18px] w-[18px] items-center justify-center rounded-full border',
                    selected
                      ? 'border-accent bg-accent text-accent-fg'
                      : 'border-border-strong text-transparent',
                  )}
                >
                  {selected ? <IconCheck size={12} /> : null}
                </span>
              </IconButton>
              {rowButton}
            </li>
          );
        })}
      </ul>
    </Sheet>
  );
}

export function VersionHistorySheet(props: VersionHistorySheetProps) {
  // The compare selection is transient UI state that belongs to the sheet, not
  // the page: it clears whenever the sheet closes so a stale pair never lingers.
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  useEffect(() => {
    if (!props.open) setSelectedIds([]);
  }, [props.open]);

  return versionHistorySheet({
    ...props,
    selectedIds,
    onToggleSelect: (id) => setSelectedIds((current) => toggleCompareSelection(current, id)),
    onCompare: (fromId, toId) => {
      setSelectedIds([]);
      props.onCompare(fromId, toId);
    },
  });
}
