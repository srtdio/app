import { describe, expect, it } from 'vitest';
import {
  buildUploadPlan,
  computeDisplayNames,
  uploadMode,
  uploadNameError,
} from '@/components/pages/assets/AssetUploadSheet';

// The sheet body renders through a portal to document.body (no DOM under the SSR
// test environment), so the naming behaviour is extracted into pure helpers and
// driven directly here, mirroring NewFolderSheet's helper tests. The component
// wires uploadMode -> which input shows, computeDisplayNames -> the auto-name
// preview, uploadNameError -> the disabled state, and buildUploadPlan -> the per
// file upload, so covering these covers the sheet's behaviour.

/** A File with the given name; the bytes are irrelevant to naming. */
function fakeFile(name: string): File {
  return new File(['x'], name, { type: 'image/png' });
}

describe('uploadMode', () => {
  it('auto-names in a folder, names a single root file, bases several root files', () => {
    // Folder mode shows no name input at all (every file is auto-named).
    expect(uploadMode(true, 1)).toBe('folder');
    expect(uploadMode(true, 5)).toBe('folder');
    expect(uploadMode(false, 1)).toBe('root-single');
    expect(uploadMode(false, 2)).toBe('root-bulk');
  });
});

describe('in a folder: auto-named, no name input', () => {
  it('numbers files after the folder, continuing the existing labels', () => {
    const names = computeDisplayNames({
      inFolder: true,
      folderName: 'Trip',
      base: '',
      siblingLabels: [],
      count: 2,
    });
    expect(names).toEqual(['Trip 1', 'Trip 2']);
    // No typed name is required to upload into a folder.
    expect(uploadNameError('folder', '')).toBeNull();
  });
});

describe('at the root with one file: one required name', () => {
  it('blocks upload until the single name is filled, then uses it verbatim', () => {
    expect(uploadNameError('root-single', '')).not.toBeNull();
    expect(uploadNameError('root-single', '   ')).not.toBeNull();
    expect(uploadNameError('root-single', 'Hero shot')).toBeNull();
    const names = computeDisplayNames({
      inFolder: false,
      folderName: null,
      base: 'Hero shot',
      siblingLabels: [],
      count: 1,
    });
    expect(names).toEqual(['Hero shot']);
  });
});

describe('at the root with two files: one base, numbered names', () => {
  it('shows only a base input and sends "<base> 1"/"<base> 2"', () => {
    expect(uploadNameError('root-bulk', '')).not.toBeNull();
    expect(uploadNameError('root-bulk', 'Launch')).toBeNull();
    const names = computeDisplayNames({
      inFolder: false,
      folderName: null,
      base: 'Launch',
      siblingLabels: [],
      count: 2,
    });
    expect(names).toEqual(['Launch 1', 'Launch 2']);
  });
});

describe('buildUploadPlan', () => {
  it('keeps each file under its original name and pairs it with its display_name', () => {
    const pending = [
      { id: 'p1', file: fakeFile('IMG_0001.png') },
      { id: 'p2', file: fakeFile('IMG_0002.png') },
    ];
    const plan = buildUploadPlan(pending, {
      inFolder: true,
      folderName: 'Trip',
      base: '',
      siblingLabels: [],
    });
    // The part is always sent under the original filename, never a typed name.
    expect(plan.map((item) => item.file.name)).toEqual(['IMG_0001.png', 'IMG_0002.png']);
    expect(plan.map((item) => item.displayName)).toEqual(['Trip 1', 'Trip 2']);
  });
});
