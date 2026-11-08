import { expect, test, type Locator, type Page } from '@playwright/test';
import { installHarnessNetwork } from '../fixtures/harness-routes';
import { PEER_NAME } from '../fixtures/chat-data';

// WhatsApp-style formatting through the writing box (ui/WritingBox): select a
// word in the chat box, tap Aa, then Bold on the format row, send; the bubble
// shows the word bold with no stars, and the stored body keeps the markers
// (copy and edit show the raw text). WYSIWYG: while typing the stars never
// show (the box's mirror draws the word bold, its markers hidden).
// Linux WebKit approximates iOS WebKit (it never shows a keyboard); it is not iOS.

const chatBox = (page: Page): Locator =>
  page.locator('[data-writing-box][data-mode="chat"]').first();
const composer = (page: Page): Locator => chatBox(page).locator('textarea').first();

async function openDm(page: Page): Promise<void> {
  await installHarnessNetwork(page);
  await page.goto('/chat');
  await page.getByText(PEER_NAME, { exact: true }).first().click();
  await composer(page).waitFor({ state: 'visible' });
}

test('select a word, tap Aa then Bold, send: the bubble shows it bold without stars', async ({
  page,
}) => {
  await openDm(page);
  const box = composer(page);
  await box.click();
  await box.fill('ship today');
  await chatBox(page).getByRole('button', { name: 'Aa', exact: true }).click();
  const row = chatBox(page).getByRole('toolbar', { name: 'Format' });
  await expect(row).toBeVisible();
  const labels = await row
    .getByRole('button')
    .evaluateAll((els) => els.map((el) => el.getAttribute('aria-label')));
  // Aa (on) closes its own row: no X.
  expect(labels).toEqual([
    'Aa',
    'Bold',
    'Italic',
    'Underline',
    'Strike',
    'Link',
    'Numbered list',
    'Bullet list',
    'Quote',
  ]);
  // Select "today".
  await box.evaluate((el: HTMLTextAreaElement) => {
    el.focus();
    el.setSelectionRange(5, 10);
    el.dispatchEvent(new Event('select', { bubbles: true }));
    document.dispatchEvent(new Event('selectionchange'));
  });
  await row.getByRole('button', { name: 'Bold', exact: true }).click();
  await expect(box).toHaveValue('ship *today*');
  // The box kept focus (the row keys never take it).
  expect(await box.evaluate((el) => document.activeElement === el)).toBe(true);
  // Live styling: the mirror draws the word styled, and no star shows.
  await expect(page.locator('[data-format-mirror] span', { hasText: 'today' })).toBeVisible();
  await expect(chatBox(page).locator('[data-format-mirror]')).not.toContainText('*');
  // The Bold key reads on with the ink outline (never a fill).
  const bold = row.getByRole('button', { name: 'Bold', exact: true });
  await expect(bold).toHaveAttribute('aria-pressed', 'true');
  await expect(bold.locator('span').first()).toHaveClass(/\blit-selected\b/);

  const before = await page.locator('[data-msg-id]').count();
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => page.locator('[data-msg-id]').count()).toBe(before + 1);
  const bubble = page.locator('[data-msg-id]').last();
  await expect(bubble.locator('[data-msg-body] strong', { hasText: 'today' })).toBeVisible();
  await expect(bubble.locator('[data-msg-body]')).not.toContainText('*');
  // Send closes the format row (Slack keeps neither it nor the expanded editor).
  await expect(chatBox(page).getByRole('toolbar', { name: 'Format' })).toHaveCount(0);
});

test('typing the closing star hides both markers; Aa closes its own row', async ({ page }) => {
  await openDm(page);
  const box = composer(page);
  await box.click();
  await page.keyboard.type('ship *today*');
  await expect(box).toHaveValue('ship *today*');
  await expect(chatBox(page).locator('[data-format-mirror]')).not.toContainText('*');
  await expect(page.locator('[data-format-mirror] span', { hasText: 'today' })).toBeVisible();
  // A letter right after the bold word stays bold; the saved text keeps the pair.
  await page.keyboard.type('s');
  await expect(box).toHaveValue('ship *todays*');
  await chatBox(page).getByRole('button', { name: 'Aa', exact: true }).click();
  const row = chatBox(page).getByRole('toolbar', { name: 'Format' });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'Aa', exact: true }).click();
  await expect(chatBox(page).getByRole('toolbar', { name: 'Format' })).toHaveCount(0);
});
