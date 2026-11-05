import { expect, test, type Locator, type Page } from '@playwright/test';
import { installHarnessNetwork } from '../fixtures/harness-routes';
import { PEER_NAME } from '../fixtures/chat-data';

// WhatsApp-style formatting: select a word in the chat composer, tap Bold on
// the format strip, send; the bubble shows the word bold with no stars, and the
// stored body keeps the markers (copy and edit show the raw text).
// Linux WebKit approximates iOS WebKit (it never shows a keyboard); it is not iOS.

const composer = (page: Page): Locator => page.locator('form textarea').first();

async function openDm(page: Page): Promise<void> {
  await installHarnessNetwork(page);
  await page.goto('/chat');
  await page.getByText(PEER_NAME, { exact: true }).first().click();
  await composer(page).waitFor({ state: 'visible' });
}

test('select a word, tap Bold, send: the bubble shows it bold without stars', async ({ page }) => {
  await openDm(page);
  const box = composer(page);
  await box.click();
  await box.fill('ship today');
  // Select "today".
  await box.evaluate((el: HTMLTextAreaElement) => {
    el.focus();
    el.setSelectionRange(5, 10);
    el.dispatchEvent(new Event('select', { bubbles: true }));
    document.dispatchEvent(new Event('selectionchange'));
  });
  const strip = page.locator('[data-format-strip]');
  await expect(strip).toBeVisible();
  await expect(strip.getByRole('button')).toHaveText(['Bold', 'Italic', 'Strike', 'Underline']);
  await strip.getByRole('button', { name: 'Bold', exact: true }).click();
  await expect(box).toHaveValue('ship *today*');
  // The box kept focus (the strip never takes it).
  expect(await box.evaluate((el) => document.activeElement === el)).toBe(true);
  // Live styling: the mirror draws the word, markers faded.
  await expect(page.locator('[data-format-mirror] span', { hasText: 'today' })).toBeVisible();

  const before = await page.locator('[data-msg-id]').count();
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => page.locator('[data-msg-id]').count()).toBe(before + 1);
  const bubble = page.locator('[data-msg-id]').last();
  await expect(bubble.locator('[data-msg-body] strong', { hasText: 'today' })).toBeVisible();
  await expect(bubble.locator('[data-msg-body]')).not.toContainText('*');
});
