import { expect, test, type Page } from '@playwright/test';
import { installHarnessNetwork, type HarnessNetwork } from '../fixtures/harness-routes';
import {
  DM_CHANNEL,
  DRAFT_ITEM_ID,
  DRAFT_PLAN_ID,
  ENDED_PLAN_TITLE,
  GROUP_CHANNEL,
  GROUP_NAME,
  ME,
  PEER,
  PEER_NAME,
  TEAM_PLAN_ID,
  UPCOMING_CLIENT_PLAN_ID,
  UPCOMING_CLIENT_PLAN_TITLE,
  UPCOMING_TEAM_PLAN_ID,
  seedClientPlanWithDraft,
  seedTeamAndHiddenPlans,
  seedUpcomingPlans,
} from '../fixtures/chat-data';
import { expectMinTouchTarget } from '../helpers/touch-target';

// The Plans sheet: the agency's Plan tile lists upcoming plans ("Plans"); a
// row opens that plan's Plan screen and never sends. From the screen a plan
// is sent with "Send in {chat}"; a Draft plan in a chat with a client is held
// back until "Open for client" (plan_share_with_client). The agency's Forward
// of a Draft card into a chat with a client sends nothing ("Open the plan for
// client first."), a client sees a draft post by name only, and the empty
// list. Runs in both colour schemes (the dark and light projects).

async function openChat(page: Page, name: string): Promise<void> {
  await page.goto('/chat');
  const row = page.getByText(name, { exact: true }).first();
  await row.waitFor({ state: 'visible' });
  await row.click();
  await page.locator('[data-msg-id]').first().waitFor({ state: 'visible', timeout: 8000 });
  await page.waitForTimeout(300);
}

function expectClean(network: HarnessNetwork): void {
  expect(network.blocked, 'blocked non-fixture requests').toEqual([]);
  expect([...new Set(network.unmatched)], 'unrecognised fixture requests').toEqual([]);
}

async function openPicker(page: Page): Promise<ReturnType<Page['getByRole']>> {
  const plus = page.getByRole('button', { name: 'Add attachment' });
  test.skip((await plus.count()) === 0, 'no upload endpoint in this env: the plus tray is off');
  await plus.click();
  await expect(page.locator('[data-tray]')).toBeVisible();
  await page.waitForTimeout(250);
  await page.locator('[data-tray-tile="plan"]').click();
  const picker = page.getByRole('dialog', { name: 'Plans' });
  await expect(picker).toBeVisible();
  return picker;
}

function sharedPlans(network: HarnessNetwork, channelId: string): unknown[] {
  return (network.world.tables.chat_messages ?? [])
    .filter((m) => m.channel_id === channelId && Array.isArray(m.shared_plan_ids))
    .map((m) => m.shared_plan_ids);
}

function viewAsClient(network: HarnessNetwork): void {
  for (const m of network.world.tables.workspace_members ?? []) {
    if (m.user_id === ME) m.role = 'client';
    if (m.user_id === PEER) m.role = 'agency';
  }
}

