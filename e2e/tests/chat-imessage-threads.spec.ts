import { expect, test, type Locator, type Page } from '@playwright/test';
import { expectMinTouchTarget } from '../helpers/touch-target';
import { installHarnessNetwork, type HarnessNetwork } from '../fixtures/harness-routes';
import { MAYA_NAME, REFUSED_SEND, THREAD_GROUP_NAME, THREAD_IDS } from '../fixtures/chat-data';

// Work-chat threads (L3/L4, 8 Nov 2026; replaces the iMessage rail): every
// reply is a thread. The main chat shows top-level messages only, each root
// with a replies row; the thread screen holds the root, "N replies" and the
// replies. Real app tree against fixture data, iPhone 13 viewport, light and
// dark projects. Linux WebKit approximates iOS WebKit, it is not iOS.

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
  // Counts and replies rows land with the page: nothing restyles after it.
  await page.waitForTimeout(2500);
  expect(await rowLooks(page)).toEqual(first);
  await expect(page.locator('[data-replies-row]').first()).toBeVisible();
  // No rail, no chip any more.
  await expect(page.locator('[data-rail]')).toHaveCount(0);
  await expect(page.locator('[data-thread-chip]')).toHaveCount(0);
  expectClean(network);
});

test(
  'DM: replies never show in the main chat; the root carries its replies row',
  { tag: '@theme' },
  async ({ page }) => {
    const network = await installHarnessNetwork(page);
    await openChat(page, MAYA_NAME);
    await expect(row(page, 'r1')).toBeVisible();
    for (const key of ['r1a', 'r1b', 'r1c']) {
      await expect(page.locator(`li[data-msg-id="${THREAD_IDS[key] ?? key}"]`)).toHaveCount(0);
    }
    const replies = page.locator('[data-replies-row]', { hasText: '4 replies' }).first();
    await expect(replies).toBeVisible();
    await expect(replies.locator('[data-replies-count]')).toHaveCSS('font-weight', '600');
    // Up to 3 square photos of the latest repliers; the latest reply's first line.
    expect(await replies.locator('[data-replies-photos] [data-avatar-role="stack"]').count())
      .toBeLessThanOrEqual(3);
    await expect(replies.locator('[data-replies-latest]')).toContainText(':');
    expectMinTouchTarget(await replies.locator('button').boundingBox(), { dimension: 'height' });
    // A reply to a deleted root stays out of the main chat too.
    await expect(page.locator(`li[data-msg-id="${THREAD_IDS.rda ?? 'rda'}"]`)).toHaveCount(0);
    expectClean(network);
  },
);

test('DM: the thread screen opens, sends a reply, and shows a refused reply', async ({ page }) => {
  const network = await installHarnessNetwork(page);
  await openChat(page, MAYA_NAME);
  await page.locator('[data-replies-row]', { hasText: '4 replies' }).first().locator('button').click();

  const view = page.locator('[data-thread-view]');
  await expect(view).toBeVisible();
  // L4: a post-card thread takes the post's title.
  await expect(view.locator('[data-thread-view-title]')).toContainText('Monday carousel');
  await expect(view.locator('[data-thread-separator]')).toHaveText('4 replies');
  const close = view.locator('[data-thread-view-close]');
  expectMinTouchTarget(await close.boundingBox(), { dimension: 'height' });
  const input = view.getByPlaceholder('Reply', { exact: true });
  await expect(input).toBeVisible();

  await input.fill('Reply in thread');
  await view.getByRole('button', { name: 'Send' }).click();
  await expect(view.locator('li[data-msg-id]', { hasText: 'Reply in thread' })).toBeVisible();
  await expect(view.locator('[data-thread-separator]')).toHaveText('5 replies');
  await expect(view.locator('[data-rail]')).toHaveCount(0);

  // A refused reply (a 400 P0001, refused for good): "Not sent" with the
  // reason and Delete only, no Retry.
  await input.fill(REFUSED_SEND);
  await view.getByRole('button', { name: 'Send' }).click();
  const failed = view.locator('li[data-msg-id]', { hasText: REFUSED_SEND });
  await expect(failed.locator('[data-failed-reason]')).toBeVisible({ timeout: 8000 });
  await expect(failed.locator('[data-failed-delete]')).toBeVisible();
  await expect(failed.locator('[data-failed-retry]')).toHaveCount(0);

  await close.click();
  await expect(view).toHaveCount(0);
  // The reply stays in its thread; the root's replies row counts it.
  await expect(page.locator('li[data-msg-id]', { hasText: 'Reply in thread' })).toHaveCount(0);
  await expect(page.locator('[data-replies-row]', { hasText: '5 replies' })).toHaveCount(1);
  expectClean(network);
});

test('group: every head carries the square photo at 16, the thread keeps names', async ({
  page,
}) => {
  const network = await installHarnessNetwork(page);
  await openChat(page, THREAD_GROUP_NAME);
  const plainPhoto = await row(page, 'ge').locator(':scope > *').first().boundingBox();
  expect(Math.round(plainPhoto?.x ?? 0)).toBe(16);
  await page.locator('[data-replies-row]', { hasText: '4 replies' }).first().locator('button').click();
  const view = page.locator('[data-thread-view]');
  await expect(view).toBeVisible();
  await expect(view.locator('li[data-msg-id]', { hasText: 'Love the colours.' })).toContainText(
    'Ana Silva',
  );
  expectClean(network);
});

test('laptop: right-click opens the actions in the sheet order, tiles first', async ({
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
  const own = row(page, 'r1');
  await own.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await own.locator('[data-bubble]').click({ button: 'right' });
  const keys = await page
    .getByRole('menu', { name: 'Message actions' })
    .locator('[data-menu-item]')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-menu-item')));
  const actions = keys.filter((k) => k !== null && !k.startsWith('react'));
  expect(actions[0]).toBe('reply');
  expect(actions).toContain('more-actions');
  expect(actions.indexOf('copy-link')).toBeGreaterThan(actions.indexOf('reply'));
  expectClean(network);
  await context.close();
});
