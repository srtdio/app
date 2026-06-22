import { useState } from 'react';
import { IconFolder, IconTrash } from '@/components/ui/icons';
import type { FolderDeleteOutcome } from '@/lib/asset-upload';

interface FolderActionSheetProps {
  /** The folder this sheet acts on; shown in the header and the confirm copy. */
  name: string;
  onClose: () => void;
  /** Open the rename sheet for this folder (the page closes the action sheet first). */
  onRename: () => void;
  /** Commit: POST to the worker's /folders/delete route, reporting the outcome. */
  onConfirmDelete: () => Promise<FolderDeleteOutcome>;
  onToast: (message: string) => void;
}

function Row({
  icon,
  label,
  onClick,
  disabled,
  destructive,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  destructive?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`flex h-12 w-full items-center gap-3 rounded-lg px-3 text-sm hover:bg-panel-2 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
        destructive ? 'text-bad' : 'text-fg'
      }`}
    >
      <span className={destructive ? 'text-bad' : 'text-fg-2'}>{icon}</span>
      {label}
    </button>
  );
}

/**
 * Run the delete-confirm flow: call onConfirmDelete and, on success, toast and
 * close; on failure surface the mapped message and leave the sheet open. Pure
 * orchestration, so it is unit-tested directly (the sheet body has no DOM in the
 * node test environment). No em-dashes in any string (CLAUDE.md).
 */
export async function confirmDeleteFolder(args: {
  onConfirmDelete: () => Promise<FolderDeleteOutcome>;
  onToast: (message: string) => void;
  onClose: () => void;
}): Promise<void> {
  const outcome = await args.onConfirmDelete();
  if (outcome.ok) {
    args.onToast('Folder deleted');
    args.onClose();
  } else {
    args.onToast(outcome.message);
  }
}

/**
 * Bottom action sheet opened by a long-press on a folder card (owner/admin/
 * agency only; the affordance is hidden for everyone else). The default view
 * offers Rename and a destructive Delete; Delete swaps to an in-sheet confirm
 * that detaches the folder's contents to the root on commit. Mirrors
 * AssetActionSheet's container and Row. Theme tokens only so light and dark
 * match; rows are >=44px (h-12).
 */
export function FolderActionSheet({
  name,
  onClose,
  onRename,
  onConfirmDelete,
  onToast,
}: FolderActionSheetProps) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const handleDelete = (): void => {
    if (busy) return;
    setBusy(true);
    void confirmDeleteFolder({ onConfirmDelete, onToast, onClose }).finally(() => setBusy(false));
  };

  return (
    <div className="fixed inset-0 z-40 flex items-end">
      <button
        type="button"
        aria-label="Close actions"
        onClick={onClose}
        className="absolute inset-0 bg-black/40"
      />
      <div
        role="dialog"
        aria-label={`Actions for ${name}`}
        className="relative w-full rounded-t-2xl border-t border-border bg-panel p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] md:mx-auto md:mb-4 md:max-w-sm md:rounded-2xl md:border"
      >
        <div className="truncate px-3 py-2 text-sm font-semibold text-fg">{name}</div>
        {confirming ? (
          <div className="px-3 pb-2">
            <p className="py-1 text-sm text-fg-2">
              Delete &quot;{name}&quot;? Files inside move to All assets.
            </p>
            <div className="mt-2 flex justify-end gap-2.5">
              <button
                type="button"
                onClick={() => setConfirming(false)}
                disabled={busy}
                className="inline-flex h-11 items-center rounded-lg px-3.5 text-sm text-fg hover:bg-panel-2 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleDelete}
                disabled={busy}
                className="inline-flex h-11 items-center rounded-lg bg-bad px-3.5 text-sm font-medium text-white disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                {busy ? 'Deleting' : 'Delete'}
              </button>
            </div>
          </div>
        ) : (
          <>
            <Row icon={<IconFolder size={18} />} label="Rename" onClick={onRename} />
            <Row
              icon={<IconTrash size={18} />}
              label="Delete folder"
              onClick={() => setConfirming(true)}
              destructive
            />
          </>
        )}
      </div>
    </div>
  );
}