test('agency: Plans lists upcoming plans; a row opens the plan, never sends; send from the screen', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const network = await installHarnessNetwork(page);
  seedUpcomingPlans(network.world, { sender: ME });
  await openChat(page, PEER_NAME);

  const picker = await openPicker(page);
  await expect(picker.getByText('Upcoming plans in Harness Studio')).toBeVisible();
  const rows = picker.locator('[data-plan-pick]');
  await expect(rows).toHaveCount(2);
  // Ending soonest first; the ended plan never shows.
  expect(
    await rows.evaluateAll((els) => els.map((el) => el.getAttribute('data-plan-pick'))),
  ).toEqual([UPCOMING_TEAM_PLAN_ID, UPCOMING_CLIENT_PLAN_ID]);
  await expect(picker.getByText(ENDED_PLAN_TITLE)).toHaveCount(0);
  const teamRow = picker.locator(`[data-plan-pick="${UPCOMING_TEAM_PLAN_ID}"]`);
  await expect(teamRow.locator('[data-plan-chip="warn"]')).toHaveText('Draft');
  await expect(teamRow.getByText('1 concept')).toBeVisible();
  await expect(teamRow.getByText('1 post')).toBeVisible();
  await expect(picker.locator('[data-plan-chip="accent"]')).toHaveCount(0);
  await expect(picker.getByText(UPCOMING_CLIENT_PLAN_TITLE)).toBeVisible();
  await expect(picker.locator('[data-plan-pick-new]')).toHaveText(/New plan/);
  expectMinTouchTarget(await teamRow.boundingBox());
  expectMinTouchTarget(await picker.locator('[data-plan-pick-new]').boundingBox());

  // A row opens that plan's screen; nothing is sent.
  await picker.locator(`[data-plan-pick="${UPCOMING_CLIENT_PLAN_ID}"]`).click();
  await expect(picker).toBeHidden();
  const plan = page.locator('[data-plan-page="plan"]');
  await expect(plan).toBeVisible();
  await expect(plan.getByRole('heading', { name: UPCOMING_CLIENT_PLAN_TITLE })).toBeVisible();
  expect(sharedPlans(network, DM_CHANNEL)).toEqual([]);
  expect(network.rpcCalls.filter((c) => c.name === 'chat_plan_share')).toHaveLength(0);
  // Send in this chat from the screen (an Open plan).
  await plan.locator('[data-plan-send-here]').click();
  await expect(plan.locator('[data-plan-go-card]')).toBeVisible();
  expect(sharedPlans(network, DM_CHANNEL)).toEqual([[UPCOMING_CLIENT_PLAN_ID]]);
  expect(network.rpcCalls.filter((c) => c.name === 'plan_share_with_client')).toHaveLength(0);
  await page.goBack();
  await expect(plan).toBeHidden();

  // Again: the shared plan now reads "In this chat".
  const again = await openPicker(page);
  await expect(
    again.locator(`[data-plan-pick="${UPCOMING_CLIENT_PLAN_ID}"] [data-plan-chip="accent"]`),
  ).toHaveText('In this chat');

  // The Draft plan in a chat with a client: the screen holds the send back.
  await again.locator(`[data-plan-pick="${UPCOMING_TEAM_PLAN_ID}"]`).click();
  await expect(plan).toBeVisible();
  const send = plan.locator('[data-plan-send-here]');
  await expect(send).toBeDisabled();
  await expect(plan.locator('[data-plan-send-hint]')).toHaveText(
    'Open the plan for client to send it here.',
  );
  await expect(page.getByRole('dialog', { name: 'Share with client first?' })).toHaveCount(0);

  // Open for client, then send: two separate writes.
  await plan.locator('[data-plan-open-client]').click();
  const confirm = page.getByRole('dialog', { name: 'Open this plan for client?' });
  await expect(confirm).toBeVisible();
  const from = network.rpcCalls.length;
  await confirm.locator('[data-plan-confirm]').click();
  await expect(confirm).toBeHidden();
  await expect(send).toBeEnabled();
  await send.click();
  await expect(plan.locator('[data-plan-go-card]')).toBeVisible();
  const calls = network.rpcCalls
    .slice(from)
    .filter((c) => c.name === 'plan_share_with_client' || c.name === 'chat_plan_share');
  expect(calls.map((c) => c.name)).toEqual(['plan_share_with_client', 'chat_plan_share']);
  expect(calls[0]?.args.p_plan_id).toBe(UPCOMING_TEAM_PLAN_ID);
  expect(
    (network.world.tables.plans ?? []).find((p) => p.id === UPCOMING_TEAM_PLAN_ID)?.audience,
  ).toBe('client');
  expect(sharedPlans(network, DM_CHANNEL)).toEqual([
    [UPCOMING_CLIENT_PLAN_ID],
    [UPCOMING_TEAM_PLAN_ID],
  ]);
  await plan.locator('[data-plan-go-card]').click();
  await expect(plan).toBeHidden();
  const teamCard = page.locator(`[data-plan-card="${UPCOMING_TEAM_PLAN_ID}"]`);
  await expect(teamCard).toBeInViewport();
  // Open for client: no "Draft" chip any more.
  await expect(teamCard.locator('[data-plan-chip="warn"]')).toHaveCount(0);
  // The ticker's plan: the soonest ending, now shared here (Plan A/N).
  const tickerPlan = page.locator('[data-loops-strip="open"] [data-status-item="plan"]');
  await expect(tickerPlan).toBeVisible();
  await expect(tickerPlan).toHaveAttribute('aria-label', 'Plan 0 of 2 approved by client');
  expectClean(network);
});

