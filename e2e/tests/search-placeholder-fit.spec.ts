import { expect, test, type Locator, type Page } from '@playwright/test';
import { installHarnessNetwork } from '../fixtures/harness-routes';
import { GROUP_NAME, PEER_NAME } from '../fixtures/chat-data';

// Audit A1-01, after decision B (7 Nov 2026): the screens have no search
// field of their own; the one search is the top bar's palette. At 360px wide,
// with the field empty, its placeholder shows in full: "Search anything" beside
// Cancel, and in a picker's pick mode "Search posts" beside the "Posts only"
// pill and Cancel. Linux WebKit approximates iOS WebKit; it is not iOS.

test.use({ viewport: { width: 360, height: 800 } });

interface Fit {
  scrollWidth: number;
  clientWidth: number;
  /** Width the text can use: clientWidth minus the left and right padding. */
  textBox: number;
  /** The placeholder's rendered width in the input's own font. */
  placeholder: number;
}

/**
 * scrollWidth does not grow for an overflowing placeholder in every engine, so
 * the placeholder is also measured in a hidden span carrying the input's
 * computed font and compared with the input's text box.
 */
async function measure(input: Locator): Promise<Fit> {
  return input.evaluate((el) => {
    const field = el as HTMLInputElement;
    const style = getComputedStyle(field);
    const probe = document.createElement('span');
    probe.textContent = field.placeholder;
    probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;left:-9999px;top:0;';
    probe.style.font = style.font;
    probe.style.letterSpacing = style.letterSpacing;
    probe.style.fontFeatureSettings = style.fontFeatureSettings;
    document.body.appendChild(probe);
    const placeholder = probe.getBoundingClientRect().width;
    probe.remove();
    return {
      scrollWidth: field.scrollWidth,
      clientWidth: field.clientWidth,
      textBox: field.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
      placeholder,
    };
  });
}

async function expectPlaceholderFits(page: Page, copy: string): Promise<void> {
  const input = page.getByRole('dialog', { name: 'Command palette' }).getByRole('combobox').first();
  await expect(input).toBeVisible();
  await expect(input).toHaveValue('');
  await expect(input).toHaveAttribute('placeholder', copy);
  await page.evaluate(() => document.fonts.ready);
  const fit = await measure(input);
  expect(fit.scrollWidth, `${copy}: scrollWidth <= clientWidth`).toBeLessThanOrEqual(
    fit.clientWidth,
  );
  expect(fit.placeholder, `${copy}: placeholder fits the text box`).toBeLessThanOrEqual(
    fit.textBox,
  );
}

test('every screen: no search field of its own at 360px', async ({ page }) => {
  await installHarnessNetwork(page);
  for (const [path, ready] of [
    ['/pipeline', page.getByText('Monday carousel', { exact: true }).first()],
    ['/assets', page.getByRole('button', { name: 'New file' })],
    ['/chat', page.getByText(GROUP_NAME, { exact: true }).first()],
  ] as const) {
    await page.goto(path);
    await expect(ready).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('input[type="search"]')).toHaveCount(0);
    await expect(page.getByRole('searchbox')).toHaveCount(0);
  }
});

test('Palette: "Search anything" fits at 360px', async ({ page }) => {
  await installHarnessNetwork(page);
  await page.goto('/chat');
  await page.getByText(GROUP_NAME, { exact: true }).first().waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
  await expectPlaceholderFits(page, 'Search anything');
});

test('Palette pick mode: "Search posts" fits beside its pill at 360px', async ({ page }) => {
  await installHarnessNetwork(page);
  await page.goto('/chat');
  await page.getByText(PEER_NAME, { exact: true }).first().click();
  await page.locator('[data-msg-id]').first().waitFor({ state: 'visible', timeout: 8000 });
  await page.getByRole('button', { name: 'Add attachment', exact: true }).click();
  await page.locator('[data-tray-tile="post"]').click();
  const picker = page.getByRole('dialog', { name: 'Share a post' });
  await expect(picker).toBeVisible();
  await picker.locator('[data-palette-pick-open]').click();
  const palette = page.locator('[data-palette-overlay][data-palette-mode="pick"]');
  await expect(palette).toBeVisible();
  await expect(palette.locator('[data-palette-pick-pill]')).toHaveText('Posts only');
  await expectPlaceholderFits(page, 'Search posts');
  // The pill sits inside the screen, on the same line as the field.
  const pill = await palette.locator('[data-palette-pick-pill]').boundingBox();
  if (pill === null) throw new Error('pick pill has no box');
  expect(pill.x + pill.width).toBeLessThanOrEqual(360);
});
