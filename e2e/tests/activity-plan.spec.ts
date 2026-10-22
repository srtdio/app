import { expect, test, type Page } from '@playwright/test';
import { expectMinTouchTarget } from '../helpers/touch-target';
import {
  ACTIVITY_PLAN_COMMENT_BODY,
  ACTIVITY_PLAN_COMMENT_ID,
  installHarnessNetwork,
  seedActivityPlanComment,
  seedActivityPlanReview,
  type HarnessNetwork,
} from '../fixtures/harness-routes';
import {
  DM_CHANNEL,
  HIDDEN_PLAN_ID,
  MAYA,
  ME,
  PEER,
  PEER_NAME,
  PLAN_CONCEPT_ITEM,
  PLAN_CONCEPT_TITLE,
  PLAN_ID,
  PLAN_POST_ITEM,
  seedClientPlan,
} from '../fixtures/chat-data';

// Plan rows on Notifications (the bell merged into Activity): a plan_comment
// or plan_review row is an Activity plan-item card with its Activity wording,
// listed under All and the Plans chip; a tap marks it read and opens the
// standalone Plan page (/plans/:planId?item=, a comment adds &comment=) with
// that item open. A cold deep link to an unreadable plan shows "Plan not
// available" and Back lands on Notifications. Runs in both colour schemes (the
// dark and light projects) on the iPhone viewport. Linux WebKit approximates
// iOS WebKit.

const FILE_VERSION = '0190e100-0000-7000-8000-0000000000c1';
const POST_TITLE = 'Monday carousel';

function expectClean(network: HarnessNetwork): void {
  expect(network.blocked, 'blocked non-fixture requests').toEqual([]);
  expect([...new Set(network.unmatched)], 'unrecognised fixture requests').toEqual([]);
}

/** Make the viewer a client (the DM peer agency side). */
function viewAsClient(network: HarnessNetwork): void {
  for (const m of network.world.tables.workspace_members ?? []) {
    if (m.user_id === ME) m.role = 'client';
    if (m.user_id === PEER) m.role = 'agency';
  }
}

const planPage = (page: Page, id: string) => page.locator(`[data-plan-page="${id}"]`);

/** The Notifications card whose header is `title`. */
function card(page: Page, title: string) {
  return page.locator('[data-activity-lead]').filter({ hasText: title }).first();
}

test('agency: a plan_comment row is a Notifications card (All and Plans) and opens the item', async ({
  page,
}) => {
  const network = await installHarnessNetwork(page);
  seedClientPlan(network.world, { channelId: DM_CHANNEL, sender: ME, fileVersionId: FILE_VERSION });
  seedActivityPlanComment(network.world, {
    planId: PLAN_ID,
    itemId: PLAN_CONCEPT_ITEM,
    actor: PEER,
  });

  await page.goto('/notifications');
  const row = card(page, PLAN_CONCEPT_TITLE);
  await expect(row).toBeVisible({ timeout: 15_000 });
  await expect(row).toContainText(`${PEER_NAME} commented`);
  await expect(row).toContainText(ACTIVITY_PLAN_COMMENT_BODY);
  await expect(page.locator('[data-activity-plan-icon]')).toHaveCount(1);

  // The Plans chip lists it too.
  await page.getByRole('button', { name: 'Plans', exact: true }).click();
  await expect(row).toBeVisible();
  expectMinTouchTarget(await row.boundingBox());

  // The tap: marked read, then the standalone page with the item open.
  await row.click();
  await expect(page).toHaveURL(
    new RegExp(
      `/plans/${PLAN_ID}\\?item=${PLAN_CONCEPT_ITEM}&comment=${ACTIVITY_PLAN_COMMENT_ID}$`,
    ),
  );
  const item = planPage(page, 'item');
  await expect(item).toBeVisible();
  await expect(item.getByRole('heading', { name: PLAN_CONCEPT_TITLE })).toBeVisible();
  await expect(item.getByText(ACTIVITY_PLAN_COMMENT_BODY)).toBeVisible();
  expectMinTouchTarget(await item.getByRole('button', { name: 'Back', exact: true }).boundingBox());
  expect(network.rpcCalls.filter((c) => c.name === 'inbox_mark_read')).toHaveLength(1);
  expectClean(network);
});

test('client: a plan_review row is a Notifications card and opens the post item', async ({
  page,
}) => {
  const network = await installHarnessNetwork(page);
  viewAsClient(network);
  seedClientPlan(network.world, {
    channelId: DM_CHANNEL,
    sender: PEER,
    fileVersionId: FILE_VERSION,
  });
  seedActivityPlanReview(network.world, {
    planId: PLAN_ID,
    itemId: PLAN_POST_ITEM,
    actor: MAYA,
    side: 'client',
    status: 'approved',
  });

  await page.goto('/notifications');
  const row = card(page, POST_TITLE);
  await expect(row).toContainText('Maya Chen approved a plan item', { timeout: 15_000 });

  await row.click();
  await expect(page).toHaveURL(new RegExp(`/plans/${PLAN_ID}\\?item=${PLAN_POST_ITEM}$`));
  const item = planPage(page, 'item');
  await expect(item).toBeVisible();
  await expect(item.getByRole('heading', { name: POST_TITLE })).toBeVisible();
  expectClean(network);
});

test('an unreadable plan shows "Plan not available"; a cold deep link Back lands on Notifications', async ({
  page,
}) => {
  const network = await installHarnessNetwork(page);
  await page.goto(`/plans/${HIDDEN_PLAN_ID}?item=${PLAN_CONCEPT_ITEM}`);
  const plan = planPage(page, 'plan');
  await expect(plan).toBeVisible({ timeout: 15_000 });
  await expect(plan.getByText('Plan not available').first()).toBeVisible();
  await expect(planPage(page, 'item')).toHaveCount(0);

  await plan.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page).toHaveURL(/\/notifications$/);
  await expect(planPage(page, 'plan')).toHaveCount(0);
  expectClean(network);
});
