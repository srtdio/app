import { expect, test, type Page } from '@playwright/test';
import { installHarnessNetwork, type HarnessNetwork } from '../fixtures/harness-routes';
import { COLLEAGUE_A, ME, POST_IDS, setHarnessPlatform, WORKSPACE_ID } from '../fixtures/chat-data';
import { expectMinTouchTarget } from '../helpers/touch-target';

// Agency acts on behalf of client. The harness viewer (ME) is the workspace
// owner, an agency-side role: on a post in review the post's ⋯ sheet offers
// "Approve for {brand}" (flow B 31: creators never get a primary Approve) with
// the two-step confirm plus the on-behalf line, and Activity names who
// approved with "on behalf of client". The real app tree runs against fixture
// data in both colour schemes; Linux WebKit approximates iOS WebKit, it is not iOS.

const KEY = 'hs';

function expectNoBlocked(network: HarnessNetwork): void {
  expect(network.blocked, 'blocked non-fixture requests').toEqual([]);
}

/** Give the fixture workspace a key, so a regression would print KEY-N (spec-local world edit). */
function withKey(network: HarnessNetwork): void {
  const ws = network.world.tables.workspaces?.[0];
  if (ws !== undefined) ws.key = KEY;
}

test('PCS: agency approves with the on-behalf line in the confirm', async ({ page }) => {
  const network = await installHarnessNetwork(page);
  withKey(network);
  await page.goto(`/posts/${POST_IDS[0]}`);

  const more = page.getByRole('button', { name: 'Post actions' });
  await more.waitFor({ state: 'visible', timeout: 15_000 });
  // Flow B 31: no primary Approve for the creator side.
  await expect(page.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
  await more.click();
  const sheet = page.getByRole('dialog', { name: 'Post actions', exact: true });
  // Approve for {brand}, Reject and Park sit in the ⋯ sheet.
  await expect(sheet.getByRole('button', { name: /Reject/ })).toBeVisible();
  await expect(sheet.getByRole('button', { name: /Park/ })).toBeVisible();
  await sheet.getByRole('button', { name: /Approve for Harness Studio/ }).click();

  const line = page.locator('[data-approve-on-behalf]');
  await expect(line).toHaveText('You are approving on behalf of Harness Studio.');
  // Codes are not shown: the confirm button reads "Approve" alone.
  await expect(page.locator('[data-approve-confirm-button]')).toHaveText('Approve');
  await expect(page.getByText('HS-101', { exact: false })).toHaveCount(0);
  // Back sends nothing.
  await page.locator('[data-approve-back]').click();
  await expect(line).toHaveCount(0);
  expectNoBlocked(network);
});

test('Activity: "<Name> approved" under the title, no brand suffix, never KEY-N', async ({
  page,
}) => {
  const network = await installHarnessNetwork(page);
  withKey(network);
  const now = new Date().toISOString();
  network.world.tables.inbox_entries?.push(
    {
      id: '0190f100-0000-7000-8000-0000000000a1',
      user_id: ME,
      actor_user_id: COLLEAGUE_A,
      workspace_id: WORKSPACE_ID,
      event_type: 'stage_change',
      entity_type: 'post',
      entity_id: POST_IDS[0],
      scope: 'posts',
      scope_key: POST_IDS[0],
      tier: 'active',
      payload: { from: 'review', to: 'approved', actor_role: 'agency' },
      read_at: null,
      snoozed_until: null,
      email_sent_at: null,
      deleted_at: null,
      created_at: now,
    },
    {
      id: '0190f100-0000-7000-8000-0000000000a2',
      user_id: ME,
      actor_user_id: COLLEAGUE_A,
      workspace_id: WORKSPACE_ID,
      event_type: 'assets_deleted',
      entity_type: 'workspace',
      entity_id: WORKSPACE_ID,
      scope: 'everything',
      scope_key: WORKSPACE_ID,
      tier: 'active',
      payload: { count: 3, filenames: ['a.png', 'b.png', 'c.png'], actor_role: 'agency' },
      read_at: null,
      snoozed_until: null,
      email_sent_at: null,
      deleted_at: null,
      created_at: now,
    },
  );
  await page.goto('/notifications');

  // The title shows once, in the card header; the line keeps the stage change only.
  await expect(page.getByText('Leo Martins approved', { exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText(/on behalf of/)).toHaveCount(0);
  await expect(page.getByText('Monday carousel', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('HS-101', { exact: false })).toHaveCount(0);
  await expect(page.getByText('Leo Martins deleted 3 assets', { exact: true })).toBeVisible();
  await expect(page.getByText('Moved to', { exact: false })).toHaveCount(0);
  expectNoBlocked(network);
});

// A post's platform always equals its workspace's. The PCS "{Platform} preview"
// chip and panel name the workspace platform and list that platform's sizes.
// Tagged @theme for light and dark.

function workspaceLabel(page: Page) {
  return (page.viewportSize()?.width ?? 0) >= 768
    ? page.locator('aside button').first()
    : page.getByRole('button', { name: 'Switch workspace' });
}

const CASES = [
  { platform: 'linkedin', label: 'LinkedIn', format: 'carousel', size: '1200 x 627 · 1.91:1' },
  { platform: 'instagram', label: 'Instagram', format: 'carousel', size: '1080 x 566 · 1.91:1' },
] as const;

for (const c of CASES) {
  test(`a post in a ${c.label} workspace shows the ${c.label} preview @theme`, async ({ page }) => {
    const network = await installHarnessNetwork(page);
    setHarnessPlatform(network.world, c.platform, c.format);
    await page.goto(`/posts/${POST_IDS[0]}`);

    await expect(workspaceLabel(page)).toContainText(`Harness Studio - ${c.label}`, {
      timeout: 15_000,
    });
    const chip = page.getByRole('button', { name: `${c.label} preview` });
    await expect(chip).toBeVisible();
    expectMinTouchTarget(await chip.boundingBox());
    await chip.click();

    const panel = page.getByRole('dialog', { name: `${c.label} preview` });
    await expect(panel).toBeVisible();
    // It opens on the frame the post page shows, then lists the platform's sizes.
    await expect(panel.getByRole('radio', { name: /This post/ })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await expect(panel.getByRole('radio', { name: /Portrait/ })).toBeVisible();
    await expect(panel).toContainText(c.size);
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
    expect(network.blocked, 'blocked non-fixture requests').toEqual([]);
  });
}
