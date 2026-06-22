import { describe, expect, it, vi } from 'vitest';
import { canSaveFolderName, submitFolderRename } from '@/components/pages/assets/FolderRenameSheet';
import type { FolderRenameOutcome } from '@/lib/asset-upload';

// The sheet body renders through a portal to document.body (no DOM under the node
// test environment), so the Save gate and the submit flow are extracted into pure
// helpers and driven directly here, mirroring NewFolderSheet's tests. The
// component wires canSaveFolderName -> the disabled state and submitFolderRename ->
// the toast/inline-error/close, so covering both helpers covers the sheet.

describe('canSaveFolderName gates Save', () => {
  it('disables an empty, whitespace, or over-long name', () => {
    expect(canSaveFolderName('', 'Brand')).toBe(false);
    expect(canSaveFolderName('   ', 'Brand')).toBe(false);
    expect(canSaveFolderName('x'.repeat(81), 'Brand')).toBe(false);
  });

  it('disables a name unchanged from the current one (after trim)', () => {
    expect(canSaveFolderName('Brand', 'Brand')).toBe(false);
    expect(canSaveFolderName('  Brand  ', 'Brand')).toBe(false);
  });

  it('enables a changed name of a usable length', () => {
    expect(canSaveFolderName('Campaigns', 'Brand')).toBe(true);
    expect(canSaveFolderName('x'.repeat(80), 'Brand')).toBe(true);
  });
});

describe('submitFolderRename', () => {
  it('toasts the server-resolved name then refreshes and closes on success', async () => {
    const onSubmit = vi.fn(
      async (): Promise<FolderRenameOutcome> => ({
        ok: true,
        folder: { id: 'f-1', name: 'Campaigns', parentId: null },
      }),
    );
    const onToast = vi.fn();
    const onRenamed = vi.fn();
    const onClose = vi.fn();

    const inlineError = await submitFolderRename({
      name: 'Campaigns',
      onSubmit,
      onToast,
      onRenamed,
      onClose,
    });

    expect(inlineError).toBeNull();
    expect(onSubmit).toHaveBeenCalledWith('Campaigns');
    expect(onToast).toHaveBeenCalledWith('Renamed to Campaigns');
    expect(onRenamed).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('returns the inline error and keeps the sheet open on a name collision', async () => {
    const onSubmit = vi.fn(
      async (): Promise<FolderRenameOutcome> => ({
        ok: false,
        nameTaken: true,
        message: 'A folder with this name already exists here',
      }),
    );
    const onToast = vi.fn();
    const onRenamed = vi.fn();
    const onClose = vi.fn();

    const inlineError = await submitFolderRename({
      name: 'Brand',
      onSubmit,
      onToast,
      onRenamed,
      onClose,
    });

    expect(inlineError).toBe('A folder with this name already exists here');
    expect(onToast).not.toHaveBeenCalled();
    expect(onRenamed).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('toasts and does not close on any other failure', async () => {
    const onSubmit = vi.fn(
      async (): Promise<FolderRenameOutcome> => ({
        ok: false,
        nameTaken: false,
        message: 'Only the agency team can rename folders',
      }),
    );
    const onToast = vi.fn();
    const onRenamed = vi.fn();
    const onClose = vi.fn();

    const inlineError = await submitFolderRename({
      name: 'Brand',
      onSubmit,
      onToast,
      onRenamed,
      onClose,
    });

    expect(inlineError).toBeNull();
    expect(onToast).toHaveBeenCalledWith('Only the agency team can rename folders');
    expect(onRenamed).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
