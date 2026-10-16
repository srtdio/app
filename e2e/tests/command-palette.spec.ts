import { expect, test, type Page } from '@playwright/test';
import { installHarnessNetwork } from '../fixtures/harness-routes';
import { GROUP_CHANNEL, GROUP_NAME, ME, WORKSPACE_ID } from '../fixtures/chat-data';

// The search screen (command palette): "Search anything", grouped results
// from workspace_search_grouped + workspace_search_counts, the RECENT list on
// an empty search, the overlay's scrim token, laptop keyboard navigation and
// the phone's full-screen sheet with Cancel. Linux WebKit approximates iOS.

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

async function openPalette(page: Page): Promise<void> {
  await page
    .getByRole('button', { name: /^Search( ⌘K)?$/ })
    .filter({ visible: true })
    .first()
    .click();
  await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
}

test.describe('command palette', () => {
  test('phone: full screen, Cancel, scrim token, grouped results @theme', async ({ page }) => {
    const net = await installHarnessNetwork(page);
    await page.goto('/chat');
    await page.getByText(GROUP_NAME, { exact: true }).first().waitFor({ state: 'visible' });
    await openPalette(page);

    const input = page.getByPlaceholder('Search anything');
    await expect(input).toBeVisible();
    await expect(page.getByText('Go to', { exact: true })).toHaveCount(0);

    // Full screen on phones, with a 44px Cancel.
    const dialog = page.getByRole('dialog', { name: 'Command palette' });
    const box = await dialog.boundingBox();
    const viewport = page.viewportSize();
    expect(Math.round(box?.width ?? 0)).toBe(viewport?.width);
    const cancel = page.getByRole('button', { name: 'Cancel' });
    const cancelBox = await cancel.boundingBox();
    expect(cancelBox?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect(cancelBox?.width ?? 0).toBeGreaterThanOrEqual(44);

    // The overlay paints the scrim token for this theme, never a hardcoded black.
    const overlay = page.locator('[data-palette-overlay]');
    const dark = await page.evaluate(() => document.documentElement.classList.contains('dark'));
    const scrim = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--scrim').trim(),
    );
    expect(scrim).toBe(dark ? 'rgba(0, 0, 0, 0.6)' : 'rgba(20, 22, 30, 0.45)');
    await expect(overlay).toHaveCSS(
      'background-color',
      dark ? 'rgba(0, 0, 0, 0.6)' : 'rgba(20, 22, 30, 0.45)',
    );

    await input.fill('crew');
    const groups = page.locator('[data-palette-group="Groups"]');
    await expect(groups).toBeVisible();
    await expect(groups.getByText(GROUP_NAME, { exact: true })).toBeVisible();
    await expect(page.locator('[data-palette-group="Posts"]')).toHaveCount(0);

    // One round trip each, in parallel, named args and one uuid_v7 trace id.
    const grouped = net.rpcCalls.filter((c) => c.name === 'workspace_search_grouped');
    const counts = net.rpcCalls.filter((c) => c.name === 'workspace_search_counts');
    expect(grouped).toHaveLength(1);
    expect(counts).toHaveLength(1);
    expect(grouped[0]?.args).toMatchObject({
      p_workspace_id: WORKSPACE_ID,
      p_query: 'crew',
      p_per_kind: 5,
    });
    expect(String(grouped[0]?.args.p_trace_id)).toMatch(UUID_V7);
    expect(counts[0]?.args.p_trace_id).toBe(grouped[0]?.args.p_trace_id);
    expect(net.rpcCalls.some((c) => c.name === 'workspace_search')).toBe(false);

    await cancel.click();
    await expect(dialog).toHaveCount(0);
  });

  test('recents: an opened group shows under RECENT, scoped to this user', async ({ page }) => {
    await installHarnessNetwork(page);
    await page.goto(`/chat?channel=${encodeURIComponent(GROUP_CHANNEL)}`);
    await expect
      .poll(() =>
        page.evaluate(
          (key) => window.localStorage.getItem(key),
          `sorted:recent:${ME}:${WORKSPACE_ID}`,
        ),
      )
      .toContain('"type":"group"');
    // Only {type, id, openedAt} is stored: no titles.
    const stored = await page.evaluate(
      (key) => window.localStorage.getItem(key) ?? '',
      `sorted:recent:${ME}:${WORKSPACE_ID}`,
    );
    expect(stored).not.toContain(GROUP_NAME);

    await page.goto('/chat');
    await page.getByText(GROUP_NAME, { exact: true }).first().waitFor({ state: 'visible' });
    await openPalette(page);
    const recent = page.locator('[data-palette-group="Recent"]');
    await expect(recent).toBeVisible();
    await expect(recent.getByText('Recent', { exact: true })).toHaveCSS(
      'text-transform',
      'uppercase',
    );
    await expect(recent.getByText(GROUP_NAME, { exact: true })).toBeVisible();
    await expect(recent.getByText('Group', { exact: true })).toBeVisible();

    // Sign-out clears every list on this device.
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('sorted:signout')));
    const after = await page.evaluate(
      (key) => window.localStorage.getItem(key),
      `sorted:recent:${ME}:${WORKSPACE_ID}`,
    );
    expect(after).toBeNull();
  });
});

test.describe('command palette on a laptop @desktop', () => {
  test.skip(({ isMobile }) => isMobile, 'desktop only');

  test('centred box, Esc chip, arrows move, Enter opens, Esc closes', async ({ page }) => {
    await installHarnessNetwork(page);
    await page.goto('/chat');
    await page.getByText(GROUP_NAME, { exact: true }).first().waitFor({ state: 'visible' });
    await openPalette(page);
    const dialog = page.getByRole('dialog', { name: 'Command palette' });
    await expect(dialog.getByText('Esc', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cancel' })).toBeHidden();
    const box = await dialog.boundingBox();
    const viewport = page.viewportSize();
    const centre = (box?.x ?? 0) + (box?.width ?? 0) / 2;
    expect(Math.abs(centre - (viewport?.width ?? 0) / 2)).toBeLessThanOrEqual(1);

    const input = page.getByPlaceholder('Search anything');
    await input.fill('crew');
    const rows = page.locator('[data-palette-group="Groups"] [role="option"]');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toHaveAttribute('aria-selected', 'true');
    await input.press('ArrowDown');
    await expect(rows.nth(1)).toHaveAttribute('aria-selected', 'true');
    await input.press('ArrowUp');
    await expect(rows.nth(0)).toHaveAttribute('aria-selected', 'true');
    // Newest first: Thread crew, then Launch crew.
    await input.press('ArrowDown');
    await expect(rows.nth(1)).toContainText(GROUP_NAME);
    await input.press('Enter');
    await expect(dialog).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`channel=${encodeURIComponent(GROUP_CHANNEL)}`));

    await openPalette(page);
    await page.getByPlaceholder('Search anything').press('Escape');
    await expect(dialog).toHaveCount(0);
  });
});
