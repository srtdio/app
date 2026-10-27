import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  installHarnessNetwork,
  WORKSPACE_ID,
  type HarnessNetwork,
} from '../fixtures/harness-routes';
import {
  collectPageErrors,
  routeBookCall,
  routeNotOperator,
  routeUploadFull,
  routeUsage,
  routeWorkspaceStorage,
} from '../fixtures/workspace-storage';
import { PEER_NAME } from '../fixtures/chat-data';
import { expectMinTouchTarget } from '../helpers/touch-target';

// Workspace rules on screen: the free-plan limit rows in the switcher (with the
// Contact and Book a call sheets), the 800 MB storage banner, the "This
// workspace is full" sheet on a 413 upload, and Settings > Storage. Tagged
// @theme so it runs in light and dark. The upload cap is never printed.

const WORKSPACE = 'Harness Studio - LinkedIn';
const LIMIT_NOTE = 'On the free plan you can own one workspace. Need another? Talk to us.';

function expectClean(network: HarnessNetwork, errors: string[]): void {
  expect(network.blocked, 'blocked non-fixture requests').toEqual([]);
  // The chat store logs an aborted first load when the shell picks the active
  // workspace; that is the harness boot, not this feature.
  const own = errors.filter((e) => !/chat store: initial load failed.*read cancelled/.test(e));
  expect(own, 'console and page errors').toEqual([]);
}

async function expectNo950(page: Page): Promise<void> {
  expect(await page.locator('body').innerText()).not.toContain('950');
}

/** A sheet settles at rest, moved by translateY only (no X, scale or rotate). */
async function expectSheetAtRest(sheet: Locator): Promise<void> {
  await expect
    .poll(() => sheet.evaluate((el) => getComputedStyle(el).transform))
    .toMatch(/^(none|matrix\(1, 0, 0, 1, 0, 0\))$/);
}

