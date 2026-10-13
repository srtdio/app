import { expect, test, type Locator, type Page } from '@playwright/test';
import { installHarnessNetwork, type HarnessNetwork } from '../fixtures/harness-routes';
import { expectMinTouchTarget } from '../helpers/touch-target';
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

// Plan in chat: the tray's Plan tile ("Plans", then New plan), the New plan
// screen's Create plan (a Draft plan, no card sent, its Plan screen opens),
// the Draft footer (Open for client, Send in the chat, Go to card), the plan
// card (Draft, Open, Plan deleted), the Plan and Item screens with agency and
// client approval and Agency only comments, Forward (a Draft into a chat with
// a client is refused), and back closing one layer at a time. Runs in
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

/** The Plan tile opens "Share a plan"; its last row opens the New plan screen. */
async function newPlanFromTile(page: Page): Promise<void> {
  await page.locator('[data-tray-tile="plan"]').click();
  const picker = page.getByRole('dialog', { name: 'Plans' });
  await expect(picker).toBeVisible();
  await picker.locator('[data-plan-pick-new]').click();
}

async function agencyFlow(page: Page): Promise<void> {
  test.setTimeout(120_000);
  const network = await installHarnessNetwork(page);
  seedLibrary(network);
  await openChat(page, PEER_NAME);

  // D1: the Plan tile is live for the agency side.
  await openTray(page);
  const tile = page.locator('[data-tray-tile="plan"]');
  await expect(tile).toBeEnabled();
  await newPlanFromTile(page);

  // D2: the New plan screen: no audience choice, drafts allowed.
  const compose = page_(page, 'compose');
  await expect(compose).toBeVisible();
  await expect(compose.getByText('Who can see it')).toHaveCount(0);
  await expect(compose.locator('[data-plan-audience]')).toHaveCount(0);
  await expect(compose.locator('[data-plan-add-drafts]')).toBeVisible();
  await expect(compose.locator('[data-plan-create]')).toHaveText('Create plan');
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

  // Create plan: a Draft plan, no card sent; its Plan screen opens.
  await compose.locator('[data-plan-create]').click();
  await expect(compose).toBeHidden();
  const plan = page_(page, 'plan');
  await expect(plan).toBeVisible();
  const tables = network.world.tables;
  expect(tables.plans).toHaveLength(1);
  const planId = String(tables.plans?.[0]?.id);
  expect(tables.plans?.[0]?.audience).toBe('team');
  expect((tables.plan_items ?? []).filter((i) => i.plan_id === planId)).toHaveLength(2);
  expect(
    (tables.asset_attachments ?? []).filter((a) => a.entity_type === 'plan_item'),
  ).toHaveLength(1);
  expect(network.rpcCalls.filter((c) => c.name === 'chat_plan_share')).toEqual([]);
  // The header: the range, then Draft; progress the team side.
  await expect(plan.locator('[data-plan-page-subtitle]')).toHaveText(/ · Draft$/);
  await expect(plan.locator('[data-plan-screen-progress]')).toHaveText('Team 0 of 2');
  // The Draft footer: Open for client, and Send in this chat held back (it has a client).
  const openClient = plan.locator('[data-plan-open-client]');
  const send = plan.locator('[data-plan-send-here]');
  await expect(openClient).toHaveText('Open for client');
  await expect(send).toHaveText(`Send in ${PEER_NAME}`);
  await expect(send).toBeDisabled();
  await expect(plan.locator('[data-plan-send-hint]')).toHaveText(
    'Open the plan for client to send it here.',
  );
  await expect(plan.getByText("Agency only. The client can't see it yet.")).toHaveCount(0);
  for (const target of [openClient, send]) expectMinTouchTarget(await target.boundingBox());
  // One list by day (no Concepts/Posts tabs): each row tagged with its kind.
  await expect(plan.locator('[data-plan-tab]')).toHaveCount(0);
  await expect(plan.locator('[data-plan-row]')).toHaveCount(2);
  const kind = (label: string) => page.locator(`[data-plan-row-kind="${label}"]`);
  const conceptRow = () => plan.locator('[data-plan-row]').filter({ has: kind('Concept 1 of 1') });
  const postRow = () => plan.locator('[data-plan-row]').filter({ has: kind('Post 1 of 1') });
  // On a Draft plan the agency's team state is the row's checkbox.
  const conceptWrap = () =>
    plan.locator('[data-plan-row-wrap]').filter({ has: kind('Concept 1 of 1') });
  const row = conceptRow();
  await expect(conceptWrap().locator('[data-plan-slot="team"]')).toHaveAttribute(
    'aria-checked',
    'false',
  );

  // D5: the Item screen, agency approve with its confirm (a Draft plan).
  await row.click();
  const item = page_(page, 'item');
  await expect(item).toBeVisible();
  await expect(item.getByText('Concept 1 of 1')).toBeVisible();
  await expect(item.locator('[data-plan-media="files"]')).toBeVisible();
  // Remove from plan: a red button at the bottom, not a menu row.
  await expect(item.locator('[data-plan-remove]')).toHaveText(/Remove from plan/);
  await item.locator('[data-plan-approve]').click();
  const confirm = page.getByRole('dialog', { name: 'Agency approve' });
  await expect(confirm).toBeVisible();
  await expect(confirm.getByText(/Only the agency sees this/)).toBeVisible();
  await confirm.locator('[data-plan-confirm]').click();
  await expect(confirm).toBeHidden();
  await expect(item.locator('[data-plan-status] [data-plan-pill="team"]')).toHaveText('Approved');

  // An Agency only comment: tinted, with the lock label.
  await item.locator('[data-plan-visibility="team"]').click();
  await item.getByRole('textbox', { name: 'Comment' }).fill('Need drone shots, checking Tuesday.');
  await item.getByRole('button', { name: 'Send comment' }).click();
  const note = item.locator('[data-plan-comment="team"]');
  await expect(note).toBeVisible();
  await expect(note.getByText('Agency only')).toBeVisible();
  await expect(note).toHaveClass(/bg-warn-soft/);

  // Back closes one layer: the item; the Draft plan shows the team tick.
  await page.goBack();
  await expect(item).toBeHidden();
  await expect(plan).toBeVisible();
  await expect(conceptWrap().locator('[data-plan-slot="team"]')).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect(plan.locator('[data-plan-screen-progress]')).toHaveText('Team 1 of 2');

  // Open for client: the confirm, then the client side for everyone.
  await openClient.click();
  const openConfirm = page.getByRole('dialog', { name: 'Open this plan for client?' });
  await expect(openConfirm).toBeVisible();
  await expect(openConfirm).toContainText(
    'Client can open it from any plan card in chat and tick slots. They get a notification. This cannot be undone.',
  );
  await openConfirm.locator('[data-plan-confirm]').click();
  await expect(openConfirm).toBeHidden();
  await expect(page.getByText('Open for client', { exact: true }).last()).toBeVisible();
  expect(tables.plans?.[0]?.audience).toBe('client');
  await expect(plan.locator('[data-plan-page-subtitle]')).toHaveText(/ · Shared with client$/);
  await expect(plan.locator('[data-plan-open-client]')).toHaveCount(0);
  // Team ticks are never shown on an Open plan: read-only client boxes.
  await expect(plan.locator('[data-plan-slot="team"]')).toHaveCount(0);
  await expect(conceptWrap().locator('[data-plan-slot="client"]')).toBeDisabled();
  await expect(plan.locator('[data-plan-screen-progress]')).toHaveText('Client 0 of 2');
  // The agency's status line: the client's side, then the visible comment count.
  await expect(conceptRow().locator('[data-plan-row-status]')).toHaveText(
    'Client waiting · 1 comment',
  );

  // Send in this chat: the card lands; the button becomes Go to card.
  await expect(send).toBeEnabled();
  await send.click();
  await expect(plan.locator('[data-plan-go-card]')).toHaveText('Go to card');
  expect(
    (tables.chat_messages ?? [])
      .filter((m) => m.channel_id === DM_CHANNEL && Array.isArray(m.shared_plan_ids))
      .map((m) => m.shared_plan_ids),
  ).toEqual([[planId]]);

  // Go to card: the screen closes, the card scrolls into view and is highlighted.
  await plan.locator('[data-plan-go-card]').click();
  await expect(plan).toBeHidden();
  const card = page.locator(`[data-plan-card="${planId}"]`);
  await expect(card).toBeInViewport();
  await expect(
    page.locator('[data-msg-id]').filter({ has: card }).locator('.ring-accent'),
  ).toHaveCount(1);
  await expect(card.getByText('1 concept')).toBeVisible();
  await expect(card.getByText('1 post')).toBeVisible();
  await expect(card.locator('[data-plan-progress]')).toHaveText('Client 0 of 2');
  await expect(card.locator('[data-plan-chip="warn"]')).toHaveCount(0);
  await expect(card.locator('[data-plan-forward]')).toBeVisible();

  // D4 again from the card.
  await card.locator('[data-plan-open]').click();
  await expect(plan).toBeVisible();
  await expect(plan.locator('[data-plan-go-card]')).toBeVisible();

  // A post item for the agency: the pipeline post view embedded, no plan
  // review buttons, and the header overflow opens the post view's own sheet.
  await postRow().scrollIntoViewIfNeeded();
  await postRow().click();
  await expect(item).toBeVisible();
  await expect(item.getByText('Post 1 of 1')).toBeVisible();
  await expect(item.getByText('Fixture caption')).toBeVisible();
  await expect(item.getByRole('button', { name: 'Agency approve' })).toHaveCount(0);
  await expect(item.locator('[data-plan-approve]')).toHaveCount(0);
  await expect(item.locator('[data-plan-ask]')).toHaveCount(0);
  // The post view's own sheet keeps Move but no Remove from plan row.
  await expect(item.locator('[data-plan-remove]')).toBeVisible();
  await expectOverflowOpensPipeline(page, item);

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
  await expect(postRow()).toHaveCount(0);
  // Back once returns to the thread.
  await page.goBack();
  await expect(plan).toBeHidden();
  await expect(page.locator('[data-msg-id]').first()).toBeVisible();
  await expect(page).toHaveURL(/\/chat/);
  expectClean(network);
}

