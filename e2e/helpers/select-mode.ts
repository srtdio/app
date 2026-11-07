import type { Locator, Page } from '@playwright/test';

// List select mode (ui/ListCard `select`, ui/SelectBar): a long-press on touch
// (LONG_PRESS_MS, 450) or a right-click with a mouse enters it with the card
// ticked; inside it a tap toggles. The bar renders data-select-bar (Bank adds
// data-bank-select-bar), data-select-bar-cancel, data-select-bar-count and one
// data-select-bar-action="<id>" button per action.

/** Long enough for any long-press (LONG_PRESS_MS is 450) on touch. */
export const HOLD_MS = 900;

/** Laptop layout (useIsLaptop's breakpoint). */
export const isLaptopPage = (page: Page): boolean => (page.viewportSize()?.width ?? 0) >= 768;

/**
 * Hold a card (touch) or right-click it (mouse): the select gesture. The touch
 * hold dispatches pointerdown, waits past the threshold, then pointerup on the
 * card root ([data-list-card]), where ListCard wires the gesture.
 */
export async function selectGesture(page: Page, card: Locator): Promise<void> {
  await card.scrollIntoViewIfNeeded();
  if (isLaptopPage(page)) {
    await card.click({ button: 'right' });
    return;
  }
  const box = await card.boundingBox();
  if (box === null) throw new Error('select target has no box');
  const at = { clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 };
  const touch = { ...at, pointerType: 'touch', isPrimary: true, pointerId: 31 };
  await card.dispatchEvent('pointerdown', touch);
  await page.waitForTimeout(HOLD_MS);
  await card.dispatchEvent('pointerup', touch);
  // The real finger lift trails a click; ListCard swallows it (consumeClickSuppression).
  await card.dispatchEvent('click');
}

/** The list's select bar (ui/SelectBar). */
export const selectBar = (page: Page): Locator => page.locator('[data-select-bar]');

/** One select bar action by its id (data-select-bar-action). */
export const selectBarAction = (page: Page, id: string): Locator =>
  selectBar(page).locator(`[data-select-bar-action="${id}"]`);
