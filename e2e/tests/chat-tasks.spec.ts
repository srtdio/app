import { expect, test, type Page } from '@playwright/test';
import { expectMinTouchTarget } from '../helpers/touch-target';
import { installHarnessNetwork, type HarnessNetwork } from '../fixtures/harness-routes';
import { COLLEAGUE_A, DM_CHANNEL, GROUP_NAME, PEER_NAME } from '../fixtures/chat-data';
import {
  applyTaskBatch,
  OLDER_LINE_TITLE,
  seedOlderTaskHistory,
  seedTasks,
  TASK_CHANNEL,
  TASK_DUE_TITLE,
} from '../fixtures/tasks-data';
import { withSaveData } from '../helpers/save-data';

// The chat Tasks: one shared, flat list every member edits the same way. The
// composer button, the sheet (tick, inline edit, the priority menu, add,
// delete), nothing written until one Save (one chat_task_save_batch), one
// "edited tasks" line per Save that expands in place, the marks another
// person's Save leaves, both editing the same task (Keep mine / Keep theirs),
// Share, the bell and numbered list continuation. The real app tree runs
// against fixture data; the other member's Save is written straight into the
// fixture tables. Linux WebKit approximates iOS WebKit.

function expectClean(network: HarnessNetwork): void {
  expect(network.blocked, 'blocked non-fixture requests').toEqual([]);
  expect([...new Set(network.unmatched)], 'unrecognised fixture requests').toEqual([]);
}

async function openChat(page: Page, name: string): Promise<void> {
  await page.goto('/chat');
  await page.getByText(name, { exact: true }).first().click();
  await page.locator('[data-msg-id]').first().waitFor({ state: 'visible', timeout: 8000 });
}

async function openSheet(page: Page): Promise<ReturnType<Page['getByRole']>> {
  const button = page.getByRole('button', { name: 'Tasks', exact: true });
  await button.click();
  const sheet = page.getByRole('dialog', { name: 'Tasks' });
  await expect(sheet).toBeVisible();
  await expect(sheet.locator('[data-task-list]')).toBeVisible();
  return sheet;
}

/** The fixture row of task number `n` in the group chat. */
function taskRow(network: HarnessNetwork, n: number): Record<string, unknown> {
  const row = network.world.tables.chat_tasks?.find(
    (t) => t.channel_id === TASK_CHANNEL && Number(t.number) === n,
  );
  if (row === undefined) throw new Error(`no task ${n}`);
  return row;
}