async function openSwitcher(page: Page): Promise<Locator> {
  const label = page.getByRole('button', { name: 'Switch workspace' });
  await expect(label).toContainText(WORKSPACE, { timeout: 15_000 });
  await label.click();
  const dialog = page.getByRole('dialog', { name: 'Switch workspace' });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function expectSupportRows(scope: Locator): Promise<void> {
  const contact = scope.getByRole('button', { name: /Contact us/ });
  const book = scope.getByRole('button', { name: /Book a call/ });
  await expect(contact).toContainText('support@srtd.io');
  await expect(book).toContainText('Pick a time, we send a Meet link');
  expectMinTouchTarget(await contact.boundingBox());
  expectMinTouchTarget(await book.boundingBox());
}

test('owner at the free-plan limit gets Contact us and Book a call @theme', async ({ page }) => {
  const errors = collectPageErrors(page);
  const network = await installHarnessNetwork(page);
  await routeNotOperator(page);
  const bookings = await routeBookCall(page);
  await page.goto('/pipeline');

  const dialog = await openSwitcher(page);
  await expect(dialog.getByRole('button', { name: 'Create workspace' })).toBeDisabled();
  await expect(dialog).toContainText(LIMIT_NOTE);
  await expectSupportRows(dialog);

  // Contact us: the address, the suggested line and Open email.
  await dialog.getByRole('button', { name: /Contact us/ }).click();
  const contact = page.getByRole('dialog', { name: 'Write to us' });
  await expect(contact).toBeVisible();
  await expectSheetAtRest(contact);
  await expect(contact).toContainText(
    'Tell us what you need. Someone from the team replies by email.',
  );
  await expect(contact).toContainText('support@srtd.io');
  await expect(contact).toContainText('Suggested line, copied with the address:');
  await expect(contact).toContainText(`Hi, I'm on ${WORKSPACE} and need another workspace.`);
  await expect(contact.getByRole('link', { name: 'Open email' })).toHaveAttribute(
    'href',
    /^mailto:support@srtd\.io\?subject=Another%20workspace%20for%20/,
  );
  for (const name of ['Copy', 'Close']) {
    expectMinTouchTarget(
      await contact.getByRole('button', { name, exact: true }).last().boundingBox(),
    );
  }
  await contact.getByRole('button', { name: 'Close', exact: true }).last().click();
  await expect(contact).toBeHidden();

  // Book a call: three suggested slots plus another day; Book waits for a pick.
  await dialog.getByRole('button', { name: /Book a call/ }).click();
  const sheet = page.getByRole('dialog', { name: 'Book a call' });
  await expect(sheet).toBeVisible();
  await expectSheetAtRest(sheet);
  await expect(sheet).toContainText('Pick a time. We send a Google Meet link to your email.');
  const choices = sheet.getByRole('radio');
  await expect(choices).toHaveCount(4);
  await expect(choices.last()).toHaveText('Another day or time');
  for (const choice of await choices.all()) expectMinTouchTarget(await choice.boundingBox());
  const bookButton = sheet.getByRole('button', { name: 'Book', exact: true });
  await expect(bookButton).toBeDisabled();
  await choices.first().click();
  await expect(choices.first()).toHaveAttribute('aria-checked', 'true');
  await expect(bookButton).toBeEnabled();
  expectMinTouchTarget(await bookButton.boundingBox());
  await bookButton.click();

  const booked = page.getByRole('dialog', { name: 'Booked' });
  await expect(booked).toContainText(
    'The team sends a Google Meet link to your email before the call.',
  );
  expect(bookings).toHaveLength(1);
  expect(bookings[0]).toMatchObject({ workspace_id: expect.any(String) });
  expect(typeof bookings[0]?.slot_at).toBe('string');
  expect(typeof bookings[0]?.tz).toBe('string');

  await expectNo950(page);
  expectClean(network, errors);
});

test('a platform operator who owns a workspace sees no limit rows @theme', async ({ page }) => {
  const errors = collectPageErrors(page);
  const network = await installHarnessNetwork(page, { operator: true });
  await page.goto('/pipeline');

  const dialog = await openSwitcher(page);
  await expect(dialog.getByRole('button', { name: 'Create workspace' })).toBeEnabled();
  await expect(dialog).not.toContainText(LIMIT_NOTE);
  await expect(dialog.getByRole('button', { name: /Contact us/ })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: /Book a call/ })).toHaveCount(0);
  expectClean(network, errors);
});

test('storage banner shows at 820 MB and not at 500 MB @theme', async ({ page }) => {
  const errors = collectPageErrors(page);
  const network = await installHarnessNetwork(page, { operator: true });
  await routeUsage(page, 500);
  const firstRead = page.waitForResponse(/asset-upload\.harness\.test\/usage/);
  await page.goto('/pipeline');
  await firstRead;
  await expect(page.getByRole('button', { name: 'Switch workspace' })).toContainText(WORKSPACE, {
    timeout: 15_000,
  });
  await expect(page.getByText('This workspace has used')).toHaveCount(0);

  // The banner re-reads /usage after any upload: now at 820 MB.
  await page.unroute(/^https:\/\/asset-upload\.harness\.test\/usage/);
  await routeUsage(page, 820);
  await page.evaluate((workspaceId) => {
    window.dispatchEvent(new CustomEvent('sorted:upload-complete', { detail: { workspaceId } }));
  }, WORKSPACE_ID);
  const banner = page.getByRole('status').filter({ hasText: 'This workspace has used' });
  await expect(banner).toHaveText(
    'This workspace has used 820 MB of its 1 GB. Deleted files free up space only after 31 days, or when the owner empties Recently deleted.',
    { timeout: 15_000 },
  );
  expectMinTouchTarget(await banner.getByRole('button', { name: 'Dismiss' }).boundingBox());
  await expectNo950(page);
  expectClean(network, errors);
});