async function clientFlow(page: Page): Promise<void> {
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
  await tile.click({ force: true });
  await expect(page_(page, 'compose')).toHaveCount(0);
  await page.keyboard.press('Escape');

  // D3: the client's card has Forward.
  const card = page.locator(`[data-plan-card="${PLAN_ID}"]`).first();
  await card.scrollIntoViewIfNeeded();
  await expect(card).toBeVisible();
  await expect(card.getByText(PLAN_TITLE)).toBeVisible();
  await expect(card.locator('[data-plan-forward]')).toBeVisible();

  // Forward to a DM: a fresh message in that chat, and the toast.
  await card.locator('[data-plan-forward]').click();
  const picker = page.getByRole('dialog', { name: 'Forward plan' });
  await expect(picker).toBeVisible();
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
  // The same subtitle for everyone; no status line and no Add for a client.
  await expect(plan.locator('[data-plan-page-subtitle]')).toHaveText(/ · Shared with client$/);
  await expect(plan.locator('[data-plan-title-menu]')).toHaveCount(0);
  await expect(plan.locator('[data-plan-row-status]')).toHaveCount(0);
  // A client gets Go to card only (the card is in this chat).
  await expect(plan.locator('[data-plan-go-card]')).toBeVisible();
  await expect(plan.locator('[data-plan-send-here], [data-plan-open-client]')).toHaveCount(0);
  await expect(plan.locator('[data-plan-add], [data-plan-add-header]')).toHaveCount(0);
  // The concept's Everyone comment shows as the row's third line.
  await expect(
    plan
      .locator('[data-plan-row]')
      .filter({ has: page.locator('[data-plan-row-kind="Concept 1 of 1"]') })
      .locator('[data-plan-row-comments]'),
  ).toHaveText('1 comment');
  await expect(plan.locator('[data-plan-pill="team"]')).toHaveCount(0);

  // D5: a concept: Approve with its confirm.
  await plan
    .locator('[data-plan-row]')
    .filter({ has: page.locator('[data-plan-row-kind="Concept 1 of 1"]') })
    .click();
  const item = page_(page, 'item');
  await expect(item).toBeVisible();
  await expect(item.getByText('Can we keep it under 30 seconds?')).toBeVisible();
  await expect(item.locator('[data-plan-visibility]')).toHaveCount(0);
  await item.locator('[data-plan-approve]').click();
  const confirm = page.getByRole('dialog', { name: 'Approve' });
  await expect(confirm).toBeVisible();
  await expect(
    confirm.getByText(`Approve "${PLAN_CONCEPT_TITLE}"? The agency will go ahead`, {
      exact: false,
    }),
  ).toBeVisible();
  await confirm.locator('[data-plan-confirm]').click();
  await expect(confirm).toBeHidden();
  await expect(item.locator('[data-plan-status] [data-plan-pill="client"]')).toHaveText('Approved');
  expect(network.world.tables.plan_item_reviews).toEqual([
    expect.objectContaining({ side: 'client', status: 'approved' }),
  ]);

  // A post item: the pipeline post view embedded, no plan review buttons.
  await page.goBack();
  await expect(item).toBeHidden();
  const postRow = plan
    .locator('[data-plan-row]')
    .filter({ has: page.locator('[data-plan-row-kind="Post 1 of 1"]') });
  await postRow.scrollIntoViewIfNeeded();
  await postRow.click();
  await expect(item).toBeVisible();
  await expect(item.getByText('Fixture caption')).toBeVisible();
  await expect(item.locator('[data-plan-approve]')).toHaveCount(0);
  await expect(item.locator('[data-plan-ask]')).toHaveCount(0);
  await expectOverflowOpensPipeline(page, item);

  await page.goBack();
  await expect(item).toBeHidden();
  await expect(plan).toBeVisible();
  await page.goBack();
  await expect(plan).toBeHidden();
  expectClean(network);
}

