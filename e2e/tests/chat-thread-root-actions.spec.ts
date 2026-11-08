import { expect, test, type Page } from '@playwright/test';
import { installHarnessNetwork, type HarnessNetwork } from '../fixtures/harness-routes';
import { MAYA_NAME } from '../fixtures/chat-data';

// The thread screen's "N replies" divider acts on its root (8 Nov 2026):
// ⋮ opens the root's long-press sheet, and the task icon opens the chat's
// Tasks sheet with the root's text in "Add a task", saving nothing until the
// person adds it. Real app tree against fixture data. Linux WebKit
// approximates iOS WebKit, it is not iOS. Listed in scripts/ci/e2e-areas.ts (chat).

function expectClean(network: HarnessNetwork): void {
  expect(network.blocked, 'blocked non-fixture requests').toEqual([]);
  expect([...new Set(network.unmatched)], 'unrecognised fixture requests').toEqual([]);
}

const TASK_WRITES = new Set([
  'chat_task_save_batch',
  'chat_task_create',
  'chat_task_create_many',
  'chat_task_save',
  'chat_task_set',
]);

function taskSaves(network: HarnessNetwork): number {
  return network.rpcCalls.filter((c) => TASK_WRITES.has(c.name)).length;
}

async function openThread(page: Page): Promise<void> {
  await page.goto('/chat');
  const target = page.getByText(MAYA_NAME, { exact: true }).first();
  await target.waitFor({ state: 'visible' });
  await target.click();
  await page.locator('[data-msg-id]').first().waitFor({ state: 'visible', timeout: 8000 });
  await page
    .locator('[data-replies-row]', { hasText: '4 replies' })
    .first()
    .locator('button')
    .click();
  await expect(page.locator('[data-thread-replies-divider]')).toBeVisible();
}

test('thread divider ⋮ opens the root long-press sheet', async ({ page }) => {
  const network = await installHarnessNetwork(page);
  await openThread(page);
  await page.locator('[data-thread-root-action="more"]').click();
  await expect(page.locator('[data-menu-items]')).toBeVisible();
  expectClean(network);
});

test('thread divider task icon opens Tasks with the root text, unsaved', async ({ page }) => {
  const network = await installHarnessNetwork(page);
  await openThread(page);
  const before = taskSaves(network);
  await page.locator('[data-thread-root-action="tasks"]').click();
  const field = page.locator('[data-task-add] input');
  await expect(field).toBeVisible();
  await expect(field).not.toHaveValue('');
  // Give any stray save time to fire: none may.
  await page.waitForTimeout(1500);
  expect(taskSaves(network)).toBe(before);
  expectClean(network);
});
