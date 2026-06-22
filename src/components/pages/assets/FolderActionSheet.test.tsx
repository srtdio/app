import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  FolderActionSheet,
  confirmDeleteFolder,
} from '@/components/pages/assets/FolderActionSheet';
import type { FolderDeleteOutcome } from '@/lib/asset-upload';

// The sheet's interactions (reveal the confirm, commit the delete) run through
// the pure confirmDeleteFolder helper, which is driven directly here since this
// node test environment has no DOM. The default (menu) view is rendered to
// static markup to assert the Rename and Delete rows are offered; the destructive
// Delete row uses the text-bad token so light and dark match.

describe('FolderActionSheet menu', () => {
  it('offers a Rename and a destructive Delete row under the folder name', () => {
    const out = renderToStaticMarkup(
      <FolderActionSheet
        name="Campaigns"
        onClose={() => {}}
        onRename={() => {}}
        onConfirmDelete={async () => ({ ok: true })}
        onToast={() => {}}
      />,
    );
    expect(out).toContain('Campaigns');
    expect(out).toContain('Rename');
    expect(out).toContain('Delete folder');
    expect(out).toContain('text-bad');
  });
});

describe('confirmDeleteFolder', () => {
  it('toasts and closes after a successful delete', async () => {
    const onConfirmDelete = vi.fn(async (): Promise<FolderDeleteOutcome> => ({ ok: true }));
    const onToast = vi.fn();
    const onClose = vi.fn();

    await confirmDeleteFolder({ onConfirmDelete, onToast, onClose });

    expect(onConfirmDelete).toHaveBeenCalledOnce();
    expect(onToast).toHaveBeenCalledWith('Folder deleted');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('toasts the failure message and stays open', async () => {
    const onConfirmDelete = vi.fn(
      async (): Promise<FolderDeleteOutcome> => ({
        ok: false,
        message: 'Only the agency team can delete folders',
      }),
    );
    const onToast = vi.fn();
    const onClose = vi.fn();

    await confirmDeleteFolder({ onConfirmDelete, onToast, onClose });

    expect(onToast).toHaveBeenCalledWith('Only the agency team can delete folders');
    expect(onClose).not.toHaveBeenCalled();
  });
});
