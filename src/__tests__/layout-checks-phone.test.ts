import { describe, expect, it } from 'vitest';
import {
  barTitleViolations,
  columnViolations,
  controlEdgeViolations,
  controlPaddingViolations,
  cutLabelViolations,
  formatPhoneViolations,
  gapViolations,
  nearMiss,
  PHONE_COLUMNS,
  PHONE_GUTTER,
  PHONE_MAX_LISTED,
  PHONE_RULE_EXEMPTIONS,
  PHONE_TEXT_COLUMN,
  PHONE_TOLERANCE,
  phoneColumns,
  phoneRows,
  phoneViolations,
  rowCentreViolations,
  rowEdgeViolations,
  slicedLineViolations,
  stripCentreViolations,
  textEdgeViolations,
  textOverlapViolations,
  textSpillViolations,
  type PhoneGeom,
  type PhoneItem,
  type PhoneKind,
  type PhoneStrip,
} from '../../e2e/visual/layout-checks-phone-core';
import type { Box } from '../../e2e/visual/layout-checks-core';
import { ROW_PICTURE_PHONE, ROW_TEXT_START_PHONE } from '@/components/ui/layout';

// The pure judgement behind the phone rules (e2e/visual/layout-checks-phone.ts
// measures every visual screen under 768 wide; R1, R3, R5, R7 to R13). Small
// hand-made geometry per rule: no browser, no DOM.

const VW = 390;
const box = (x: number, y: number, width: number, height: number): Box => ({
  x,
  y,
  width,
  height,
});

let nextId = 1;
function item(kind: PhoneKind, ink: Box, over: Partial<PhoneItem> = {}): PhoneItem {
  return {
    id: nextId++,
    kind,
    label: `${kind} ${ink.x},${ink.y}`,
    ink,
    lines: kind === 'text' ? [{ box: ink, sliceTop: 0, sliceBottom: 0 }] : [],
    control: null,
    holder: null,
    faced: false,
    labelCentred: false,
    name: '',
    framed: false,
    centred: false,
    pinLeft: true,
    pinRight: true,
    follows: false,
    align: 'start',
    scrollsX: false,
    moved: false,
    clipped: false,
    layer: 0,
    scroller: 0,
    bar: null,
    strip: null,
    flexRow: null,
    solo: false,
    stamp: false,
    cutX: 0,
    hiddenLines: 0,
    pastLeft: 0,
    pastRight: 0,
    exempt: [],
    ...over,
  };
}
const text = (x: number, y: number, width = 100, over: Partial<PhoneItem> = {}): PhoneItem =>
  item('text', box(x, y, width, 16), over);
const picture = (x: number, y: number, size = ROW_PICTURE_PHONE): PhoneItem =>
  item('picture', box(x, y, size, size));
const geom = (
  items: PhoneItem[],
  strips: PhoneStrip[] = [],
  width = VW,
  siblings: PhoneGeom['siblings'] = [],
): PhoneGeom => ({ viewport: { width, height: 664 }, items, strips, siblings });
const rules = (found: { rule: string }[]): string[] => found.map((v) => v.rule);

describe('the phone columns', () => {
  it('are the gutter and the text column beside a row picture', () => {
    expect(PHONE_TOLERANCE).toBe(1.5);
    expect(PHONE_COLUMNS).toEqual([16, 64]);
    expect(PHONE_GUTTER + ROW_TEXT_START_PHONE).toBe(PHONE_TEXT_COLUMN);
  });

  it('nearMiss: off a line, yet close enough to belong to it', () => {
    expect(nearMiss(1.5)).toBe(false);
    expect(nearMiss(1.6)).toBe(true);
    expect(nearMiss(-8)).toBe(true);
    expect(nearMiss(10)).toBe(true);
    expect(nearMiss(10.1)).toBe(false);
  });
});

