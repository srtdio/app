import { expect, test, type Locator, type Page } from '@playwright/test';
import { installHarnessNetwork, type HarnessNetwork } from '../fixtures/harness-routes';
import {
  DM_CHANNEL,
  PEER,
  PLAN_CONCEPT_COMMENT_ID,
  PLAN_CONCEPT_ITEM,
  PLAN_ID,
  seedClientPlan,
} from '../fixtures/chat-data';

// A plan item's comments are a chat thread (Spec C, 8 Nov 2026): chat's own
// bubble (MessageBubble), chat's swipe core (right = Reply focuses the box;
// left rubber-bands, plan comments have no delete), chat's long-press menu
// (Reply, Copy link, Copy text, Reply privately; no reactions), and the
// laptop right-click opens the same menu. The real app tree runs against
// fixture data; Linux WebKit approximates iOS WebKit, it is not iOS.

const isPhone = (page: Page): boolean => (page.viewportSize()?.width ?? 0) < 768;

const itemPage = (page: Page): Locator => page.locator('[data-plan-page="item"]');
const row = (page: Page): Locator =>
  itemPage(page).locator(`[data-plan-comment-id="${PLAN_CONCEPT_COMMENT_ID}"]`);
const menu = (page: Page): Locator => page.getByRole('menu', { name: 'Message actions' });

async function openItem(page: Page): Promise<HarnessNetwork> {
  const network = await installHarnessNetwork(page);
  // The peer wrote the seeded comment: someone else's row.
  seedClientPlan(network.world, { channelId: DM_CHANNEL, sender: PEER, fileVersionId: PLAN_ID });
  await page.goto(`/plans/${PLAN_ID}?item=${PLAN_CONCEPT_ITEM}`);
  await expect(row(page)).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(300);
  return network;
}

/** A finger drags the row by dx px (left when negative) and lets go, on touch. */
async function swipeRow(target: Locator, dx: number): Promise<void> {
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (box === null) throw new Error('row has no box');
  const y = box.y + Math.min(box.height / 2, 24);
  const x0 = box.x + box.width / 2;
  const touch = { pointerType: 'touch', pointerId: 7, isPrimary: true, clientY: y };
  // Park the cursor off the row: a cursor over it drags the swipe back.
  await target.page().mouse.move(1, 1);
  await target.dispatchEvent('pointerdown', { ...touch, clientX: x0 });
  const steps = 8;
  for (let i = 1; i <= steps; i += 1) {
    await target.dispatchEvent('pointermove', { ...touch, clientX: x0 + (dx * i) / steps });
  }
  await target.dispatchEvent('pointerup', { ...touch, clientX: x0 + dx });
}

/** Hold the bubble like a finger: pointerdown, 700ms still, pointerup. */
async function hold(page: Page, target: Locator): Promise<void> {
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (box === null) throw new Error('no box');
  const at = {
    clientX: box.x + box.width / 2,
    clientY: box.y + Math.min(box.height / 2, 20),
    pointerType: 'touch',
    isPrimary: true,
    pointerId: 7,
  };
  await target.dispatchEvent('pointerdown', at);
  await page.waitForTimeout(700);
  await target.dispatchEvent('pointerup', at);
}

test('a plan comment is a chat row: swipe right replies, left rubber-bands @theme', async ({
  page,
}) => {
  test.skip(!isPhone(page), 'touch swipe: phone only');
  const network = await openItem(page);
  const r = row(page);
  // Chat's own row: the bubble and the sender line, everyone on the left.
  await expect(r).toHaveAttribute('data-msg-id', PLAN_CONCEPT_COMMENT_ID);
  await expect(r.locator('[data-bubble]')).toContainText('Can we keep it under 30 seconds?');
  await expect(r.locator('[data-sender-name]')).toBeVisible();
  expect(await r.evaluate((el) => getComputedStyle(el).touchAction)).toContain('pan-y');

  // Left: plan comments cannot be deleted, so the row only rubber-bands.
  await swipeRow(r, -120);
  await expect(r).toBeVisible();
  await expect(menu(page)).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // Right: Reply focuses the comment box (a plan item is itself a thread).
  await swipeRow(r, 120);
  await expect(itemPage(page).getByRole('textbox', { name: 'Comment' })).toBeFocused();
  expect(network.blocked, 'blocked non-fixture requests').toEqual([]);
});

test("a long-press opens chat's menu with the rows a plan comment has @theme", async ({ page }) => {
  test.skip(!isPhone(page), 'long-press: phone only');
  const network = await openItem(page);
  await hold(page, row(page).locator('[data-bubble]'));
  const m = menu(page);
  await expect(m).toBeVisible();
  await expect(m.locator('[data-menu-item="reply"]')).toBeVisible();
  await expect(m.locator('[data-menu-item="copy-link"]')).toBeVisible();
  await expect(m.locator('[data-menu-item="copy"]')).toBeVisible();
  // No reactions, Forward, Tasks, Mark unread, Edit or Delete on a plan comment.
  for (const key of ['forward', 'add-task', 'mark-unread', 'edit', 'delete']) {
    await expect(m.locator(`[data-menu-item="${key}"]`)).toHaveCount(0);
  }
  await expect(m.getByRole('button', { name: 'More reactions' })).toHaveCount(0);
  // Reply: the box takes focus and the menu closes.
  await m.locator('[data-menu-item="reply"]').click();
  await expect(m).toHaveCount(0);
  await expect(itemPage(page).getByRole('textbox', { name: 'Comment' })).toBeFocused();
  expect(network.blocked, 'blocked non-fixture requests').toEqual([]);
});

test('laptop: right-click opens the same menu @desktop', async ({ page }) => {
  test.skip(isPhone(page), 'laptop only');
  const network = await openItem(page);
  await row(page).locator('[data-bubble]').click({ button: 'right' });
  const m = menu(page);
  await expect(m).toBeVisible();
  await expect(m.locator('[data-menu-item="reply"]')).toBeVisible();
  await expect(m.locator('[data-menu-item="copy"]')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(m).toHaveCount(0);
  expect(network.blocked, 'blocked non-fixture requests').toEqual([]);
});
