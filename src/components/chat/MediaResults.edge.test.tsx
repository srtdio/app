import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Phone rule R7: the chat home chip results (Links, Files, Voice notes) start
// on the 16 page edge, like the section label above them. The list already
// carries the gutter, so on phone the rows add no inset of their own; md+
// keeps px-2. The loading placeholder row lands where the real row lands.
const SRC = readFileSync(resolve(__dirname, 'MediaResults.tsx'), 'utf8');

describe('MediaResults rows sit on the 16 edge on phone', () => {
  it.each([
    [
      'list row (Links, Files)',
      "const ROW = cn('flex min-h-16 min-w-0 items-center gap-3 px-2 py-2 max-md:px-0'",
    ],
    ['voice note row', "cn('flex min-w-0 flex-col gap-1 px-2 py-2 max-md:px-0', NO_TOUCH_SELECT)"],
    ['loading placeholder row', 'className="flex items-center gap-3 px-2 py-2 max-md:px-0"'],
  ])('%s drops its inset below md', (_name, needle) => {
    expect(SRC).toContain(needle);
  });

  it('no row keeps a phone inset', () => {
    const insetRows = SRC.split('\n').filter(
      (l) => /\bpx-2 py-2\b/.test(l) && !l.includes('max-md:px-0'),
    );
    expect(insetRows).toEqual([]);
  });
});
