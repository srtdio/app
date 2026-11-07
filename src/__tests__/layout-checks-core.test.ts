import { describe, expect, it } from 'vitest';
import {
  boxText,
  clipBox,
  distinctRoles,
  edgeHit,
  edgeViolations,
  floatsOver,
  formatViolations,
  intersection,
  isLiftedLayer,
  layoutMode,
  lineCount,
  lineHeightPx,
  LIST_CARD_HEIGHT_PX,
  listCardViolations,
  overlappingPairs,
  overlaps,
  roleSignature,
  sameWidth,
  spansFullWidth,
  tooManyRoles,
  wrapsPastOneLine,
  type Box,
  type ListCardGeom,
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

  it('targets in different fixed or sticky layers never pair', () => {
    const targets: TapTarget[] = [
      // A list row on the scrolling page under the floating nav pill.
      { label: 'row', box: box(0, 549, 346, 72), related: [], layer: null },
      { label: 'nav Plan', box: box(200, 600, 44, 44), related: [], layer: 0 },
      // The decision bar is its own sticky layer.
      { label: 'Approve', box: box(200, 608, 174, 44), related: [], layer: 1 },
      // Two controls in the same nav layer still pair.
      { label: 'nav stray', box: box(220, 610, 44, 44), related: [], layer: 0 },
    ];
    expect(overlappingPairs(targets)).toEqual([[1, 3]]);
  });

  it('absolute layering by design does not pair', () => {
    const targets: TapTarget[] = [
      { label: 'card press', box: box(17, 185, 169, 146), related: [], layeredWith: [1] },
      { label: 'card ⋮', box: box(138, 199, 44, 44), related: [] },
      { label: 'search', box: box(16, 68, 272, 44), related: [] },
      { label: 'clear X', box: box(244, 68, 44, 44), related: [], layeredWith: [2] },
    ];
    expect(overlappingPairs(targets)).toEqual([]);
  });

  it('passive targets (pointer-events none, aria-hidden, inert) never pair', () => {
    const targets: TapTarget[] = [
      { label: 'a', box: box(0, 0, 44, 44), related: [] },
      { label: 'b', box: box(10, 10, 44, 44), related: [], passive: true },
    ];
    expect(overlappingPairs(targets)).toEqual([]);
  });

  it('compares only what shows through each overflow clip', () => {
    const scroller = box(0, 96, 390, 400);
    const targets: TapTarget[] = [
      // A chat card scrolled up under the header: clipped to the scroller.
      { label: 'card', box: box(114, -31, 248, 448), related: [], clip: scroller },
      { label: 'header btn', box: box(338, 5, 44, 44), related: [], clip: box(0, 0, 390, 664) },
      // Clipped right out: never a target.
      { label: 'gone', box: box(0, 520, 44, 44), related: [], clip: scroller },
      { label: 'under gone', box: box(0, 520, 44, 44), related: [] },
      // Still overlapping inside the clip: a real fault.
      { label: 'in scroller', box: box(200, 200, 44, 44), related: [], clip: scroller },
    ];
    expect(overlappingPairs(targets)).toEqual([[0, 4]]);
  });

  it('a lifted bar or popover outside a scroller floats over what scrolls in it', () => {
    // Laptop chat thread: the status bar (relative z-raised) sits above the
    // message list (scroller 0); its 44 chevron overhangs the list by 4. A
    // post card scrolled to the list's top shows through the list's clip
    // under that 4. The composer's schedule menu (absolute z-nav) opens
    // over the same list.
    const list = box(240, 148, 1040, 500);
    const chevron: TapTarget = {
      label: 'status chevron',
      box: box(1248, 107.5, 16, 44),
      related: [],
      scroller: null,
      liftedOver: [0],
    };
    const card: TapTarget = {
      label: 'post card',
      box: box(968, 12.5, 288, 448),
      related: [],
      scroller: 0,
      clip: list,
    };
    const row: TapTarget = {
      label: 'schedule row',
      box: box(937, 400, 322, 56),
      related: [],
      scroller: null,
      liftedOver: [0],
    };
    const targets = [chevron, card, row];
    expect(floatsOver(chevron, card)).toBe(true);
    expect(floatsOver(card, chevron)).toBe(false);
    expect(overlappingPairs(targets)).toEqual([]);
    // Without the lift (an in-flow control overhanging the list) it is a fault.
    const flat = targets.map((t) => ({ ...t, liftedOver: [] }));
    expect(overlappingPairs(flat)).toEqual([
      [0, 1],
      [1, 2],
    ]);
  });

  it('a lift never excuses targets scrolling in the same scroller', () => {
    const list = box(0, 100, 400, 500);
    const targets: TapTarget[] = [
      // A lifted ⋮ inside the list: the list holds its layer, so it floats over nothing there.
      { label: 'row ⋮', box: box(300, 200, 44, 44), related: [], scroller: 0, liftedOver: [1] },
      { label: 'next row', box: box(0, 220, 400, 60), related: [], scroller: 0, clip: list },
      // A lifted bar over another scroller (1) does not float over list 0.
      { label: 'bar btn', box: box(0, 200, 44, 44), related: [], scroller: null, liftedOver: [1] },
    ];
    expect(overlappingPairs(targets)).toEqual([
      [0, 1],
      [1, 2],
    ]);
  });

  it('a lifted layer is positioned with a z-index of its own', () => {
    expect(isLiftedLayer({ position: 'relative', zIndex: '10' })).toBe(true);
    expect(isLiftedLayer({ position: 'absolute', zIndex: '30' })).toBe(true);
    expect(isLiftedLayer({ position: 'absolute', zIndex: '0' })).toBe(true);
    expect(isLiftedLayer({ position: 'relative', zIndex: 'auto' })).toBe(false);
    expect(isLiftedLayer({ position: 'static', zIndex: '10' })).toBe(false);
    expect(isLiftedLayer({ position: 'absolute', zIndex: '' })).toBe(false);
  });

  it('clips a box to a rect', () => {
    expect(clipBox(box(0, 0, 100, 100), box(50, 50, 100, 100))).toEqual(box(50, 50, 50, 50));
    expect(clipBox(box(0, 0, 10, 10), box(20, 20, 10, 10))).toBeNull();
    expect(clipBox(box(0, 0, 10, 10), null)).toEqual(box(0, 0, 10, 10));
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

  it('decorative (aria-hidden, inert) subtrees are not checked', () => {
    const found = edgeViolations(
      [
        {
          label: 'div "October 2026"',
          box: box(10.6, 73, 102, 20),
          fullBleed: false,
          decorative: true,
        },
      ],
      vw,
    );
    expect(found).toEqual([]);
  });

  it('measures text cut to its overflow clip, not its unclipped run', () => {
    const found = edgeViolations(
      [
        // A truncated line whose text run is 1298px wide; it shows only to 374.
        {
          label: 'span "Love the new cover"',
          box: box(40, 454, 1298, 17),
          fullBleed: false,
          clip: box(16, 400, 358, 100),
        },
        // Clipped away entirely.
        {
          label: 'span "gone"',
          box: box(2, 10, 50, 20),
          fullBleed: false,
          clip: box(16, 100, 358, 100),
        },
        // A real one: the clip itself reaches the edge.
        {
          label: 'span "near"',
          box: box(300, 10, 86, 20),
          fullBleed: false,
          clip: box(0, 0, 390, 664),
        },
      ],
      vw,
    );
    expect(found.map((f) => [f.item.label, f.side])).toEqual([['span "near"', 'right']]);
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
    const roles = ['a/400/Inter', 'b/500/Inter', 'c/400/Inter', 'c/400/JetBrains'];
    expect(tooManyRoles(roles)).toBe(true);
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
    const where = boxText(box(4, 2, 30.04, 20));
    const text = formatViolations('chat-thread', [
      { check: 'edge', message: `span "Hi" within 12px of the left edge (${where})` },
      { check: 'tap-overlap', message: 'button "A" overlaps button "B"' },
    ]);
    expect(text).toBe(
      '[chat-thread] edge: span "Hi" within 12px of the left edge (4,2 30x20)\n' +
        '[chat-thread] tap-overlap: button "A" overlaps button "B"',
    );
  });
});

describe('list cards (ui/ListCard): equal heights, the 72 picture 16 inside, 12 to the text', () => {
  // A card at x 16 with a 1px border: picture at 16 + 1 + 16 = 33, text at 33 + 72 + 12 = 117.
  const good = (y: number, height = 118): ListCardGeom => ({
    label: `card@${y}`,
    card: { x: 16, y, width: 358, height },
    borderLeft: 1,
    borderTop: 1,
    picture: { x: 33, y: y + 17, width: 72, height: 72 },
    text: { x: 117, y: y + 17, width: 240, height: 84 },
  });

  it('passes cards of one height with the picture in place', () => {
    expect(listCardViolations([good(0), good(130), good(260.6, 118.4)])).toEqual([]);
  });

  it('fails a card more than 1px taller than the first', () => {
    const out = listCardViolations([good(0), good(130, 140)]);
    expect(out.filter((m) => m.includes('cards differ'))).toHaveLength(1);
  });

  it('every list card is 118 tall on every screen (the six lists are one height)', () => {
    expect(LIST_CARD_HEIGHT_PX).toBe(118);
    // Equal to each other but not 118: a screen whose cards all grew still fails.
    const tall = listCardViolations([good(0, 130), good(140, 130)]);
    expect(tall).toHaveLength(2);
    for (const m of tall) expect(m).toContain('not 118');
    expect(listCardViolations([good(0, 117.2)])).toEqual([]);
  });

  it('fails a picture that is not 72x72', () => {
    const card = good(0);
    const out = listCardViolations([{ ...card, picture: { x: 33, y: 17, width: 40, height: 40 } }]);
    expect(out.some((m) => m.includes('not 72x72'))).toBe(true);
  });

  it('fails a picture not 16 inside the card edge (left or top)', () => {
    const card = good(0);
    const out = listCardViolations([{ ...card, picture: { x: 29, y: 17, width: 72, height: 72 } }]);
    expect(out.some((m) => m.includes('not 16,16'))).toBe(true);
  });

  it('fails text not 12 after the picture', () => {
    const card = good(0);
    const out = listCardViolations([{ ...card, text: { x: 125, y: 17, width: 200, height: 84 } }]);
    expect(out.some((m) => m.includes('not 12'))).toBe(true);
  });

  it('fails a card with no picture slot', () => {
    expect(listCardViolations([{ ...good(0), picture: null }])[0]).toContain('no picture slot');
  });
});
