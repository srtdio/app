// The photo viewer: nothing shows through. The backdrop is the overlay token
// plus a strong blur; its settle-back uses the motion tokens.
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { describe, expect, it } from 'vitest';

const source = readFileSync(fileURLToPath(new URL('./ImageLightbox.tsx', import.meta.url)), 'utf8');

describe('ImageLightbox backdrop', () => {
  it('blurs what is behind it', () => {
    expect(source).toContain('className="absolute inset-0 bg-overlay backdrop-blur-xl"');
  });

  it('uses motion tokens only', () => {
    expect(source).not.toMatch(/duration-(\d+|\[)|ease-(in|out|in-out|linear)\b/);
  });
});
