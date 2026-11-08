import { useId, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { ErrorNote } from '@/components/ui/ErrorNote';
import { Input } from '@/components/ui/Input';
import { Sheet, SheetActions } from '@/components/ui/Sheet';
import type { RenameOutcome } from '@/lib/asset-upload';
import type { AssetToast } from '@/components/pages/assets/AssetActionSheet';

/** display_name ceiling (mirrors the worker's validName). */
const MAX_ASSET_NAME = 500;

/** The Sheet's discard confirm for an edited file name. */
const ASSET_RENAME_DISCARD = {
  title: 'Discard the new name?',
  message: 'The file keeps its current name.',
};

/** The line under the Name field when Save meets an empty name. */
export const ASSET_NAME_REQUIRED = 'The file needs a name';

/**
 * What a Save tap does with the typed name: an empty one says why, an
 * unchanged one just closes (nothing to write), else it renames. The field's
 * maxLength holds the ceiling. Pure.
 */
export function assetRenameAction(
  name: string,
  initialName: string,
): 'empty' | 'unchanged' | 'rename' {
  const trimmed = name.trim();
  if (trimmed === '') return 'empty';
  if (trimmed === initialName.trim()) return 'unchanged';
  return 'rename';
}

interface AssetRenameSheetProps {
  open: boolean;
  initialName: string;
  onClose: () => void;
  /** Commit the trimmed name to the worker's /rename route. */
  onSubmit: (name: string) => Promise<RenameOutcome>;
  /** Failures pass 'error' (the bad tone); successes stay neutral. */
  onToast: AssetToast;
}

/**
 * Rename one asset from its menu: one Name field prefilled with the current
 * name. On success it toasts and closes; a failure is toasted and the sheet
 * stays open. The sheet is busy while saving, so it cannot be closed mid-save.
 */
export function AssetRenameSheet({
  open,
  initialName,
  onClose,
  onSubmit,
  onToast,
}: AssetRenameSheetProps) {
  const [name, setName] = useState(initialName);
  const [saving, setSaving] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const ids = useId();
  const formId = `${ids}-form`;
  const fieldId = `${ids}-name`;

  // Seed while rendering (not in an effect) so the open frame never reads as
  // dirty and places a Back guard for a name nobody typed.
  const seedKey = open ? initialName : null;
  const [seeded, setSeeded] = useState<string | null>(seedKey);
  if (seeded !== seedKey) {
    setSeeded(seedKey);
    setName(open ? initialName : '');
    setNameError(null);
    if (!open) setSaving(false);
  }

  // A changed name is unsaved work: X, Escape, the backdrop and system Back ask first.
  const dirty = open && name !== initialName;

  // Save is never disabled for "not valid yet": an empty name says why under
  // the field and the field takes focus. Busy is the only hold.
  async function save(): Promise<void> {
    if (saving) return;
    const action = assetRenameAction(name, initialName);
    if (action === 'empty') {
      setNameError(ASSET_NAME_REQUIRED);
      document.getElementById(fieldId)?.focus();
      return;
    }
    if (action === 'unchanged') {
      onClose();
      return;
    }
    setSaving(true);
    const outcome = await onSubmit(name.trim());
    setSaving(false);
    if (outcome.ok) {
      onToast('Renamed');
      onClose();
    } else {
      onToast(outcome.message, 'error');
    }
  }

  const footer = (
    <SheetActions
      cancel={
        <Button variant="ghost" onClick={onClose} disabled={saving}>
          Cancel
        </Button>
      }
      primary={
        <Button variant="primary" shape="pill" type="submit" form={formId} busy={saving}>
          Save
        </Button>
      }
    />
  );

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Rename file"
      footer={footer}
      busy={saving}
      dirty={dirty}
      discard={ASSET_RENAME_DISCARD}
    >
      {/* A form so Enter in the field saves; the footer's Save submits it
          through the form attribute. */}
      <form
        id={formId}
        noValidate
        className="flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <label htmlFor={fieldId} className="text-base font-medium text-fg-2">
          Name
        </label>
        <Input
          id={fieldId}
          name="file-name"
          autoComplete="off"
          aria-label="File name"
          value={name}
          maxLength={MAX_ASSET_NAME}
          disabled={saving}
          aria-invalid={nameError !== null}
          aria-describedby={nameError !== null ? `${fieldId}-error` : undefined}
          onChange={(event) => {
            setName(event.target.value);
            if (event.target.value.trim() !== '') setNameError(null);
          }}
          className="h-11"
        />
        {nameError !== null ? (
          <ErrorNote>
            <span id={`${fieldId}-error`}>{nameError}</span>
          </ErrorNote>
        ) : null}
      </form>
    </Sheet>
  );
}
