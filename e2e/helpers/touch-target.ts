import { expect, type Locator, type Page } from '@playwright/test';

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

/**
 * Asserts every visible button inside `scope` (a Page or a Locator) is at least
 * 44x44. Buttons that are not laid out (null or zero-size box) are skipped, so a
 * hidden-but-visible-per-Playwright edge case cannot fail the run.
 */
export async function expectAllVisibleControlsTouchSized(
  scope: Page | Locator,
  opts?: { min?: number },
): Promise<number> {
  const buttons = await scope.locator('button:visible').all();
  let checked = 0;
  for (const button of buttons) {
    const box = await button.boundingBox();
    if (box === null || box.width === 0 || box.height === 0) continue;
    expectMinTouchTarget(box, opts);
    checked += 1;
  }
  return checked;
}
