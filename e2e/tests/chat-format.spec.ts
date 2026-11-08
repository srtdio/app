import { expect, test, type Locator, type Page } from '@playwright/test';
import { installHarnessNetwork } from '../fixtures/harness-routes';
import { PEER_NAME } from '../fixtures/chat-data';

/**
 * The saved (marker) text of a live-format box. The box keeps paired markers as
 * invisible characters and its own `value` getter hands back the saved text in
 * the page's world; Playwright's toHaveValue reads from its utility world, which
 * sees the raw characters, so the saved text is read with evaluate.
 */
async function expectSaved(field: Locator, text: string): Promise<void> {
  await expect.poll(() => field.evaluate((el) => (el as HTMLTextAreaElement).value)).toBe(text);
}

// WhatsApp-style formatting through the writing box (ui/WritingBox): select a
// word in the chat box, tap Aa, then Bold on the format row, send; the bubble
// shows the word bold with no stars, and the stored body keeps the markers
// (copy and edit show the raw text). WYSIWYG: while typing the stars never
// show (the box's mirror draws the word bold, its markers hidden).
// Linux WebKit approximates iOS WebKit (it never shows a keyboard); it is not iOS.

const chatBox = (page: Page): Locator =>
  page.locator('[data-writing-box][data-mode="chat"]').first();
const composer = (page: Page): Locator => chatBox(page).locator('textarea').first();
const isPhone = (page: Page): boolean => (page.viewportSize()?.width ?? 0) < 768;

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
  const keys = await row
    .locator('[data-row-key]')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-row-key')));
  // Phone: X close (a filled circle like send) ... send; no Aa, no Quote, no
  // mic. Laptop: Aa (on) closes its own row.
  expect(keys).toEqual(
    isPhone(page)
      ? ['close', 'bold', 'italic', 'underline', 'strike', 'link', 'ol', 'ul']
      : ['aa', 'bold', 'italic', 'underline', 'strike', 'link', 'ol', 'ul', 'quote'],
  );
  // Select "today".
  await box.evaluate((el: HTMLTextAreaElement) => {
    el.focus();
    el.setSelectionRange(5, 10);
    el.dispatchEvent(new Event('select', { bubbles: true }));
    document.dispatchEvent(new Event('selectionchange'));
  });
  await row.getByRole('button', { name: 'Bold', exact: true }).click();
  await expectSaved(box, 'ship *today*');
  // The box kept focus (the row keys never take it).
  expect(await box.evaluate((el) => document.activeElement === el)).toBe(true);
  // Live styling: the mirror draws the word styled, and no star shows.
  await expect(page.locator('[data-format-mirror] span', { hasText: 'today' })).toBeVisible();
  await expect(chatBox(page).locator('[data-format-mirror]')).not.toContainText('*');
  // The Bold key reads on: its glyph turns ink, never a tile, ring or fill.
  const bold = row.getByRole('button', { name: 'Bold', exact: true });
  await expect(bold).toHaveAttribute('aria-pressed', 'true');
  await expect(bold.locator('span').first()).toHaveClass(/\btext-fg\b/);
  await expect(bold.locator('span').first()).not.toHaveClass(/\bbg-|lit-selected|\bborder\b/);

  const before = await page.locator('[data-msg-id]').count();
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => page.locator('[data-msg-id]').count()).toBe(before + 1);
  const bubble = page.locator('[data-msg-id]').last();
  await expect(bubble.locator('[data-msg-body] strong', { hasText: 'today' })).toBeVisible();
  await expect(bubble.locator('[data-msg-body]')).not.toContainText('*');
  // Send closes the format row (Slack keeps neither it nor the expanded editor).
  await expect(chatBox(page).getByRole('toolbar', { name: 'Format' })).toHaveCount(0);
});

test('typing the closing star hides both markers; the row closes (phone X, laptop Aa)', async ({
  page,
}) => {
  await openDm(page);
  const box = composer(page);
  await box.click();
  await page.keyboard.type('ship *today*');
  await expectSaved(box, 'ship *today*');
  await expect(chatBox(page).locator('[data-format-mirror]')).not.toContainText('*');
  await expect(page.locator('[data-format-mirror] span', { hasText: 'today' })).toBeVisible();
  // A letter right after the bold word stays bold; the saved text keeps the pair.
  await page.keyboard.type('s');
  await expectSaved(box, 'ship *todays*');
  await chatBox(page).getByRole('button', { name: 'Aa', exact: true }).click();
  const row = chatBox(page).getByRole('toolbar', { name: 'Format' });
  await expect(row).toBeVisible();
  await row
    .getByRole('button', { name: isPhone(page) ? 'Close formatting' : 'Aa', exact: true })
    .click();
  await expect(chatBox(page).getByRole('toolbar', { name: 'Format' })).toHaveCount(0);
});

test('phone: selecting text opens the format row; collapsing it closes the row', async ({
  page,
}) => {
  test.skip(!isPhone(page), 'phone only');
  await openDm(page);
  const box = composer(page);
  await box.click();
  await box.fill('ship today');
  const row = chatBox(page).getByRole('toolbar', { name: 'Format' });
  await expect(row).toHaveCount(0);
  await box.evaluate((el: HTMLTextAreaElement) => {
    el.focus();
    el.setSelectionRange(5, 10);
    document.dispatchEvent(new Event('selectionchange'));
  });
  await expect(row).toBeVisible();
  await expect(row.locator('[data-row-key="close"]')).toBeVisible();
  await expect(chatBox(page).locator('[data-row-trailing]')).toHaveCount(0);
  await box.evaluate((el: HTMLTextAreaElement) => {
    el.setSelectionRange(10, 10);
    document.dispatchEvent(new Event('selectionchange'));
  });
  await expect(row).toHaveCount(0);
  // The mic is back beside send.
  await expect(chatBox(page).locator('[data-row-trailing]')).toBeVisible();
});
