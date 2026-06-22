import { useEffect, useState } from 'react';
import { Sheet } from '@/components/ui/Sheet';
import { IconFolder } from '@/components/ui/icons';
import { flattenFolders, type FolderItem } from '@/lib/assets';
import type { MoveAssetsOutcome } from '@/lib/asset-upload';

interface MoveToFolderSheetProps {
  open: boolean;
  /** How many files the move would relocate (drives the title pluralisation). */
  count: number;
  folders: FolderItem[];
  onClose: () => void;
  /** Commit: POST the selection to the worker's /folders/move route. */
  onMove: (targetFolderId: string | null) => Promise<MoveAssetsOutcome>;
  /** Toast sink (the page toast queue). */
  onToast: (message: string) => void;
  /** Called once after a successful move, to refresh the lists and exit select mode. */
  onMoved: () => void;
}

/**
 * Run the move against a chosen destination: toast the server-reported moved
 * count on success then refresh and close, or surface the mapped error on
 * failure. Pure orchestration, unit-tested directly (mirrors submitFolderRename).
 * No em-dashes in any string (CLAUDE.md).
 */
export async function submitMove(args: {
  targetFolderId: string | null;
  onMove: (targetFolderId: string | null) => Promise<MoveAssetsOutcome>;
  onToast: (message: string) => void;
  onMoved: () => void;
  onClose: () => void;
}): Promise<void> {
  const outcome = await args.onMove(args.targetFolderId);
  if (outcome.ok) {
    args.onToast(`Moved ${outcome.moved} file${outcome.moved === 1 ? '' : 's'}`);
    args.onMoved();
    args.onClose();
  } else {
    args.onToast(outcome.message);
  }
}

/**
 * The Move-to-folder destination sheet: a scrollable list of every folder in the
 * workspace (depth-first, indented by depth) plus an "All assets" row that moves
 * the selection back to the library root. Picking a row fires onMove and, on
 * success, toasts the moved count, refreshes, and closes; a failure toasts the
 * mapped error and leaves the sheet open. Every row disables while a move is in
 * flight. Theme tokens only so light and dark match; targets >=44px.
 */
export function MoveToFolderSheet({
  open,
  count,
  folders,
  onClose,
  onMove,
  onToast,
  onMoved,
}: MoveToFolderSheetProps) {
  const [busy, setBusy] = useState(false);

  // Always reopen ready to pick, even if a prior move was mid-flight when closed.
  useEffect(() => {
    if (!open) setBusy(false);
  }, [open]);

  const destinations = flattenFolders(folders);

  async function pick(targetFolderId: string | null): Promise<void> {
    if (busy) return;
    setBusy(true);
    await submitMove({ targetFolderId, onMove, onToast, onMoved, onClose });
    setBusy(false);
  }

  const rowClass =
    'flex min-h-[44px] w-full items-center gap-3 rounded-lg pr-3 text-left text-sm text-fg transition-colors hover:bg-panel-2 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent';

  return (
    <Sheet open={open} onClose={onClose} title={`Move ${count} file${count === 1 ? '' : 's'} to`}>
      <div className="flex flex-col">
        <button
          type="button"
          disabled={busy}
          onClick={() => void pick(null)}
          style={{ paddingLeft: 12 }}
          className={rowClass}
        >
          <span className="shrink-0 text-fg-2">
            <IconFolder size={18} />
          </span>
          <span className="truncate">All assets</span>
        </button>

        {destinations.map((dest) => (
          <button
            key={dest.id}
            type="button"
            disabled={busy}
            onClick={() => void pick(dest.id)}
            style={{ paddingLeft: 12 + dest.depth * 16 }}
            className={rowClass}
          >
            <span className="shrink-0 text-fg-2">
              <IconFolder size={18} />
            </span>
            <span className="truncate">{dest.name}</span>
          </button>
        ))}
      </div>
    </Sheet>
  );
}