test(
  'one Save: edit 2, add 1, exactly one "edited tasks" line that expands to 3 rows; the other side is marked',
  { tag: '@theme' },
  async ({ page }) => {
    const network = await installHarnessNetwork(page);
    seedTasks(network.world);
    await openChat(page, GROUP_NAME);
    const button = page.getByRole('button', { name: 'Tasks', exact: true });
    expectMinTouchTarget(await button.boundingBox());

    const sheet = await openSheet(page);
    // One flat numbered list: no groups, no side labels, no due labels.
    const numbers = await sheet
      .locator('[data-task-row-id]')
      .evaluateAll((rows) => rows.map((r) => r.getAttribute('data-task-number')));
    expect(numbers).toEqual(['8', '9', '10', '11']);
    await expect(sheet).not.toContainText('Creators');
    await expect(sheet).not.toContainText('Approvers');
    await expect(sheet.locator('[data-task-due]')).toHaveCount(0);
    const save = sheet.locator('[data-task-save]');
    await expect(save).toBeDisabled();
    expectMinTouchTarget(
      await sheet.locator('[data-task-number="8"] [data-task-tick]').boundingBox(),
    );

    // The priority menu on the last row stays fully on screen.
    await sheet.locator('[data-task-number="11"] [data-task-chip]').click();
    const menu = page.locator('[data-task-menu]');
    await expect(menu).toBeVisible();
    const box = await menu.boundingBox();
    const vp = page.viewportSize();
    if (box === null || vp === null) throw new Error('no menu box');
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(vp.height);
    expect(box.x + box.width).toBeLessThanOrEqual(vp.width);
    await menu.locator('[data-task-menu-p="0"]').click();
    await expect(menu).toHaveCount(0);

    // Edit a title in place, add one; change-then-revert is no change.
    await sheet.locator('[data-task-number="9"] [data-task-title]').click();
    const title = sheet.locator('[data-task-title-input]');
    await expect(title).toBeFocused();
    await title.fill('Shot list v2');
    await title.press('Enter');
    await sheet.locator('[data-task-number="8"] [data-task-tick]').click();
    await sheet.locator('[data-task-number="8"] [data-task-tick]').click();
    const add = sheet.getByRole('textbox', { name: 'Add a task' });
    await add.fill('Story frames');
    await add.press('Enter');
    await expect(add).toBeFocused();
    expect(network.rpcCalls.some((c) => c.name.startsWith('chat_task'))).toBe(false);

    await expect(save).toBeEnabled();
    await save.click();
    await expect
      .poll(() => network.rpcCalls.filter((c) => c.name === 'chat_task_save_batch').length)
      .toBe(1);
    const call = network.rpcCalls.find((c) => c.name === 'chat_task_save_batch');
    const batch = call?.args.p_batch as {
      creates: { title: string; priority: number }[];
      edits: { task_id: string; changes: Record<string, unknown>; base_updated_at: string }[];
      deletes: unknown[];
    };
    expect(batch.creates).toEqual([{ title: 'Story frames', priority: 1, side: 'agency' }]);
    expect(batch.edits.map((e) => e.changes)).toEqual([{ priority: 0 }, { title: 'Shot list v2' }]);
    expect(batch.edits.every((e) => typeof e.base_updated_at === 'string')).toBe(true);
    expect(typeof call?.args.p_trace_id).toBe('string');
    await expect(sheet.locator('[data-task-number="12"]')).toContainText('Story frames');
    await expect(save).toBeDisabled();

    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Tasks' })).toHaveCount(0);
    const line = page.locator('[data-task-batch-toggle]');
    await expect(line).toHaveCount(1);
    await expect(line).toHaveText('You edited tasks');
    await line.click();
    await expect(page.locator('[data-task-batch-row]')).toHaveCount(3);
    await expect(page.locator('[data-task-batch-rows]')).toContainText(
      'Added #12 Story frames · P1',
    );

    // The other member saves: their changes are marked here.
    const nine = taskRow(network, 9);
    applyTaskBatch(
      network.world.tables,
      TASK_CHANNEL,
      {
        edits: [
          {
            task_id: String(nine.id),
            base_updated_at: String(nine.updated_at),
            changes: { title: 'Shot list v3' },
          },
        ],
      },
      COLLEAGUE_A,
    );
    const again = await openSheet(page);
    await expect(again.locator('[data-task-strip]')).toContainText('Leo Martins changed 1 task');
    const marked = again.locator('[data-task-number="9"]');
    await expect(marked).toHaveAttribute('data-task-marked', '');
    await expect(marked.locator('[data-task-mark]')).toHaveText('was Shot list v2');
    await expect(again.locator('[data-task-number="8"]')).not.toHaveAttribute(
      'data-task-marked',
      '',
    );
    expectClean(network);
  },
);

test('both edit the same task: the second saver sees Keep mine / Keep theirs', async ({ page }) => {
  const network = await installHarnessNetwork(page);
  seedTasks(network.world);
  await openChat(page, GROUP_NAME);
  const sheet = await openSheet(page);
  await sheet.locator('[data-task-number="8"] [data-task-title]').click();
  await sheet.locator('[data-task-title-input]').fill('Hook (mine)');
  await sheet.locator('[data-task-title-input]').press('Enter');
  await sheet.locator('[data-task-number="11"] [data-task-tick]').click();

  // Meanwhile the other member saves task 8 first.
  const eight = taskRow(network, 8);
  applyTaskBatch(
    network.world.tables,
    TASK_CHANNEL,
    {
      edits: [
        {
          task_id: String(eight.id),
          base_updated_at: String(eight.updated_at),
          changes: { title: 'Hook (Leo)' },
        },
      ],
    },
    COLLEAGUE_A,
  );
  await sheet.locator('[data-task-save]').click();

  // Everything else is saved; task 8 stays dirty and asks.
  await expect(sheet.locator('[data-task-conflict]')).toContainText('changed this to "Hook (Leo)"');
  await expect(sheet.locator('[data-task-keep-mine]')).toHaveText('Keep mine');
  await expect(sheet.locator('[data-task-keep-theirs]')).toHaveText('Keep theirs');
  expect(taskRow(network, 11).status).toBe('done');
  expect(taskRow(network, 8).title).toBe('Hook (Leo)');
  await expect(sheet.locator('[data-task-save]')).toBeEnabled();

  await sheet.locator('[data-task-keep-mine]').click();
  await expect(sheet.locator('[data-task-conflict]')).toHaveCount(0);
  await expect.poll(() => taskRow(network, 8).title).toBe('Hook (mine)');
  expectClean(network);
});

