import { describe, expect, it, vi } from 'vitest';
import { folderNameError, submitNewFolder } from '@/components/pages/assets/NewFolderSheet';
import type { FolderCreateOutcome } from '@/lib/asset-upload';

// The sheet body renders through a portal to document.body (no DOM under the SSR
// test environment), so the gate and submit flow are extracted into pure helpers
// and driven directly here, mirroring MembersInviteForm's sendInvite tests. The
// component wires folderNameError -> the disabled state and submitNewFolder ->
// the toast/refresh/close, so covering both helpers covers the sheet's behaviour.

describe('folderNameError gates the submit', () => {
  it('rejects an empty or whitespace name', () => {
    expect(folderNameError('')).toBe('Give the folder a name');
    expect(folderNameError('   ')).toBe('Give the folder a name');
  });

  it('rejects a name longer than 80 characters', () => {
    expect(folderNameError('x'.repeat(81))).toBe('Keep the name under 80 characters');
  });

  it('accepts a trimmed name of a usable length', () => {
    expect(folderNameError('Campaigns')).toBeNull();
    expect(folderNameError('x'.repeat(80))).toBeNull();
  });
});

describe('submitNewFolder', () => {
  it('toasts the server-resolved (auto-numbered) name then refreshes and closes', async () => {
    const onSubmit = vi.fn(
      async (): Promise<FolderCreateOutcome> => ({
        ok: true,
        folder: { id: 'f-2', name: 'Campaigns 2', parentId: null },
      }),
    );
    const onToast = vi.fn();
    const onCreated = vi.fn();
    const onClose = vi.fn();

    await submitNewFolder({ name: 'Campaigns', onSubmit, onToast, onCreated, onClose });

    expect(onSubmit).toHaveBeenCalledWith('Campaigns');
    expect(onToast).toHaveBeenCalledWith('Created Campaigns 2');
    expect(onCreated).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('toasts the mapped error and does not refresh or close on failure', async () => {
    const onSubmit = vi.fn(
      async (): Promise<FolderCreateOutcome> => ({ ok: false, message: 'Network down' }),
    );
    const onToast = vi.fn();
    const onCreated = vi.fn();
    const onClose = vi.fn();

    await submitNewFolder({ name: 'Campaigns', onSubmit, onToast, onCreated, onClose });

    expect(onToast).toHaveBeenCalledWith('Network down');
    expect(onCreated).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
