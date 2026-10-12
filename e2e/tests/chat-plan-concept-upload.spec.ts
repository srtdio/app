import { expect, test, type Page } from '@playwright/test';
import { expectMinTouchTarget } from '../helpers/touch-target';
import {
  installHarnessNetwork,
  solidPng,
  WORKSPACE_ID,
  type HarnessNetwork,
} from '../fixtures/harness-routes';
import {
  DATED_PLAN_ID,
  DATED_PLAN_ITEMS,
  DM_CHANNEL,
  ME,
  PEER_NAME,
  seedDatedPlan,
} from '../fixtures/chat-data';

// Concept files: a fresh upload beside the library picker, and the Edit
// concept sheet's files read. Create: one uploaded file (library origin, held
// in flight so Save reads "Uploading..." and waits) and one library file land
// in plan_concept_add. Edit: a slow files read shows the skeleton row with no
// Add or Upload, then the list; a failed read shows "Couldn't load files."
// with Retry, and Save sends files as null so the links stay. Runs in both
// colour schemes (the dark and light projects) on the iPhone viewport.

const LIB_IMAGE = '0190e000-0000-7000-8000-0000000000c1';
const LIB_IMAGE_VERSION = '0190e100-0000-7000-8000-0000000000c1';
const LINKED_VERSION = '0190e100-0000-7000-8000-0000000000c2';

const page_ = (page: Page, id: string) => page.locator(`[data-plan-page="${id}"]`);

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

