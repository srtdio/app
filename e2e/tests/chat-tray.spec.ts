import { expect, test, type Page } from '@playwright/test';
import { installHarnessNetwork, type HarnessNetwork } from '../fixtures/harness-routes';
import { DM_CHANNEL, GROUP_NAME, PEER_NAME, WORKSPACE_ID, ME } from '../fixtures/chat-data';

// The composer tray (D1 to D5): eight tiles in order, Draft faded and inert in
// a chat with a client and live in an agency-only group, each share picker
// mode, and the Assets tile sending library files with no upload. The viewer
// is the workspace owner (agency side); the DM peer is a client and the group
// is agency only. Runs in both colour schemes (the dark and light projects),
// on the iPhone viewport and on a laptop. Linux WebKit approximates iOS WebKit.

const TILE_ORDER = ['photos', 'file', 'assets', 'brief', 'post', 'draft', 'plan', 'schedule'];
const LIB_IMAGE = '0190e000-0000-7000-8000-0000000000a1';
const LIB_IMAGE_VERSION = '0190e100-0000-7000-8000-0000000000a1';
const LIB_PDF = '0190e000-0000-7000-8000-0000000000a2';
const LIB_PDF_VERSION = '0190e100-0000-7000-8000-0000000000a2';

/** Two library assets (an image and a PDF) with their current versions embedded. */
function seedLibrary(network: HarnessNetwork): void {
  const version = (id: string, kind: string, mime: string, size: number) => ({
    id,
    kind,
    mime_type: mime,
    size_bytes: size,
    width: kind === 'image' ? 64 : null,
    height: kind === 'image' ? 48 : null,
    duration_ms: null,
  });
  const asset = (id: string, versionId: string, filename: string, at: string, v: unknown) => ({
    id,
    workspace_id: WORKSPACE_ID,
    filename,
    display_name: null,
    uploaded_at: at,
    current_version_id: versionId,
    folder_id: null,
    origin: 'library',
    uploaded_by: ME,
    deleted_at: null,
    current_version: v,
  });
  const assets = (network.world.tables.assets ??= []);
  assets.push(
    asset(
      LIB_IMAGE,
      LIB_IMAGE_VERSION,
      'hero-shot.png',
      '2026-09-30T10:00:00Z',
      version(LIB_IMAGE_VERSION, 'image', 'image/png', 4321),
    ),
    asset(
      LIB_PDF,
      LIB_PDF_VERSION,
      'brand-deck.pdf',
      '2026-09-29T10:00:00Z',
      version(LIB_PDF_VERSION, 'file', 'application/pdf', 98765),
    ),
  );
}

async function openChat(page: Page, name: string): Promise<void> {
  await page.goto('/chat');
  const row = page.getByText(name, { exact: true }).first();
  await row.waitFor({ state: 'visible' });
  await row.click();
  await page.locator('[data-msg-id]').first().waitFor({ state: 'visible', timeout: 8000 });
  await page.waitForTimeout(300);
}

function composer(page: Page) {
  return page.locator('form:has(textarea)').first();
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: test.info().outputPath(`${name}.png`) });
}

function expectClean(network: HarnessNetwork): void {
  expect(network.blocked, 'blocked non-fixture requests').toEqual([]);
  expect([...new Set(network.unmatched)], 'unrecognised fixture requests').toEqual([]);
}

async function openTray(page: Page): Promise<void> {
  const plus = page.getByRole('button', { name: 'Add attachment' });
  test.skip((await plus.count()) === 0, 'no upload endpoint in this env: the plus tray is off');
  await plus.click();
  await expect(page.locator('[data-tray]')).toBeVisible();
  await page.waitForTimeout(250);
}

async function tileIds(page: Page): Promise<string[]> {
  return page
    .locator('[data-tray-tile]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-tray-tile') ?? ''));
}

