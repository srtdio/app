import { expect, test, type Locator, type Page } from '@playwright/test';
import { expectMinTouchTarget } from '../helpers/touch-target';
import { installHarnessNetwork, type HarnessNetwork } from '../fixtures/harness-routes';
import { MAYA_NAME, REFUSED_SEND, THREAD_GROUP_NAME, THREAD_IDS } from '../fixtures/chat-data';

// iMessage-style threads for post-card replies (boards i1, i2, i3, i4-group-b)
// in the real app tree against fixture data, at the iPhone 13 viewport, in the
// light and dark projects. Linux WebKit approximates iOS WebKit, it is not iOS.

/** A message row by its fixture key. */
function row(page: Page, key: string): Locator {
  return page.locator(`li[data-msg-id="${THREAD_IDS[key] ?? key}"]`).first();
}

async function openChat(page: Page, name: string): Promise<void> {
  await page.goto('/chat');
  const target = page.getByText(name, { exact: true }).first();
  await target.waitFor({ state: 'visible' });
  await target.click();
  await page.locator('[data-msg-id]').first().waitFor({ state: 'visible', timeout: 8000 });
}

/** Every rendered row's look: its class and which rail pieces it draws. */
async function rowLooks(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() => {
    const out: Record<string, string> = {};
    for (const li of document.querySelectorAll('li[data-msg-id]')) {
      const id = li.getAttribute('data-msg-id') ?? '';
      const rails = [...li.querySelectorAll('[data-rail]')]
        .map((el) => el.getAttribute('data-rail'))
        .join(',');
      const quote = li.querySelector('[data-reply-quote], blockquote') !== null ? 'quote' : '';
      out[id] = `${li.className}|${rails}|${quote}`;
    }
    return out;
  });
}

function expectClean(network: HarnessNetwork): void {
  expect(network.blocked, 'blocked non-fixture requests').toEqual([]);
  expect([...new Set(network.unmatched)], 'unrecognised fixture requests').toEqual([]);
}

test('DM: the first paint is final once history is released', async ({ page }) => {
  const network = await installHarnessNetwork(page);
  await page.goto('/chat');
  const target = page.getByText(MAYA_NAME, { exact: true }).first();
  await target.waitFor({ state: 'visible' });
  const gate = network.holdHistory();
  await target.click();
  await page.waitForTimeout(300);
  gate.release();
  await page.locator('[data-msg-id]').first().waitFor({ state: 'visible', timeout: 8000 });
  const first = await rowLooks(page);
  expect(Object.keys(first).length).toBeGreaterThan(20);
  // Counts, roots and chips land with the page: nothing restyles after it.
  await page.waitForTimeout(2500);
  expect(await rowLooks(page)).toEqual(first);
  await expect(page.locator('[data-thread-chip]').first()).toBeVisible();
  expectClean(network);
});

test(
  'DM: runs, chips, the left root card and the deleted root',
  { tag: '@theme' },
  async ({ page }) => {
    const network = await installHarnessNetwork(page);
    await openChat(page, MAYA_NAME);

    // i1: an own root card heads its run; members show no quote; "4 replies" on its side.
    await expect(row(page, 'r1').locator('[data-rail="elbow"]')).toHaveCount(1);
    for (const key of ['r1a', 'r1b', 'r1c']) {
      await expect(row(page, key).locator('[data-rail="tick"]')).toHaveCount(1);
      await expect(row(page, key)).not.toContainText('Shared post');
    }
    await expect(row(page, 'r1a')).toHaveClass(/pl-\[30px\]/);
    await expect(row(page, 'r1b')).not.toHaveClass(/pl-\[30px\]/);
    const replies = page.locator('[data-thread-open="replies"]', { hasText: '4 replies' });
    await expect(replies).toHaveCount(1);
    await expect(replies).toHaveCSS('font-size', '13px');
    expectMinTouchTarget(await replies.boundingBox(), { dimension: 'height' });

    // A plain row breaks the run; the next member starts a chip-headed run.
    await expect(row(page, 'p2').locator('[data-rail]')).toHaveCount(0);
    await expect(row(page, 'r1d').locator('[data-rail="tick"]')).toHaveCount(1);

    // A peer's (left) root card shifts with its run.
    await expect(row(page, 'r2')).toHaveClass(/pl-\[30px\]/);
    await expect(row(page, 'r2').locator('[data-rail="elbow"]')).toHaveCount(1);

    // i3: the root is beyond the first page; the chip names it with the record's count.
    const chip = page.locator('[data-thread-chip]', { hasText: 'Product teaser' });
    await expect(chip).toContainText('· 4 replies');
    expectMinTouchTarget(await chip.locator('button').boundingBox(), { dimension: 'height' });

    // A deleted root card: its reply falls back to the plain quote, no rail.
    await expect(row(page, 'rda').locator('[data-rail]')).toHaveCount(0);
    await expect(row(page, 'rda')).toContainText('This message was deleted');
    await expect(row(page, 'pq')).toContainText('Next up: the teaser captions.');
    await expect(row(page, 'pq').locator('[data-rail]')).toHaveCount(0);
    expectClean(network);
  },
);

