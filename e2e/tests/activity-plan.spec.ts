import { expect, test, type Page } from '@playwright/test';
import { expectMinTouchTarget } from '../helpers/touch-target';
import {
  ACTIVITY_PLAN_COMMENT_BODY,
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

// Plan rows live in the chat bell, never in Activity (item 12): a
// plan_comment or plan_review row shows in the bell's Plans section with its
// Activity wording; a tap marks it read and opens the standalone Plan page
// (/plans/:planId?item=) with that item open, and Activity shows no plan card.
// A cold deep link to an unreadable plan shows "Plan not available" and Back
// lands on Activity. Runs in both colour schemes (the dark and light projects)
// on the iPhone viewport. Linux WebKit approximates iOS WebKit.

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

/** Open the chat bell on the Chat home and wait for its rows. */
async function openBell(page: Page): Promise<void> {
  await page.goto('/chat');
  const bell = page.locator('[data-bell-button]');
  await bell.waitFor({ state: 'visible', timeout: 15_000 });
  await bell.click();
  await page.locator('[data-bell-skeleton]').waitFor({ state: 'detached' });
}

test('agency: a plan_comment row is a bell row (not Activity) and opens the item', async ({
  page,
}) => {
  const network = await installHarnessNetwork(page);
  seedClientPlan(network.world, { channelId: DM_CHANNEL, sender: ME, fileVersionId: FILE_VERSION });
  seedActivityPlanComment(network.world, {
    planId: PLAN_ID,
    itemId: PLAN_CONCEPT_ITEM,
    actor: PEER,
  });

  // Activity drops it through the bell split.
  await page.goto('/activity');
  await page.waitForTimeout(1500);
  await expect(card(page, PLAN_CONCEPT_TITLE)).toHaveCount(0);
  await expect(page.locator('[data-activity-plan-icon]')).toHaveCount(0);
  await shot(page, 'activity-plan-01-activity-no-plan-row');

  await openBell(page);
  const row = page.locator('[data-bell-row="plan"]');
  await expect(row).toHaveCount(1);
  await expect(page.locator('[data-bell-section="plans"]')).toBeVisible();
  await expect(row).toContainText(`${PEER_NAME} commented on a plan item`);
  expectMinTouchTarget(await row.locator('[data-bell-open]').boundingBox());
  await page.waitForTimeout(300);
  await shot(page, 'activity-plan-02-bell-row');

  // The tap: marked read, then the standalone page with the item open.
  await row.locator('[data-bell-open]').click();
  await expect(page).toHaveURL(new RegExp(`/plans/${PLAN_ID}\\?item=${PLAN_CONCEPT_ITEM}$`));
  const item = planPage(page, 'item');
  await expect(item).toBeVisible();
  await expect(item.getByRole('heading', { name: PLAN_CONCEPT_TITLE })).toBeVisible();
  await expect(item.getByText(ACTIVITY_PLAN_COMMENT_BODY)).toBeVisible();
  expectMinTouchTarget(await item.getByRole('button', { name: 'Back', exact: true }).boundingBox());
  await page.waitForTimeout(300);
  await shot(page, 'activity-plan-03-agency-item');
  expectClean(network);
});

test('client: a plan_review row is a bell row and opens the post item', async ({ page }) => {
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
  await page.waitForTimeout(1500);
  await expect(card(page, POST_TITLE)).toHaveCount(0);

  await openBell(page);
  const row = page.locator('[data-bell-row="plan"]');
  await expect(row).toContainText('Maya Chen approved a plan item');
  await page.waitForTimeout(300);
  await shot(page, 'activity-plan-04-client-bell-row');

  await row.locator('[data-bell-open]').click();
  await expect(page).toHaveURL(new RegExp(`/plans/${PLAN_ID}\\?item=${PLAN_POST_ITEM}$`));
  const item = planPage(page, 'item');
  await expect(item).toBeVisible();
  await expect(item.getByRole('heading', { name: POST_TITLE })).toBeVisible();
  await page.waitForTimeout(300);
  await shot(page, 'activity-plan-05-client-item');
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
