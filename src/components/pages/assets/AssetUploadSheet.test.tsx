import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildUploadPlan,
  computeDisplayNames,
  seedName,
  uploadMode,
  uploadNameError,
} from '@/components/pages/assets/AssetUploadSheet';

// The sheet body renders through a portal to document.body (no DOM under the SSR
// test environment), so the naming behaviour is extracted into pure helpers and
// driven directly here. The component wires uploadMode -> which input shows,
// computeDisplayNames -> the numbered-name preview, uploadNameError -> the disabled state, and buildUploadPlan -> the per
// file upload, so covering these covers the sheet's behaviour.

/** A File with the given name; the bytes are irrelevant to naming. */
function fakeFile(name: string): File {
  return new File(['x'], name, { type: 'image/png' });
}

describe('uploadMode', () => {
  it('names a single file, bases several files', () => {
    expect(uploadMode(0)).toBe('root-single');
    expect(uploadMode(1)).toBe('root-single');
    expect(uploadMode(2)).toBe('root-bulk');
    expect(uploadMode(5)).toBe('root-bulk');
  });
});

describe('at the root with one file: one required name', () => {
  it('blocks upload until the single name is filled, then uses it verbatim', () => {
    expect(uploadNameError('root-single', '')).not.toBeNull();
    expect(uploadNameError('root-single', '   ')).not.toBeNull();
    expect(uploadNameError('root-single', 'Hero shot')).toBeNull();
    const names = computeDisplayNames({
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
    const plan = buildUploadPlan(pending, { base: 'Trip', siblingLabels: [] });
    // The part is always sent under the original filename, never a typed name.
    expect(plan.map((item) => item.file.name)).toEqual(['IMG_0001.png', 'IMG_0002.png']);
    expect(plan.map((item) => item.displayName)).toEqual(['Trip 1', 'Trip 2']);
  });
});

describe('from a post page: the name box starts as the post title', () => {
  const TITLE = 'Ethyl Acetate - The Ferrari Story';

  it('prefills the post title instead of the file name', () => {
    expect(seedName('', TITLE, 'IMG_0042.png')).toBe(TITLE);
  });

  it('keeps a name the user already typed', () => {
    expect(seedName('Hero shot', TITLE, 'IMG_0042.png')).toBe('Hero shot');
  });

  it('falls back to the file name with no default (Assets page) or a blank title', () => {
    expect(seedName('', null, 'IMG_0042.png')).toBe('IMG_0042');
    expect(seedName('', '   ', 'IMG_0042.png')).toBe('IMG_0042');
  });

  it('names a single file after the post title', () => {
    const base = seedName('', TITLE, 'a.png');
    expect(computeDisplayNames({ base, siblingLabels: [], count: 1 })).toEqual([TITLE]);
  });

  it('numbers a bulk upload from the existing max for that base', () => {
    const base = seedName('', TITLE, 'a.png');
    const names = computeDisplayNames({
      base,
      siblingLabels: [`${TITLE} 1`, `${TITLE} 4`, 'Other 9', `${TITLE} (comment)`],
      count: 3,
    });
    expect(names).toEqual([`${TITLE} 5`, `${TITLE} 6`, `${TITLE} 7`]);
  });
});

describe('upload progress is the ring on the row thumb (decision F)', () => {
  const src = readFileSync(
    fileURLToPath(new URL('./AssetUploadSheet.tsx', import.meta.url)),
    'utf8',
  );

  it('the row thumb carries ui/UploadRing (file) while uploading and UploadRetry when failed', () => {
    expect(src).toContain("from '@/components/ui/UploadRing'");
    expect(src).toMatch(/<UploadRing[^>]*variant="file"/);
    expect(src).toMatch(/<UploadRetry[^>]*variant="file"/);
    expect(src).toContain('label="Stop upload"');
    // The X cancels through the existing Stop (its confirm), not a new path.
    expect(src).toContain('onCancel={() => setStopAsk(true)}');
    // The thumb is the file ring's own 44 box in every state.
    expect(src).toMatch(/data-upload-thumb=\{status\.state\}\s+className="relative flex h-11 w-11/);
  });

  it('the size meta reads bytes ("1.2 of 3.4 MB"), never a percent', () => {
    expect(src).toContain('uploadSizeMeta(status.progress * item.file.size, item.file.size)');
    expect(src).not.toContain('fractionToPercent');
    expect(src).not.toMatch(/%`|\{percent\}/);
  });

  it('no bar is left: no role="progressbar", no fill, no Retry text button', () => {
    expect(src).not.toContain('role="progressbar"');
    expect(src).not.toContain('lit-fill');
    expect(src).not.toContain('mv-fill');
    expect(src).not.toMatch(/>\s*Retry\s*</);
  });
});
