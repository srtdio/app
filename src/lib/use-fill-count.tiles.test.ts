// Tile grids page by the rows of tiles that fit one screen times the columns
// (9 Nov 2026): the same one-screen rule as the row lists, kept in 6..40.
import { describe, expect, it } from 'vitest';
import { FILL_COUNT_CEILING, FILL_COUNT_FLOOR, tileFillCount } from '@/lib/use-fill-count';

describe('tileFillCount', () => {
  it('rows that fit (square tiles across the grid) plus one, times the columns', () => {
    // 3 columns over 360 px: 120 px tiles; 844 / 120 = 7.03 -> 8 rows, +1 = 9 rows.
    expect(tileFillCount(844, 360, 3)).toBe(27);
    // 4 columns over 480 px: 120 px tiles, same rows, 4 across.
    expect(tileFillCount(844, 480, 4)).toBe(36);
  });

  it('stays within the floor and the ceiling', () => {
    expect(tileFillCount(100, 1200, 2)).toBe(FILL_COUNT_FLOOR);
    expect(tileFillCount(4000, 300, 6)).toBe(FILL_COUNT_CEILING);
    expect(tileFillCount(Number.NaN, 360, 3)).toBe(FILL_COUNT_FLOOR);
  });
});
