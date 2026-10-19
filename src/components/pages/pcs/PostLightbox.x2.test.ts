import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// FT16: Escape in the in-place viewer goes through the shared escape stack, so
// a sheet or dialog opened above it takes the key and the viewer stays.
const SRC = readFileSync(fileURLToPath(new URL('./PostLightbox.tsx', import.meta.url)), 'utf8');

describe('PostLightbox Escape (FT16)', () => {
  it('registers an escape layer and no longer reads Escape off the window', () => {
    expect(SRC).toContain("import { useEscapeLayer } from '@/lib/escape-stack';");
    expect(SRC).toMatch(
      /useEscapeLayer\(true, \(\) => \{\s*if \(!viewingRef\.current\) onClose\(\);\s*\}\);/,
    );
    expect(SRC).not.toContain("event.key === 'Escape'");
  });

  it('arrows still nudge the native scroller from the window listener', () => {
    expect(SRC).toContain("event.key === 'ArrowLeft'");
    expect(SRC).toContain("event.key === 'ArrowRight'");
  });
});