test('DM: the thread view opens, sends "Reply in thread", and shows a refused reply', async ({
  page,
}) => {
  const network = await installHarnessNetwork(page);
  await openChat(page, MAYA_NAME);
  await page.locator('[data-thread-open="replies"]', { hasText: '4 replies' }).click();

  const view = page.locator('[data-thread-view]');
  await expect(view).toBeVisible();
  await expect(view.locator('[data-thread-view-title]')).toContainText('Monday carousel');
  await expect(view.locator('[data-thread-separator]')).toHaveText('4 replies');
  const close = view.locator('[data-thread-view-close]');
  expectMinTouchTarget(await close.boundingBox(), { dimension: 'height' });
  await expect(view).toHaveCSS('opacity', '1');
  const input = view.getByPlaceholder('Reply in thread');
  await expect(input).toBeVisible();

  await input.fill('Reply in thread');
  await view.getByRole('button', { name: 'Send' }).click();
  await expect(view.locator('li[data-msg-id]', { hasText: 'Reply in thread' })).toBeVisible();
  await expect(view.locator('[data-thread-separator]')).toHaveText('5 replies');
  await expect(
    view.locator('li[data-msg-id]', { hasText: 'Reply in thread' }).locator('[data-rail="tick"]'),
  ).toHaveCount(1);

  // A refused reply on the rail: its alert sits on the page fill, the tick under it.
  await input.fill(REFUSED_SEND);
  await view.getByRole('button', { name: 'Send' }).click();
  const failed = view.locator('li[data-msg-id]', { hasText: REFUSED_SEND });
  await expect(failed.locator('[data-failed-retry]')).toBeVisible({ timeout: 8000 });
  await expect(failed.locator('[data-failed-retry]')).toHaveClass(/bg-bg/);
  await expect(failed.locator('[data-rail="tick"]')).toHaveCount(1);

  await close.click();
  await expect(view).toHaveCount(0);
  // The reply shows in the chat too, on its thread's rail.
  const sent = page.locator('li[data-msg-id]', { hasText: 'Reply in thread' });
  await expect(sent).toBeVisible();
  await expect(sent.locator('[data-rail="tick"]')).toHaveCount(1);
  await expect(page.locator('[data-thread-open="replies"]', { hasText: '5 replies' })).toHaveCount(
    1,
  );

  // The chip opens the view too; Escape closes it.
  await page.locator('[data-thread-chip] button', { hasText: 'Product teaser' }).click();
  await expect(view).toBeVisible();
  await expect(view.locator('[data-thread-separator]')).toHaveText('4 replies');
  await page.keyboard.press('Escape');
  await expect(view).toHaveCount(0);
  expectClean(network);
});

test('group (i4-group-b): photos and the gutter shift on the rail only', async ({ page }) => {
  const network = await installHarnessNetwork(page);
  await openChat(page, THREAD_GROUP_NAME);
  await expect(row(page, 'gr').locator('[data-rail="elbow"]')).toHaveCount(1);
  for (const key of ['ga', 'gd']) {
    await expect(row(page, key)).toHaveClass(/pl-\[30px\]/);
    // The tick runs into the sender photo, which sits at 30 to 56.
    await expect(row(page, key).locator('[data-rail-target] [data-rail="tick"]')).toHaveCount(1);
  }
  const photo = await row(page, 'ga').locator('[data-rail-target]').first().boundingBox();
  expect(Math.round(photo?.x ?? 0)).toBe(30);
  // A tucked row reaches across the gutter to its bubble at 64.
  const tucked = await row(page, 'gb').locator('[data-bubble]').boundingBox();
  expect(Math.round(tucked?.x ?? 0)).toBe(64);
  // The own reply between keeps its place; the plain row after keeps its photo at 16.
  await expect(row(page, 'gc')).not.toHaveClass(/pl-\[30px\]/);
  await expect(row(page, 'ge').locator('[data-rail]')).toHaveCount(0);
  const plainPhoto = await row(page, 'ge').locator(':scope > *').first().boundingBox();
  expect(Math.round(plainPhoto?.x ?? 0)).toBe(16);

  // The thread view keeps the group rows: photo, name line and the 14px shift.
  await page.locator('[data-thread-open="replies"]', { hasText: '4 replies' }).click();
  const view = page.locator('[data-thread-view]');
  await expect(view).toBeVisible();
  await expect(view.locator('li[data-msg-id]', { hasText: 'Love the colours.' })).toContainText(
    'Ana Silva',
  );
  expectClean(network);
});

test('laptop: the hover smiley on an own rail row sits on the page fill', async ({
  browser,
}, info) => {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    isMobile: false,
    hasTouch: false,
    colorScheme: info.project.use.colorScheme ?? 'dark',
  });
  const page = await context.newPage();
  const network = await installHarnessNetwork(page);
  await openChat(page, MAYA_NAME);
  const own = row(page, 'r1b');
  await own.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await own.locator('[data-bubble]').hover();
  const smiley = own.locator('[data-react]');
  await expect(smiley).toHaveCSS('opacity', '1');
  await expect(smiley).toHaveClass(/bg-bg/);
  await expect(own.locator('[data-rail="tick"]')).toHaveCount(1);
  expectClean(network);
  await context.close();
});
