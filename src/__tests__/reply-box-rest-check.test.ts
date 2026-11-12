import { describe, expect, it } from 'vitest';
import {
  REPLY_BOX_GUTTER_PX,
  REPLY_BOX_TEXT_COLUMN_PX,
  replyBoxRestViolations,
  type Box,
  type ReplyBoxRestGeom,
} from '../../e2e/visual/layout-checks-core';

// Check 19 (12 Nov 2026): the pure geometry behind assertReplyBoxAtRest
// (e2e/visual/layout-checks.ts). A reply box at rest: its field's first line
// on the writing frame's and the "+" key's centre; on a phone a docked box 16
// from both screen edges and its text on the 64 column.

const box = (x: number, y: number, width: number, height: number): Box => ({
  x,
  y,
  width,
  height,
});

/**
 * A phone pill on a 390 screen as the shared change draws it: the frame
 * 16..374 and 46 tall at y 700, the 44 "+" at 16 + 1 + 4, the field's text at
 * 65 (inside the 64 column's tolerance), its first line on the frame's centre.
 */
function phonePill(over: Partial<ReplyBoxRestGeom> = {}): ReplyBoxRestGeom {
  return {
    label: 'reply box (chat, pill)',
    viewportWidth: 390,
    frame: box(16, 700, 358, 46),
    lineCentreY: 723,
    textStartX: 65,
    plus: box(21, 701, 36, 44),
    docked: true,
    ...over,
  };
}

describe('replyBoxRestViolations (check 19)', () => {
  it('passes the phone pill as the shared change draws it', () => {
    expect(replyBoxRestViolations([phonePill()])).toEqual([]);
  });

  it('passes with no boxes', () => {
    expect(replyBoxRestViolations([])).toEqual([]);
  });

  it('(a) flags a first line more than 1.5 off the frame centre', () => {
    // The old inline textarea: its line sat about 3 under the pill's centre.
    const out = replyBoxRestViolations([phonePill({ lineCentreY: 726 })]);
    expect(out.some((m) => m.includes("off the frame's centre"))).toBe(true);
  });

  it('(a) allows 1.5 off the centre', () => {
    expect(replyBoxRestViolations([phonePill({ lineCentreY: 724.5 })])).toEqual([]);
  });

  it('(a) flags a "+" key off the first line', () => {
    const out = replyBoxRestViolations([phonePill({ plus: box(21, 698, 36, 44) })]);
    expect(out).toEqual([expect.stringContaining('the "+" key\'s centre')]);
  });

  it('(b) flags the old 12 dock on a phone, both edges', () => {
    const out = replyBoxRestViolations([
      phonePill({ frame: box(12, 700, 366, 46), textStartX: 61, plus: box(17, 701, 36, 44) }),
    ]);
    expect(out).toEqual([
      expect.stringContaining(`from the left screen edge, want ${REPLY_BOX_GUTTER_PX}`),
      expect.stringContaining(`from the right screen edge, want ${REPLY_BOX_GUTTER_PX}`),
      expect.stringContaining(`want the ${REPLY_BOX_TEXT_COLUMN_PX} column`),
    ]);
  });

  it('(c) flags text off the 64 column; 65 is on it', () => {
    expect(replyBoxRestViolations([phonePill({ textStartX: 66 })])).toEqual([
      expect.stringContaining(`want the ${REPLY_BOX_TEXT_COLUMN_PX} column`),
    ]);
    expect(replyBoxRestViolations([phonePill({ textStartX: 63 })])).toEqual([]);
  });

  it('(c) is not judged without a "+" key', () => {
    expect(replyBoxRestViolations([phonePill({ plus: null, textStartX: 29 })])).toEqual([]);
  });

  it('(b) and (c) skip a box inline in a page column (not docked)', () => {
    const inline = phonePill({ docked: false, frame: box(32, 700, 326, 46), textStartX: 81 });
    expect(replyBoxRestViolations([inline])).toEqual([]);
  });

  it('a laptop box answers to (a) only', () => {
    const laptop = phonePill({
      viewportWidth: 1280,
      frame: box(300, 700, 600, 46),
      textStartX: 349,
      plus: box(305, 701, 36, 44),
    });
    expect(replyBoxRestViolations([laptop])).toEqual([]);
    expect(replyBoxRestViolations([{ ...laptop, lineCentreY: 730 }])).toHaveLength(2);
  });
});
