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
  PLAN_PAD,
  PLAN_STACK,
  ROW_HEIGHT,
  ROW_HEIGHT_PHONE,
  ROW_INSET,
  ROW_INSET_PHONE,
  ROW_PICTURE,
  ROW_PICTURE_PHONE,
  ROW_TEXT_START,
  ROW_TEXT_START_PHONE,
  SCREEN_CHIPS_TOP,
  SCREEN_CONTENT_TOP,
  SCREEN_GUTTER_LAPTOP,
  SCREEN_GUTTER_PHONE,
} from '@/components/ui/layout';
import {
  LIST_SCREEN_CHIPS_END,
  LIST_SCREEN_CHIPS_PAD,
  LIST_SCREEN_CHIPS_TOP,
  LIST_SCREEN_CONTENT_TOP,
  LIST_SCREEN_GUTTER,
} from '@/components/shell/ListScreen';
import {
  LIST_CARD_FRAME_2,
  LIST_CARD_LINE2_2,
  LIST_CARD_PICTURE,
  LIST_CARD_SUB_INSET,
  listCardFrame,
} from '@/components/ui/ListCard';
import { CHIP_FACE_SIZE, CHIP_HIT } from '@/components/ui/Chip';
import { Avatar, AVATAR_CARD_PHONE_PX, AVATAR_CARD_SIZE, AVATAR_PX } from '@/components/ui/Avatar';
import { PLAN_DAY_PAD, PLAN_DAY_STACK } from '@/components/chat/PlanScreen';
import { ACTIVITY_NEW_CHIP } from '@/components/pages/activity/ActivityCard';

/**
 * The px of the one `<prefix>-<step>` class in `classes` (4px grid). No
 * variant: the base class, which is what a phone (under 768) draws.
 */
function px(classes: string, prefix: string): number {
  const re = new RegExp(`(?:^|\\s)${prefix}-(\\d+(?:\\.\\d+)?)(?=\\s|$)`, 'g');
  const hits = [...classes.matchAll(re)].map((m) => Number(m[1]) * 4);
  expect(hits, `${prefix}-* in "${classes}"`).toHaveLength(1);
  return hits[0] ?? NaN;
}

