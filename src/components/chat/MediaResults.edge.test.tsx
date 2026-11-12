import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Phone rule R7: the chat home chip results (Links, Files, Voice notes) start
// on the 16 page edge, like the section label above them. The rows keep their
// px-2; below md their list pulls out by the same 8 so the row content lands on
// the 16 gutter. md+ is unchanged. The loading placeholder list pulls the same
// way, so a placeholder row lands where the real row lands. Photos and Videos
// grids never pull.
const SRC = readFileSync(resolve(__dirname, 'MediaResults.tsx'), 'utf8');

describe('MediaResults rows sit on the 16 edge on phone', () => {
  it('the row list pulls out by the row inset below md, grids do not', () => {
    expect(SRC).toContain("<ul className={grid ? GRID : 'flex flex-col max-md:-mx-2'}>");
    expect(SRC).not.toMatch(/const GRID = [^\n]*-mx-/);
  });

  it('the loading row list pulls the same way', () => {
    expect(SRC).toContain('<ul data-media-skeleton="" className="flex flex-col max-md:-mx-2">');
  });

  it('rows keep the px-2 inset the pull cancels', () => {
    expect(SRC).toContain("const ROW = cn('flex min-h-16 min-w-0 items-center gap-3 px-2 py-2'");
    expect(SRC).toContain("cn('flex min-w-0 flex-col gap-1 px-2 py-2', NO_TOUCH_SELECT)");
    expect(SRC).toContain('className="flex items-center gap-3 px-2 py-2"');
  });
});
