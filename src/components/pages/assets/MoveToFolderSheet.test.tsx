import { describe, expect, it, vi } from 'vitest';
import { submitMove } from '@/components/pages/assets/MoveToFolderSheet';
import { flattenFolders, type FolderItem } from '@/lib/assets';
import type { MoveAssetsOutcome } from '@/lib/asset-upload';

// The sheet body renders through Sheet's portal to document.body (no DOM under
// the node SSR test env), so the orchestration is extracted into the pure
// submitMove helper and driven directly here, mirroring NewFolderSheet.test. The
// component wires submitMove -> the toast/refresh/close on each picked row, and
// derives its destination rows from flattenFolders, which is asserted below.

const folders: FolderItem[] = [
  { id: 'f-brand', name: 'Brand', parentId: null },
  { id: 'f-logos', name: 'Logos', parentId: 'f-brand' },
  { id: 'f-camp', name: 'campaigns', parentId: null },
];

describe('move destinations', () => {
  it('offers the flattened folder tree the sheet renders as rows (root row is added separately)', () => {
    expect(flattenFolders(folders)).toEqual([
      { id: 'f-brand', name: 'Brand', depth: 0 },
      { id: 'f-logos', name: 'Logos', depth: 1 },
      { id: 'f-camp', name: 'campaigns', depth: 0 },
    ]);
  });
});

describe('submitMove', () => {
  it('picking the root (null target) moves and toasts the singular count then refreshes and closes', async () => {
    const onMove = vi.fn(async (): Promise<MoveAssetsOutcome> => ({ ok: true, moved: 1 }));
    const onToast = vi.fn();
    const onMoved = vi.fn();
    const onClose = vi.fn();

    await submitMove({ targetFolderId: null, onMove, onToast, onMoved, onClose });

    expect(onMove).toHaveBeenCalledWith(null);
    expect(onToast).toHaveBeenCalledWith('Moved 1 file');
    expect(onMoved).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('picking a folder destination toasts the plural moved count', async () => {
    const onMove = vi.fn(async (): Promise<MoveAssetsOutcome> => ({ ok: true, moved: 3 }));
    const onToast = vi.fn();
    const onMoved = vi.fn();
    const onClose = vi.fn();

    await submitMove({ targetFolderId: 'f-brand', onMove, onToast, onMoved, onClose });

    expect(onMove).toHaveBeenCalledWith('f-brand');
    expect(onToast).toHaveBeenCalledWith('Moved 3 files');
    expect(onMoved).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('toasts the failure message and stays open (no refresh, no close)', async () => {
    const onMove = vi.fn(
      async (): Promise<MoveAssetsOutcome> => ({
        ok: false,
        message: "Couldn't move the files. Check your connection and retry",
      }),
    );
    const onToast = vi.fn();
    const onMoved = vi.fn();
    const onClose = vi.fn();

    await submitMove({ targetFolderId: 'f-brand', onMove, onToast, onMoved, onClose });

    expect(onToast).toHaveBeenCalledWith(
      "Couldn't move the files. Check your connection and retry",
    );
    expect(onMoved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
