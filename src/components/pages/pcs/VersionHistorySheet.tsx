// The PCS version-history sheet: every immutable version, newest first. Each row
// shows v{n}, the author display name (resolved by the page from the same members
// read PCS already uses, falling back to (ex-member)), and a localized timestamp.
// The current version carries a marker and just closes the sheet on tap; tapping
// any older row asks the page to enter the read-only old-version view. The sheet
// is presentational: it owns no reads and no writes.

import { Sheet } from '@/components/ui/Sheet';
import { IconCheck, IconChevronRight } from '@/components/ui/icons';
import { sortVersionsDesc, type PostVersionView } from '@/lib/post-versions';

interface VersionHistorySheetProps {
  open: boolean;
  onClose: () => void;
  versions: readonly PostVersionView[];
  /** The current (highest) version number, or null when there are none. */
  currentVersionNumber: number | null;
  /** Resolve a createdBy uuid (with its legacy author name) to a display name,
   *  falling back to the legacy name then (ex-member). */
  resolveAuthor: (userId: string | null, legacyName: string | null) => string;
  /** Enter the read-only view for a non-current version. */
  onSelectVersion: (id: string) => void;
}

// Localized date + time, matching the timestamp convention used elsewhere in the
// app (Comments). No hardcoded timezone; falls back to the raw value if unparseable.
function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

export function VersionHistorySheet({
  open,
  onClose,
  versions,
  currentVersionNumber,
  resolveAuthor,
  onSelectVersion,
}: VersionHistorySheetProps) {
  const ordered = sortVersionsDesc(versions);

  return (
    <Sheet open={open} onClose={onClose} title="Version history">
      <ul className="flex flex-col gap-1">
        {ordered.map((version) => {
          const isCurrent = version.versionNumber === currentVersionNumber;
          return (
            <li key={version.id}>
              <button
                type="button"
                onClick={() => (isCurrent ? onClose() : onSelectVersion(version.id))}
                aria-current={isCurrent ? 'true' : undefined}
                className="flex w-full min-h-[44px] items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors hover:bg-panel-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                <span className="flex min-w-0 flex-col">
                  <span className="text-sm font-medium tabular-nums text-fg">
                    v{version.versionNumber}
                  </span>
                  <span className="truncate text-xs text-fg-3">
                    {resolveAuthor(version.createdBy, version.legacyAuthorName)}
                    <span aria-hidden> · </span>
                    {formatTimestamp(version.createdAt)}
                  </span>
                </span>
                {isCurrent ? (
                  <span className="ml-auto inline-flex shrink-0 items-center gap-1 text-xs font-medium text-accent">
                    <IconCheck size={14} />
                    Current
                  </span>
                ) : (
                  <span className="ml-auto shrink-0 text-fg-3">
                    <IconChevronRight size={16} />
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </Sheet>
  );
}