/**
 * The post item's header overflow opens the post view's own action sheet:
 * Open in pipeline first, then the post's actions; Escape closes it.
 */
async function expectOverflowOpensPipeline(page: Page, item: Locator): Promise<void> {
  await item.locator('[data-plan-more]').click();
  const more = page.getByRole('dialog', { name: 'Post actions', exact: true });
  await expect(more.getByRole('button', { name: /Open in pipeline/ })).toBeVisible();
  await expect(more.getByRole('button', { name: /Send to chat/ })).toBeVisible();
  await expect(more.getByRole('button', { name: /Copy link/ })).toBeVisible();
  // Open in pipeline is the first row (DOM order, not geometry mid-slide).
  const labels = await more.getByRole('button').allInnerTexts();
  const at = (re: RegExp): number => labels.findIndex((t) => re.test(t));
  expect(at(/Open in pipeline/)).toBeGreaterThanOrEqual(0);
  expect(at(/Open in pipeline/)).toBeLessThan(at(/Send to chat/));
  await page.keyboard.press('Escape');
  await expect(more).toBeHidden();
}

async function teamAndHidden(page: Page): Promise<void> {
  test.setTimeout(90_000);
  const network = await installHarnessNetwork(page);
  seedTeamAndHiddenPlans(network.world, { channelId: GROUP_CHANNEL, sender: COLLEAGUE_A });
  await openChat(page, GROUP_NAME);
  const hidden = page.locator('[data-plan-card="unavailable"]');
  await hidden.scrollIntoViewIfNeeded();
  await expect(hidden).toHaveText('Plan deleted');
  const draftChip = page.locator('[data-plan-chip="warn"]');
  await expect(draftChip).toHaveText('Draft');
  await draftChip.scrollIntoViewIfNeeded();

  // Forward the Draft card into a chat with a client: nothing is sent.
  const draftCard = page.locator('[data-plan-card]').filter({ has: draftChip }).first();
  await draftCard.locator('[data-plan-forward]').click();
  const picker = page.getByRole('dialog', { name: 'Forward plan' });
  await expect(picker).toBeVisible();
  const messagesBefore = (network.world.tables.chat_messages ?? []).length;
  await picker.getByRole('button', { name: new RegExp(PEER_NAME) }).click();
  await expect(page.getByText('Open the plan for client first.')).toBeVisible();
  expect(network.world.tables.chat_messages ?? []).toHaveLength(messagesBefore);
  await expect(page.getByRole('dialog', { name: 'Share with client first?' })).toHaveCount(0);
  await page.keyboard.press('Escape');

  // An agency-only group: Create plan, then Send in the group (no client here).
  await openTray(page);
  await newPlanFromTile(page);
  const compose = page_(page, 'compose');
  await expect(compose).toBeVisible();
  await expect(compose.locator('[data-plan-add-drafts]')).toBeVisible();
  await compose.locator('[data-plan-title]').fill('Internal week');
  await compose.locator('[data-plan-create]').click();
  const plan = page_(page, 'plan');
  await expect(plan).toBeVisible();
  const send = plan.locator('[data-plan-send-here]');
  await expect(send).toHaveText(`Send in ${GROUP_NAME}`);
  await expect(send).toBeEnabled();
  await expect(plan.locator('[data-plan-send-hint]')).toHaveCount(0);
  await send.click();
  await expect(plan.locator('[data-plan-go-card]')).toBeVisible();
  expectClean(network);
}

test.describe('phone', () => {
  test('agency: new plan, share, plan and item screens, team approve and comment', async ({
    page,
  }) => {
    await agencyFlow(page);
  });

  test('client: tile off, card Forward, approve a concept, post item opens the post', async ({
    page,
  }) => {
    await clientFlow(page);
  });

  test('Draft and deleted cards; a Draft forward into a client chat is refused; send in a group', async ({
    page,
  }) => {
    await teamAndHidden(page);
  });
});

test.describe('laptop', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false });

  test('agency: new plan, share, plan and item screens, team approve and comment', async ({
    page,
  }) => {
    await agencyFlow(page);
  });

  test('client: tile off, card Forward, approve a concept, post item opens the post', async ({
    page,
  }) => {
    await clientFlow(page);
  });
});
