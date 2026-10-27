import { expect, test, type Page } from '@playwright/test';
import { installHarnessNetwork, type HarnessNetwork } from '../fixtures/harness-routes';
import { expectMinTouchTarget } from '../helpers/touch-target';

// The operator's Cockpit: a health dot left of Activity in the top bar, and
// the live panel (laptop: a side panel beside the page; phone: a bottom sheet).
// A normal user gets nothing: no dot, no cockpit chunk, no ops-cockpit request.
// Runs on iPhone (dark, and light via @theme) and on the 1280 laptop (@desktop).

const isLaptop = (page: Page): boolean => (page.viewportSize()?.width ?? 0) >= 768;

function expectClean(network: HarnessNetwork): void {
  expect(network.blocked, 'blocked non-fixture requests').toEqual([]);
  expect([...new Set(network.unmatched)], 'unrecognised fixture requests').toEqual([]);
}

/** Every request for a cockpit module or chunk (dev serves modules by path). */
function watchCockpitChunks(page: Page): string[] {
  const seen: string[] = [];
  page.on('request', (request) => {
    const url = request.url();
    if (/\/(components|lib)\/cockpit\/|\/Cockpit[-.][\w-]*\.js/.test(url)) seen.push(url);
  });
  return seen;
}

const activity = (page: Page) => page.locator('[data-notifications-button]');
const dot = (page: Page) => page.locator('[data-cockpit-dot]');

test('a normal user: no dot, no cockpit chunk, no ops-cockpit request @theme @desktop', async ({
  page,
}) => {
  const network = await installHarnessNetwork(page);
  const chunks = watchCockpitChunks(page);
  await page.goto('/pipeline');
  await expect(activity(page)).toBeVisible({ timeout: 15_000 });
  // Past the idle window the status poll would have used.
  await page.waitForTimeout(3_000);
  await expect(dot(page)).toHaveCount(0);
  expect(chunks).toEqual([]);
  expect(network.cockpitCalls).toEqual([]);
  // Chat still opens.
  await page.goto('/chat');
  await expect(page.getByRole('searchbox', { name: 'Search chats' })).toBeVisible();
  await expect(dot(page)).toHaveCount(0);
  expect(chunks).toEqual([]);
  expectClean(network);
});

test('the operator: dot left of Activity, grey then coloured by the idle status poll @theme @desktop', async ({
  page,
}) => {
  const network = await installHarnessNetwork(page, { operator: true, cockpitLevel: 'red' });
  await page.goto('/pipeline');
  await expect(dot(page)).toBeVisible({ timeout: 15_000 });
  expectMinTouchTarget(await dot(page).boundingBox());
  const dotBox = await dot(page).boundingBox();
  const activityBox = await activity(page).boundingBox();
  expect((dotBox?.x ?? 0) < (activityBox?.x ?? 0)).toBe(true);
  await expect(dot(page)).toHaveAttribute('data-cockpit-dot', 'red', { timeout: 10_000 });
  await expect(dot(page)).toHaveAttribute('aria-label', 'Cockpit: needs you');
  expect(network.cockpitCalls[0]).toBe('?mode=status');
  expectClean(network);
});

test('the operator opens the panel, walks every tab, and closes it @theme @desktop', async ({
  page,
}) => {
  const network = await installHarnessNetwork(page, { operator: true, cockpitLevel: 'red' });
  await page.goto('/pipeline');
  await expect(dot(page)).toBeVisible({ timeout: 15_000 });
  const mainBefore = await page.locator('main').boundingBox();
  await dot(page).click();

  const surface = isLaptop(page)
    ? page.locator('aside[aria-label="Cockpit"]')
    : page.getByRole('dialog', { name: 'Cockpit' });
  await expect(surface).toBeVisible();
  await expect(surface).toContainText('Live');
  await expect(surface.locator('[data-cockpit-stamp]')).toHaveText(/^\d{2}:\d{2}:\d{2}$/);
  await expect(surface).toContainText('invite-send is failing');
  expect(network.cockpitCalls).toContain('?mode=full&tab=needs&open=1');

  if (isLaptop(page)) {
    // Beside the page: the page shrinks and stays usable, nothing dims.
    const mainAfter = await page.locator('main').boundingBox();
    expect((mainAfter?.width ?? 0) < (mainBefore?.width ?? 0)).toBe(true);
    await expect(page.locator('.bg-scrim')).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Open post Monday carousel' }).first(),
    ).toBeVisible();
  }

  const tabs = surface.getByRole('tab');
  await expect(tabs).toHaveText([
    'Needs you',
    'Users',
    'Errors',
    'Logs',
    'Email',
    'Chat',
    'Traffic',
  ]);
  for (const [tab, text] of [
    ['Users', 'Daily users'],
    ['Errors', 'PipelinePage · 12 times'],
    ['Logs', 'invite-send'],
    ['Email', 'p***@example.com'],
    ['Chat', 'Open Agora console'],
    ['Traffic', 'Home to sign-up'],
  ] as const) {
    await surface.getByRole('tab', { name: tab }).click();
    await expect(surface.getByRole('tabpanel')).toContainText(text);
  }
  // Logs: the search field takes the cursor on tap; a pasted trace narrows to it.
  await surface.getByRole('tab', { name: 'Logs' }).click();
  const search = surface.getByRole('searchbox', { name: 'Search logs' });
  await search.click();
  await expect(search).toBeFocused();
  await search.fill('0190a000-0000-7000-8000-00000000aaaa');
  await expect(surface.getByRole('tabpanel')).toContainText('resend 429');
  await expect(surface.getByRole('tabpanel')).not.toContainText('GET /rest/v1/posts');
  // Email never shows a full address.
  await surface.getByRole('tab', { name: 'Email' }).click();
  await expect(surface).toContainText('p***@example.com');
  await expect(surface).not.toContainText(/\w{2}@example\.com/);

  if (isLaptop(page)) {
    await page.keyboard.press('Escape');
    await expect(surface).toHaveCount(0);
    await expect(dot(page)).toBeFocused();
  } else {
    await surface.getByRole('button', { name: 'Close' }).click();
    await expect(surface).toHaveCount(0);
  }
  // Reopening returns to the last tab.
  await dot(page).click();
  await expect(
    (isLaptop(page)
      ? page.locator('aside[aria-label="Cockpit"]')
      : page.getByRole('dialog', { name: 'Cockpit' })
    ).getByRole('tab', { name: 'Email' }),
  ).toHaveAttribute('aria-selected', 'true');
  expectClean(network);
});

test('the operator: chat still opens instantly with the dot on @desktop', async ({ page }) => {
  const network = await installHarnessNetwork(page, { operator: true });
  await page.goto('/chat');
  await expect(page.getByRole('searchbox', { name: 'Search chats' })).toBeVisible({
    timeout: 15_000,
  });
  await expect(dot(page)).toBeVisible();
  expectClean(network);
});
