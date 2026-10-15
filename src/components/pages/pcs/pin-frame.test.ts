import { describe, expect, it } from 'vitest';
import {
  coverWindow,
  cutPercent,
  frameToOriginal,
  FULL_WINDOW,
  originalToFrame,
} from '@/components/pages/pcs/pin-annotations';
import { cropFor } from '@/components/preview/preview-math';

describe('coverWindow', () => {
  it('matches the preview panel Shown window', () => {
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
  it('shows the whole image while the size is unknown', () => {
    expect(coverWindow(null, 0.8)).toEqual(FULL_WINDOW);
    expect(coverWindow({ w: 0, h: 10 }, 0.8)).toEqual(FULL_WINDOW);
  });
  it('reports the cut share', () => {
    expect(cutPercent(coverWindow({ w: 1920, h: 1080 }, 1))).toBe(44);
    expect(cutPercent(FULL_WINDOW)).toBe(0);
  });
});

describe('pin mapping', () => {
  const win = coverWindow({ w: 1920, h: 1080 }, 9 / 16); // keeps the centre 31.6% of the width
  it('a pin inside the window shows exactly where it was placed', () => {
    const at = originalToFrame({ x: 0.5, y: 0.25 }, win);
    expect(at.edge).toBeNull();
    expect(at.x).toBeCloseTo(0.5);
    expect(at.y).toBeCloseTo(0.25);
  });
  it('a pin outside the window becomes an edge marker on the nearest edge', () => {
    expect(originalToFrame({ x: 0.05, y: 0.5 }, win)).toEqual({ x: 0, y: 0.5, edge: 'left' });
    expect(originalToFrame({ x: 0.95, y: 0.1 }, win)).toMatchObject({ x: 1, edge: 'right' });
    const tall = coverWindow({ w: 1080, h: 1920 }, 0.8);
    expect(originalToFrame({ x: 0.5, y: 0.02 }, tall)).toMatchObject({ y: 0, edge: 'top' });
    expect(originalToFrame({ x: 0.5, y: 0.99 }, tall)).toMatchObject({ y: 1, edge: 'bottom' });
  });
  it('round-trips place -> store -> display exactly', () => {
    for (const w of [win, coverWindow({ w: 1080, h: 1920 }, 0.8), FULL_WINDOW]) {
      for (const tap of [
        { x: 0, y: 0 },
        { x: 0.3, y: 0.7 },
        { x: 1, y: 1 },
        { x: 0.5, y: 0.5 },
      ]) {
        const stored = frameToOriginal(tap, w);
        expect(stored.x).toBeGreaterThanOrEqual(0);
        expect(stored.x).toBeLessThanOrEqual(1);
        const shown = originalToFrame(stored, w);
        expect(shown.edge).toBeNull();
        expect(shown.x).toBeCloseTo(tap.x, 12);
        expect(shown.y).toBeCloseTo(tap.y, 12);
      }
    }
  });
  it('a pin placed on the old uncropped gallery keeps its spot on the image', () => {
    // Stored relative to the original; on the frame it lands on the same image point.
    const stored = { x: 0.5, y: 0.4 };
    const tall = coverWindow({ w: 1080, h: 1920 }, 0.8);
    const shown = originalToFrame(stored, tall);
    expect(frameToOriginal(shown, tall).y).toBeCloseTo(0.4);
  });
});