describe('R1 fit', () => {
  it('flags two texts whose lines overlap, not stacked lines or other layers', () => {
    const a = text(64, 100, 120);
    const b = text(170, 102, 60);
    expect(rules(textOverlapViolations([a, b]))).toEqual(['R1']);
    expect(textOverlapViolations([a, text(64, 118, 120)])).toEqual([]);
    expect(textOverlapViolations([a, text(170, 102, 60, { layer: 7 })])).toEqual([]);
    expect(textOverlapViolations([a, text(170, 102, 60, { exempt: ['R1'] })])).toEqual([]);
  });

  it('flags a label taller than its 44 button (F1), not one inside it', () => {
    const holder = box(16, 100, 120, 44);
    const spills = item('text', box(28, 98, 96, 48), { holder });
    expect(rules(textSpillViolations([spills]))).toEqual(['R1']);
    expect(textSpillViolations([item('text', box(28, 112, 96, 20), { holder })])).toEqual([]);
  });

  it('flags text running past the screen edge, not inside a sideways scroller (R4)', () => {
    expect(rules(textEdgeViolations([text(300, 10, 90, { pastRight: 24 })], VW))).toEqual(['R1']);
    expect(textEdgeViolations([text(300, 10, 90, { pastRight: 24, scrollsX: true })], VW)).toEqual(
      [],
    );
    expect(textEdgeViolations([text(300, 10, 74)], VW)).toEqual([]);
  });

  it('flags a line sliced by its box', () => {
    const sliced = item('text', box(16, 10, 100, 12), {
      lines: [{ box: box(16, 10, 100, 12), sliceTop: 0, sliceBottom: 4 }],
    });
    expect(rules(slicedLineViolations([sliced]))).toEqual(['R1']);
    expect(slicedLineViolations([text(16, 10)])).toEqual([]);
  });
});

describe('R3 labels never cut', () => {
  it('flags a cut time and a cut button label, not a cut name in a row (R2)', () => {
    const button = item('control', box(250, 6, 124, 44), { labelCentred: true });
    const row = item('control', box(0, 60, VW, 60));
    const found = cutLabelViolations([
      text(300, 10, 60, { stamp: true, cutX: 9 }),
      button,
      text(262, 20, 100, { control: button.id, cutX: 14 }),
      row,
      text(64, 80, 250, { control: row.id, cutX: 40 }),
      text(64, 150, 250, { cutX: 40 }),
    ]);
    expect(rules(found)).toEqual(['R3', 'R3']);
  });

  it('flags a clamped label that hides lines', () => {
    expect(rules(cutLabelViolations([text(16, 10, 60, { stamp: true, hiddenLines: 1 })]))).toEqual([
      'R3',
    ]);
  });
});

describe('R5 controls', () => {
  it('keeps a filled control 16 from each edge; full-bleed rows and scrollers pass', () => {
    const tight = item('control', box(250, 10, 128, 44), { faced: true });
    expect(rules(controlEdgeViolations([tight], VW))).toEqual(['R5']);
    const fine = item('control', box(16, 10, 358, 44), { faced: true });
    const bleed = item('control', box(0, 80, VW, 60), { faced: true });
    const chip = item('control', box(330, 150, 90, 36), { faced: true, scrollsX: true });
    const bare = item('control', box(340, 200, 44, 44));
    expect(controlEdgeViolations([fine, bleed, chip, bare], VW)).toEqual([]);
  });

  it('keeps 8 side padding around a label; round keys are not judged', () => {
    const tight = item('control', box(16, 10, 100, 44), { faced: true });
    const label = text(20, 24, 92, { control: tight.id, framed: true });
    expect(rules(controlPaddingViolations([tight, label]))).toEqual(['R5']);
    const roomy = item('control', box(16, 80, 120, 44), { faced: true });
    const round = item('control', box(200, 80, 36, 36), { faced: true });
    expect(
      controlPaddingViolations([
        roomy,
        text(28, 94, 96, { control: roomy.id, framed: true }),
        round,
        text(204, 90, 28, { control: round.id, framed: true }),
      ]),
    ).toEqual([]);
  });
});

