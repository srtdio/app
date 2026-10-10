import { expect, test, type Page } from '@playwright/test';
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

// Activity plan rows: a plan_comment or plan_review row opens the standalone
// Plan page (/plans/:planId?item=) with that item open; a comment row scrolls
// to and highlights its comment. One Back (header or browser) returns to
// Activity; a cold deep link's Back lands on Activity; an unreadable plan shows
// "Plan not available". Runs in both colour schemes (the dark and light
// projects) on the iPhone viewport. Linux WebKit approximates iOS WebKit.

const FILE_VERSION = '0190e100-0000-7000-8000-0000000000c1';
const POST_TITLE = 'Monday carousel';

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: test.info().outputPath(`${name}.png`) });
}

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

/** The Activity card whose header is `title`. */
function card(page: Page, title: string) {
  return page.locator('[data-activity-lead]').filter({ hasText: title }).first();
}

test('agency: a plan_comment row opens the item with the comment highlighted; Back = Activity', async ({
  page,
}) => {
  const network = await installHarnessNetwork(page);
  seedClientPlan(network.world, { channelId: DM_CHANNEL, sender: ME, fileVersionId: FILE_VERSION });
  seedActivityPlanComment(network.world, {
    planId: PLAN_ID,
    itemId: PLAN_CONCEPT_ITEM,
    actor: PEER,
  });

  await page.goto('/activity');
  const lead = card(page, PLAN_CONCEPT_TITLE);
  await lead.waitFor({ state: 'visible', timeout: 15_000 });
  await expect(lead.getByText(`${PEER_NAME} commented`, { exact: true })).toBeVisible();
  await expect(lead.getByText(ACTIVITY_PLAN_COMMENT_BODY)).toBeVisible();
  await expect(lead.locator('[data-activity-plan-icon]')).toBeVisible();
  await page.waitForTimeout(300);
  await shot(page, 'activity-plan-01-agency-card');

  // The tap: the standalone page with the item open, the comment highlighted.
  await lead.click();
  await expect(page).toHaveURL(
    new RegExp(
      `/plans/${PLAN_ID}\\?item=${PLAN_CONCEPT_ITEM}&comment=${ACTIVITY_PLAN_COMMENT_ID}$`,
    ),
  );
  const item = planPage(page, 'item');
  await expect(item).toBeVisible();
  await expect(item.getByRole('heading', { name: PLAN_CONCEPT_TITLE })).toBeVisible();
  const highlighted = item.locator(`[data-plan-comment-id="${ACTIVITY_PLAN_COMMENT_ID}"]`);
  await expect(highlighted).toHaveAttribute('data-plan-comment-highlight', '');
  await expect(highlighted).toBeInViewport();
  await expect(highlighted).toContainText(ACTIVITY_PLAN_COMMENT_BODY);
  // The back control is 44x44.
  const back = item.getByRole('button', { name: 'Back', exact: true });
  const box = await back.boundingBox();
  expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  await page.waitForTimeout(300);
  await shot(page, 'activity-plan-02-agency-item-highlight');
  // The highlight is brief.
  await expect(highlighted).not.toHaveAttribute('data-plan-comment-highlight', { timeout: 5000 });

  // The browser's Back once: Activity, no plan layer left behind.
  await page.goBack();
  await expect(page).toHaveURL(/\/activity$/);
  await expect(planPage(page, 'item')).toHaveCount(0);
  await expect(planPage(page, 'plan')).toHaveCount(0);
  await expect(card(page, PLAN_CONCEPT_TITLE)).toBeVisible();

  // The header's Back once: Activity too.
  await card(page, PLAN_CONCEPT_TITLE).click();
  await expect(planPage(page, 'item')).toBeVisible();
  await planPage(page, 'item').getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page).toHaveURL(/\/activity$/);
  await expect(planPage(page, 'item')).toHaveCount(0);
  await expect(planPage(page, 'plan')).toHaveCount(0);
  await page.waitForTimeout(300);
  await shot(page, 'activity-plan-03-agency-back');
  expectClean(network);
});

test('client: a plan_review row opens the post item; Back = Activity', async ({ page }) => {
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

  await page.goto('/activity');
  const lead = card(page, POST_TITLE);
  await lead.waitFor({ state: 'visible', timeout: 15_000 });
  await expect(lead.getByText('Maya Chen approved a plan item', { exact: true })).toBeVisible();
  await page.waitForTimeout(300);
  await shot(page, 'activity-plan-04-client-card');

  await lead.click();
  await expect(page).toHaveURL(new RegExp(`/plans/${PLAN_ID}\\?item=${PLAN_POST_ITEM}$`));
  const item = planPage(page, 'item');
  await expect(item).toBeVisible();
  await expect(item.getByRole('heading', { name: POST_TITLE })).toBeVisible();
  // No "Shared with/by" line outside a chat: the plan screen has no subtitle row.
  await expect(planPage(page, 'plan').getByText(/Shared (with|by)/)).toHaveCount(0);
  await page.waitForTimeout(300);
  await shot(page, 'activity-plan-05-client-item');

  await item.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page).toHaveURL(/\/activity$/);
  await expect(planPage(page, 'item')).toHaveCount(0);
  await expect(card(page, POST_TITLE)).toBeVisible();
  expectClean(network);
});

test('an unreadable plan shows "Plan not available"; a cold deep link Back lands on Activity', async ({
  page,
}) => {
  const network = await installHarnessNetwork(page);
  await page.goto(`/plans/${HIDDEN_PLAN_ID}?item=${PLAN_CONCEPT_ITEM}`);
  const plan = planPage(page, 'plan');
  await expect(plan).toBeVisible({ timeout: 15_000 });
  await expect(plan.getByText('Plan not available').first()).toBeVisible();
  await expect(planPage(page, 'item')).toHaveCount(0);
  await page.waitForTimeout(300);
  await shot(page, 'activity-plan-06-not-available');

  await plan.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page).toHaveURL(/\/activity$/);
  await expect(planPage(page, 'plan')).toHaveCount(0);
  expectClean(network);
});
