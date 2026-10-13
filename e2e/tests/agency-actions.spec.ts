import { expect, test } from '@playwright/test';
import { installHarnessNetwork, type HarnessNetwork } from '../fixtures/harness-routes';
import { COLLEAGUE_A, ME, POST_IDS, WORKSPACE_ID } from '../fixtures/chat-data';

// Agency acts on behalf of client. The harness viewer (ME) is the workspace
// owner, an agency-side role: on a post in review the PCS rail offers Approve
// with the two-step confirm plus the on-behalf line, and Activity names who
// approved with "on behalf of client". The real app tree runs against fixture
// data in both colour schemes; Linux WebKit approximates iOS WebKit, it is not iOS.

const KEY = 'hs';

function expectNoBlocked(network: HarnessNetwork): void {
  expect(network.blocked, 'blocked non-fixture requests').toEqual([]);
}

/** Give the fixture workspace a key so refs read KEY-N (spec-local world edit). */
function withKey(network: HarnessNetwork): void {
  const ws = network.world.tables.workspaces?.[0];
  if (ws !== undefined) ws.key = KEY;
}

test('PCS: agency approves with the on-behalf line in the confirm', async ({ page }) => {
  const network = await installHarnessNetwork(page);
  withKey(network);
  await page.goto(`/posts/${POST_IDS[0]}`);

  const approve = page.getByRole('button', { name: 'Approve', exact: true }).first();
  await approve.waitFor({ state: 'visible', timeout: 15_000 });
  await expect(
    page.getByText('Waiting on the client. You can approve on their behalf.').first(),
  ).toBeVisible();
  // Agency sees Approve and Reject in review (and Park).
  await expect(page.getByRole('button', { name: 'Reject', exact: true }).first()).toBeVisible();
  await approve.click();

  const line = page.locator('[data-approve-on-behalf]');
  await expect(line).toHaveText('You are approving on behalf of client.');
  await expect(page.locator('[data-approve-confirm-button]')).toHaveText('Approve HS-101');
  // Back sends nothing.
  await page.locator('[data-approve-back]').click();
  await expect(line).toHaveCount(0);
  expectNoBlocked(network);
});

test('Activity: "<Name> approved KEY-N on behalf of client"', async ({ page }) => {
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
  await page.goto('/activity');

  await expect(page.getByText('Leo Martins approved HS-101 on behalf of client')).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText('Leo Martins deleted 3 assets', { exact: true })).toBeVisible();
  await expect(page.getByText('Moved to', { exact: false })).toHaveCount(0);
  expectNoBlocked(network);
});
