import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { imageCountLabel } from '@/components/pages/pcs/ReadOnlyVersionView';

// FN11 copy on the read-only version view.
const SRC = readFileSync(
  fileURLToPath(new URL('./ReadOnlyVersionView.tsx', import.meta.url)),
  'utf8',
);

describe('ReadOnlyVersionView copy (FN11)', () => {
  it('counts images in words, singular at one', () => {
    expect(imageCountLabel(1)).toBe('1 image');
    expect(imageCountLabel(3)).toBe('3 images');
    expect(imageCountLabel(0)).toBe('No images');
  });

  it('says versions cannot be changed, never "immutable" or "image(s)"', () => {
    expect(SRC).toContain('Versions can&apos;t be changed');
    expect(SRC).not.toContain('Versions are immutable');
    expect(SRC).not.toContain('image(s)');
  });
});
