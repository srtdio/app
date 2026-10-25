import { expect, test, type Page, type Request } from '@playwright/test';
import { installHarnessNetwork } from '../fixtures/harness-routes';
import { GROUP_NAME, PEER_NAME } from '../fixtures/chat-data';

// Message search (UI-4): the chat home's Messages results, a hit opening its
// chat at the message with the in-chat bar, the bar's arrows, and Clear
// restoring the list. Linux WebKit approximates iOS WebKit; it is not iOS.

const QUERY = 'palet';
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function searchCalls(page: Page): Array<Record<string, unknown>> {
  const calls: Array<Record<string, unknown>> = [];
  page.on('request', (request: Request) => {
    if (!request.url().includes('/rest/v1/rpc/chat_message_search')) return;
    calls.push((request.postDataJSON() ?? {}) as Record<string, unknown>);
  });
  return calls;
}

async function tileNames(page: Page): Promise<string[]> {
  return page
    .locator('[data-chat-home] button[aria-label^="Open "]')
    .evaluateAll((els) => els.map((el) => el.getAttribute('aria-label') ?? ''));
}

async function runSearchFlow(page: Page): Promise<void> {
  await installHarnessNetwork(page);
  const calls = searchCalls(page);
  await page.goto('/chat');
  await page.getByText(GROUP_NAME, { exact: true }).first().waitFor({ state: 'visible' });
  const before = await tileNames(page);
  expect(before.length).toBeGreaterThan(1);

  const box = page.getByRole('searchbox', { name: 'Search chats' });
  await box.fill(QUERY);
  // The old list is gone in the same frame the results come in.
  await expect(page.locator('[data-search-results]')).toBeVisible();
  await expect(page.locator('[data-chat-home]')).toHaveCount(0);
  const firstHit = page.locator('[data-search-hit]').first();
  await expect(firstHit).toBeVisible();
  await expect(firstHit.locator('b[data-search-match]').first()).toHaveText(/^palette$/i);
  // Long-press never selects text or raises the iOS callout.
  const touch = await firstHit.evaluate((el) => {
    const style = getComputedStyle(el) as CSSStyleDeclaration & { webkitTouchCallout?: string };
    return { callout: style.webkitTouchCallout ?? 'none', select: style.webkitUserSelect };
  });
  expect(touch.callout).toBe('none');
  expect(touch.select).toBe('none');

  // One RPC per page, named args, a uuid_v7 trace id.
  expect(calls.length).toBeGreaterThanOrEqual(1);
  const last = calls[calls.length - 1] ?? {};
  expect(last.p_query).toBe(QUERY);
  expect(typeof last.p_workspace_id).toBe('string');
  expect(String(last.p_trace_id)).toMatch(UUID_V7);
  for (const key of Object.keys(last)) expect(key.startsWith('p_')).toBe(true);

  // Clear restores the list exactly as before.
  await page.getByRole('button', { name: 'Clear search' }).click();
  await expect(page.locator('[data-search-results]')).toHaveCount(0);
  expect(await tileNames(page)).toEqual(before);

  // A hit opens its chat at the message with the bar on "1 of N".
  await box.fill(QUERY);
  await expect(firstHit).toBeVisible();
  await firstHit.click();
  // The arrival tint is a 2s glow on the row: check it first, before the slower bar checks.
  await expect(page.locator('[data-msg-id][data-jump-glow]').first()).toBeVisible();
  const bar = page.locator('[data-chat-search-bar]');
  await expect(bar).toBeVisible();
  await expect(bar.locator('input')).toHaveValue(QUERY);
  const counter = bar.locator('[data-search-counter]');
  await expect(counter).toHaveText(/^1 of \d+\+?$/);
  await expect(page.locator('[data-msg-id] mark[data-search-mark]').first()).toBeVisible();

  // Up is the older match, down the newer one.
  const total = Number(/of (\d+)/.exec((await counter.textContent()) ?? '')?.[1] ?? '0');
  expect(total).toBeGreaterThan(1);
  await bar.getByRole('button', { name: 'Older match' }).click();
  await expect(counter).toHaveText(/^2 of \d+\+?$/);
  await bar.getByRole('button', { name: 'Newer match' }).click();
  await expect(counter).toHaveText(/^1 of \d+\+?$/);
  await bar.locator('input').press('Enter');
  await expect(counter).toHaveText(/^2 of \d+\+?$/);

  // Close clears every highlight and brings the header back.
  await bar.getByRole('button', { name: 'Close search' }).click();
  await expect(bar).toHaveCount(0);
  await expect(page.locator('mark[data-search-mark]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Search this chat' })).toBeVisible();
}

test('chat search: phone', async ({ page }) => {
  await runSearchFlow(page);
});

test('chat search: in-chat bar from the header icon', async ({ page }) => {
  await installHarnessNetwork(page);
  await page.goto('/chat');
  await page.getByText(PEER_NAME, { exact: true }).first().click();
  await page.getByRole('button', { name: 'Search this chat' }).click();
  const bar = page.locator('[data-chat-search-bar]');
  await expect(bar).toBeVisible();
  await bar.locator('input').fill('tigh');
  await expect(bar.locator('[data-search-counter]')).toHaveText(/^1 of \d+\+?$/);
  await expect(page.locator('mark[data-search-mark]').first()).toHaveText(/^tighten$/i);
});

test.describe('laptop', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false });

  test('chat search: laptop', async ({ page }) => {
    await runSearchFlow(page);
    // The list stays beside the thread: a second hit in the same open chat
    // jumps again and reopens the bar on that match.
    const hits = page.locator('[data-search-hit]');
    const firstChat = await hits.nth(0).getAttribute('aria-label');
    const sameChat = hits
      .filter({ has: page.locator(':scope') })
      .locator(`xpath=self::*[@aria-label=${JSON.stringify(firstChat)}]`);
    await expect(sameChat).toHaveCount(3);
    await sameChat.nth(1).click();
    const bar = page.locator('[data-chat-search-bar]');
    await expect(bar.locator('[data-search-counter]')).toHaveText(/^2 of \d+\+?$/);
    await sameChat.nth(0).click();
    await expect(bar.locator('[data-search-counter]')).toHaveText(/^1 of \d+\+?$/);
  });
});
