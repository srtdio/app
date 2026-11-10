import { afterEach, describe, expect, it, vi } from 'vitest';
import { ROW_HEIGHT } from '@/components/ui/layout';
import {
  FILL_COUNT_CEILING,
  FILL_COUNT_FLOOR,
  fillColumns,
  fillCount,
  getFillCount,
  resetFillCountForTest,
  useFillCount,
} from '@/lib/use-fill-count';

afterEach(() => {
  resetFillCountForTest();
  vi.unstubAllGlobals();
});

describe('fillCount: rows the first screen holds, plus one, x columns, 6..40', () => {
  it('is the screen height over the 72 row (ROW_HEIGHT), rounded up, plus one', () => {
    expect(ROW_HEIGHT).toBe(72);
    expect(fillCount(844)).toBe(Math.ceil(844 / 72) + 1); // 13
    expect(fillCount(667)).toBe(11);
    expect(fillCount(576)).toBe(9);
    expect(fillCount(577)).toBe(10);
  });

  it('multiplies by the laptop columns', () => {
    expect(fillCount(800, 2)).toBe((Math.ceil(800 / 72) + 1) * 2); // 26
    expect(fillCount(500, 3)).toBe(24);
    expect(fillCount(500, 0)).toBe(fillCount(500, 1));
  });

  it('never drops under the floor of 6 or over the ceiling of 40', () => {
    expect(FILL_COUNT_FLOOR).toBe(6);
    expect(FILL_COUNT_CEILING).toBe(40);
    expect(fillCount(0)).toBe(6);
    expect(fillCount(200)).toBe(6);
    expect(fillCount(4000)).toBe(40);
    expect(fillCount(1366, 4)).toBe(40);
    expect(fillCount(Number.NaN)).toBe(6);
  });

  it('is pure: the same height gives the same count', () => {
    for (const h of [0, 320, 568, 844, 1024, 1366, 2160]) {
      expect(fillCount(h)).toBe(fillCount(h));
      expect(fillCount(h)).toBeGreaterThanOrEqual(6);
      expect(fillCount(h)).toBeLessThanOrEqual(40);
    }
  });
});

describe('fillColumns: laptop list columns from the window width', () => {
  it('is one column below md', () => {
    expect(fillColumns(390)).toBe(1);
    expect(fillColumns(767)).toBe(1);
  });

  it('from md: the width after the Sidebar (240) and gutters (48), in 360 columns, at least 1', () => {
    expect(fillColumns(768)).toBe(1);
    expect(fillColumns(1024)).toBe(Math.floor((1024 - 288) / 360)); // 2
    expect(fillColumns(1440)).toBe(Math.floor((1440 - 288) / 360)); // 3
  });
});

describe('useFillCount: the screen is read once per app load', () => {
  it('reads the window once and returns the same value on every later call', () => {
    const screen = { innerHeight: 844, innerWidth: 390 };
    vi.stubGlobal('window', screen);
    const first = getFillCount();
    expect(first).toBe(fillCount(844, 1, 72));
    // A later resize is never read: the stored value stands.
    screen.innerHeight = 300;
    screen.innerWidth = 1440;
    expect(getFillCount()).toBe(first);
    expect(useFillCount()).toBe(first);
  });

  it('uses the laptop columns on md and up', () => {
    vi.stubGlobal('window', { innerHeight: 800, innerWidth: 1024 });
    expect(useFillCount()).toBe(fillCount(800, 2));
  });

  it('adds no listener and measures nothing', () => {
    const addEventListener = vi.fn();
    const getBoundingClientRect = vi.fn();
    vi.stubGlobal('window', { innerHeight: 700, innerWidth: 390, addEventListener });
    vi.stubGlobal('document', {
      getBoundingClientRect,
      addEventListener,
      documentElement: { dataset: {} },
    });
    getFillCount();
    getFillCount();
    expect(addEventListener).not.toHaveBeenCalled();
    expect(getBoundingClientRect).not.toHaveBeenCalled();
  });

  it('outside a browser is the floor, and stores nothing', () => {
    expect(getFillCount()).toBe(6);
    vi.stubGlobal('window', { innerHeight: 844, innerWidth: 390 });
    expect(getFillCount()).toBe(13);
  });
});

describe('getFillCount: one count per app load', () => {
  it('is computed once (later window changes are not read)', () => {
    const screen = { innerHeight: 844, innerWidth: 390 };
    vi.stubGlobal('window', screen);
    const first = getFillCount();
    expect(first).toBe(13);
    screen.innerHeight = 2000;
    expect(getFillCount()).toBe(first);
    expect(useFillCount()).toBe(first);
  });
});