describe('R7 and R8 row edges', () => {
  it('groups a picture and the lines beside it into one row, sorted by x', () => {
    const rows = phoneRows([text(64, 14, 200), picture(16, 12), text(64, 34, 180), text(16, 90)]);
    expect(rows.map((r) => r.length)).toEqual([3, 1]);
    expect(rows[0]?.[0]?.kind).toBe('picture');
  });

  it('flags a row that starts near 16 but off it; on it and far from it pass', () => {
    expect(rules(rowEdgeViolations([text(21, 10)], VW))).toEqual(['R7']);
    expect(rowEdgeViolations([text(16.8, 10)], VW)).toEqual([]);
    expect(rowEdgeViolations([text(120, 10)], VW)).toEqual([]);
  });

  it('never judges centred, pushed, scrolled, moved or exempt items', () => {
    for (const over of [
      { centred: true },
      { pinLeft: false },
      { scrollsX: true },
      { moved: true },
      { align: 'center' as const },
      { follows: true },
      { exempt: ['R7' as const] },
    ]) {
      expect(rowEdgeViolations([text(21, 10, 100, over)], VW)).toEqual([]);
    }
  });

  it('judges the glyph of a leading back key, not its 44 hit box', () => {
    const key = item('control', box(4, 6, 44, 44), { name: 'Back' });
    const off = item('icon', box(23, 20, 8, 16), { control: key.id });
    expect(rules(rowEdgeViolations([key, off, text(64, 20)], VW))).toEqual(['R7']);
    const on = item('icon', box(16, 20, 8, 16), { control: key.id });
    expect(rowEdgeViolations([key, on, text(64, 20)], VW)).toEqual([]);
  });

  it('flags a trailing key or picture off the right 16; text is never judged there', () => {
    const key = item('control', box(340, 6, 44, 44), { name: 'More' });
    const glyph = item('icon', box(363, 20, 4, 16), { control: key.id });
    expect(rules(rowEdgeViolations([text(16, 20), key, glyph], VW))).toEqual(['R8']);
    const flush = item('icon', box(370, 20, 4, 16), { control: key.id });
    expect(rowEdgeViolations([text(16, 20), key, flush], VW)).toEqual([]);
    expect(rowEdgeViolations([text(16, 20, 352)], VW)).toEqual([]);
    // A chip that merely ends near the edge is not pinned there.
    const chip = item('control', box(300, 80, 68, 36), { faced: true, pinRight: false });
    expect(rowEdgeViolations([chip], VW)).toEqual([]);
  });

  it('never looks inside a card: the card is the item', () => {
    expect(rowEdgeViolations([text(28, 10, 100, { framed: true })], VW)).toEqual([]);
  });
});

describe('R9 columns', () => {
  it('holds 16 and 64 and adds any x three items share', () => {
    expect(phoneColumns([16, 64])).toEqual([16, 64]);
    expect(phoneColumns([40, 40.3, 40.6, 90, 90])).toEqual([16, 64, expect.closeTo(40.3, 1)]);
  });

  it('flags text 4 off the 64 column beside a picture (A10)', () => {
    const found = columnViolations([picture(16, 10), text(68, 20), picture(16, 70), text(64, 80)]);
    expect(rules(found)).toEqual(['R9']);
    expect(found[0]?.message).toContain('68');
  });

  it('passes an item on a column of its own, and anything after other text', () => {
    const shared = [text(56, 10), text(56, 40), text(56, 70)];
    expect(columnViolations(shared)).toEqual([]);
    expect(columnViolations([text(16, 10, 40), text(70, 10, 60)])).toEqual([]);
  });
});

describe('R10 bar titles', () => {
  const bar: PhoneStrip = { kind: 'bar', label: 'bar', box: box(0, 0, VW, 56), fullWidth: true };
  const back = (): PhoneItem[] => {
    const key = item('control', box(4, 6, 44, 44), { name: 'Back', bar: 0, strip: 0 });
    return [key, item('icon', box(16, 20, 8, 16), { control: key.id, bar: 0, strip: 0 })];
  };

  it('wants 64 after a leading icon key', () => {
    const at56 = text(56, 20, 120, { bar: 0, strip: 0 });
    expect(rules(barTitleViolations(geom([...back(), at56], [bar])))).toEqual(['R10']);
    const at64 = text(64, 20, 120, { bar: 0, strip: 0 });
    expect(barTitleViolations(geom([...back(), at64], [bar]))).toEqual([]);
  });

  it('wants 16 with no leading key, and skips narrow bars', () => {
    const at22 = text(22, 20, 120, { bar: 0, strip: 0 });
    expect(rules(barTitleViolations(geom([at22], [bar])))).toEqual(['R10']);
    expect(barTitleViolations(geom([at22], [{ ...bar, fullWidth: false }]))).toEqual([]);
  });
});

