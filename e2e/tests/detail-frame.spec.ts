import { expect, test, type Page } from '@playwright/test';
import { installHarnessNetwork } from '../fixtures/harness-routes';
import { POST_IDS } from '../fixtures/chat-data';
import { AUDIT_BRIEF_ID, seedAudit } from '../fixtures/audit-pr-b';
import { expectMinTouchTarget } from '../helpers/touch-target';

// PR B screen frames: on a phone, Post detail and Brief detail drop the shell's
// Topbar and BottomTabs, as a chat thread does; the page's own back arrow sits
// top-left. A list page keeps both. iPhone viewport, dark (the default project).

const POST = POST_IDS[0] ?? '';

/** The phone tab bar: the visible shell nav holding the Pipeline tab (the sidebar is md+). */
const bottomTabs = (page: Page) =>
  page.locator('nav:visible').filter({ has: page.locator('a[href="/pipeline"]') });

/** The Topbar's workspace switch (phone). */
const topbarSwitch = (page: Page) => page.getByRole('button', { name: 'Switch workspace' }).first();

async function expectBackTopLeft(page: Page): Promise<void> {
  const back = page.getByRole('button', { name: 'Back', exact: true }).first();
  await expect(back).toBeVisible();
  const box = await back.boundingBox();
  expectMinTouchTarget(box);
  if (box === null) throw new Error('back has no box');
  expect(box.x).toBeLessThan(24);
  expect(box.y).toBeLessThan(80);
}

test('Pipeline keeps the Topbar and the bottom tabs', async ({ page }) => {
  const network = await installHarnessNetwork(page);
  await page.goto('/pipeline');
  await expect(page.getByRole('button', { name: 'Open post Monday carousel' })).toBeVisible({
    timeout: 15_000,
  });
  await expect(bottomTabs(page)).toBeVisible();
  await expect(topbarSwitch(page)).toBeVisible();
  expect(network.blocked).toEqual([]);
});

test('Post detail on a phone has no Topbar and no bottom tabs; Back is top-left', async ({
  page,
}) => {
  const network = await installHarnessNetwork(page);
  await page.goto(`/posts/${POST}`);
  await expect(page.getByRole('heading', { name: 'Monday carousel', level: 1 })).toBeVisible({
    timeout: 15_000,
  });
  await expect(bottomTabs(page)).toHaveCount(0);
  await expect(topbarSwitch(page)).toBeHidden();
  await expectBackTopLeft(page);
  expect(network.blocked).toEqual([]);
});

test('Brief detail on a phone has no Topbar and no bottom tabs; Back is top-left', async ({
  page,
}) => {
  const network = await installHarnessNetwork(page);
  seedAudit(network, { role: 'creator' });
  await page.goto(`/briefs/${AUDIT_BRIEF_ID}`);
  await expect(page.getByRole('heading', { name: 'Autumn range launch', level: 1 })).toBeVisible({
    timeout: 15_000,
  });
  await expect(bottomTabs(page)).toHaveCount(0);
  await expect(topbarSwitch(page)).toBeHidden();
  await expectBackTopLeft(page);
  expect(network.blocked).toEqual([]);
});
