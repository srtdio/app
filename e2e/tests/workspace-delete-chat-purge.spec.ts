import { expect, test, type Page } from '@playwright/test';
import { installHarnessNetwork, type HarnessNetwork } from '../fixtures/harness-routes';
import { ME, PEER, PEER_NAME } from '../fixtures/chat-data';
import {
  FILE_ASSET_ID,
  FILE_MESSAGE_BODY,
  FILE_NAME,
  TEXT_MESSAGE_BODY,
  WORKSPACE_NAME,
  installDeleteRoutes,
  makeNonOwner,
  makeRecent,
  seedChatFile,
  type DeleteRecorder,
} from '../fixtures/workspace-delete';
import { expectMinTouchTarget } from '../helpers/touch-target';

// Chat delete with a file purges it for good (chat_message_delete, then the
// asset-upload Worker's POST /purge-chat), a text-only delete keeps the old
// confirm, and Settings > Workspace lets the owner delete the workspace after
// typing its name. Tagged @theme: runs light and dark. Linux WebKit
// approximates iOS WebKit; it is not iOS.

const FILE_CONFIRM_MESSAGE = `${FILE_NAME} is permanently deleted for privacy. Files shared in chat never go to Recently deleted and can't be restored.`;

function watchConsole(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    // The chat store logs its StrictMode-cancelled first load ("read
    // cancelled") at error level; that predates this feature and is not ours.
    if (msg.type() === 'error' && !msg.text().includes('read cancelled')) errors.push(msg.text());
  });
  page.on('pageerror', (error) => errors.push(String(error)));
  return errors;
}

function expectClean(network: HarnessNetwork, errors: string[]): void {
  expect(network.blocked, 'blocked non-fixture requests').toEqual([]);
  expect(errors, 'console errors').toEqual([]);
}

async function setup(
  page: Page,
  seed?: (network: HarnessNetwork) => void,
): Promise<{ network: HarnessNetwork; recorder: DeleteRecorder; errors: string[] }> {
  const errors = watchConsole(page);
  const network = await installHarnessNetwork(page);
  seed?.(network);
  const recorder = await installDeleteRoutes(page, network.world);
  return { network, recorder, errors };
}

/** Hold a bubble like a finger: pointerdown, 700ms still, pointerup. */
async function holdBubble(page: Page, text: string): Promise<void> {
  const bubble = page.locator('[data-bubble]', { hasText: text }).last();
  await bubble.scrollIntoViewIfNeeded();
  const box = await bubble.boundingBox();
  if (box === null) throw new Error('bubble has no box');
  const at = { clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 };
  await bubble.dispatchEvent('pointerdown', { ...at, pointerType: 'touch', isPrimary: true });
  await page.waitForTimeout(700);
  await bubble.dispatchEvent('pointerup', { ...at, pointerType: 'touch', isPrimary: true });
}

/** Long-press Delete: the single-message confirm opens (no selection mode). */
async function deleteFromMenu(page: Page, text: string): Promise<void> {
  const menu = page.getByRole('menu');
  // The thread can still be settling its scroll right after it opens; a hold
  // that lands mid-move is cancelled like a finger that moved, so hold again.
  await expect(async () => {
    await holdBubble(page, text);
    await expect(menu).toBeVisible({ timeout: 1_500 });
  }).toPass({ timeout: 10_000 });
  const remove = menu.locator('[data-menu-item="delete"]');
  expectMinTouchTarget(await remove.boundingBox());
  await remove.click();
  await expect(page.locator('[data-selection-bar]')).toHaveCount(0);
}

async function openDm(page: Page): Promise<void> {
  await page.goto('/chat');
  await page.getByText(PEER_NAME, { exact: true }).first().click();
  await page
    .locator('[data-bubble]', { hasText: FILE_MESSAGE_BODY })
    .last()
    .waitFor({ state: 'visible' });
}

