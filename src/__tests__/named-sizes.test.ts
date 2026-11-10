// Named sizes (10 Nov 2026: densities removed, one size = the former Cozy).
// The parts draw with literal Tailwind classes (the compiler needs them); this
// guard proves each part's class equals its named constant in ui/layout.
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  CHIP_FACE,
  CHIP_TAP,
  NEW_CHIP_HEIGHT,
  PAIR_BOX_HEIGHT,
  PAIR_PILL_HEIGHT,
  PLAN_PAD,
  PLAN_STACK,
  ROW_HEIGHT,
  ROW_INSET,
  ROW_PICTURE,
  ROW_TEXT_START,
} from '@/components/ui/layout';
import {
  LIST_CARD_PICTURE,
  LIST_CARD_SUB_INSET,
  listCardFrame,
} from '@/components/ui/ListCard';
import { CHIP_FACE_SIZE, CHIP_HIT } from '@/components/ui/Chip';
import { Avatar } from '@/components/ui/Avatar';
import { PLAN_DAY_PAD, PLAN_DAY_STACK } from '@/components/chat/PlanScreen';
import { ACTIVITY_TOPBAR_BOX, ACTIVITY_TOPBAR_PILL } from '@/components/shell/topbar-actions';
import { ACTIVITY_NEW_CHIP } from '@/components/pages/activity/ActivityCard';

/** The px of the one `<prefix>-<step>` class in `classes` (4px grid). */
function px(classes: string, prefix: string): number {
  const re = new RegExp(`(?:^|\\s)${prefix}-(\\d+(?:\\.\\d+)?)(?=\\s|$)`, 'g');
  const hits = [...classes.matchAll(re)].map((m) => Number(m[1]) * 4);
  expect(hits, `${prefix}-* in "${classes}"`).toHaveLength(1);
  return hits[0] ?? NaN;
}

describe('named sizes: each part class equals its ui/layout constant', () => {
  it('no density variant survives in a part', () => {
    for (const cls of [
      listCardFrame(),
      LIST_CARD_PICTURE,
      LIST_CARD_SUB_INSET,
      CHIP_FACE_SIZE,
      PLAN_DAY_STACK,
      PLAN_DAY_PAD,
      ACTIVITY_TOPBAR_BOX,
      ACTIVITY_TOPBAR_PILL,
      ACTIVITY_NEW_CHIP,
    ]) {
      expect(cls).not.toMatch(/(^|\s)(compact|calm):/);
    }
  });

  it('ROW_HEIGHT, ROW_INSET: the ListCard frame', () => {
    expect(px(listCardFrame(), 'h')).toBe(ROW_HEIGHT);
    expect(px(listCardFrame(), 'py')).toBe(ROW_INSET);
    expect(ROW_INSET + ROW_PICTURE + ROW_INSET).toBe(ROW_HEIGHT);
  });

  it('ROW_PICTURE: the ListCard picture box and Avatar card', () => {
    expect(px(LIST_CARD_PICTURE, 'h')).toBe(ROW_PICTURE);
    expect(px(LIST_CARD_PICTURE, 'w')).toBe(ROW_PICTURE);
    const html = renderToStaticMarkup(createElement(Avatar, { name: 'Priya Shah', role: 'card' }));
    expect(html).toMatch(new RegExp(`\\bh-${ROW_PICTURE / 4}\\b`));
    expect(html).toMatch(new RegExp(`\\bw-${ROW_PICTURE / 4}\\b`));
  });

  it('ROW_TEXT_START: the sub-row inset is picture + 12', () => {
    expect(px(LIST_CARD_SUB_INSET, 'pl')).toBe(ROW_TEXT_START);
    expect(ROW_PICTURE + 12).toBe(ROW_TEXT_START);
  });

  it('CHIP_FACE, CHIP_TAP: the chip face and its hit', () => {
    expect(px(CHIP_FACE_SIZE, 'min-h')).toBe(CHIP_FACE);
    expect(px(CHIP_HIT, 'min-h')).toBe(CHIP_TAP);
  });

  it('PLAN_STACK, PLAN_PAD: the Plan day', () => {
    expect(px(PLAN_DAY_STACK, 'gap')).toBe(PLAN_STACK);
    expect(px(PLAN_DAY_PAD, 'py')).toBe(PLAN_PAD);
  });

  it('PAIR_BOX_HEIGHT, PAIR_PILL_HEIGHT: the Threads | Catch up box and pill', () => {
    expect(px(ACTIVITY_TOPBAR_BOX, 'h')).toBe(PAIR_BOX_HEIGHT);
    expect(px(ACTIVITY_TOPBAR_PILL, 'h')).toBe(PAIR_PILL_HEIGHT);
  });

  it('NEW_CHIP_HEIGHT: the "N new" chip is its 16 box plus 1 above and below', () => {
    expect(ACTIVITY_NEW_CHIP).toMatch(/(^|\s)box-content(\s|$)/);
    expect(ACTIVITY_NEW_CHIP).toMatch(/(^|\s)py-px(\s|$)/);
    expect(px(ACTIVITY_NEW_CHIP, 'h') + 2).toBe(NEW_CHIP_HEIGHT);
  });
});
