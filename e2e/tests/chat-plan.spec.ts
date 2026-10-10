import { expect, test, type Page } from '@playwright/test';
import { installHarnessNetwork, type HarnessNetwork } from '../fixtures/harness-routes';
import {
  COLLEAGUE_A,
  DM_CHANNEL,
  GROUP_CHANNEL,
  GROUP_NAME,
  MAYA_NAME,
  ME,
  PEER,
  PEER_NAME,
  PLAN_CONCEPT_TITLE,
  PLAN_ID,
  PLAN_TITLE,
  THREAD_DM,
  WORKSPACE_ID,
  seedClientPlan,
  seedTeamAndHiddenPlans,
} from '../fixtures/chat-data';

// Plan in chat (D1 to D8): the tray's Plan tile, the New plan screen and its
// share sequence, the plan card (agency, client, team only, not available),
// the Plan and Item screens with team and client approval and Team only
// comments, Forward for a client, and back closing one layer at a time. Runs in
// both colour schemes (the dark and light projects), on the iPhone viewport and
// on a laptop. Linux WebKit approximates iOS WebKit.

const LIB_IMAGE = '0190e000-0000-7000-8000-0000000000b1';
const LIB_IMAGE_VERSION = '0190e100-0000-7000-8000-0000000000b1';

/** One library image with its current version embedded (the Assets picker read). */
function seedLibrary(network: HarnessNetwork): void {
  (network.world.tables.assets ??= []).push({
    id: LIB_IMAGE,
    workspace_id: WORKSPACE_ID,
    filename: 'reel-moodboard.png',
    display_name: null,
    uploaded_at: '2026-09-30T10:00:00Z',
    current_version_id: LIB_IMAGE_VERSION,
    folder_id: null,
    origin: 'library',
    uploaded_by: ME,
    deleted_at: null,
    current_version: {
      id: LIB_IMAGE_VERSION,
      kind: 'image',
      mime_type: 'image/png',
      size_bytes: 4321,
      width: 64,
      height: 48,
      duration_ms: null,
    },
  });
}

/** Make the viewer a client and the DM peer agency side. */
function viewAsClient(network: HarnessNetwork): void {
  for (const m of network.world.tables.workspace_members ?? []) {
    if (m.user_id === ME) m.role = 'client';
    if (m.user_id === PEER) m.role = 'agency';
  }
}

async function openChat(page: Page, name: string): Promise<void> {
  await page.goto('/chat');
  const row = page.getByText(name, { exact: true }).first();
  await row.waitFor({ state: 'visible' });
  await row.click();
  await page.locator('[data-msg-id]').first().waitFor({ state: 'visible', timeout: 8000 });
  await page.waitForTimeout(300);
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: test.info().outputPath(`${name}.png`) });
}

function expectClean(network: HarnessNetwork): void {
  expect(network.blocked, 'blocked non-fixture requests').toEqual([]);
  expect([...new Set(network.unmatched)], 'unrecognised fixture requests').toEqual([]);
}

async function openTray(page: Page): Promise<void> {
  const plus = page.getByRole('button', { name: 'Add attachment' });
  test.skip((await plus.count()) === 0, 'no upload endpoint in this env: the plus tray is off');
  await plus.click();
  await expect(page.locator('[data-tray]')).toBeVisible();
  await page.waitForTimeout(250);
}

const page_ = (page: Page, id: string) => page.locator(`[data-plan-page="${id}"]`);

