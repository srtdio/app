// The PCS version-history sheet: every immutable version, newest first. Each row
// shows v{n}, the author display name (resolved by the page from the same members
// read PCS already uses, falling back to (ex-member)), and a localized timestamp.
// The current version carries a marker and just closes the sheet on tap; tapping
// any older row asks the page to enter the read-only old-version view. When there
// are two or more versions, each row also gains a leading select control: pick any
// two and the footer confirms a word-level caption compare. The sheet owns only
// the transient compare selection; it holds no reads and no writes.

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Sheet } from '@/components/ui/Sheet';
import { IconCheck, IconChevronRight } from '@/components/ui/icons';
import { cn } from '@/lib/cn';
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
  /** Enter compare mode for the two chosen versions (from = earlier). */
  onCompare: (fromId: string, toId: string) => void;
}

// The pure render model: the props above plus the transient selection the wrapper
// owns. Kept hookless so the unit env can call it directly and walk the tree.
interface VersionHistorySheetModel extends VersionHistorySheetProps {
  selectedIds: readonly string[];
  onToggleSelect: (id: string) => void;
}

const ROW_BASE =
  'flex w-full min-h-[44px] items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors hover:bg-panel-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent';

// Localized date + time, matching the timestamp convention used elsewhere in the
// app (Comments). No hardcoded timezone; falls back to the raw value if unparseable.
function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
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
}: VersionHistorySheetModel): ReactNode {
  const ordered = sortVersionsDesc(versions);
  // Compare is only offered when there is more than one version to line up.
  const showSelect = versions.length >= 2;

  // The two picked versions, earlier first: the from side is always the lower
  // version_number so the diff reads old -> new regardless of pick order.
  const picked = selectedIds
    .map((id) => versions.find((version) => version.id === id))
    .filter((version): version is PostVersionView => version !== undefined)
    .sort((a, b) => a.versionNumber - b.versionNumber);
  const fromVersion = picked[0];
  const toVersion = picked[1];
  const canCompare = fromVersion !== undefined && toVersion !== undefined;

  const footer = showSelect ? (
    <button
      type="button"
      disabled={!canCompare}
      onClick={() => {
        if (fromVersion !== undefined && toVersion !== undefined) {
          onCompare(fromVersion.id, toVersion.id);
        }
      }}
      className={cn(
        'flex h-11 w-full items-center justify-center rounded-md text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:pointer-events-none',
        canCompare ? 'bg-accent text-accent-fg hover:bg-accent-hover' : 'bg-panel-2 text-fg-3',
      )}
    >
      {canCompare
        ? `Compare v${fromVersion.versionNumber} → v${toVersion.versionNumber}`
        : 'Select two versions'}
    </button>
  ) : undefined;

  return (
    <Sheet open={open} onClose={onClose} title="Version history" footer={footer}>
      <ul className="flex flex-col gap-1">
        {ordered.map((version) => {
          const isCurrent = version.versionNumber === currentVersionNumber;
          const selected = selectedIds.includes(version.id);
          const rowButton = (
            <button
              type="button"
              onClick={() => (isCurrent ? onClose() : onSelectVersion(version.id))}
              aria-current={isCurrent ? 'true' : undefined}
              className={showSelect ? cn(ROW_BASE, 'min-w-0 flex-1') : ROW_BASE}
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
          );

          if (!showSelect) {
            return <li key={version.id}>{rowButton}</li>;
          }

          return (
            <li
              key={version.id}
              className={cn(
                'flex items-center gap-1 rounded-lg border border-transparent',
                selected && 'border-accent-line bg-accent-soft',
              )}
            >
              <button
                type="button"
                aria-pressed={selected}
                aria-label={`Select v${version.versionNumber} to compare`}
                onClick={() => onToggleSelect(version.id)}
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
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
              </button>
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
