import { expect, test, type Locator, type Page } from '@playwright/test';
import { installHarnessNetwork } from '../fixtures/harness-routes';
import { POST_IDS } from '../fixtures/chat-data';

// Pop-ups (12 Nov 2026): one ui/toast card at a time, its top edge 12 under
// the 56 top bar (safe area added), never over the bar: on phone the back "<"
// and the bar title stay free; on laptop sort, "+" and the avatar stay free.
// The card comes from the post's Copy link (Link copied, or the copy error:
// either is a top card).

const POST = POST_IDS[0] ?? '';
const GAP = 12;

type Box = { x: number; y: number; width: number; height: number };

function intersects(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

async function box(el: Locator): Promise<Box> {
  const b = await el.boundingBox();
  if (b === null) throw new Error('no box');
  return b;
}

async function openPost(page: Page): Promise<void> {
  await installHarnessNetwork(page);
  await page.goto(`/posts/${POST}`);
  await expect(page.getByRole('heading', { name: 'Monday carousel', level: 1 })).toBeVisible({
    timeout: 15_000,
  });
}

/** Copy link from the post's ⋯ menu: one top card shows. */
async function popCard(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'More actions', exact: true }).first().click();
  await page
    .getByRole('menuitem', { name: /Copy link/ })
    .first()
    .click();
  const slot = page.locator('[data-toast-slot]');
  await expect(slot).toHaveCount(1);
  // Let the drop-in settle so the box is the resting one.
  await page.waitForTimeout(500);
  return slot;
}

async function expectUnderBar(card: Locator, bar: Locator): Promise<void> {
  const c = await box(card);
  const b = await box(bar);
  expect(c.y).toBeGreaterThanOrEqual(b.y + b.height + GAP - 1);
}

test('phone: one pop-up at a time, 12 under the bar, back key and title free', async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 0) >= 768, 'phone only');
  await openPost(page);
  const back = page.getByRole('button', { name: 'Back', exact: true }).first();
  await expect(back).toBeVisible();
  const bar = back.locator('xpath=ancestor::header[1]');

  for (let i = 0; i < 3; i += 1) {
    const card = await popCard(page);
    await expect(page.locator('[data-toast-slot]')).toHaveCount(1);
    await expectUnderBar(card, bar);
    const c = await box(card);
    expect(intersects(c, await box(back))).toBe(false);
    expect(intersects(c, await box(bar))).toBe(false);
  }
});

test('laptop: one pop-up at a time, 12 under the bar; sort, "+" and avatar free @desktop', async ({
  page,
}) => {
  test.skip((page.viewportSize()?.width ?? 0) < 768, 'laptop only');
  await openPost(page);
  const bar = page
    .locator('header')
    .filter({ has: page.locator('[data-topbar-slot]') })
    .first();
  await expect(bar).toBeVisible();
  const keys = [
    page.locator('[data-topbar-slot="sort"]').first(),
    page.locator('[data-topbar-slot="primary"]').first(),
    page.getByRole('button', { name: 'Account menu', exact: true }).first(),
  ];

  for (let i = 0; i < 3; i += 1) {
    const card = await popCard(page);
    await expect(page.locator('[data-toast-slot]')).toHaveCount(1);
    await expectUnderBar(card, bar);
    const c = await box(card);
    for (const key of keys) expect(intersects(c, await box(key))).toBe(false);
  }
});
