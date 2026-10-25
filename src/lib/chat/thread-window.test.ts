import { describe, expect, it, vi } from 'vitest';
import {
  centreOn,
  createIdCallbacks,
  createStableCache,
  cropToWindow,
  extendDown,
  extendUp,
  isLive,
  isMounted,
  keysFor,
  latestWindow,
  MAX_MOUNTED,
  resolveWindow,
  samePropValue,
  STEP,
  trimWindow,
  windowEdge,
  type ThreadWindow,
} from '@/lib/chat/thread-window';

const idsOf = (n: number, prefix = 'm'): string[] =>
  Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);

const size = (win: ThreadWindow): number => win.end - win.start;

describe('thread window: sizes', () => {
  it('opens on the latest 50 and caps at 300', () => {
    expect(STEP).toBe(50);
    expect(MAX_MOUNTED).toBe(300);
    expect(latestWindow(500)).toEqual({ start: 450, end: 500 });
    expect(latestWindow(20)).toEqual({ start: 0, end: 20 });
    expect(latestWindow(0)).toEqual({ start: 0, end: 0 });
  });

  it('paging up then down through 500 rows never mounts more than 300', () => {
    const total = 500;
    let win = latestWindow(total);
    const seen: ThreadWindow[] = [win];
    // Up: each step mounts 50 above; the reader is at the top of the window.
    while (win.start > 0) {
      const grown = extendUp(win);
      win = trimWindow(grown, grown.start);
      seen.push(win);
    }
    expect(win).toEqual({ start: 0, end: MAX_MOUNTED });
    // Down: each step mounts 50 below; the reader is at the bottom.
    while (win.end < total) {
      const grown = extendDown(win, total);
      win = trimWindow(grown, grown.end - 1);
      seen.push(win);
    }
    expect(win).toEqual({ start: total - MAX_MOUNTED, end: total });
    for (const w of seen) {
      expect(size(w)).toBeLessThanOrEqual(MAX_MOUNTED);
      expect(w.start).toBeGreaterThanOrEqual(0);
      expect(w.end).toBeLessThanOrEqual(total);
    }
    // Up drops rows at the bottom; down drops rows at the top.
    expect(seen[6]).toEqual({ start: 150, end: 450 });
    expect(seen.some((w) => w.start === 50 && w.end === 350)).toBe(true);
  });

  it('extends stop at the loaded edges', () => {
    expect(extendUp({ start: 0, end: 50 })).toEqual({ start: 0, end: 50 });
    expect(extendUp({ start: 30, end: 80 })).toEqual({ start: 0, end: 80 });
    expect(extendDown({ start: 0, end: 80 }, 80)).toEqual({ start: 0, end: 80 });
    expect(extendDown({ start: 0, end: 60 }, 80)).toEqual({ start: 0, end: 80 });
  });
});

describe('thread window: trim', () => {
  it('leaves a window at or under the cap alone', () => {
    const win = { start: 10, end: 310 };
    expect(trimWindow(win, 10)).toBe(win);
  });

  it('drops the side farther from the reader and keeps the reader mounted', () => {
    expect(trimWindow({ start: 0, end: 350 }, 20)).toEqual({ start: 0, end: 300 });
    expect(trimWindow({ start: 0, end: 350 }, 340)).toEqual({ start: 50, end: 350 });
    // A huge window (many pages landed at once): the reader's row survives.
    const huge = trimWindow({ start: 0, end: 1000 }, 900);
    expect(size(huge)).toBe(MAX_MOUNTED);
    expect(isMounted(huge, 900)).toBe(true);
    const top = trimWindow({ start: 0, end: 1000 }, 5);
    expect(top).toEqual({ start: 0, end: 300 });
  });

  it('clamps a reader index outside the window', () => {
    expect(trimWindow({ start: 100, end: 450 }, 0)).toEqual({ start: 100, end: 400 });
    expect(trimWindow({ start: 100, end: 450 }, 9999)).toEqual({ start: 150, end: 450 });
  });
});

describe('thread window: keys', () => {
  it('a null start follows older pages; an id start stays on its row', () => {
    const ids = idsOf(100);
    const top = keysFor(ids, { start: 0, end: 100 });
    expect(top).toEqual({ startId: null, endId: null });
    const older = [...idsOf(50, 'o'), ...ids];
    expect(resolveWindow(older, top)).toEqual({ start: 0, end: 150 });
    const mid = keysFor(ids, { start: 50, end: 100 });
    expect(mid).toEqual({ startId: 'm51', endId: null });
    expect(resolveWindow(older, mid)).toEqual({ start: 100, end: 150 });
  });

  it('a null end follows live rows; an id end does not', () => {
    const ids = idsOf(100);
    const liveKeys = keysFor(ids, { start: 50, end: 100 });
    const fixedKeys = keysFor(ids, { start: 0, end: 60 });
    expect(fixedKeys).toEqual({ startId: null, endId: 'm60' });
    const grown = [...ids, 'n1', 'n2'];
    expect(resolveWindow(grown, liveKeys)).toEqual({ start: 50, end: 102 });
    expect(resolveWindow(grown, fixedKeys)).toEqual({ start: 0, end: 60 });
    expect(isLive(resolveWindow(grown, liveKeys), grown.length)).toBe(true);
    expect(isLive(resolveWindow(grown, fixedKeys), grown.length)).toBe(false);
  });

  it('a gone edge falls back to the newest and 50 above it', () => {
    const ids = idsOf(200);
    expect(resolveWindow(ids, { startId: 'gone', endId: 'gone' })).toEqual({
      start: 150,
      end: 200,
    });
  });
});

