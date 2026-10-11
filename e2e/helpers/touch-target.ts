import { expect } from '@playwright/test';

type Box = { width: number; height: number };
type Dimension = keyof Box;

/** WebKit reports sub-pixel layout sizes (43.99998 for a 44px box). */
const SUBPIXEL_TOLERANCE = 0.01;

/**
 * Asserts a touch target is at least `min` px (default 44) on both sides, or on
 * only `dimension` when given. A null box (element not laid out) fails loudly.
 */
export function expectMinTouchTarget(box: Box | null, opts?: { min?: number }): void;
export function expectMinTouchTarget<D extends Dimension>(
  box: Pick<Box, D> | null,
  opts: { min?: number; dimension: D },
): void;
export function expectMinTouchTarget(
  box: Partial<Box> | null,
  { min = 44, dimension }: { min?: number; dimension?: Dimension } = {},
): void {
  if (box === null) throw new Error('expectMinTouchTarget: element has no bounding box');
  const dims: readonly Dimension[] = dimension === undefined ? ['width', 'height'] : [dimension];
  for (const dim of dims) {
    const value = box[dim];
    if (value === undefined) throw new Error(`expectMinTouchTarget: box has no ${dim}`);
    expect(value, `touch target ${dim}`).toBeGreaterThanOrEqual(min - SUBPIXEL_TOLERANCE);
  }
}