async function trayAndPickers(page: Page, prefix: string): Promise<void> {
  const network = await installHarnessNetwork(page);

  // A DM with a client: eight tiles in order, Draft faded and inert; Plan live (agency).
  await openChat(page, PEER_NAME);
  await openTray(page);
  expect(await tileIds(page)).toEqual(TILE_ORDER);
  const draft = page.locator('[data-tray-tile="draft"]');
  await expect(draft).toBeDisabled();
  await expect(draft).toHaveAttribute('aria-disabled', 'true');
  await expect(draft).toHaveAttribute('aria-label', 'Draft, not available in chats with clients');
  expect(Number(await draft.evaluate((el) => getComputedStyle(el).opacity))).toBeLessThan(1);
  for (const box of await page
    .locator('[data-tray-tile]')
    .evaluateAll((els) => els.map((e) => e.getBoundingClientRect()))) {
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
  await expect(page.locator('[data-tray-tile="plan"]')).toBeEnabled();
  await shot(page, `${prefix}-1-tray-client-dm`);
  await draft.click({ force: true });
  await expect(page.getByRole('dialog', { name: 'Share a draft' })).toHaveCount(0);

  // Post tile: the post picker, no tabs, no draft.
  await page.locator('[data-tray-tile="post"]').click();
  const posts = page.getByRole('dialog', { name: 'Share a post' });
  await expect(posts).toBeVisible();
  await expect(posts.getByRole('tablist')).toHaveCount(0);
  await expect(posts.getByText('Waiting on client')).toBeVisible();
  await page.waitForTimeout(300);
  await shot(page, `${prefix}-2-post-picker`);
  await page.keyboard.press('Escape');
  await expect(posts).toBeHidden();

  // Brief tile: briefs only.
  await openTray(page);
  await page.locator('[data-tray-tile="brief"]').click();
  const briefs = page.getByRole('dialog', { name: 'Share a brief' });
  await expect(briefs).toBeVisible();
  await expect(briefs.locator('[data-picker-mode="briefs"]')).toBeVisible();
  await page.waitForTimeout(300);
  await shot(page, `${prefix}-3-brief-picker`);
  await page.keyboard.press('Escape');
  await expect(briefs).toBeHidden();

  // An agency-only group: Draft is live and opens the draft picker.
  await openChat(page, GROUP_NAME);
  await openTray(page);
  const live = page.locator('[data-tray-tile="draft"]');
  await expect(live).toBeEnabled();
  await expect(live).not.toHaveAttribute('aria-disabled', 'true');
  await shot(page, `${prefix}-4-tray-agency-group`);
  await live.click();
  const drafts = page.getByRole('dialog', { name: 'Share a draft' });
  await expect(drafts).toBeVisible();
  await expect(drafts.locator('[data-picker-mode="drafts"]')).toBeVisible();
  await page.waitForTimeout(300);
  await shot(page, `${prefix}-5-draft-picker`);
  await page.keyboard.press('Escape');
  expectClean(network);
}

async function libraryImageAndPdf(page: Page, prefix: string): Promise<void> {
  const network = await installHarnessNetwork(page);
  seedLibrary(network);
  await openChat(page, PEER_NAME);
  const before = await page.locator('[data-msg-id]').count();
  await openTray(page);
  await page.locator('[data-tray-tile="assets"]').click();
  const sheet = page.getByRole('dialog', { name: 'Add from Assets' });
  await expect(sheet).toBeVisible();
  const tiles = sheet.locator('[data-asset-tile]');
  await expect(tiles).toHaveCount(2);
  // Newest uploaded first.
  expect(
    await tiles.evaluateAll((els) => els.map((e) => e.getAttribute('data-asset-tile'))),
  ).toEqual([LIB_IMAGE, LIB_PDF]);
  await expect(sheet.locator(`[data-asset-tile="${LIB_IMAGE}"] img`)).toBeVisible();
  await page.waitForTimeout(300);
  await shot(page, `${prefix}-6-asset-picker`);
  await tiles.nth(0).click();
  await tiles.nth(1).click();
  await expect(sheet.getByRole('button', { name: 'Add (2)' })).toBeEnabled();
  await page.waitForTimeout(150);
  await shot(page, `${prefix}-7-asset-picker-selected`);
  await sheet.getByRole('button', { name: 'Add (2)' }).click();
  await expect(sheet).toBeHidden();

  // Already uploaded: chips with no progress bar.
  await expect(composer(page).getByText('hero-shot.png')).toBeVisible();
  await expect(composer(page).getByText('brand-deck.pdf')).toBeVisible();
  await expect(composer(page).locator('[data-schedule-upload-bar]')).toHaveCount(0);
  await shot(page, `${prefix}-8-library-chips`);

  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => page.locator('[data-msg-id]').count()).toBe(before + 1);
  // No upload: both go by their library version ids, meta shaped like an upload.
  expect(network.uploads).toEqual([]);
  const sent = (network.world.tables.chat_messages ?? []).filter(
    (m) => m.channel_id === DM_CHANNEL && Array.isArray(m.attachment_asset_ids),
  );
  const last = sent[sent.length - 1];
  expect(last?.attachment_asset_ids).toEqual([LIB_IMAGE_VERSION, LIB_PDF_VERSION]);
  expect(last?.attachment_meta).toEqual({
    [LIB_IMAGE_VERSION]: { mime: 'image/png', name: 'hero-shot.png', size: 4321 },
    [LIB_PDF_VERSION]: { mime: 'application/pdf', name: 'brand-deck.pdf', size: 98765 },
  });

  // The image renders as an image; the PDF as the existing file chip.
  const bubble = page.locator('[data-msg-id]').last();
  await expect(bubble.locator('[data-album] img')).toBeVisible();
  await expect(bubble.locator('[data-file-icon-spot]')).toBeVisible();
  await expect(bubble.getByText('brand-deck.pdf')).toBeVisible();
  await page.waitForTimeout(400);
  await shot(page, `${prefix}-9-library-sent`);
  expectClean(network);
}

test.describe('phone', () => {
  test('tray tiles, Draft gating and each picker mode', async ({ page }) => {
    await trayAndPickers(page, 'tray-phone');
  });

  test('send one library image and one library PDF, no upload', async ({ page }) => {
    await libraryImageAndPdf(page, 'tray-phone');
  });
});

test.describe('laptop', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false });

  test('tray tiles, Draft gating and each picker mode', async ({ page }) => {
    await trayAndPickers(page, 'tray-laptop');
  });

  test('send one library image and one library PDF, no upload', async ({ page }) => {
    await libraryImageAndPdf(page, 'tray-laptop');
  });
});