describe('R11 strips', () => {
  const strip: PhoneStrip = {
    kind: 'row',
    label: 'row',
    box: box(0, 100, VW, 56),
    fullWidth: true,
  };

  it('flags a one-line item off the strip centre', () => {
    const off = text(16, 114, 100, { strip: 0 });
    expect(rules(stripCentreViolations(geom([off], [strip])))).toEqual(['R11']);
    const on = text(16, 120, 100, { strip: 0 });
    expect(stripCentreViolations(geom([on], [strip]))).toEqual([]);
  });

  it('centres two stacked lines as a pair', () => {
    const pair = [text(64, 110, 120, { strip: 0 }), text(64, 130, 90, { strip: 0 })];
    expect(stripCentreViolations(geom(pair, [strip]))).toEqual([]);
    const low = [text(64, 116, 120, { strip: 0 }), text(64, 136, 90, { strip: 0 })];
    expect(rules(stripCentreViolations(geom(low, [strip])))).toEqual(['R11']);
  });
});

describe('R12 icon and text', () => {
  it('flags an icon off the centre line of the text beside it', () => {
    const icon = item('icon', box(16, 10, 16, 16), { flexRow: 5, solo: true });
    const label = text(40, 14, 80, { flexRow: 5, solo: true });
    expect(rules(rowCentreViolations([icon, label]))).toEqual(['R12']);
    const level = text(40, 10, 80, { flexRow: 5, solo: true });
    expect(rowCentreViolations([icon, level])).toEqual([]);
    expect(rowCentreViolations([icon, text(40, 14, 80, { flexRow: 6, solo: true })])).toEqual([]);
  });
});

describe('R13 gaps', () => {
  it('flags like siblings with unequal gaps', () => {
    expect(rules(gapViolations([{ label: 'tiles', axis: 'x', gaps: [8, 8, 12] }]))).toEqual([
      'R13',
    ]);
    expect(gapViolations([{ label: 'tiles', axis: 'x', gaps: [8, 8.4, 9] }])).toEqual([]);
    expect(gapViolations([{ label: 'pair', axis: 'y', gaps: [8] }])).toEqual([]);
  });
});

describe('the whole screen', () => {
  it('passes a list row on the new phone sizes: picture at 16, text at 64', () => {
    const rows = [0, 60, 120].flatMap((y) => [
      picture(16, y + 12),
      text(64, y + 12, 200),
      text(64, y + 32, 180),
    ]);
    expect(phoneViolations(geom(rows))).toEqual([]);
    expect(phoneViolations(geom(rows, [], 360))).toEqual([]);
    expect(phoneViolations(geom(rows, [], 320))).toEqual([]);
  });

  it('is a no-op at 768 and wider', () => {
    expect(phoneViolations(geom([text(21, 10)], [], 768))).toEqual([]);
    expect(rules(phoneViolations(geom([text(21, 10)])))).toEqual(['R7', 'R9']);
  });

  it('stays fast on a big screen', () => {
    const many: PhoneItem[] = [];
    for (let i = 0; i < 600; i++) {
      many.push(picture(16, i * 60 + 12), text(64, i * 60 + 12, 200), text(64, i * 60 + 32, 180));
    }
    const started = performance.now();
    expect(phoneViolations(geom(many))).toEqual([]);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('names the screen, the width and the rule, and caps the list per rule', () => {
    const found = Array.from({ length: PHONE_MAX_LISTED + 3 }, (_, i) => ({
      rule: 'R7' as const,
      message: `item ${i}`,
    }));
    const lines = formatPhoneViolations('pipeline', 360, found).split('\n');
    expect(lines).toHaveLength(PHONE_MAX_LISTED + 1);
    expect(lines[0]).toBe('[pipeline @360] R7: item 0');
    expect(lines.at(-1)).toBe('[pipeline @360] R7: and 3 more');
  });
});

describe('R14 the one exemption list', () => {
  it('gives every entry a rule, a selector and a one-line reason', () => {
    for (const e of PHONE_RULE_EXEMPTIONS) {
      expect(e.rule).toMatch(/^R(1|3|5|7|8|9|10|11|12|13)$/);
      expect(e.selector.trim().length).toBeGreaterThan(0);
      expect(e.reason.trim().length).toBeGreaterThan(10);
      expect(e.reason).not.toContain('\n');
    }
  });
});
