import { expect, test, type Page } from '@playwright/test';
import { installHarnessNetwork, type HarnessNetwork } from '../fixtures/harness-routes';
import { MAYA_NAME, ME, POST_IDS, WORKSPACE_ID } from '../fixtures/chat-data';

// No KEY-N codes in the UI: with the workspace key known (so the old UI would
// have printed "HS-101"), the brief page, the post page and the chat post card
// and its sheet name things by title only. The real app tree runs against
// fixture data in both colour schemes; Linux WebKit approximates iOS WebKit,
// it is not iOS.

const KEY = 'hs';
/** A KEY-N code such as "HS-101". */
const CODE = /\b[A-Z]{2,}-\d+\b/;

const BRIEF_ID = '0190e100-0000-7000-8000-0000000000b1';
const BRIEF_TITLE = 'Festive drop';

function expectNoBlocked(network: HarnessNetwork): void {
  expect(network.blocked, 'blocked non-fixture requests').toEqual([]);
}

/** Give the fixture workspace a key, so a regression would print KEY-N (spec-local world edit). */
function withKey(network: HarnessNetwork): void {
  const ws = network.world.tables.workspaces?.[0];
  if (ws !== undefined) ws.key = KEY;
}

/** Seed one brief (spec-local world edit). */
function withBrief(network: HarnessNetwork, status: 'open' | 'closed'): void {
  const now = new Date().toISOString();
  (network.world.tables.briefs ??= []).push({
    id: BRIEF_ID,
    workspace_id: WORKSPACE_ID,
    number: 7,
    title: BRIEF_TITLE,
    objective: 'Build hype for the drop',
    brand_requirements: 'Gold logo only',
    legacy_author_name: null,
    status,
    target_date: null,
    reference_links: null,
    mentions: null,
    format_requested: 'carousel',
    closed_at: status === 'closed' ? now : null,
    closed_by: status === 'closed' ? ME : null,
    created_by: ME,
    created_via: 'app',
    created_at: now,
    updated_at: now,
    deleted_at: null,
    row_version: 1,
  });
}

/** The visible page text (display:none is left out by innerText). */
async function visibleText(page: Page): Promise<string> {
  return page.locator('body').innerText();
}

/** Registers the no entity codes tests; called from an area spec (see scripts/ci/e2e-areas.ts). */
export function noEntityCodesCases(): void {
  test.describe('no entity codes', () => {
    test('brief page: no KEY-N code; the ⋯ menu offers Copy link, Copy brief and Reopen brief', async ({
      page,
    }) => {
      const network = await installHarnessNetwork(page);
      withKey(network);
      withBrief(network, 'closed');
      await page.goto(`/briefs/${BRIEF_ID}`);

      await expect(page.getByRole('heading', { name: BRIEF_TITLE })).toBeVisible({
        timeout: 15_000,
      });
      expect(await visibleText(page)).not.toMatch(CODE);
      await expect(page.getByText('HS-7', { exact: false })).toHaveCount(0);

      await page.getByRole('button', { name: 'Brief actions' }).click();
      const menu = page.getByRole('menu', { name: 'Brief actions' });
      await expect(menu.getByRole('menuitem')).toHaveText([
        'Copy link',
        'Copy brief',
        'Reopen brief',
      ]);
      expect(await visibleText(page)).not.toMatch(CODE);
      expectNoBlocked(network);
    });

    test('post page: no KEY-N code, and the approve confirm reads "Approve"', async ({ page }) => {
      const network = await installHarnessNetwork(page);
      withKey(network);
      await page.goto(`/posts/${POST_IDS[0]}`);

      // Flow B 31: the agency-side viewer approves from the ⋯ sheet.
      const more = page.getByRole('button', { name: 'Post actions' });
      await more.waitFor({ state: 'visible', timeout: 15_000 });
      await expect(page.getByText('Monday carousel', { exact: true }).first()).toBeVisible();
      expect(await visibleText(page)).not.toMatch(CODE);
      await expect(page.getByText('HS-101', { exact: false })).toHaveCount(0);

      await more.click();
      await page
        .getByRole('dialog', { name: 'Post actions', exact: true })
        .getByRole('button', { name: /Approve on their behalf/ })
        .click();
      await expect(page.locator('[data-on-behalf-approve]')).toHaveText('Approve');
      expect(await visibleText(page)).not.toMatch(CODE);
      await page.locator('[data-on-behalf-cancel]').click();
      expectNoBlocked(network);
    });

    test('chat post card and its sheet: no KEY-N code, "Talk about this post"', async ({
      page,
    }) => {
      const network = await installHarnessNetwork(page);
      withKey(network);
      await page.goto('/chat');
      await page.getByText(MAYA_NAME, { exact: true }).first().click();
      await page.locator('[data-msg-id]').first().waitFor({ state: 'visible', timeout: 8000 });

      const card = page.locator('[role="button"][aria-label^="Open post"]').last();
      await card.scrollIntoViewIfNeeded();
      await expect(card).toBeVisible();
      await expect(page.locator('[data-card-ref], [data-card-pill-ref]')).toHaveCount(0);
      await expect(page.locator('[data-post-ref-key]')).toHaveCount(0);
      expect(await card.innerText()).not.toMatch(CODE);
      expect(await card.getAttribute('aria-label')).not.toMatch(CODE);

      await card.click();
      const sheet = page.getByRole('dialog').filter({ has: page.locator('[data-post-sheet]') });
      await expect(sheet).toBeVisible();
      await expect(sheet.getByRole('button', { name: 'Talk about this post' })).toBeVisible();
      expect(await sheet.innerText()).not.toMatch(CODE);
      expectNoBlocked(network);
    });
  });
}
