import { describe, expect, it } from 'vitest';
import {
  containBox,
  coverWindow,
  cutPercent,
  frameMap,
  frameToOriginal,
  FULL_WINDOW,
  IDENTITY_MAP,
  originalToFrame,
} from '@/components/pages/pcs/pin-annotations';
import { cropFor } from '@/components/preview/preview-math';

describe('coverWindow / containBox', () => {
  it('cover matches the preview panel Shown window', () => {
    const size = { label: 'x', w: 1080, h: 1350, layout: 'feed' as const };
    for (const original of [
      { w: 1920, h: 1080 },
      { w: 1080, h: 1920 },
      { w: 1080, h: 1350 },
    ]) {
      const win = coverWindow(original, 1080 / 1350);
      const ref = cropFor(original, size).window;
      expect(win.x).toBeCloseTo(ref.x);
      expect(win.y).toBeCloseTo(ref.y);
      expect(win.w).toBeCloseTo(ref.w);
      expect(win.h).toBeCloseTo(ref.h);
    }
  });
  it('contain centres the media with bands on the short sides', () => {
    const wideInTall = containBox({ w: 1920, h: 1080 }, 9 / 16);
    expect(wideInTall.w).toBe(1);
    expect(wideInTall.h).toBeCloseTo(0.31640625);
    expect(wideInTall.y).toBeCloseTo((1 - 0.31640625) / 2);
    const tallInWide = containBox({ w: 1000, h: 3000 }, 9 / 16);
    expect(tallInWide.h).toBe(1);
    expect(tallInWide.w).toBeCloseTo(1 / 3 / (9 / 16));
  });
  it('unknown size shows the whole image; bands cut nothing', () => {
    expect(coverWindow(null, 0.8)).toEqual(FULL_WINDOW);
    expect(containBox({ w: 0, h: 10 }, 0.8)).toEqual(FULL_WINDOW);
    expect(cutPercent(frameMap({ w: 1920, h: 1080 }, 9 / 16, 'contain'))).toBe(0);
    expect(cutPercent(frameMap({ w: 1920, h: 1080 }, 1, 'cover'))).toBe(44);
    expect(cutPercent(IDENTITY_MAP)).toBe(0);
  });
});

describe('pin mapping through a crop', () => {
  const map = frameMap({ w: 1920, h: 1080 }, 9 / 16, 'cover');
  it('a pin inside the shown part lands exactly where it was placed', () => {
    const at = originalToFrame({ x: 0.5, y: 0.25 }, map);
    expect(at.edge).toBeNull();
    expect(at.x).toBeCloseTo(0.5);
    expect(at.y).toBeCloseTo(0.25);
  });
  it('a pin cut off by the crop becomes an edge marker on the nearest edge', () => {
    expect(originalToFrame({ x: 0.05, y: 0.5 }, map)).toEqual({ x: 0, y: 0.5, edge: 'left' });
    expect(originalToFrame({ x: 0.95, y: 0.1 }, map)).toMatchObject({ x: 1, edge: 'right' });
    const tall = frameMap({ w: 1080, h: 1920 }, 0.8, 'cover');
    expect(originalToFrame({ x: 0.5, y: 0.02 }, tall)).toMatchObject({ y: 0, edge: 'top' });
    expect(originalToFrame({ x: 0.5, y: 0.99 }, tall)).toMatchObject({ y: 1, edge: 'bottom' });
  });
});

describe('pin mapping through a fit with bands', () => {
  const map = frameMap({ w: 1920, h: 1080 }, 9 / 16, 'contain');
  it('every stored pin is on the media, inside the bands, never an edge marker', () => {
    for (const p of [
      { x: 0, y: 0 },
      { x: 0.04, y: 0.3 },
      { x: 1, y: 1 },
    ]) {
      const at = originalToFrame(p, map);
      expect(at.edge).toBeNull();
      expect(at.y).toBeGreaterThanOrEqual(map.box.y - 1e-9);
      expect(at.y).toBeLessThanOrEqual(map.box.y + map.box.h + 1e-9);
    }
    expect(originalToFrame({ x: 0.5, y: 0.5 }, map)).toMatchObject({ x: 0.5, y: 0.5 });
    expect(originalToFrame({ x: 0.5, y: 0 }, map).y).toBeCloseTo(map.box.y);
  });
  it('a tap on a band places nothing', () => {
    expect(frameToOriginal({ x: 0.5, y: 0.05 }, map)).toBeNull();
    expect(frameToOriginal({ x: 0.5, y: 0.95 }, map)).toBeNull();
  });
});

describe('round-trip place -> store -> display', () => {
  const maps = [
    frameMap({ w: 1920, h: 1080 }, 9 / 16, 'cover'),
    frameMap({ w: 1080, h: 1920 }, 0.8, 'cover'),
    frameMap({ w: 1920, h: 1080 }, 9 / 16, 'contain'),
    frameMap({ w: 1000, h: 3000 }, 9 / 16, 'contain'),
    IDENTITY_MAP,
  ];
  it('a tap on the media is stored relative to the original and shown on the same spot', () => {
    for (const map of maps) {
      for (const u of [0, 0.3, 0.5, 1]) {
        for (const v of [0, 0.7, 1]) {
          const tap = { x: map.box.x + u * map.box.w, y: map.box.y + v * map.box.h };
          const stored = frameToOriginal(tap, map);
          expect(stored).not.toBeNull();
          if (stored === null) continue;
          expect(stored.x).toBeGreaterThanOrEqual(0);
          expect(stored.x).toBeLessThanOrEqual(1);
          const shown = originalToFrame(stored, map);
          expect(shown.edge).toBeNull();
          expect(shown.x).toBeCloseTo(tap.x, 12);
          expect(shown.y).toBeCloseTo(tap.y, 12);
        }
      }
    }
  });
  it('a pin stored on the original keeps its image spot through crop and bands', () => {
    const stored = { x: 0.3, y: 0.4 };
    for (const map of maps) {
      const shown = originalToFrame(stored, map);
      if (shown.edge !== null) continue;
      const back = frameToOriginal(shown, map);
      expect(back?.x).toBeCloseTo(0.3, 12);
      expect(back?.y).toBeCloseTo(0.4, 12);
    }
  });
});
