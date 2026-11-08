// Catch up's card swipe: X and rotate only (never Y), the lean capped at 6deg,
// the threshold decides read (right) or keep (left), below it springs home.

import { describe, expect, it } from 'vitest';
import {
  CARD_SWING,
  SWIPE_ROTATE_MAX,
  flyOutDx,
  swipeDecision,
  swipeRotate,
  swipeTint,
  swipeTransform,
} from '@/lib/catch-up/card-swipe';

describe('catch-up card swipe', () => {
  it('moves on X with a lean, never Y', () => {
    for (const dx of [-400, -120, -11, 0, 11, 120, 400]) {
      const t = swipeTransform(dx, 360);
      expect(t).not.toMatch(/translateY|translate3d|translate\(/);
      if (dx !== 0) expect(t).toMatch(/^translateX\(-?\d+px\) rotate\(-?[\d.]+deg\)$/);
    }
    expect(swipeTransform(0, 360)).toBe('');
    expect(CARD_SWING.axis).toEqual(['x', 'rotate']);
  });

  it('caps the lean at 6deg either way', () => {
    expect(SWIPE_ROTATE_MAX).toBe(6);
    expect(swipeRotate(5000, 360)).toBe(6);
    expect(swipeRotate(-5000, 360)).toBe(-6);
    expect(Math.abs(swipeRotate(40, 360))).toBeLessThan(6);
  });

  it('decides past the threshold, springs back below it', () => {
    expect(swipeDecision(200, 360)).toBe('read');
    expect(swipeDecision(-200, 360)).toBe('keep');
    expect(swipeDecision(40, 360)).toBeNull();
    expect(swipeDecision(-40, 360)).toBeNull();
    expect(swipeTint(80, 360)).toBe('read');
    expect(swipeTint(-80, 360)).toBe('keep');
    expect(swipeTint(10, 360)).toBeNull();
  });

  it('flies out past the card width in the decision direction', () => {
    expect(flyOutDx('read', 360)).toBeGreaterThan(360);
    expect(flyOutDx('keep', 360)).toBeLessThan(-360);
  });
});
