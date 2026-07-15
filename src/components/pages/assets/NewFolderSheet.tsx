import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Sheet } from '@/components/ui/Sheet';
import { IconFolder } from '@/components/ui/icons';
import type { FolderCreateOutcome } from '@/lib/asset-upload';

/** The longest a folder name may be; mirrors the folders.name column limit. */
const MAX_FOLDER_NAME = 80;

interface NewFolderSheetProps {
  open: boolean;
  onClose: () => void;
  /** Commit: POST {name} to the worker's /folders route, reporting the outcome. */
  onSubmit: (name: string) => Promise<FolderCreateOutcome>;
  /** Toast sink (the page toast queue). */
  onToast: (message: string) => void;
  /** Called once after a folder is created, to refresh the folder list. */
  onCreated: () => void;
}

/**
 * Validate a typed folder name. Returns the inline error to show, or null when
 * the trimmed name is a usable length (1..80). Pure, so the gate is unit-tested
 * without React. No em-dashes in any string (CLAUDE.md).
 */
export function folderNameError(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed.length === 0) return 'Give the folder a name';
  if (trimmed.length > MAX_FOLDER_NAME) return 'Keep the name under 80 characters';
  return null;
}

/**
 * Run the create-folder submit flow against an already-validated name: toast the
 * returned (possibly auto-numbered) name on success then refresh and close, or
 * surface the mapped error on failure. Pure orchestration, unit-tested directly.
 */
export async function submitNewFolder(args: {
  name: string;
  onSubmit: (name: string) => Promise<FolderCreateOutcome>;
  onToast: (message: string) => void;
  onCreated: () => void;
  onClose: () => void;
}): Promise<void> {
  const outcome = await args.onSubmit(args.name);
  if (outcome.ok) {
    args.onToast(`Created ${outcome.folder.name}`);
    args.onCreated();
    args.onClose();
  } else {
    args.onToast(outcome.message);
  }
}

/**
 * The New folder sheet: one Name field (1..80 chars after trim). Submit stays
 * disabled until the name is valid; validation copy appears inline once the
 * field is blurred. On success it toasts the server-resolved name (which may be
 * auto-numbered), refreshes the folder list, and closes; on failure it surfaces
 * the mapped error. Theme tokens only so light and dark match; targets >=44px.
 */
export function NewFolderSheet({
  open,
  onClose,
  onSubmit,
  onToast,
  onCreated,
}: NewFolderSheetProps) {
  const [name, setName] = useState('');
  const [touched, setTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Clear the field whenever the sheet closes so it always opens empty.
  useEffect(() => {
    if (!open) {
      setName('');
      setTouched(false);
      setSubmitting(false);
    }
  }, [open]);

  const error = folderNameError(name);
  const canSubmit = error === null && !submitting;
  const showError = touched && error !== null;

  async function submit(): Promise<void> {
    if (error !== null) {
      setTouched(true);
      return;
    }
    if (submitting) return;
    setSubmitting(true);
    await submitNewFolder({ name, onSubmit, onToast, onCreated, onClose });
    setSubmitting(false);
  }

  const footer = (
    <span className="ml-auto flex gap-2.5">
      <Button variant="ghost" onClick={onClose} disabled={submitting}>
        Cancel
      </Button>
      <Button variant="primary" disabled={!canSubmit} onClick={() => void submit()}>
        <IconFolder size={16} />
        {submitting ? 'Creating' : 'Create folder'}
      </Button>
    </span>
  );

  return (
    <Sheet open={open} onClose={onClose} title="New folder" footer={footer}>
      <div className="flex flex-col gap-4">
        <label className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium text-fg-2">Name</span>
          <Input
            placeholder="What should this folder be called?"
            value={name}
            autoFocus
            aria-invalid={showError}
            disabled={submitting}
            onChange={(event) => setName(event.target.value)}
            onBlur={() => setTouched(true)}
          />
          {showError ? <span className="text-xs text-bad">{error}</span> : null}
        </label>
      </div>
    </Sheet>
  );
}
