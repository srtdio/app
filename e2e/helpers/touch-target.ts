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
 * Asserts every visible button inside `scope` (a Page or a Locator) has a hit
 * area of at least 44x44. The hit area is the button's box grown by any
 * absolutely positioned ::before / ::after expander (the `before:-inset-3`
 * pattern), since taps on those land on the button. Buttons that are not laid
 * out (null or zero-size box) are skipped, as are buttons matching `exclude`.
 * A failure names the button.
 */
export async function expectAllVisibleControlsTouchSized(
  scope: Page | Locator,
  opts?: { min?: number; exclude?: string },
): Promise<number> {
  const min = opts?.min ?? 44;
  const selector = opts?.exclude ? `button:visible:not(${opts.exclude})` : 'button:visible';
  const buttons = await scope.locator(selector).all();
  let checked = 0;
  for (const button of buttons) {
    const hit = await button.evaluate((el) => {
      const r = el.getBoundingClientRect();
      let { left, top, right, bottom } = r;
      for (const pseudo of ['::before', '::after']) {
        const cs = getComputedStyle(el, pseudo);
        if (cs.content === 'none' || cs.position !== 'absolute') continue;
        const px = (v: string): number => (v.endsWith('px') ? parseFloat(v) : 0);
        left = Math.min(left, r.left + px(cs.left));
        top = Math.min(top, r.top + px(cs.top));
        right = Math.max(right, r.right - px(cs.right));
        bottom = Math.max(bottom, r.bottom - px(cs.bottom));
      }
      const name = el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 40) ?? '';
      return { width: right - left, height: bottom - top, raw: r.width * r.height, name };
    });
    if (hit.raw === 0) continue;
    expect(hit.width, `touch target width: "${hit.name}"`).toBeGreaterThanOrEqual(
      min - SUBPIXEL_TOLERANCE,
    );
    expect(hit.height, `touch target height: "${hit.name}"`).toBeGreaterThanOrEqual(
      min - SUBPIXEL_TOLERANCE,
    );
    checked += 1;
  }
  return checked;
}