test('agency: Forward a Draft plan into a client chat sends nothing', async ({ page }) => {
  test.setTimeout(90_000);
  const network = await installHarnessNetwork(page);
  seedTeamAndHiddenPlans(network.world, { channelId: GROUP_CHANNEL, sender: ME });
  await openChat(page, GROUP_NAME);
  const card = page.locator(`[data-plan-card="${TEAM_PLAN_ID}"]`);
  await card.scrollIntoViewIfNeeded();
  await expect(card.locator('[data-plan-chip="warn"]')).toHaveText('Draft');
  await card.locator('[data-plan-forward]').click();
  const forward = page.getByRole('dialog', { name: 'Forward plan' });
  await expect(forward).toBeVisible();
  const target = forward.locator(`[data-plan-forward-target="${DM_CHANNEL}"]`);
  await expect(target.locator('[data-plan-has-client]')).toHaveText('Has client');
  await expect(
    forward.locator(`[data-plan-forward-target="${GROUP_CHANNEL}"] [data-plan-has-client]`),
  ).toHaveCount(0);
  const from = network.rpcCalls.length;
  await target.click();
  await expect(page.getByText('Open the plan for client first.')).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Share with client first?' })).toHaveCount(0);
  // No plan or share write (a read cursor may land meanwhile).
  expect(
    network.rpcCalls
      .slice(from)
      .map((c) => c.name)
      .filter((n) => n.startsWith('plan_') || n === 'chat_plan_share'),
  ).toEqual([]);
  expect(sharedPlans(network, DM_CHANNEL)).toEqual([]);
  expectClean(network);
});

test('client: a draft post in a client plan shows by name only and does nothing', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const network = await installHarnessNetwork(page);
  viewAsClient(network);
  seedClientPlanWithDraft(network.world, { channelId: DM_CHANNEL, sender: PEER });
  await openChat(page, PEER_NAME);
  const card = page.locator(`[data-plan-card="${DRAFT_PLAN_ID}"]`);
  await card.scrollIntoViewIfNeeded();
  // The draft counts: 1 concept, 1 post, 0 of 2.
  await expect(card.getByText('1 post')).toBeVisible();
  await expect(card.locator('[data-plan-progress]')).toHaveText('Client 0 of 2');
  await card.locator('[data-plan-open]').click();
  const plan = page.locator('[data-plan-page="plan"]');
  await expect(plan).toBeVisible();
  const row = plan.locator(`[data-plan-row="${DRAFT_ITEM_ID}"]`);
  await row.scrollIntoViewIfNeeded();
  // A draft is name only for a client: no slot checkbox.
  await expect(plan.locator(`[data-plan-row-wrap="${DRAFT_ITEM_ID}"]`)).toHaveCount(0);
  await expect(row.locator('[data-plan-slot]')).toHaveCount(0);
  await expect(row).toHaveAttribute('aria-disabled', 'true');
  await expect(row.getByText('Not ready to view yet')).toBeVisible();
  await expect(row.getByText('Product teaser')).toBeVisible();
  // The type line says it is not ready; no separate Draft chip.
  await expect(row).toHaveAttribute('data-plan-row-draft', 'locked');
  await expect(row.locator('[data-plan-pill="draft"]')).toHaveCount(0);
  // aria-disabled: a forced tap still lands on it and opens nothing.
  await row.click({ force: true });
  await page.waitForTimeout(400);
  await expect(page.locator('[data-plan-page="item"]')).toHaveCount(0);
  expectClean(network);
});

test('agency: no upcoming plans shows the empty line and New plan', async ({ page }) => {
  test.setTimeout(60_000);
  const network = await installHarnessNetwork(page);
  await openChat(page, PEER_NAME);
  const picker = await openPicker(page);
  await expect(picker.locator('[data-plan-picker-empty]')).toContainText('No upcoming plans');
  await expect(picker.getByText("Plans that have ended don't show here.")).toBeVisible();
  await expect(picker.locator('[data-plan-pick]')).toHaveCount(0);
  await picker.locator('[data-plan-pick-new]').click();
  await expect(page.locator('[data-plan-page="compose"]')).toBeVisible();
  expectClean(network);
});