function seedLibrary(network: HarnessNetwork): void {
  (network.world.tables.assets ??= []).push({
    id: LIB_IMAGE,
    workspace_id: WORKSPACE_ID,
    filename: 'moodboard.png',
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

/** The concept the edit tests open, with one linked file. */
function seedLinkedConcept(network: HarnessNetwork): string {
  seedDatedPlan(network.world, { channelId: DM_CHANNEL, sender: ME });
  const target = DATED_PLAN_ITEMS.find((it) => it.title === 'Lamp lighting reel');
  if (target === undefined) throw new Error('fixture');
  (network.world.tables.asset_attachments ??= []).push({
    id: '0190e200-0000-7000-8000-0000000000c3',
    asset_id: LINKED_VERSION,
    asset_version_id: LINKED_VERSION,
    entity_type: 'plan_item',
    entity_id: target.id,
    workspace_id: WORKSPACE_ID,
    position: 0,
    attached_by: ME,
    attached_at: '2026-10-01T10:00:00Z',
    deleted_at: null,
  });
  return target.id;
}

async function openItem(page: Page, itemId: string, beforeItem?: () => void): Promise<void> {
  const card = page.locator(`[data-plan-card="${DATED_PLAN_ID}"]`);
  await card.scrollIntoViewIfNeeded();
  await card.locator('[data-plan-open]').click();
  const plan = page_(page, 'plan');
  await expect(plan.locator('[data-plan-row]').first()).toBeVisible();
  // The plan list (its row thumbnails read asset_attachments too) has painted.
  beforeItem?.();
  await plan.locator(`[data-plan-row="${itemId}"]`).click();
  await expect(page_(page, 'item')).toBeVisible();
}

test('create a concept with one uploaded file and one library file', async ({ page }) => {
  test.setTimeout(120_000);
  const network = await installHarnessNetwork(page);
  seedLibrary(network);
  const origins: string[] = [];
  page.on('request', (req) => {
    if (req.method() !== 'POST' || !req.url().includes('asset-upload.harness.test')) return;
    const body = req.postDataBuffer()?.toString('latin1') ?? '';
    origins.push(/name="origin"\r\n\r\n([a-z]+)/.exec(body)?.[1] ?? 'none');
  });
  await openChat(page, PEER_NAME);

  await page.getByRole('button', { name: 'Add attachment' }).click();
  await page.locator('[data-tray-tile="plan"]').click();
  await page.getByRole('dialog', { name: 'Share a plan' }).locator('[data-plan-pick-new]').click();
  const compose = page_(page, 'compose');
  await expect(compose).toBeVisible();
  await compose.locator('[data-plan-title]').fill('Launch week');

  await compose.locator('[data-plan-add-concept]').click();
  const concept = page.getByRole('dialog', { name: 'Add concept' });
  await expect(concept).toBeVisible();
  await concept.locator('[data-plan-concept-title]').fill('Opening reel');
  const upload = concept.locator('[data-plan-concept-upload-pick]');
  await expect(upload).toHaveText('Upload');
  expectMinTouchTarget(await upload.boundingBox());

  // Library pick.
  await concept.locator('[data-plan-concept-files]').click();
  const assets = page.getByRole('dialog', { name: 'Add from Assets' });
  await expect(assets).toBeVisible();
  await assets.locator(`[data-asset-tile="${LIB_IMAGE}"]`).click();
  await assets.getByRole('button', { name: 'Add (1)' }).click();
  await expect(assets).toBeHidden();
  await expect(concept.locator('[data-plan-concept-file]')).toHaveCount(1);

  // Fresh upload, held in flight: it shows the comments' Uploading chip.
  const held = network.holdUploads();
  await concept.locator('[data-plan-concept-upload-input]').setInputFiles({
    name: 'storyboard.png',
    mimeType: 'image/png',
    buffer: solidPng(64, 48, [200, 120, 80]),
  });
  await expect(concept.locator('[data-plan-concept-upload="uploading"]')).toHaveCount(1);
  await expect(concept.getByText('Uploading', { exact: true })).toBeVisible();

  // Save waits: "Uploading..." and a second tap does nothing.
  const save = concept.locator('[data-plan-concept-save]');
  await save.click();
  await expect(save).toHaveText('Uploading...');
  await save.click();
  await expect(concept).toBeVisible();
  await page.waitForTimeout(300);
  await shot(page, 'upload-01-save-waits');
  held.release();
  await expect(concept).toBeHidden();
  await expect(compose.locator('[data-plan-draft-concept]')).toHaveCount(1);
  await expect(compose.getByText('2 files')).toBeVisible();
  expect(network.uploads).toEqual(['storyboard.png']);
  expect(origins).toEqual(['library']);

  await compose.locator('[data-plan-share]').click();
  await expect(compose).toBeHidden();
  const adds = network.rpcCalls.filter((c) => c.name === 'plan_concept_add');
  expect(adds).toHaveLength(1);
  expect(adds[0]?.args.p_attachment_version_ids).toEqual([
    LIB_IMAGE_VERSION,
    '0190f100-0000-7000-8000-000000000001',
  ]);
  await page.waitForTimeout(300);
  await shot(page, 'upload-02-shared');
  expectClean(network);
});

test('edit while the files read is slow: skeleton, then the list', async ({ page }) => {
  test.setTimeout(90_000);
  const network = await installHarnessNetwork(page);
  const itemId = seedLinkedConcept(network);
  await openChat(page, PEER_NAME);
  const holds: Array<{ release: () => void }> = [];
  await openItem(page, itemId, () => {
    holds.push(network.holdTable('asset_attachments'));
  });
  const item = page_(page, 'item');
  await item.locator('[data-plan-edit-concept]').click();
  const sheet = page.getByRole('dialog', { name: 'Edit concept' });
  await expect(sheet).toBeVisible();
  await expect(sheet.locator('[data-plan-concept-files-loading]')).toBeVisible();
  await expect(sheet.locator('[data-plan-concept-files]')).toHaveCount(0);
  await expect(sheet.locator('[data-plan-concept-upload-pick]')).toHaveCount(0);
  await page.waitForTimeout(400);
  await shot(page, 'upload-03-files-loading');

  for (const held of holds) held.release();
  await expect(sheet.locator('[data-plan-concept-files-loading]')).toHaveCount(0);
  await expect(sheet.locator('[data-plan-concept-file]')).toHaveCount(1);
  await expect(sheet.locator('[data-plan-concept-files]')).toBeVisible();
  await expect(sheet.locator('[data-plan-concept-upload-pick]')).toBeVisible();
  await page.waitForTimeout(300);
  await shot(page, 'upload-04-files-loaded');
  await sheet.getByRole('button', { name: 'Cancel' }).click();
  await expect(sheet).toBeHidden();
  expectClean(network);
});

test('failed files read: Retry, and Save keeps the files', async ({ page }) => {
  test.setTimeout(90_000);
  const network = await installHarnessNetwork(page);
  const itemId = seedLinkedConcept(network);
  await openChat(page, PEER_NAME);
  network.failTable.add('asset_attachments');
  await openItem(page, itemId);
  const item = page_(page, 'item');
  await item.locator('[data-plan-edit-concept]').click();
  const sheet = page.getByRole('dialog', { name: 'Edit concept' });
  await expect(sheet).toBeVisible();
  const failed = sheet.locator('[data-plan-concept-files-failed]');
  await expect(failed).toContainText("Couldn't load files.");
  const retry = sheet.locator('[data-plan-concept-files-retry]');
  expectMinTouchTarget(await retry.boundingBox());
  await expect(sheet.locator('[data-plan-concept-files]')).toHaveCount(0);
  await expect(sheet.locator('[data-plan-concept-upload-pick]')).toHaveCount(0);
  await page.waitForTimeout(300);
  await shot(page, 'upload-05-files-failed');

  // Save with the files unknown: files go as null; the link stays.
  await sheet.locator('[data-plan-concept-title]').fill('Lamp lighting reel v2');
  await sheet.locator('[data-plan-concept-save]').click();
  await expect(sheet).toBeHidden();
  const edits = network.rpcCalls.filter((c) => c.name === 'plan_concept_edit');
  expect(edits).toHaveLength(1);
  expect(edits[0]?.args.p_attachment_version_ids).toBeNull();
  const links = (network.world.tables.asset_attachments ?? []).filter(
    (a) => a.entity_id === itemId && a.deleted_at === null,
  );
  expect(links.map((a) => a.asset_version_id)).toEqual([LINKED_VERSION]);

  // Retry reloads the files once the read works.
  await item.locator('[data-plan-edit-concept]').click();
  await expect(sheet).toBeVisible();
  await expect(failed).toBeVisible();
  network.failTable.delete('asset_attachments');
  await sheet.locator('[data-plan-concept-files-retry]').click();
  await expect(sheet.locator('[data-plan-concept-file]')).toHaveCount(1);
  await expect(sheet.locator('[data-plan-concept-upload-pick]')).toBeVisible();
  await page.waitForTimeout(300);
  await shot(page, 'upload-06-files-retried');
  await sheet.getByRole('button', { name: 'Cancel' }).click();
  expectClean(network);
});