test.describe('chat delete with a file', () => {
  test('confirm names the file; delete records first, then purges; toast @theme', async ({
    page,
  }) => {
    const { network, recorder, errors } = await setup(page, ({ world }) => {
      seedChatFile(world);
      makeRecent(world);
    });
    await openDm(page);

    // Cancel first: nothing is sent.
    await deleteFromMenu(page, FILE_MESSAGE_BODY);
    const confirm = page.getByRole('alertdialog');
    await expect(confirm).toBeVisible();
    await expect(confirm).toHaveAttribute('aria-label', 'Delete this message?');
    await expect(confirm).toContainText('Delete this message?');
    await expect(confirm).toContainText(FILE_CONFIRM_MESSAGE);
    const cancel = confirm.getByRole('button', { name: 'Cancel', exact: true });
    const go = confirm.getByRole('button', { name: 'Delete for everyone', exact: true });
    await expect(cancel).toBeVisible();
    await expect(go).toBeVisible();
    expectMinTouchTarget(await cancel.boundingBox());
    expectMinTouchTarget(await go.boundingBox());
    await cancel.click();
    await expect(confirm).toHaveCount(0);
    expect(recorder.order).toEqual([]);

    // Delete again from the menu and confirm.
    await deleteFromMenu(page, FILE_MESSAGE_BODY);
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: 'Delete for everyone' })
      .click();

    await expect(page.getByText('Deleted. File removed for good.')).toBeVisible();
    expect(recorder.order).toEqual(['rpc:chat_message_delete', 'purge-chat']);
    expect(recorder.purgeBodies).toHaveLength(1);
    expect(recorder.purgeBodies[0]).toMatchObject({ asset_ids: [FILE_ASSET_ID] });
    expect(typeof recorder.purgeBodies[0]?.workspace_id).toBe('string');
    expect(recorder.purgeAuth[0]).toMatch(/^Bearer \S+/);
    expect(recorder.deleteArgs[0]?.p_message_ids).toHaveLength(1);
    expect(typeof recorder.deleteArgs[0]?.p_trace_id).toBe('string');
    await expect(page.locator('[data-bubble]', { hasText: FILE_MESSAGE_BODY })).toHaveCount(0);
    expectClean(network, errors);
  });

  test('a text-only message takes the single-message confirm and never purges', async ({
    page,
  }) => {
    const { network, recorder, errors } = await setup(page, ({ world }) => {
      seedChatFile(world);
      makeRecent(world);
    });
    await openDm(page);

    await deleteFromMenu(page, TEXT_MESSAGE_BODY);
    const confirm = page.getByRole('alertdialog');
    await expect(confirm).toHaveAttribute('aria-label', 'Delete message?');
    await expect(confirm).toContainText('It is removed for everyone in this chat.');
    await expect(confirm).not.toContainText('permanently deleted');
    await confirm.getByRole('button', { name: 'Delete for everyone', exact: true }).click();

    await expect(page.locator('[data-bubble]', { hasText: TEXT_MESSAGE_BODY })).toHaveCount(0);
    await expect.poll(() => recorder.order).toEqual(['rpc:chat_message_delete']);
    await expect(page.getByText('Deleted. File removed for good.')).toHaveCount(0);
    expect(recorder.purgeBodies).toEqual([]);
    expectClean(network, errors);
  });
});

test.describe('Settings: Delete workspace', () => {
  async function openWorkspaceSettings(page: Page): Promise<void> {
    await page.goto('/settings?panel=workspace');
    await expect(page.getByRole('heading', { name: 'Danger' })).toBeVisible({ timeout: 15_000 });
  }

  test('owner types the exact name, deletes, lands on Create workspace @theme', async ({
    page,
  }) => {
    const { network, recorder, errors } = await setup(page);
    await openWorkspaceSettings(page);

    const danger = page.locator('section[aria-labelledby="workspace-danger-title"]');
    await expect(danger).toContainText('Delete workspace');
    await expect(danger).toContainText('Permanent. Nothing is saved.');
    const open = danger.getByRole('button', { name: 'Delete', exact: true });
    expectMinTouchTarget(await open.boundingBox());
    await open.click();

    const title = `Delete ${WORKSPACE_NAME} for good?`;
    const sheet = page.getByRole('dialog', { name: title });
    await expect(sheet).toBeVisible();
    // The sheet settles by translateY only.
    await expect
      .poll(() => sheet.evaluate((el) => getComputedStyle(el).transform))
      .toMatch(/^(none|matrix\(1, 0, 0, 1, 0, 0\))$/);
    await expect(sheet.locator('h2')).toHaveText(title);
    await expect(sheet).toContainText(
      `Every post, file, chat, brief and approval in ${WORKSPACE_NAME} is deleted now. Nothing is saved, there is no Recently deleted for a workspace, and this can't be undone. Members lose access immediately.`,
    );
    const input = sheet.getByLabel(`Type ${WORKSPACE_NAME} to confirm`);
    await expect(input).toBeVisible();
    const confirm = sheet.getByRole('button', { name: 'Delete permanently' });
    const cancel = sheet.getByRole('button', { name: 'Cancel', exact: true });
    expectMinTouchTarget(await confirm.boundingBox());
    expectMinTouchTarget(await cancel.boundingBox());
    await expect(confirm).toBeDisabled();

    // Only the exact name enables it.
    for (const wrong of ['Harness', WORKSPACE_NAME.toLowerCase(), `${WORKSPACE_NAME} `]) {
      await input.fill(wrong);
      await expect(confirm).toBeDisabled();
    }
    await input.fill(WORKSPACE_NAME);
    await expect(confirm).toBeEnabled();
    expect(recorder.workspaceDeleteArgs).toEqual([]);
    await confirm.click();

    await expect.poll(() => recorder.workspaceDeleteArgs.length).toBe(1);
    expect(recorder.workspaceDeleteArgs[0]).toMatchObject({ p_confirm_name: WORKSPACE_NAME });
    expect(typeof recorder.workspaceDeleteArgs[0]?.p_trace_id).toBe('string');

    const create = page.getByRole('dialog', { name: 'Create workspace' });
    await expect(create).toBeVisible();
    await expect(create).toContainText(`${WORKSPACE_NAME} is gone. Start a new one.`);
    await expect(create.getByLabel('Brand name')).toBeVisible();
    // The toast outlives the move to the no-workspace shell (asserted after the
    // create form so it is not caught only in the moment before the move).
    await expect(page.getByText(`${WORKSPACE_NAME} deleted for good`)).toBeVisible();
    expectClean(network, errors);
  });

  test('a non-owner sees only the owner line', async ({ page }) => {
    const { network, errors } = await setup(page, ({ world }) => makeNonOwner(world, PEER, ME));
    await openWorkspaceSettings(page);
    const danger = page.locator('section[aria-labelledby="workspace-danger-title"]');
    await expect(danger).toContainText('Only the owner can delete this workspace.');
    await expect(danger.getByRole('button')).toHaveCount(0);
    await expect(danger).not.toContainText('Delete workspace');
    expectClean(network, errors);
  });
});
