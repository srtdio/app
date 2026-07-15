import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Sheet } from '@/components/ui/Sheet';
import { IconFolder } from '@/components/ui/icons';
import type { FolderRenameOutcome } from '@/lib/asset-upload';
import { MAX_FOLDER_NAME } from './folder-name';

interface FolderRenameSheetProps {
  open: boolean;
  /** The folder's current name; the field is prefilled with it on open. */
  initialName: string;
  onClose: () => void;
  /** Commit: POST {folder_id, name} to the worker's /folders/rename route. */
  onSubmit: (name: string) => Promise<FolderRenameOutcome>;
  /** Toast sink (the page toast queue). */
  onToast: (message: string) => void;
  /** Called once after a successful rename, to refresh the folder list. */
  onRenamed: () => void;
}

/**
 * Whether the Save action is enabled: the trimmed name must be a usable length
 * (1..80) and must differ from the current name (an unchanged name is a no-op).
 * Pure, so the gate is unit-tested without React.
 */
export function canSaveFolderName(name: string, initialName: string): boolean {
  const trimmed = name.trim();
  return trimmed.length >= 1 && trimmed.length <= MAX_FOLDER_NAME && trimmed !== initialName.trim();
}

/**
 * Run the rename submit flow against an already-validated name. On success it
 * toasts the server-resolved name then refreshes and closes, returning null. A
 * sibling-name collision is returned as the inline error to show under the field
 * (no toast, no close). Any other failure is toasted and returns null. Pure
 * orchestration, unit-tested directly. No em-dashes in any string (CLAUDE.md).
 */
export async function submitFolderRename(args: {
  name: string;
  onSubmit: (name: string) => Promise<FolderRenameOutcome>;
  onToast: (message: string) => void;
  onRenamed: () => void;
  onClose: () => void;
}): Promise<string | null> {
  const outcome = await args.onSubmit(args.name);
  if (outcome.ok) {
    args.onToast(`Renamed to ${outcome.folder.name}`);
    args.onRenamed();
    args.onClose();
    return null;
  }
  if (outcome.nameTaken) {
    return outcome.message;
  }
  args.onToast(outcome.message);
  return null;
}

/**
 * The Rename folder sheet: one Name field prefilled with the current name. Save
 * stays disabled until the trimmed name is a usable length and actually changed.
 * On success it toasts the server-resolved name, refreshes, and closes; a
 * sibling collision (folder_name_taken) shows inline and keeps the sheet open;
 * any other failure is toasted. Theme tokens only so light and dark match;
 * targets >=44px.
 */
export function FolderRenameSheet({
  open,
  initialName,
  onClose,
  onSubmit,
  onToast,
  onRenamed,
}: FolderRenameSheetProps) {
  const [name, setName] = useState(initialName);
  const [submitting, setSubmitting] = useState(false);
  const [takenError, setTakenError] = useState<string | null>(null);

  // Prefill with the current name whenever the sheet opens; clear all state when
  // it closes so it never reopens dirty.
  useEffect(() => {
    if (open) {
      setName(initialName);
      setTakenError(null);
    } else {
      setName('');
      setTakenError(null);
      setSubmitting(false);
    }
  }, [open, initialName]);

  const canSubmit = canSaveFolderName(name, initialName) && !submitting;

  async function submit(): Promise<void> {
    if (!canSaveFolderName(name, initialName) || submitting) return;
    setSubmitting(true);
    const inlineError = await submitFolderRename({ name, onSubmit, onToast, onRenamed, onClose });
    setTakenError(inlineError);
    setSubmitting(false);
  }

  const footer = (
    <span className="ml-auto flex gap-2.5">
      <Button variant="ghost" onClick={onClose} disabled={submitting}>
        Cancel
      </Button>
      <Button variant="primary" disabled={!canSubmit} onClick={() => void submit()}>
        <IconFolder size={16} />
        {submitting ? 'Saving' : 'Save'}
      </Button>
    </span>
  );

  return (
    <Sheet open={open} onClose={onClose} title="Rename folder" footer={footer}>
      <div className="flex flex-col gap-4">
        <label className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium text-fg-2">Name</span>
          <Input
            placeholder="What should this folder be called?"
            value={name}
            autoFocus
            aria-invalid={takenError !== null}
            disabled={submitting}
            onChange={(event) => {
              setName(event.target.value);
              setTakenError(null);
            }}
          />
          {takenError !== null ? <span className="text-xs text-bad">{takenError}</span> : null}
        </label>
      </div>
    </Sheet>
  );
}