async function agencyFlow(page: Page, prefix: string): Promise<void> {
  test.setTimeout(120_000);
  const network = await installHarnessNetwork(page);
  seedLibrary(network);
  await openChat(page, PEER_NAME);

  // D1: the Plan tile is live for the agency side.
  await openTray(page);
  const tile = page.locator('[data-tray-tile="plan"]');
  await expect(tile).toBeEnabled();
  await shot(page, `${prefix}-01-tray-agency`);
  await tile.click();

  // D2: the New plan screen.
  const compose = page_(page, 'compose');
  await expect(compose).toBeVisible();
  await expect(compose.getByText('Who can see it').first()).toBeVisible();
  await expect(compose.locator('[data-plan-audience="client"]')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  // A chat with a client: no "Add drafts".
  await expect(compose.locator('[data-plan-add-drafts]')).toHaveCount(0);
  await page.waitForTimeout(300);
  await shot(page, `${prefix}-02-new-plan-empty`);
  await compose.locator('[data-plan-title]').fill(PLAN_TITLE);

  // One concept with one library file.
  await compose.locator('[data-plan-add-concept]').click();
  const concept = page.getByRole('dialog', { name: 'Add concept' });
  await expect(concept).toBeVisible();
  await concept.locator('[data-plan-concept-title]').fill('Season opening reel');
  await concept.locator('[data-plan-concept-description]').fill('Morning light, no voiceover.');
  await concept.locator('[data-plan-concept-files]').click();
  const assets = page.getByRole('dialog', { name: 'Add from Assets' });
  await expect(assets).toBeVisible();
  await assets.locator(`[data-asset-tile="${LIB_IMAGE}"]`).click();
  await assets.getByRole('button', { name: 'Add (1)' }).click();
  await expect(assets).toBeHidden();
  await expect(concept.locator('[data-plan-concept-file]')).toHaveCount(1);
  await page.waitForTimeout(300);
  await shot(page, `${prefix}-03-add-concept`);
  await concept.locator('[data-plan-concept-save]').click();
  await expect(concept).toBeHidden();
  await expect(compose.locator('[data-plan-draft-concept]')).toHaveCount(1);

  // One post from Pipeline.
  await compose.locator('[data-plan-add-posts]').click();
  const posts = page.getByRole('dialog', { name: 'Share a post' });
  await expect(posts).toBeVisible();
  await posts.getByRole('button', { name: /Monday carousel/ }).click();
  await posts.getByRole('button', { name: 'Done (1)' }).click();
  await expect(posts).toBeHidden();
  await expect(compose.locator('[data-plan-draft-post]')).toHaveCount(1);
  await page.waitForTimeout(300);
  await shot(page, `${prefix}-04-new-plan-filled`);

  // Share in chat: the screen closes, the card lands, the toast says so.
  await compose.locator('[data-plan-share]').click();
  await expect(compose).toBeHidden();
  // "Plan shared" sits just above the composer (never over a page header).
  const notice = page.locator('[data-plan-shared-notice="shown"]');
  await expect(notice).toHaveText('Plan shared');
  const noticeBox = await notice.locator('span').boundingBox();
  const composerBox = await page.locator('form:has(textarea)').first().boundingBox();
  expect(noticeBox).not.toBeNull();
  expect(composerBox).not.toBeNull();
  if (noticeBox !== null && composerBox !== null) {
    expect(noticeBox.y + noticeBox.height).toBeLessThanOrEqual(composerBox.y);
    expect(noticeBox.y).toBeGreaterThan(80);
  }
  const tables = network.world.tables;
  expect(tables.plans).toHaveLength(1);
  const planId = String(tables.plans?.[0]?.id);
  expect((tables.plan_items ?? []).filter((i) => i.plan_id === planId)).toHaveLength(2);
  expect(
    (tables.asset_attachments ?? []).filter((a) => a.entity_type === 'plan_item'),
  ).toHaveLength(1);
  const shared = (tables.chat_messages ?? []).filter(
    (m) => m.channel_id === DM_CHANNEL && Array.isArray(m.shared_plan_ids),
  );
  expect(shared.map((m) => m.shared_plan_ids)).toEqual([[planId]]);
  const card = page.locator(`[data-plan-card="${planId}"]`);
  await card.scrollIntoViewIfNeeded();
  await expect(card).toBeVisible();
  await expect(card.getByText('1 concept')).toBeVisible();
  await expect(card.getByText('1 post')).toBeVisible();
  await expect(card.getByText('Team 0 of 2 · Client 0 of 2')).toBeVisible();
  await expect(card.locator('[data-plan-forward]')).toHaveCount(0);
  await page.waitForTimeout(400);
  await shot(page, `${prefix}-05-card-agency`);

  // D4: the Plan screen.
  await card.locator('[data-plan-open]').click();
  const plan = page_(page, 'plan');
  await expect(plan).toBeVisible();
  await expect(plan.getByText(`Shared with ${PEER_NAME}`)).toBeVisible();
  await expect(plan.locator('[data-plan-tab="concept"]')).toHaveText('Concepts 1');
  await expect(plan.locator('[data-plan-tab="post"]')).toHaveText('Posts 1');
  const row = plan.locator('[data-plan-row]').first();
  await expect(row.getByText('Team · Waiting')).toBeVisible();
  await page.waitForTimeout(300);
  await shot(page, `${prefix}-06-plan-screen-agency`);

  // D5: the Item screen, team approve with its confirm.
  await row.click();
  const item = page_(page, 'item');
  await expect(item).toBeVisible();
  await expect(item.getByText('Concept 1 of 1')).toBeVisible();
  await expect(item.locator('[data-plan-media="files"]')).toBeVisible();
  await page.waitForTimeout(300);
  await shot(page, `${prefix}-07-item-concept-agency`);
  await item.locator('[data-plan-approve]').click();
  const confirm = page.getByRole('dialog', { name: 'Team approve' });
  await expect(confirm).toBeVisible();
  await expect(confirm.getByText(/Only the team sees this/)).toBeVisible();
  await page.waitForTimeout(300);
  await shot(page, `${prefix}-08-confirm-team-approve`);
  await confirm.locator('[data-plan-confirm]').click();
  await expect(confirm).toBeHidden();
  await expect(item.locator('[data-plan-status] [data-plan-pill="team"]')).toHaveText('Approved');

  // A Team only comment: tinted, with the lock label.
  await item.locator('[data-plan-visibility="team"]').click();
  await item.getByRole('textbox', { name: 'Comment' }).fill('Need drone shots, checking Tuesday.');
  await item.getByRole('button', { name: 'Send comment' }).click();
  const note = item.locator('[data-plan-comment="team"]');
  await expect(note).toBeVisible();
  await expect(note.getByText('Team only')).toBeVisible();
  await expect(note).toHaveClass(/bg-warn-soft/);
  await page.waitForTimeout(300);
  await shot(page, `${prefix}-09-team-comment`);

  // Back closes one layer at a time: item, then plan; the chat stays open.
  await page.goBack();
  await expect(item).toBeHidden();
  await expect(plan).toBeVisible();
  await expect(plan.locator('[data-plan-row]').first().getByText('Team · Approved')).toBeVisible();
  await expect(plan.locator('[data-plan-row]').first().getByText('1 comment')).toBeVisible();

  // A post item for the agency: Open in pipeline and Team approve.
  await plan.locator('[data-plan-tab="post"]').click();
  await plan.locator('[data-plan-row]').first().click();
  await expect(item).toBeVisible();
  await expect(item.getByText('Post 1 of 1')).toBeVisible();
  await expect(item.locator('[data-plan-pipeline]')).toBeVisible();
  await expect(item.locator('[data-plan-approve]')).toHaveText('Team approve');
  await expect(item.locator('[data-plan-ask]')).toHaveCount(0);
  await page.waitForTimeout(400);
  await shot(page, `${prefix}-10-item-post-agency`);

  // G2: the open item is removed elsewhere; the re-read closes the Item layer
  // through its own close (its history step released), the Plan stays.
  const openItems = network.world.tables.plan_items ?? [];
  const postAt = openItems.findIndex((i) => i.plan_id === planId && i.kind === 'post');
  expect(postAt).toBeGreaterThanOrEqual(0);
  openItems.splice(postAt, 1);
  await page.evaluate((id) => {
    window.dispatchEvent(new CustomEvent('sorted:plan-changed', { detail: { planId: id } }));
  }, planId);
  await expect(item).toBeHidden();
  await expect(plan).toBeVisible();
  await page.waitForTimeout(400);
  // No extra pop: the Plan layer is still open after the Item closed itself.
  await expect(plan).toBeVisible();
  await expect(plan.locator('[data-plan-tab="post"]')).toHaveText('Posts 0');
  // Back once returns to the thread.
  await page.goBack();
  await expect(plan).toBeHidden();
  await expect(page.locator('[data-msg-id]').first()).toBeVisible();
  await expect(page).toHaveURL(/\/chat/);
  expectClean(network);
}

async function clientFlow(page: Page, prefix: string): Promise<void> {
  test.setTimeout(120_000);
  const network = await installHarnessNetwork(page);
  viewAsClient(network);
  seedLibrary(network);
  seedClientPlan(network.world, {
    channelId: DM_CHANNEL,
    sender: PEER,
    fileVersionId: LIB_IMAGE_VERSION,
  });
  await openChat(page, PEER_NAME);

  // D1: the Plan tile is faded and inert for a client.
  await openTray(page);
  const tile = page.locator('[data-tray-tile="plan"]');
  await expect(tile).toBeDisabled();
  await expect(tile).toHaveAttribute('aria-disabled', 'true');
  expect(Number(await tile.evaluate((el) => getComputedStyle(el).opacity))).toBeLessThan(1);
  await shot(page, `${prefix}-01-tray-client`);
  await tile.click({ force: true });
  await expect(page_(page, 'compose')).toHaveCount(0);
  await page.keyboard.press('Escape');

  // D3: the client's card has Forward.
  const card = page.locator(`[data-plan-card="${PLAN_ID}"]`).first();
  await card.scrollIntoViewIfNeeded();
  await expect(card).toBeVisible();
  await expect(card.getByText(PLAN_TITLE)).toBeVisible();
  await expect(card.locator('[data-plan-forward]')).toBeVisible();
  await page.waitForTimeout(400);
  await shot(page, `${prefix}-02-card-client`);

  // Forward to a DM: a fresh message in that chat, and the toast.
  await card.locator('[data-plan-forward]').click();
  const picker = page.getByRole('dialog', { name: 'Forward plan' });
  await expect(picker).toBeVisible();
  await page.waitForTimeout(300);
  await shot(page, `${prefix}-03-forward-picker`);
  await picker.getByRole('button', { name: new RegExp(MAYA_NAME) }).click();
  await expect(page.getByText(`Forwarded to ${MAYA_NAME}`)).toBeVisible();
  const forwarded = (network.world.tables.chat_messages ?? []).filter(
    (m) => m.channel_id === THREAD_DM && Array.isArray(m.shared_plan_ids),
  );
  expect(forwarded.map((m) => m.shared_plan_ids)).toEqual([[PLAN_ID]]);

  // G3: Forward into the chat that is open: the new card shows at once.
  const cards = page.locator(`[data-plan-card="${PLAN_ID}"]`);
  await expect(cards).toHaveCount(1);
  await card.locator('[data-plan-forward]').click();
  await expect(picker).toBeVisible();
  await picker.getByRole('button', { name: new RegExp(PEER_NAME) }).click();
  await expect(page.getByText(`Forwarded to ${PEER_NAME}`)).toBeVisible();
  await expect(cards).toHaveCount(2);
  expect(
    (network.world.tables.chat_messages ?? []).filter(
      (m) => m.channel_id === DM_CHANNEL && Array.isArray(m.shared_plan_ids),
    ),
  ).toHaveLength(2);

  // D4: the client's Plan screen (one pill per row).
  await card.locator('[data-plan-open]').click();
  const plan = page_(page, 'plan');
  await expect(plan).toBeVisible();
  await expect(plan.getByText(`Shared by ${PEER_NAME}`)).toBeVisible();
  await expect(plan.locator('[data-plan-pill="team"]')).toHaveCount(0);
  await page.waitForTimeout(300);
  await shot(page, `${prefix}-04-plan-screen-client`);

  // D5: a concept: Approve with its confirm.
  await plan.locator('[data-plan-row]').first().click();
  const item = page_(page, 'item');
  await expect(item).toBeVisible();
  await expect(item.getByText('Can we keep it under 30 seconds?')).toBeVisible();
  await expect(item.locator('[data-plan-visibility]')).toHaveCount(0);
  await page.waitForTimeout(300);
  await shot(page, `${prefix}-05-item-concept-client`);
  await item.locator('[data-plan-approve]').click();
  const confirm = page.getByRole('dialog', { name: 'Approve' });
  await expect(confirm).toBeVisible();
  await expect(
    confirm.getByText(`Approve "${PLAN_CONCEPT_TITLE}"? The team will go ahead`, { exact: false }),
  ).toBeVisible();
  await page.waitForTimeout(300);
  await shot(page, `${prefix}-06-confirm-client-approve`);
  await confirm.locator('[data-plan-confirm]').click();
  await expect(confirm).toBeHidden();
  await expect(item.locator('[data-plan-status] [data-plan-pill="client"]')).toHaveText('Approved');
  expect(network.world.tables.plan_item_reviews).toEqual([
    expect.objectContaining({ side: 'client', status: 'approved' }),
  ]);

  // A post item: "Open post" only.
  await page.goBack();
  await expect(item).toBeHidden();
  await plan.locator('[data-plan-tab="post"]').click();
  await plan.locator('[data-plan-row]').first().click();
  await expect(item).toBeVisible();
  await expect(item.locator('[data-plan-open-post]')).toBeVisible();
  await expect(item.locator('[data-plan-approve]')).toHaveCount(0);
  await expect(item.locator('[data-plan-ask]')).toHaveCount(0);
  await page.waitForTimeout(400);
  await shot(page, `${prefix}-07-item-post-client`);

  await page.goBack();
  await expect(item).toBeHidden();
  await expect(plan).toBeVisible();
  await page.goBack();
  await expect(plan).toBeHidden();
  expectClean(network);
}

async function teamAndHidden(page: Page, prefix: string): Promise<void> {
  test.setTimeout(90_000);
  const network = await installHarnessNetwork(page);
  seedTeamAndHiddenPlans(network.world, { channelId: GROUP_CHANNEL, sender: COLLEAGUE_A });
  await openChat(page, GROUP_NAME);
  const hidden = page.locator('[data-plan-card="unavailable"]');
  await hidden.scrollIntoViewIfNeeded();
  await expect(hidden).toHaveText('Plan not available');
  const team = page.locator('[data-plan-chip="warn"]');
  await expect(team).toHaveText('Team only');
  await team.scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await shot(page, `${prefix}-01-cards-team-and-hidden`);

  // An agency-only group: a Team only plan offers "Add drafts".
  await openTray(page);
  await page.locator('[data-tray-tile="plan"]').click();
  const compose = page_(page, 'compose');
  await expect(compose).toBeVisible();
  await compose.locator('[data-plan-audience="team"]').click();
  await expect(compose.locator('[data-plan-add-drafts]')).toBeVisible();
  await page.waitForTimeout(300);
  await shot(page, `${prefix}-02-new-plan-team-only`);
  await page.goBack();
  await expect(compose).toBeHidden();

  // A Team only plan into a chat with a client: refused inline, screen stays open.
  await openChat(page, PEER_NAME);
  await openTray(page);
  await page.locator('[data-tray-tile="plan"]').click();
  await expect(compose).toBeVisible();
  await compose.locator('[data-plan-title]').fill('Internal week');
  await expect(compose.locator('[data-plan-share]')).toBeEnabled();
  await compose.locator('[data-plan-audience="team"]').click();
  // Team only in a chat with a client: Share is off and says why; nothing is written.
  await expect(compose.locator('[data-plan-team-blocked]')).toHaveText(
    "Team only plans can't be shared in chats with clients.",
  );
  await expect(compose.locator('[data-plan-share]')).toBeDisabled();
  const plansBefore = (network.world.tables.plans ?? []).length;
  const messagesBefore = (network.world.tables.chat_messages ?? []).length;
  await compose.locator('[data-plan-share]').click({ force: true });
  await page.waitForTimeout(300);
  // No plan_create (and no share): the fixture tables are unchanged.
  expect(network.world.tables.plans ?? []).toHaveLength(plansBefore);
  expect(network.world.tables.chat_messages ?? []).toHaveLength(messagesBefore);
  await expect(compose.locator('[data-plan-share-error]')).toHaveCount(0);
  await expect(compose).toBeVisible();
  await page.waitForTimeout(300);
  await shot(page, `${prefix}-03-team-plan-blocked`);
  expectClean(network);
}

test.describe('phone', () => {
  test('agency: new plan, share, plan and item screens, team approve and comment', async ({
    page,
  }) => {
    await agencyFlow(page, 'plan-phone-agency');
  });

  test('client: tile off, card Forward, approve a concept, post item opens the post', async ({
    page,
  }) => {
    await clientFlow(page, 'plan-phone-client');
  });

  test('team only and not available cards; team plan blocked in a client chat', async ({
    page,
  }) => {
    await teamAndHidden(page, 'plan-phone-team');
  });
});

test.describe('laptop', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false });

  test('agency: new plan, share, plan and item screens, team approve and comment', async ({
    page,
  }) => {
    await agencyFlow(page, 'plan-laptop-agency');
  });

  test('client: tile off, card Forward, approve a concept, post item opens the post', async ({
    page,
  }) => {
    await clientFlow(page, 'plan-laptop-client');
  });
});
