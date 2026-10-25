import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Sheet } from '@/components/ui/Sheet';
import type { RenameOutcome } from '@/lib/asset-upload';
import type { AssetToast } from '@/components/pages/assets/AssetActionSheet';

/** display_name ceiling (mirrors the worker's validName). */
const MAX_ASSET_NAME = 500;

/** The Sheet's discard confirm for an edited file name. */
export const ASSET_RENAME_DISCARD = {
  title: 'Discard the new name?',
  message: 'The file keeps its current name.',
};

/** Save is enabled for a non-empty, changed name within the ceiling. Pure. */
export function canSaveAssetName(name: string, initialName: string): boolean {
  const trimmed = name.trim();
  return trimmed !== '' && trimmed.length <= MAX_ASSET_NAME && trimmed !== initialName.trim();
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

  // Seed while rendering (not in an effect) so the open frame never reads as
  // dirty and places a Back guard for a name nobody typed.
  const seedKey = open ? initialName : null;
  const [seeded, setSeeded] = useState<string | null>(seedKey);
  if (seeded !== seedKey) {
    setSeeded(seedKey);
    setName(open ? initialName : '');
    if (!open) setSaving(false);
  }

  // A changed name is unsaved work: X, Escape, the backdrop and system Back ask first.
  const dirty = open && name !== initialName;

  const canSave = canSaveAssetName(name, initialName) && !saving;

  async function save(): Promise<void> {
    if (!canSave) return;
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
    <span className="ml-auto flex gap-2.5">
      <Button variant="ghost" onClick={onClose} disabled={saving}>
        Cancel
      </Button>
      <Button variant="primary" disabled={!canSave} onClick={() => void save()}>
        {saving ? 'Saving' : 'Save'}
      </Button>
    </span>
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
      <label className="flex flex-col gap-1.5">
        <span className="text-base font-medium text-fg-2">Name</span>
        <Input
          aria-label="File name"
          value={name}
          maxLength={MAX_ASSET_NAME}
          disabled={saving}
          onChange={(event) => setName(event.target.value)}
          className="h-11"
        />
      </label>
    </Sheet>
  );
}
