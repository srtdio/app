import { expect, test, type Locator, type Page } from '@playwright/test';
import { installHarnessNetwork } from '../fixtures/harness-routes';
import { GROUP_NAME } from '../fixtures/chat-data';

// Audit A1-01: the shared SectionHeader search field cut its placeholder short
// on a phone ("Search pos", "Search fil"). At 360px wide, with the field empty,
// every page's placeholder shows in full beside its sort and New controls.
// Linux WebKit approximates iOS WebKit; it is not iOS.

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
  const input = page.locator('input[type="search"]').first();
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

test('Pipeline: "Search posts" fits at 360px', async ({ page }) => {
  await installHarnessNetwork(page);
  await page.goto('/pipeline');
  await expect(page.getByText('Monday carousel', { exact: true }).first()).toBeVisible({
    timeout: 15_000,
  });
  await expectPlaceholderFits(page, 'Search posts');
});

test('Briefs: "Search briefs" fits at 360px', async ({ page }) => {
  await installHarnessNetwork(page);
  await page.goto('/briefs');
  await expect(page.getByRole('button', { name: 'Closed', exact: true }).first()).toBeVisible({
    timeout: 15_000,
  });
  await expectPlaceholderFits(page, 'Search briefs');
});

test('Assets: "Search files" fits at 360px', async ({ page }) => {
  await installHarnessNetwork(page);
  await page.goto('/assets');
  await expect(page.getByRole('button', { name: 'New asset' })).toBeVisible({
    timeout: 15_000,
  });
  await expectPlaceholderFits(page, 'Search files');
});

test('Chat list: "Search chats" fits at 360px', async ({ page }) => {
  await installHarnessNetwork(page);
  await page.goto('/chat');
  await page.getByText(GROUP_NAME, { exact: true }).first().waitFor({ state: 'visible' });
  await expect(page.getByRole('button', { name: 'New chat' })).toBeVisible();
  await expectPlaceholderFits(page, 'Search chats');
});