describe('thread window: jumps and edges', () => {
  it('centres 50 rows each side of a jump target', () => {
    expect(centreOn(500, 100)).toEqual({ start: 50, end: 151 });
    expect(centreOn(500, 10)).toEqual({ start: 0, end: 61 });
    expect(centreOn(500, 498)).toEqual({ start: 448, end: 500 });
    expect(isMounted(centreOn(500, 100), 100)).toBe(true);
  });

  it('pages within a viewport of an edge that has loaded rows past it', () => {
    const base = { total: 500, viewport: 600, edgePx: 80 };
    expect(
      windowEdge({ ...base, win: { start: 100, end: 400 }, scrollTop: 500, distanceFromBottom: 5000 }),
    ).toBe('up');
    expect(
      windowEdge({ ...base, win: { start: 0, end: 400 }, scrollTop: 0, distanceFromBottom: 5000 }),
    ).toBe('none');
    expect(
      windowEdge({ ...base, win: { start: 100, end: 400 }, scrollTop: 3000, distanceFromBottom: 10 }),
    ).toBe('down');
    expect(
      windowEdge({ ...base, win: { start: 100, end: 500 }, scrollTop: 3000, distanceFromBottom: 0 }),
    ).toBe('none');
    expect(
      windowEdge({
        ...base,
        viewport: 0,
        win: { start: 100, end: 400 },
        scrollTop: 81,
        distanceFromBottom: 5000,
      }),
    ).toBe('none');
  });
});

describe('thread window: crop', () => {
  type R = { kind: 'day'; key: string } | { kind: 'message'; id: string };
  const idOf = (r: R): string | null => (r.kind === 'message' ? r.id : null);
  const rows: R[] = [
    { kind: 'day', key: 'd1' },
    { kind: 'message', id: 'lead' },
    { kind: 'day', key: 'd2' },
    { kind: 'message', id: 'a' },
    { kind: 'message', id: 'b' },
    { kind: 'day', key: 'd3' },
    { kind: 'message', id: 'trail' },
  ];

  it('drops the lead and trail messages, keeps the pill above the first row', () => {
    expect(cropToWindow(rows, idOf, 'lead', 'trail')).toEqual([
      { kind: 'day', key: 'd2' },
      { kind: 'message', id: 'a' },
      { kind: 'message', id: 'b' },
    ]);
  });

  it('no edges: every row', () => {
    expect(cropToWindow(rows, idOf, null, null)).toEqual(rows);
  });
});

describe('thread window: stable row props', () => {
  it('compares plain objects and arrays by contents, everything else by identity', () => {
    const fn = (): void => {};
    expect(samePropValue({ a: 1, b: { c: 'x' } }, { a: 1, b: { c: 'x' } })).toBe(true);
    expect(samePropValue({ a: 1 }, { a: 2 })).toBe(false);
    expect(samePropValue({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(samePropValue([1, 2], [1, 2])).toBe(true);
    expect(samePropValue({ f: fn }, { f: fn })).toBe(true);
    expect(samePropValue({ f: fn }, { f: () => {} })).toBe(false);
    expect(samePropValue(new Map(), new Map())).toBe(false);
    expect(samePropValue(undefined, undefined)).toBe(true);
  });

  it('a cache hands back the last object while its contents are the same', () => {
    const meta = createStableCache<{ time: string; edited: boolean }>();
    const first = meta('m1', { time: '09:00', edited: false });
    expect(meta('m1', { time: '09:00', edited: false })).toBe(first);
    const edited = meta('m1', { time: '09:00', edited: true });
    expect(edited).not.toBe(first);
    expect(meta('m1', { time: '09:00', edited: true })).toBe(edited);
    expect(meta('m2', { time: '09:00', edited: true })).not.toBe(edited);
    const rail = createStableCache<{ role: string } | undefined>();
    expect(rail('m1', undefined)).toBeUndefined();
  });

  it('one callback per id, calling through to the latest handler', () => {
    let handler = vi.fn();
    const forId = createIdCallbacks((id) => handler(id));
    const a = forId('a');
    expect(forId('a')).toBe(a);
    expect(forId('b')).not.toBe(a);
    a();
    expect(handler).toHaveBeenCalledWith('a');
    handler = vi.fn();
    a();
    expect(handler).toHaveBeenCalledWith('a');
  });
});
