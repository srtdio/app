import { describe, expect, it } from 'vitest';
import {
  commentBarViolations,
  boxText,
  CHIP_FACE_BY_DENSITY,
  CHIP_FACE_PX,
  CHIP_HIT_PX,
  chipViolations,
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
  movedSideways,
  layoutDensity,
  LIST_CARD_GEOM_BY_DENSITY,
  LIST_CARD_HEIGHT_PX,
  listCardViolations,
  overlappingPairs,
  overlaps,
  pinnedBarViolations,
  roleSignature,
  sameWidth,
  spansFullWidth,
  tooManyRoles,
  COMMENT_TRAY_TILE_IDS,
  trayTileViolations,
  underBarViolations,
  wrapsPastOneLine,
  type Box,
  type ChipGeom,
  type LayoutDensity,
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

  it('a transform that moves content sideways (a row mid-swipe) is moving content', () => {
    // chat-tasks-swipe: the task row is held 80 left (translate3d(-80px,0,0)).
    expect(movedSideways('matrix(1, 0, 0, 1, -80, 0)')).toBe(true);
    expect(movedSideways('matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 24, 0, 0, 1)')).toBe(true);
    // A sheet rising on Y, a scale, no transform: not sideways.
    expect(movedSideways('matrix(1, 0, 0, 1, 0, 120)')).toBe(false);
    expect(movedSideways('matrix(0.9, 0, 0, 0.9, 0, 0)')).toBe(false);
    expect(movedSideways('none')).toBe(false);
    expect(movedSideways('matrix(1, 0, 0, 1, 0.2, 0)')).toBe(false);
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

describe('list cards (ui/ListCard): the density height flat rows (72 Cozy default), the picture at 16 and the inset in the bled row, 12 to the text', () => {
  // A flat row bled -mx-4 from the 16 gutter: row at x 0, no border; picture
  // at 0 + 16 = 16, top the density inset (Cozy 12, centred in 72); text at
  // 16 + 48 + 12 = 76 (Compact: 16 + 40 + 12 = 68).
  const good = (y: number, height?: number, density: LayoutDensity = 'cozy'): ListCardGeom => {
    const g = LIST_CARD_GEOM_BY_DENSITY[density];
    return {
      label: `card@${y}`,
      card: { x: 0, y, width: 390, height: height ?? g.height },
      borderLeft: 0,
      borderTop: 0,
      picture: { x: 16, y: y + g.insetY, width: g.picture, height: g.picture },
      text: {
        x: 16 + g.picture + 12,
        y: y + (g.height - 44) / 2,
        width: 390 - g.picture - 44,
        height: 44,
      },
    };
  };

  it('the density geometry: Compact 10 + 40 + 10 = 60, Cozy 12 + 48 + 12 = 72, Calm 16 + 48 + 16 = 80', () => {
    expect(LIST_CARD_GEOM_BY_DENSITY).toEqual({
      compact: { height: 60, picture: 40, insetY: 10 },
      cozy: { height: 72, picture: 48, insetY: 12 },
      calm: { height: 80, picture: 48, insetY: 16 },
    });
    for (const g of Object.values(LIST_CARD_GEOM_BY_DENSITY)) {
      expect(g.insetY + g.picture + g.insetY).toBe(g.height);
    }
    expect(LIST_CARD_HEIGHT_PX).toBe(72);
  });

  it('layoutDensity reads <html data-density>: Cozy when absent or unknown', () => {
    expect(layoutDensity(undefined)).toBe('cozy');
    expect(layoutDensity(null)).toBe('cozy');
    expect(layoutDensity('')).toBe('cozy');
    expect(layoutDensity('roomy')).toBe('cozy');
    expect(layoutDensity('compact')).toBe('compact');
    expect(layoutDensity('cozy')).toBe('cozy');
    expect(layoutDensity('calm')).toBe('calm');
  });

  it('passes rows of one height with the picture in place (rows touch, no gap)', () => {
    expect(listCardViolations([good(0), good(72), good(144.6, 72.4)])).toEqual([]);
  });

  it.each(['compact', 'cozy', 'calm'] as const)(
    'passes the %s rows when checked against that density',
    (density) => {
      const h = LIST_CARD_GEOM_BY_DENSITY[density].height;
      expect(listCardViolations([good(0, h, density), good(h, h, density)], density)).toEqual([]);
    },
  );

  it('fails a row more than 1px taller than the first', () => {
    const out = listCardViolations([good(0), good(72, 88)]);
    expect(out.filter((m) => m.includes('cards differ'))).toHaveLength(1);
  });

  it('every list row is the density height on every screen (the seven lists are one height)', () => {
    // Equal to each other but not 72: a screen whose rows all kept the old 60 row fails in Cozy.
    const short = listCardViolations([good(0, 60, 'compact'), good(60, 60, 'compact')]);
    expect(short.filter((m) => m.includes('not 72'))).toHaveLength(2);
    expect(listCardViolations([good(0, 71.2)])).toEqual([]);
    // A Cozy row on a Compact page fails, and a Compact row on a Calm page.
    expect(listCardViolations([good(0)], 'compact').some((m) => m.includes('not 60'))).toBe(true);
    expect(
      listCardViolations([good(0, 60, 'compact')], 'calm').some((m) => m.includes('not 80')),
    ).toBe(true);
  });

  it('fails a picture that is not the density square (48 Cozy / Calm, 40 Compact)', () => {
    const card = good(0);
    const out = listCardViolations([{ ...card, picture: { x: 16, y: 12, width: 40, height: 40 } }]);
    expect(out.some((m) => m.includes('not 48x48'))).toBe(true);
    const compact = good(0, 60, 'compact');
    const big = listCardViolations(
      [{ ...compact, picture: { x: 16, y: 10, width: 48, height: 48 } }],
      'compact',
    );
    expect(big.some((m) => m.includes('not 40x40'))).toBe(true);
  });

  it('fails a picture not at 16 and the density inset inside the bled row (the old boxed 12,12 too)', () => {
    const card = good(0);
    const off = listCardViolations([{ ...card, picture: { x: 20, y: 12, width: 48, height: 48 } }]);
    expect(off.some((m) => m.includes('not 16,12'))).toBe(true);
    // The old card: 1px border and 12 padding, i.e. a row that is not bled.
    const boxed = listCardViolations([
      { ...card, borderLeft: 1, borderTop: 1, picture: { x: 13, y: 13, width: 48, height: 48 } },
    ]);
    expect(boxed.some((m) => m.includes('not 16,12'))).toBe(true);
    const calm = good(0, 80, 'calm');
    const calmOff = listCardViolations(
      [{ ...calm, picture: { x: 16, y: 12, width: 48, height: 48 } }],
      'calm',
    );
    expect(calmOff.some((m) => m.includes('not 16,16'))).toBe(true);
  });

  it('fails text not 12 after the picture', () => {
    const card = good(0);
    const out = listCardViolations([{ ...card, text: { x: 84, y: 14, width: 200, height: 44 } }]);
    expect(out.some((m) => m.includes('not 12'))).toBe(true);
  });

  it('fails a row with no picture slot', () => {
    expect(listCardViolations([{ ...good(0), picture: null }])[0]).toContain('no picture slot');
  });
});

describe('pinnedBarViolations', () => {
  const at = (topAtRest: number, topScrolled: number, scrolledBy: number) => ({
    found: true,
    topAtRest,
    topScrolled,
    scrolledBy,
  });

  it('passes a bar that keeps its top after the scroll', () => {
    expect(pinnedBarViolations(at(0, 0, 600))).toEqual([]);
    expect(pinnedBarViolations(at(56, 56.8, 600))).toEqual([]);
  });

  it('fails a bar that scrolls away with the page', () => {
    const out = pinnedBarViolations(at(0, -600, 600));
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('must stay pinned');
  });

  it('a page too short to scroll proves nothing and passes', () => {
    expect(pinnedBarViolations(at(0, 0, 0))).toEqual([]);
  });

  it('fails a screen with no pinned bar', () => {
    const out = pinnedBarViolations({ found: false, topAtRest: 0, topScrolled: 0, scrolledBy: 0 });
    expect(out[0]).toContain('no pinned exit bar');
  });
});

describe('underBarViolations', () => {
  const bar = box(0, 0, 390, 56);

  it('passes a row whose top is the bar bottom, inside the pinned block', () => {
    expect(underBarViolations({ bar, row: box(0, 56, 390, 48), insidePin: true })).toEqual([]);
    expect(underBarViolations({ bar, row: box(0, 56.6, 390, 48), insidePin: true })).toEqual([]);
  });

  it('fails a row with a gap under the bar', () => {
    const out = underBarViolations({ bar, row: box(0, 72, 390, 48), insidePin: true });
    expect(out).toEqual(["the progress row starts 16px from the bar's bottom, not 0"]);
  });

  it('fails a row outside the pinned block', () => {
    const out = underBarViolations({ bar, row: box(0, 56, 390, 48), insidePin: false });
    expect(out[0]).toContain('not inside the pinned block');
  });

  it('fails a screen with no bar or no row', () => {
    expect(underBarViolations({ bar: null, row: null, insidePin: false })[0]).toContain(
      'no exit bar',
    );
    expect(underBarViolations({ bar, row: null, insidePin: false })[0]).toContain(
      'no checkpoint progress row',
    );
  });
});

describe('trayTileViolations', () => {
  it('the comment tray is exactly Photos, File, Assets', () => {
    expect(COMMENT_TRAY_TILE_IDS).toEqual(['photos', 'file', 'assets']);
    expect(trayTileViolations(['photos', 'file', 'assets'])).toEqual([]);
  });

  it('fails a tray with the chat tiles or a missing tile', () => {
    expect(trayTileViolations(['photos', 'file', 'assets', 'brief'])).toHaveLength(1);
    expect(trayTileViolations(['photos', 'file'])[0]).toContain('shows 2 tiles');
    expect(trayTileViolations([])[0]).toContain('(none)');
  });

  it('fails the right tiles in the wrong order', () => {
    expect(trayTileViolations(['file', 'photos', 'assets'])).toHaveLength(1);
  });
});

describe('list cards: no preview puts the tag under the time', () => {
  const card = (tagRight: number, over: Partial<ListCardGeom> = {}): ListCardGeom => ({
    label: 'card',
    card: { x: 0, y: 0, width: 390, height: 72 },
    borderLeft: 0,
    borderTop: 0,
    picture: { x: 16, y: 12, width: 48, height: 48 },
    text: { x: 76, y: 14, width: 298, height: 44 },
    time: { x: 344, y: 14, width: 30, height: 20 },
    tag: { x: tagRight - 40, y: 38, width: 40, height: 20 },
    hasPreview: false,
    unread: false,
    ...over,
  });

  it('passes a no-preview tag that ends where the time ends', () => {
    expect(listCardViolations([card(374)])).toEqual([]);
  });

  it('fails a no-preview tag left on the start of line 2', () => {
    const out = listCardViolations([card(129)]);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('tag under the time');
  });

  it('skips cards with a preview or an unread dot after the tag', () => {
    expect(listCardViolations([card(129, { hasPreview: true })])).toEqual([]);
    expect(listCardViolations([card(345, { unread: true })])).toEqual([]);
  });
});

describe('chips (ui/Chip): visible by density (32 / 36 / 40), tap box 44', () => {
  const chip = (faceHeight: number, hit: Partial<Box> = {}): ChipGeom => {
    const h = { x: 16, y: 100, width: 60, height: 44, ...hit };
    return {
      label: 'button "All"',
      hit: h,
      face: { x: h.x, y: h.y + (h.height - faceHeight) / 2, width: h.width, height: faceHeight },
    };
  };

  it('the density faces: Compact 32, Cozy 36 (default), Calm 40; the tap box 44 in all', () => {
    expect(CHIP_FACE_BY_DENSITY).toEqual({ compact: 32, cozy: 36, calm: 40 });
    expect(CHIP_FACE_PX).toBe(36);
    expect(CHIP_HIT_PX).toBe(44);
  });

  it('passes a 36 face centred in a 44 box (Cozy default)', () => {
    expect(chipViolations([chip(36), chip(36, { width: 44 })])).toEqual([]);
  });

  it.each([
    ['compact', 32],
    ['cozy', 36],
    ['calm', 40],
  ] as const)('passes the %s face (%i) centred in a 44 box', (density, face) => {
    expect(chipViolations([chip(face), chip(face, { width: 44 })], density)).toEqual([]);
  });

  it('fails a face that is not the density height (a 32 on Cozy, a 36 on Calm, a 44 anywhere)', () => {
    expect(chipViolations([chip(32)])).toEqual([expect.stringContaining('not 36')]);
    expect(chipViolations([chip(36)], 'calm')).toEqual([expect.stringContaining('not 40')]);
    expect(chipViolations([chip(36)], 'compact')).toEqual([expect.stringContaining('not 32')]);
    expect(chipViolations([chip(44)])).toEqual([expect.stringContaining('not 36')]);
  });

  it('fails a tap box under 44 tall or wide', () => {
    expect(chipViolations([chip(36, { height: 36 })]).some((m) => m.includes('not 44'))).toBe(true);
    expect(chipViolations([chip(36, { width: 41.5 })])).toEqual([
      expect.stringContaining('under 44'),
    ]);
  });

  it('fails a face pushed off centre, or a chip with no face', () => {
    const off = chip(36);
    off.face = { ...off.face!, y: off.hit.y };
    expect(chipViolations([off])).toEqual([expect.stringContaining('not centred')]);
    expect(chipViolations([{ ...chip(36), face: null }])).toEqual([
      expect.stringContaining('no visible chip face'),
    ]);
  });
});

// Decisions A, E, F (7 Nov 2026): top bar slots, the pinned chip-row Select,
// and no upload bar.
describe('top bar, chip-row Select and upload checks', () => {
  const box = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });

  it('topbarViolations: search | sort | + | avatar with fixed 44 slots passes', async () => {
    const { topbarViolations } = await import('../../e2e/visual/layout-checks-core');
    const ok = {
      search: box(200, 6, 44, 44),
      sort: box(248, 6, 44, 44),
      primary: box(292, 6, 44, 44),
      avatar: box(336, 6, 44, 44),
    };
    expect(topbarViolations(ok)).toEqual([]);
    expect(topbarViolations({ ...ok, sort: box(248, 6, 60, 44) })).not.toEqual([]);
    expect(topbarViolations({ ...ok, primary: null })).not.toEqual([]);
    expect(
      topbarViolations({ search: null, sort: null, primary: null, avatar: box(0, 0, 44, 44) }),
    ).toEqual([]);
  });

  it('topbarDriftViolations: slots hold one x across screens', async () => {
    const { topbarDriftViolations } = await import('../../e2e/visual/layout-checks-core');
    expect(
      topbarDriftViolations([
        { screen: 'pipeline', sortX: 248, primaryX: 292 },
        { screen: 'assets', sortX: 248, primaryX: 292 },
      ]),
    ).toEqual([]);
    expect(
      topbarDriftViolations([
        { screen: 'pipeline', sortX: 248, primaryX: 292 },
        { screen: 'briefs', sortX: 230, primaryX: 292 },
      ]),
    ).toHaveLength(1);
    expect(topbarDriftViolations([])).toEqual([]);
  });

  it('chipRowViolations: Select pinned at the content edge, chips end before it', async () => {
    const { chipRowViolations } = await import('../../e2e/visual/layout-checks-core');
    const ok = {
      label: 'pipeline',
      row: box(0, 100, 390, 44),
      paddingRight: 4,
      scroll: box(16, 106, 270, 32),
      select: box(290, 100, 96, 44),
      button: box(290, 100, 96, 44),
    };
    expect(chipRowViolations([ok])).toEqual([]);
    expect(chipRowViolations([{ ...ok, select: box(280, 100, 96, 44) }])).not.toEqual([]);
    expect(chipRowViolations([{ ...ok, scroll: box(16, 106, 330, 32) }])).not.toEqual([]);
    expect(chipRowViolations([{ ...ok, button: box(290, 100, 96, 32) }])).not.toEqual([]);
    expect(chipRowViolations([{ ...ok, select: null, button: null }])).toEqual([]);
  });

  it('uploadBarViolations: no visible bar and no % figure', async () => {
    const { uploadBarViolations } = await import('../../e2e/visual/layout-checks-core');
    expect(
      uploadBarViolations([{ label: 'ring', box: box(0, 0, 1, 1) }], ['1.2 of 3.4 MB']),
    ).toEqual([]);
    expect(uploadBarViolations([{ label: 'bar', box: box(0, 0, 200, 4) }], [])).toHaveLength(1);
    expect(uploadBarViolations([], ['Uploading, 40%'])).toHaveLength(1);
  });
});

describe('comment action bars (8 Nov 2026)', () => {
  const row = { x: 16, y: 200, width: 343, height: 120 };
  const bar = { x: 359 - 178, y: 182, width: 178, height: 36 };
  const button = (x: number) => ({ x, y: 178, width: 44, height: 44 });
  const good = {
    label: 'comment-c1',
    bar,
    row,
    buttons: [button(181), button(225), button(269), button(313)],
    around: [{ label: 'a time (2m)', box: { x: 120, y: 210, width: 24, height: 16 } }],
  };

  it('a bar half above its row, on its end, with 44 hits, passes', () => {
    expect(commentBarViolations([good])).toEqual([]);
  });

  it('flags a small hit, a bar off the top edge, short of the end, or over a time', () => {
    expect(
      commentBarViolations([{ ...good, buttons: [{ x: 181, y: 182, width: 36, height: 36 }] }]),
    ).toHaveLength(1);
    expect(commentBarViolations([{ ...good, bar: { ...bar, y: 200 } }])[0]).toMatch(
      /middle is 18px/,
    );
    expect(commentBarViolations([{ ...good, bar: { ...bar, x: bar.x - 12 } }])[0]).toMatch(
      /ends 12px before/,
    );
    expect(
      commentBarViolations([
        { ...good, around: [{ label: 'a time (5m)', box: { x: 300, y: 190, width: 30, height: 16 } }] },
      ]),
    ).toEqual(['comment-c1: the bar covers a time (5m)']);
  });
});
