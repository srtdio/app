import { describe, expect, it } from 'vitest';
import {
  boxText,
  distinctRoles,
  edgeHit,
  edgeViolations,
  formatViolations,
  intersection,
  layoutMode,
  lineCount,
  lineHeightPx,
  overlappingPairs,
  overlaps,
  roleSignature,
  sameWidth,
  spansFullWidth,
  tooManyRoles,
  wrapsPastOneLine,
  type Box,
  type TapTarget,
} from '../../e2e/visual/layout-checks-core';

// The pure geometry behind the visual suite's layout checks
// (e2e/visual/layout-checks.ts runs it on every screen before the shot).

const box = (x: number, y: number, width: number, height: number): Box => ({
  x,
  y,
  width,
  height,
});

describe('layoutMode', () => {
  it('is strict by default and for anything but report', () => {
    expect(layoutMode(undefined)).toBe('strict');
    expect(layoutMode('')).toBe('strict');
    expect(layoutMode('strict')).toBe('strict');
    expect(layoutMode('loose')).toBe('strict');
    expect(layoutMode('report')).toBe('report');
  });
});

describe('one-line parts', () => {
  it('reads the used line height', () => {
    expect(lineHeightPx('20px', 14)).toBe(20);
    expect(lineHeightPx('1.5', 14)).toBe(21);
    expect(lineHeightPx('normal', 10)).toBe(12);
  });

  it('counts lines from the painted text height', () => {
    expect(lineCount(17, 20)).toBe(1);
    expect(lineCount(37, 20)).toBe(2);
    expect(lineCount(0, 20)).toBe(1);
    expect(lineCount(40, 0)).toBe(1);
  });

  it('a single line (glyph box a little under or over the line) does not wrap', () => {
    expect(wrapsPastOneLine(16, 20)).toBe(false);
    expect(wrapsPastOneLine(24, 20)).toBe(false);
  });

  it('a second line wraps', () => {
    expect(wrapsPastOneLine(36, 20)).toBe(true);
    expect(wrapsPastOneLine(60, 20)).toBe(true);
  });
});

describe('tap targets', () => {
  it('measures the overlap on each axis', () => {
    expect(intersection(box(0, 0, 44, 44), box(40, 10, 44, 44))).toEqual({
      width: 4,
      height: 34,
    });
    expect(intersection(box(0, 0, 10, 10), box(20, 20, 10, 10))).toEqual({ width: 0, height: 0 });
  });

  it('a shared edge or a 1px touch is not an overlap', () => {
    expect(overlaps(box(0, 0, 44, 44), box(44, 0, 44, 44))).toBe(false);
    expect(overlaps(box(0, 0, 44, 44), box(43, 0, 44, 44))).toBe(false);
    expect(overlaps(box(0, 0, 44, 44), box(42, 0, 44, 44))).toBe(true);
  });

  it('a thin sliver on one axis is not an overlap', () => {
    expect(overlaps(box(0, 0, 44, 44), box(10, 43.5, 44, 44))).toBe(false);
  });

  it('pairs only unrelated targets', () => {
    const targets: TapTarget[] = [
      { label: 'row', box: box(0, 0, 300, 44), related: [1] },
      { label: 'row ⋯', box: box(256, 0, 44, 44), related: [0] },
      { label: 'stray', box: box(280, 20, 44, 44), related: [] },
      { label: 'far', box: box(0, 200, 44, 44), related: [] },
    ];
    expect(overlappingPairs(targets)).toEqual([
      [0, 2],
      [1, 2],
    ]);
  });

  it('a relation named on one side only is enough', () => {
    const targets: TapTarget[] = [
      { label: 'a', box: box(0, 0, 44, 44), related: [1] },
      { label: 'b', box: box(10, 10, 20, 20), related: [] },
    ];
    expect(overlappingPairs(targets)).toEqual([]);
  });
});

describe('side edges', () => {
  const vw = 390;

  it('a full-width bar is never checked', () => {
    expect(spansFullWidth(box(0, 0, 390, 56), vw)).toBe(true);
    expect(edgeHit(box(0, 0, 390, 56), vw)).toBeNull();
  });

  it('flags content nearer than 12px on either side', () => {
    expect(edgeHit(box(4, 10, 100, 20), vw)).toBe('left');
    expect(edgeHit(box(300, 10, 86, 20), vw)).toBe('right');
  });

  it('the 16 gutter and the 12 line itself pass', () => {
    expect(edgeHit(box(16, 10, 358, 20), vw)).toBeNull();
    expect(edgeHit(box(12, 10, 366, 20), vw)).toBeNull();
    expect(edgeHit(box(11.7, 10, 50, 20), vw)).toBeNull();
  });

  it('off-screen and empty boxes are not checked', () => {
    expect(edgeHit(box(-200, 10, 100, 20), vw)).toBeNull();
    expect(edgeHit(box(400, 10, 100, 20), vw)).toBeNull();
    expect(edgeHit(box(2, 10, 0, 20), vw)).toBeNull();
  });

  it('full-bleed media is allowed to the edge', () => {
    const found = edgeViolations(
      [
        { label: 'img', box: box(0, 100, 200, 200), fullBleed: true },
        { label: 'span "Hook"', box: box(6, 10, 60, 20), fullBleed: false },
      ],
      vw,
    );
    expect(found.map((f) => [f.item.label, f.side])).toEqual([['span "Hook"', 'left']]);
  });
});

describe('text roles per part', () => {
  it('signs a role by size, weight and the first family', () => {
    expect(
      roleSignature({ fontSize: '14px', fontWeight: '500', fontFamily: '"Inter", sans-serif' }),
    ).toBe('14px/500/Inter');
  });

  it('counts distinct roles and allows three', () => {
    const three = ['14px/500/Inter', '12px/400/Inter', '14px/500/Inter', '11px/400/Inter'];
    expect(distinctRoles(three)).toHaveLength(3);
    expect(tooManyRoles(three)).toBe(false);
    expect(tooManyRoles([...three, '15px/600/Inter'])).toBe(true);
  });

  it('a mono date is its own role', () => {
    expect(tooManyRoles(['a/400/Inter', 'b/500/Inter', 'c/400/Inter', 'c/400/JetBrains'])).toBe(
      true,
    );
  });
});

describe('busy width', () => {
  it('holds within half a pixel', () => {
    expect(sameWidth(88, 88)).toBe(true);
    expect(sameWidth(88, 88.4)).toBe(true);
    expect(sameWidth(88, 96)).toBe(false);
  });
});

describe('messages', () => {
  it('name the screen, the check and the element', () => {
    const text = formatViolations('chat-thread', [
      { check: 'edge', message: `span "Hi" within 12px of the left edge (${boxText(box(4, 2, 30.04, 20))})` },
      { check: 'tap-overlap', message: 'button "A" overlaps button "B"' },
    ]);
    expect(text).toBe(
      '[chat-thread] edge: span "Hi" within 12px of the left edge (4,2 30x20)\n' +
        '[chat-thread] tap-overlap: button "A" overlaps button "B"',
    );
  });
});
