import type { Locator, Page } from '@playwright/test';

/** The bottom Undo strip (UndoStrip), optionally the one whose label has `text`. */
export function undoStrip(page: Page, text?: string | RegExp): Locator {
  const strip = page.locator('[data-undo-strip]:not([data-leaving])');
  return text === undefined ? strip : strip.filter({ hasText: text });
}

/**
 * Swipe the strip down past its accept threshold (40% of its height): the
 * strip accepts, so the pending action commits now. Starts on the label (a
 * press on the Undo button never starts a drag) and stays inside the viewport.
 */
export async function swipeStripDown(page: Page, strip: Locator, share = 0.7): Promise<void> {
  const box = await strip.boundingBox();
  if (box === null) throw new Error('swipeStripDown: strip has no bounding box');
  const x = box.x + Math.min(24, box.width / 4);
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + box.height * share, { steps: 6 });
  await page.mouse.up();
}