test('Close with unsaved changes asks "Discard unsaved changes?" in the page; Delete queues into Save', async ({
  page,
}) => {
  const network = await installHarnessNetwork(page);
  seedTasks(network.world);
  await openChat(page, GROUP_NAME);
  const sheet = await openSheet(page);
  await sheet.locator('[data-task-number="9"] [data-task-delete]').click();
  await expect(sheet.locator('[data-task-number="9"]')).toHaveAttribute('data-task-deleting', '');
  await sheet.getByRole('button', { name: 'Close' }).click();
  const ask = page.getByRole('alertdialog', { name: 'Discard unsaved changes?' });
  await expect(ask).toBeVisible();
  await ask.getByRole('button', { name: 'Save' }).click();
  // Wait for the Save itself, then for the row to be deleted.
  await expect
    .poll(() => network.rpcCalls.filter((c) => c.name === 'chat_task_save_batch').length)
    .toBe(1);
  await expect.poll(() => taskRow(network, 9).deleted_at).not.toBeNull();
  const call = network.rpcCalls.find((c) => c.name === 'chat_task_save_batch');
  expect((call?.args.p_batch as { deletes: unknown[] }).deletes).toHaveLength(1);
  expect(network.rpcCalls.some((c) => c.name === 'chat_task_delete')).toBe(false);
  expectClean(network);
});

test('Notifications: an older task alert opens the chat with the sheet; Back closes it', async ({
  page,
}) => {
  const network = await installHarnessNetwork(page);
  seedTasks(network.world);

  await page.goto('/notifications');
  const row = page.locator('[data-activity-event="task_due"]');
  await expect(row).toContainText(`#10 ${TASK_DUE_TITLE}`, { timeout: 15_000 });
  await expect(row.locator('[data-activity-alert-icon="task"]')).toBeVisible();
  await row.locator('[data-activity-lead]').click();

  const sheet = page.getByRole('dialog', { name: 'Tasks' });
  await expect(sheet).toBeVisible({ timeout: 8000 });
  await expect(page).toHaveURL(new RegExp(`channel=${encodeURIComponent(TASK_CHANNEL)}`));
  await page.goBack();
  await expect(page.getByRole('dialog', { name: 'Tasks' })).toHaveCount(0);
  await expect(page.locator('[data-msg-id]').first()).toBeVisible();
  expect(network.rpcCalls.some((c) => c.name === 'inbox_mark_read')).toBe(true);
  expectClean(network);
});

test('Share: the snapshot lands here and, Forwarded, in the picked chat and its preview', async ({
  page,
}) => {
  const network = await installHarnessNetwork(page);
  seedTasks(network.world);
  await openChat(page, GROUP_NAME);
  const sheet = await openSheet(page);
  await sheet.getByRole('button', { name: 'Share to chat' }).click();

  const picker = page.getByRole('dialog', { name: 'Forward to' });
  await expect(picker).toBeVisible();
  await picker.getByRole('button', { name: PEER_NAME }).click();
  await picker.getByRole('button', { name: 'Send to 1 chat' }).click();
  await expect(picker).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'Tasks' })).toHaveCount(0);

  const here = page.locator('[data-bubble]', { hasText: `Tasks · ${GROUP_NAME} · ` });
  await expect(here).toBeVisible();
  const sends = network.rpcCalls.filter((c) => c.name === 'chat_message_send');
  const own = sends.filter((c) => c.args.p_channel_id === TASK_CHANNEL);
  const copy = sends.filter((c) => c.args.p_channel_id === DM_CHANNEL);
  expect(own).toHaveLength(1);
  expect(copy).toHaveLength(1);
  const body = String(own[0]?.args.p_body);
  expect(body).toContain(
    `\n8. Hook options · P1\n9. Shot list · P2\n10. ${TASK_DUE_TITLE} · P0\n11. Brand colours · P2`,
  );
  expect(body).not.toContain('Creators');
  expect(body).not.toContain('today');
  expect(copy[0]?.args.p_body).toBe(body);
  expect(copy[0]?.args.p_forwarded_from_message_id).toBe(own[0]?.args.p_id);
  expectClean(network);
});