test('an upload refused as workspace_full opens the full sheet @theme', async ({ page }) => {
  const errors = collectPageErrors(page);
  const network = await installHarnessNetwork(page, { operator: true });
  await routeUploadFull(page);
  await page.goto('/chat');
  await page.getByText(PEER_NAME, { exact: true }).first().click();

  const input = page.locator('form:has(textarea)').first().locator('input[type="file"]').nth(1);
  await input.setInputFiles({
    name: 'brief.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.alloc(2 * 1024 * 1024),
  });
  await page.getByRole('button', { name: 'Send', exact: true }).click();

  const sheet = page.getByRole('dialog', { name: 'This workspace is full' });
  await expect(sheet).toBeVisible({ timeout: 15_000 });
  await expectSheetAtRest(sheet);
  await expect(sheet).toContainText(
    "There isn't room for this 2 MB file. Free up space in Recently deleted, or talk to us about more storage.",
  );
  const recently = sheet.getByRole('button', { name: /Recently deleted/ });
  await expect(recently).toContainText('Free up space now');
  expectMinTouchTarget(await recently.boundingBox());
  await expectSupportRows(sheet);
  const cancel = sheet.getByRole('button', { name: 'Cancel', exact: true });
  expectMinTouchTarget(await cancel.boundingBox());
  await expectNo950(page);
  await cancel.click();
  await expect(sheet).toBeHidden();
  // The 413 is the fixture's answer; only it may log as a failed resource.
  expectClean(
    network,
    errors.filter((e) => !/status of 413/.test(e)),
  );
});

test('Settings > Storage under the warning line has no talk-to-us rows @theme', async ({
  page,
}) => {
  const errors = collectPageErrors(page);
  const network = await installHarnessNetwork(page, { operator: true });
  await routeUsage(page, 300);
  await routeWorkspaceStorage(page, { used: 300, library: 220, chat: 60, voice: 12, deleted: 8 });
  await page.goto('/settings');
  // The Storage tab (the Workspace panel's Storage row comes second).
  await page.getByRole('button', { name: 'Storage', exact: true }).first().click();

  const meter = page.getByRole('meter', { name: 'Storage' });
  await expect(meter).toBeVisible({ timeout: 15_000 });
  const panel = page.locator('div.max-w-\\[520px\\]');
  await expect(panel.getByText('300 MB', { exact: true })).toBeVisible();
  await expect(panel.getByText('of 1 GB', { exact: true })).toBeVisible();
  await expect(panel).toContainText("WHAT'S USING IT");
  for (const [label, size] of [
    ['Assets', '220 MB'],
    ['Chat files', '60 MB'],
    ['Voice notes', '12 MB'],
    ['Recently deleted', '8 MB'],
  ] as const) {
    await expect(panel.getByText(label, { exact: true })).toBeVisible();
    await expect(panel.getByText(size, { exact: true })).toBeVisible();
  }
  await expect(page.getByText('NEED MORE SPACE?')).toHaveCount(0);
  await expect(page.getByText('Contact us')).toHaveCount(0);
  await expect(page.getByText('Book a call')).toHaveCount(0);
  await expectNo950(page);
  expectClean(network, errors);
});

test('Settings > Storage past the warning line offers more space @theme', async ({ page }) => {
  const errors = collectPageErrors(page);
  const network = await installHarnessNetwork(page, { operator: true });
  await routeUsage(page, 850);
  await routeWorkspaceStorage(page, { used: 850, library: 700, chat: 90, voice: 20, deleted: 40 });
  await page.goto('/settings?panel=storage');

  const panel = page.locator('div.max-w-\\[520px\\]');
  await expect(panel.getByText('850 MB', { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('meter', { name: 'Storage' })).toHaveAttribute('data-tone', 'warn');
  await expect(panel).toContainText('NEED MORE SPACE?');
  await expect(panel).toContainText(
    `Free up space in Recently deleted, or talk to us about more storage for ${WORKSPACE}.`,
  );
  const recently = panel.getByRole('button', { name: /Recently deleted/ });
  await expect(recently).toContainText('40 MB can be freed now');
  expectMinTouchTarget(await recently.boundingBox());
  await expectSupportRows(panel);
  await expectNo950(page);
  expectClean(network, errors);
});