/** The px of the one `md:<prefix>-<step>` class: what 768 and up draws. */
function pxMd(classes: string, prefix: string): number {
  const re = new RegExp(`(?:^|\\s)md:${prefix}-(\\d+(?:\\.\\d+)?)(?=\\s|$)`, 'g');
  const hits = [...classes.matchAll(re)].map((m) => Number(m[1]) * 4);
  expect(hits, `md:${prefix}-* in "${classes}"`).toHaveLength(1);
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
      ACTIVITY_NEW_CHIP,
    ]) {
      expect(cls).not.toMatch(/(^|\s)(compact|calm):/);
    }
  });

  it('ROW_HEIGHT, ROW_INSET: the ListCard frame from 768 (md: classes)', () => {
    expect(pxMd(listCardFrame(), 'h')).toBe(ROW_HEIGHT);
    expect(pxMd(listCardFrame(), 'py')).toBe(ROW_INSET);
    expect(ROW_INSET + ROW_PICTURE + ROW_INSET).toBe(ROW_HEIGHT);
    expect([ROW_HEIGHT, ROW_INSET, ROW_PICTURE]).toEqual([72, 12, 48]);
  });

  it('ROW_HEIGHT_PHONE, ROW_INSET_PHONE: the ListCard frame under 768 (base classes)', () => {
    expect(px(listCardFrame(), 'h')).toBe(ROW_HEIGHT_PHONE);
    expect(px(listCardFrame(), 'py')).toBe(ROW_INSET_PHONE);
    // The two 20 lines and their 4 fill the row; the picture hangs from the title line.
    expect(ROW_INSET_PHONE + 20 + 4 + 20 + ROW_INSET_PHONE).toBe(ROW_HEIGHT_PHONE);
    expect(ROW_INSET_PHONE + ROW_PICTURE_PHONE).toBeLessThanOrEqual(
      ROW_HEIGHT_PHONE - ROW_INSET_PHONE,
    );
    expect([ROW_HEIGHT_PHONE, ROW_INSET_PHONE, ROW_PICTURE_PHONE]).toEqual([60, 8, 36]);
  });

  it('a 2-line preview row (Activity): never under the row height, one 20 line more', () => {
    expect(px(LIST_CARD_FRAME_2, 'min-h')).toBe(ROW_HEIGHT_PHONE);
    expect(pxMd(LIST_CARD_FRAME_2, 'min-h')).toBe(ROW_HEIGHT);
    // Both widths drop the fixed height (h-auto), so the row can grow.
    expect(LIST_CARD_FRAME_2.split(' ')).toEqual(expect.arrayContaining(['h-auto', 'md:h-auto']));
    // Line 2's floor: inset + 20 title + 4 + floor + inset = the row + 20.
    expect(2 * ROW_INSET_PHONE + 20 + 4 + px(LIST_CARD_LINE2_2, 'min-h')).toBe(
      ROW_HEIGHT_PHONE + 20,
    );
    expect(2 * ROW_INSET + 20 + 4 + pxMd(LIST_CARD_LINE2_2, 'min-h')).toBe(ROW_HEIGHT + 20);
  });

  it('ROW_PICTURE, ROW_PICTURE_PHONE: the ListCard picture box and Avatar card', () => {
    expect(pxMd(LIST_CARD_PICTURE, 'h')).toBe(ROW_PICTURE);
    expect(pxMd(LIST_CARD_PICTURE, 'w')).toBe(ROW_PICTURE);
    expect(px(LIST_CARD_PICTURE, 'h')).toBe(ROW_PICTURE_PHONE);
    expect(px(LIST_CARD_PICTURE, 'w')).toBe(ROW_PICTURE_PHONE);
    expect(pxMd(AVATAR_CARD_SIZE, 'h')).toBe(ROW_PICTURE);
    expect(pxMd(AVATAR_CARD_SIZE, 'w')).toBe(ROW_PICTURE);
    expect(px(AVATAR_CARD_SIZE, 'h')).toBe(ROW_PICTURE_PHONE);
    expect(px(AVATAR_CARD_SIZE, 'w')).toBe(ROW_PICTURE_PHONE);
    expect(AVATAR_PX.card).toBe(ROW_PICTURE);
    expect(AVATAR_CARD_PHONE_PX).toBe(ROW_PICTURE_PHONE);
    const html = renderToStaticMarkup(createElement(Avatar, { name: 'Priya Shah', role: 'card' }));
    for (const cls of AVATAR_CARD_SIZE.split(' ')) expect(html.split(/[\s"]/)).toContain(cls);
  });

  it('ROW_TEXT_START, ROW_TEXT_START_PHONE: the sub-row inset is picture + 12', () => {
    expect(pxMd(LIST_CARD_SUB_INSET, 'pl')).toBe(ROW_TEXT_START);
    expect(ROW_PICTURE + 12).toBe(ROW_TEXT_START);
    expect(px(LIST_CARD_SUB_INSET, 'pl')).toBe(ROW_TEXT_START_PHONE);
    expect(ROW_PICTURE_PHONE + 12).toBe(ROW_TEXT_START_PHONE);
  });

  it('CHIP_FACE, CHIP_TAP: the chip face and its hit', () => {
    expect(px(CHIP_FACE_SIZE, 'min-h')).toBe(CHIP_FACE);
    expect(px(CHIP_HIT, 'min-h')).toBe(CHIP_TAP);
  });

  it('PLAN_STACK, PLAN_PAD: the Plan day', () => {
    expect(px(PLAN_DAY_STACK, 'gap')).toBe(PLAN_STACK);
    expect(px(PLAN_DAY_PAD, 'py')).toBe(PLAN_PAD);
  });

  it('NEW_CHIP_HEIGHT: the "N new" chip is its 16 box plus 1 above and below', () => {
    expect(ACTIVITY_NEW_CHIP).toMatch(/(^|\s)box-content(\s|$)/);
    expect(ACTIVITY_NEW_CHIP).toMatch(/(^|\s)py-px(\s|$)/);
    expect(px(ACTIVITY_NEW_CHIP, 'h') + 2).toBe(NEW_CHIP_HEIGHT);
  });

  it('SCREEN_*: the list-screen shell (shell/ListScreen)', () => {
    expect(px(LIST_SCREEN_CHIPS_TOP, 'mt')).toBe(SCREEN_CHIPS_TOP);
    expect(px(LIST_SCREEN_CONTENT_TOP, 'pt')).toBe(SCREEN_CONTENT_TOP);
    expect(px(LIST_SCREEN_GUTTER, 'px')).toBe(SCREEN_GUTTER_PHONE);
    expect(px(LIST_SCREEN_GUTTER, 'md:px')).toBe(SCREEN_GUTTER_LAPTOP);
    expect(px(LIST_SCREEN_CHIPS_PAD, 'pl')).toBe(SCREEN_GUTTER_PHONE);
    expect(px(LIST_SCREEN_CHIPS_PAD, 'md:pl')).toBe(SCREEN_GUTTER_LAPTOP);
    expect(px(LIST_SCREEN_CHIPS_END, 'pr')).toBe(SCREEN_GUTTER_PHONE);
    expect(px(LIST_SCREEN_CHIPS_END, 'md:pr')).toBe(SCREEN_GUTTER_LAPTOP);
  });
});