test('composer: "1. a" then a newline gives "2. "; a newline on an empty item ends the list', async ({
  page,
}) => {
  const network = await installHarnessNetwork(page);
  await openChat(page, PEER_NAME);
  const input = page.getByRole('textbox').last();
  await input.click();
  await input.fill('1. a');
  await input.press('Enter');
  await expect(input).toHaveValue('1. a\n2. ');
  await input.press('Enter');
  await expect(input).toHaveValue('1. a\n');
  expect(network.rpcCalls.filter((c) => c.name === 'chat_message_send')).toHaveLength(0);
  expectClean(network);
});

test('an older page paints with its task lines in one commit; the reader does not move', async ({
  page,
}) => {
  const network = await installHarnessNetwork(page);
  // Measures the cold open: no pre-warm (Save-Data).
  await withSaveData(page);
  seedTasks(network.world);
  seedOlderTaskHistory(network.world);
  const olderTask = network.world.tables.chat_tasks?.find((t) => t.title === OLDER_LINE_TITLE);
  const olderLines = `[data-task-id="${String(olderTask?.id)}"]`;
  await openChat(page, GROUP_NAME);
  // Rows paint before the task read lands (tasks are off the open hold): the
  // first page's lines (a burst here) slot in first; the anchor is measured after.
  await page.locator('[data-task-row]').first().waitFor({ state: 'attached', timeout: 8000 });
  await expect(page.locator(olderLines)).toHaveCount(0);

  // Any commit that shows an older row without all its lines is recorded.
  await page.evaluate((selector) => {
    const w = window as unknown as { splitCommit: boolean };
    w.splitCommit = false;
    new MutationObserver(() => {
      // The older page: notes 1 to 20 (the first page ends at note 21).
      const rows = [...document.querySelectorAll('[data-msg-id^="0190e300"]')].filter(
        (el) => Number((el.getAttribute('data-msg-id') ?? '').slice(-12)) <= 20,
      ).length;
      const lines = document.querySelectorAll(selector).length;
      if ((rows > 0 && lines < 3) || (lines > 0 && rows === 0)) w.splitCommit = true;
    }).observe(document.body, { childList: true, subtree: true });
  }, olderLines);

  const gate = network.holdHistory();
  // Scroll up as a finger would (mobile WebKit has no wheel); the anchor is
  // measured before anything else renders.
  const anchor = await page.evaluate(() => {
    const list = document.querySelector('[data-thread-viewport] > ul');
    if (list === null) return null;
    list.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, cancelable: true }));
    list.scrollTop = 0;
    // A few rows below the seam (the seam row itself may regroup with the page).
    const top = list.getBoundingClientRect().top;
    const rows = [...list.querySelectorAll('[data-msg-id]')].filter(
      (el) => el.getBoundingClientRect().top >= top,
    );
    const el = rows[3];
    if (el === undefined) return null;
    return { id: el.getAttribute('data-msg-id'), top: Math.round(el.getBoundingClientRect().top) };
  });
  if (anchor === null || anchor.id === null) throw new Error('no anchor row');
  await page.evaluate(() => window.dispatchEvent(new TouchEvent('touchend', { bubbles: true })));
  await expect(page.getByText('Loading earlier messages')).toBeVisible();
  const topOf = (): Promise<number> =>
    page
      .locator(`[data-msg-id="${anchor.id}"]`)
      .first()
      .evaluate((el) => Math.round(el.getBoundingClientRect().top));
  const before = anchor.top;
  gate.release();

  await expect(page.locator(olderLines)).toHaveCount(3);
  await expect(page.getByText('Loading earlier messages')).toHaveCount(0);
  expect(Math.abs((await topOf()) - before)).toBeLessThanOrEqual(1);
  expect(
    await page.evaluate(() => (window as unknown as { splitCommit: boolean }).splitCommit),
  ).toBe(false);
  expectClean(network);
});
