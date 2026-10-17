import { expect, test, type Locator, type Page } from '@playwright/test';
import { installHarnessNetwork } from '../fixtures/harness-routes';
import { PEER_NAME, POST_IDS } from '../fixtures/chat-data';
import {
  COMMENT_TITLE,
  FULL_TITLE,
  UNSAFE_URL,
  installLinkPreviewStub,
  seedLinkBodies,
} from '../fixtures/link-previews';

// Link previews (approved prototype, 17 Oct): a full card, a sign-in card and a
// warning card in a chat, the warning sheet, and a comment card. The Worker is
// stubbed. Runs in dark and (via @theme) light for parity. Linux WebKit
// approximates iOS WebKit; it is not iOS.

const bubbleWith = (page: Page, text: string): Locator =>
  page.locator('[data-bubble]', { hasText: text }).last();

async function cardHeight(card: Locator): Promise<number> {
  return card.evaluate((el) => Math.round(el.getBoundingClientRect().height));
}

test('link previews in chat and comments @theme', async ({ page }) => {
  const net = await installHarnessNetwork(page);
  seedLinkBodies(net.world);
  const stub = await installLinkPreviewStub(page);
  const held = stub.hold();

  await page.goto('/chat');
  await page.getByText(PEER_NAME, { exact: true }).first().click();
  const full = bubbleWith(page, 'Reference for the reel tone').locator('[data-link-card]');
  const login = bubbleWith(page, 'Final logo files').locator('[data-link-card]');
  const unsafe = bubbleWith(page, 'pls see this asap').locator('[data-link-card]');
  await expect(full).toBeVisible();

  // First paint: the skeleton holds the card's final box; the warning card is
  // final at once (decided in code, never fetched).
  await expect(full.locator('[data-card-type="skeleton"]')).toBeVisible();
  await expect(unsafe.locator('[data-card-type="unsafe"]')).toBeVisible();
  const before = { full: await cardHeight(full), login: await cardHeight(login) };
  held.release();

  // Cards ask only within 300px of the viewport: bring the first one near.
  await full.scrollIntoViewIfNeeded();
  await expect(full.locator('[data-card-type="full"]')).toBeVisible();
  await expect(full).toContainText(FULL_TITLE);
  await expect(full).toContainText('instagram.com');
  await expect
    .poll(() => full.locator('img').evaluate((img) => (img as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0);
  await expect(login.locator('[data-card-type="login"]')).toBeVisible();
  await expect(login).toContainText('Sign-in needed to preview');
  // No layout jump when the data lands.
  expect(await cardHeight(full)).toBe(before.full);
  expect(await cardHeight(login)).toBe(before.login);
  // The card is the tap target: a new tab, no opener, no referrer.
  const anchor = full.locator('a').first();
  await expect(anchor).toHaveAttribute('target', '_blank');
  await expect(anchor).toHaveAttribute('rel', 'noopener noreferrer');
  expect(await cardHeight(full)).toBeGreaterThanOrEqual(44);

  // Warning card -> sheet. "Don't open" is focused; Esc closes it.
  await unsafe.locator('[data-card-type="unsafe"]').click();
  const sheet = page.getByRole('dialog', { name: 'Check before opening' });
  await expect(sheet).toBeVisible();
  await expect(sheet.locator('[data-unsafe-url]')).toHaveText(UNSAFE_URL);
  await expect(sheet).toContainText('Not a secure (https) link');
  await expect(sheet).toContainText('Uses an unusual port');
  await expect(sheet.getByRole('button', { name: "Don't open" })).toBeFocused();
  const anyway = sheet.getByRole('link', { name: 'Open anyway' });
  await expect(anyway).toHaveAttribute('rel', 'noopener noreferrer');
  expect(await anyway.evaluate((el) => Math.round(el.getBoundingClientRect().height))).toBe(46);
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  expect(stub.requested.some((url) => url.includes('g00gle'))).toBe(false);

  // A comment gets the card for its first link, below the text.
  await page.goto(`/posts/${POST_IDS[0]}`);
  const text = page.getByText('Make the opening like this one');
  await text.scrollIntoViewIfNeeded();
  const comment = page.locator('[data-link-card]', { hasText: COMMENT_TITLE });
  await expect(comment).toBeVisible();
  await expect(comment).toContainText('youtube.com · 0:45');
});
