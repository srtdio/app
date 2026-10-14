import { expect, test, type Page } from '@playwright/test';
import { installHarnessNetwork, type HarnessNetwork } from '../fixtures/harness-routes';
import { WORKSPACE_ID } from '../fixtures/chat-data';
import { expectMinTouchTarget } from '../helpers/touch-target';

// Assets tabs: All, Media, PDF, Docs, Sheets, Links filter the one loaded list
// on the client (no per-tab read), the tab lives in ?type= (Back and refresh
// keep it, unknown is All), counts and empty states come from the same list,
// and a link opens its URL in a new tab. Tagged @theme for light and dark.

const AT = Date.parse('2026-10-01T09:00:00Z');

const SEED: { name: string; kind: string; mime: string | null; url?: string }[] = [
  { name: 'Logo.png', kind: 'image', mime: 'image/png' },
  { name: 'Reel.mp4', kind: 'video', mime: 'video/mp4' },
  { name: 'Lookbook.pdf', kind: 'pdf', mime: 'application/pdf' },
  {
    name: 'Captions.docx',
    kind: 'document',
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  },
  {
    name: 'Pitch.pptx',
    kind: 'presentation',
    mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  },
  { name: 'Shared drive', kind: 'link', mime: null, url: 'https://drive.example.com/folder' },
];

function seedAssets(network: HarnessNetwork): void {
  const t = network.world.tables;
  SEED.forEach((asset, n) => {
    const suffix = String(n + 1).padStart(12, '0');
    const id = `0190e800-0000-7000-8000-${suffix}`;
    const version = `0190e900-0000-7000-8000-${suffix}`;
    (t.assets ??= []).push({
      id,
      workspace_id: WORKSPACE_ID,
      filename: asset.name,
      display_name: null,
      folder_path: '/',
      folder_id: null,
      tags: [],
      uploaded_at: new Date(AT - n * 60_000).toISOString(),
      current_version_id: version,
      current_version: {
        id: version,
        asset_id: id,
        kind: asset.kind,
        mime_type: asset.mime,
        size_bytes: asset.kind === 'link' ? null : 120_000,
        width: null,
        height: null,
        duration_ms: null,
        page_count: null,
        external_url: asset.url ?? null,
        r2_key: asset.kind === 'link' ? null : `${WORKSPACE_ID}/${id}/v1`,
        version_number: 1,
      },
      deleted_at: null,
    });
  });
}

const tab = (page: Page, name: string) => page.getByRole('tab', { name: new RegExp(`^${name} `) });
const cards = (page: Page) =>
  page
    .locator('#assets-tabpanel')
    .locator('button[aria-label^="View "], button[aria-label^="Open "]');

async function open(page: Page): Promise<HarnessNetwork> {
  const network = await installHarnessNetwork(page);
  seedAssets(network);
  return network;
}

test('six tabs filter the loaded list, with counts, empty states and ?type= @theme', async ({
  page,
}) => {
  const network = await open(page);
  const reads: string[] = [];
  page.on('request', (r) => {
    if (/\/rest\/v1\/assets\b/.test(r.url())) reads.push(r.url());
  });
  await page.goto('/assets');
  await expect(cards(page)).toHaveCount(6, { timeout: 15_000 });

  const tablist = page.getByRole('tablist', { name: 'File types' });
  await expect(tablist.getByRole('tab')).toHaveText([
    'All 6',
    'Media 2',
    'PDF 1',
    'Docs 2',
    'Sheets 0',
    'Links 1',
  ]);
  for (const t of await tablist.getByRole('tab').all()) expectMinTouchTarget(await t.boundingBox());
  await expect(tab(page, 'All')).toHaveAttribute('aria-selected', 'true');
  const readsAfterLoad = reads.length;

  const expected: [string, string, number][] = [
    ['Media', 'media', 2],
    ['PDF', 'pdf', 1],
    ['Docs', 'docs', 2],
    ['Links', 'links', 1],
  ];
  for (const [name, type, count] of expected) {
    await tab(page, name).click();
    await expect(tab(page, name)).toHaveAttribute('aria-selected', 'true');
    await expect(cards(page)).toHaveCount(count);
    expect(new URL(page.url()).searchParams.get('type')).toBe(type);
  }
  await tab(page, 'Sheets').click();
  await expect(cards(page)).toHaveCount(0);
  await expect(page.getByText('No sheets yet.')).toBeVisible();
  await tab(page, 'All').click();
  await expect(cards(page)).toHaveCount(6);
  expect(new URL(page.url()).searchParams.has('type')).toBe(false);
  // Switching never read the server again.
  expect(reads.length).toBe(readsAfterLoad);

  // Arrow keys move the selection; only the selected tab is tabbable.
  await tab(page, 'All').focus();
  await page.keyboard.press('ArrowRight');
  await expect(tab(page, 'Media')).toBeFocused();
  await expect(tab(page, 'Media')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('End');
  await expect(tab(page, 'Links')).toHaveAttribute('aria-selected', 'true');

  // Refresh keeps the tab; Back after leaving restores it; unknown is All.
  await page.reload();
  await expect(tab(page, 'Links')).toHaveAttribute('aria-selected', 'true', { timeout: 15_000 });
  await expect(cards(page)).toHaveCount(1);
  await page.goto('/pipeline');
  await page.goBack();
  await expect(tab(page, 'Links')).toHaveAttribute('aria-selected', 'true', { timeout: 15_000 });
  await page.goto('/assets?type=nonsense');
  await expect(tab(page, 'All')).toHaveAttribute('aria-selected', 'true', { timeout: 15_000 });
  await expect(cards(page)).toHaveCount(6);

  expect(network.blocked).toEqual([]);
});

test('a link opens its URL in a new tab with noopener noreferrer', async ({ page }) => {
  await open(page);
  await page.goto('/assets?type=links');
  await expect(cards(page)).toHaveCount(1, { timeout: 15_000 });
  await page.evaluate(() => {
    const opened: { href: string; target: string; rel: string }[] = [];
    (window as unknown as { __opened: typeof opened }).__opened = opened;
    HTMLAnchorElement.prototype.click = function click(this: HTMLAnchorElement) {
      opened.push({ href: this.href, target: this.target, rel: this.rel });
    };
  });
  await cards(page).first().click();
  const opened = await page.evaluate(() => (window as unknown as { __opened: unknown[] }).__opened);
  expect(opened).toEqual([
    { href: 'https://drive.example.com/folder', target: '_blank', rel: 'noopener noreferrer' },
  ]);
});

test.describe('320px phone', () => {
  test.use({ viewport: { width: 320, height: 640 } });

  test('the tab row scrolls sideways; nothing is clipped or overflows the page', async ({
    page,
  }) => {
    await open(page);
    await page.goto('/assets');
    await expect(cards(page)).toHaveCount(6, { timeout: 15_000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      320,
    );
    const links = tab(page, 'Links');
    await links.scrollIntoViewIfNeeded();
    const box = await links.boundingBox();
    expectMinTouchTarget(box);
    expect((box?.x ?? -1) >= 0 && (box?.x ?? 0) + (box?.width ?? 0) <= 320).toBe(true);
    await links.click();
    await expect(cards(page)).toHaveCount(1);
  });
});
