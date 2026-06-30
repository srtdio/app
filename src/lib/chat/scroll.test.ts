import { describe, expect, it } from 'vitest';
import { isNearBottom, NEAR_BOTTOM_THRESHOLD_PX } from './scroll';

// clientHeight is fixed; distance below the fold is driven via scrollHeight so
// each case reads as "unseen px = scrollHeight - scrollTop - clientHeight".
const CLIENT = 500;
const TOP = 1000;

function nearBottomAtDistance(distance: number, threshold?: number): boolean {
  return isNearBottom(TOP, TOP + CLIENT + distance, CLIENT, threshold);
}

describe('isNearBottom', () => {
  it('is true when pinned to the bottom (distance 0)', () => {
    expect(nearBottomAtDistance(0)).toBe(true);
  });

  it('is true exactly at the threshold', () => {
    expect(nearBottomAtDistance(NEAR_BOTTOM_THRESHOLD_PX)).toBe(true);
  });

  it('is false one px past the threshold', () => {
    expect(nearBottomAtDistance(NEAR_BOTTOM_THRESHOLD_PX + 1)).toBe(false);
  });

  it('is false when scrolled far up', () => {
    expect(nearBottomAtDistance(5000)).toBe(false);
  });

  it('honours a custom threshold', () => {
    expect(nearBottomAtDistance(40, 40)).toBe(true);
    expect(nearBottomAtDistance(41, 40)).toBe(false);
  });
});
