import { expect, test, type Locator, type Page } from '@playwright/test';
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

// The chat Tasks: one shared list every member edits the same way, a sheet at
// the height of what it holds. The composer button, the sheet (chips, tick,
// inline edit, the priority menu, add, a swipe left or the row menu's Delete),
// every change saving itself (chat_task_save_batch once changes settle, the
// header reading Saving… / Saved), one "edited tasks" line for one person's
// saves in half an hour that expands in place, the marks another person's
// save leaves, both editing the same task (Keep mine / Keep theirs), Share,
// the bell and numbered list continuation. The real app tree runs against
// fixture data; the other member's save is written straight into the fixture
// tables. Linux WebKit approximates iOS WebKit.

interface SentBatch {
  creates: { title: string; priority: number; side: string }[];
  edits: { task_id: string; changes: Record<string, unknown>; base_updated_at: string }[];
  deletes: unknown[];
}

/** Every chat_task_save_batch payload sent so far. */
function batchesOf(network: HarnessNetwork): SentBatch[] {
  return network.rpcCalls
    .filter((c) => c.name === 'chat_task_save_batch')
    .map((c) => c.args.p_batch as SentBatch);
}

/** The header settles on Saved once nothing waits to be sent. */
async function expectSaved(sheet: Locator): Promise<void> {
  await expect(sheet.locator('[data-task-save-state]')).toHaveAttribute(
    'data-task-save-state',
    'saved',
    { timeout: 8000 },
  );
}

function expectClean(network: HarnessNetwork): void {
  expect(network.blocked, 'blocked non-fixture requests').toEqual([]);
  expect([...new Set(network.unmatched)], 'unrecognised fixture requests').toEqual([]);
}

async function openChat(page: Page, name: string): Promise<void> {
  await page.goto('/chat');
  await page.getByText(name, { exact: true }).first().click();
  await page.locator('[data-msg-id]').first().waitFor({ state: 'visible', timeout: 8000 });
}

/** The tray's Tasks tile (the tray opens from the composer's plus). */
async function tasksTile(page: Page): Promise<ReturnType<Page['locator']>> {
  await page.getByRole('button', { name: 'Add attachment' }).click();
  const tile = page.locator('[data-tray-tile="tasks"]');
  await expect(tile).toBeVisible();
  return tile;
}

async function openSheet(page: Page): Promise<ReturnType<Page['getByRole']>> {
  const tile = await tasksTile(page);
  await tile.click();
  const sheet = page.getByRole('dialog', { name: 'Tasks' });
  await expect(sheet).toBeVisible();
  await expect(sheet.locator('[data-task-list]')).toBeVisible();
  return sheet;
}

/** The sheet's one header action: Share to chat. */
async function openShare(page: Page): Promise<void> {
  await page
    .getByRole('dialog', { name: 'Tasks' })
    .getByRole('button', { name: 'Share to chat', exact: true })
    .click();
}
/** The row whose title holds `text`. */
function rowOf(sheet: ReturnType<Page['getByRole']>, text: string): ReturnType<Page['locator']> {
  return sheet.locator('[data-task-row-id]', { hasText: text });
}
/** A row's own menu (a right-click on its title), then one of its rows. */
async function rowMenuPick(
  page: Page,
  row: ReturnType<Page['locator']>,
  label: string,
): Promise<void> {
  await row.locator('[data-task-title]').click({ button: 'right' });
  await page.getByRole('menuitem', { name: label }).click();
  await expect(page.getByRole('menuitem')).toHaveCount(0);
}

/** A finger drags a row's title by dx px (left when negative) and lets go, on touch. */
async function swipeRow(row: ReturnType<Page['locator']>, dx: number): Promise<void> {
  const title = row.locator('[data-task-title]');
  const box = await title.boundingBox();
  if (box === null) throw new Error('row has no box');
  const y = box.y + box.height / 2;
  const x0 = box.x + box.width / 2;
  const touch = { pointerType: 'touch', pointerId: 7, isPrimary: true, clientY: y };
  // Park Playwright's cursor in the corner, off the row: a cursor over the
  // row sends a pointermove when the row slides under it (from a stale click,
  // or parked at the start point, which drags the swipe back to 0).
  await title.page().mouse.move(1, 1);
  await title.dispatchEvent('pointerdown', { ...touch, clientX: x0 });
  const steps = 8;
  for (let i = 1; i <= steps; i += 1) {
    await title.dispatchEvent('pointermove', { ...touch, clientX: x0 + (dx * i) / steps });
  }
  await title.dispatchEvent('pointerup', { ...touch, clientX: x0 + dx });
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
  'changes save themselves: edit 2, add 1, exactly one "edited tasks" line that expands to 3 rows; the other side is marked',
  { tag: '@theme' },
  async ({ page }) => {
    const network = await installHarnessNetwork(page);
    seedTasks(network.world);
    await openChat(page, GROUP_NAME);
    const tile = await tasksTile(page);
    expectMinTouchTarget(await tile.boundingBox());
    await page.keyboard.press('Escape');

    const sheet = await openSheet(page);
    // Nothing dated: the sheet opens on No date, one flat list in number order
    // (no groups, no side labels, no old due-time labels); no Save button.
    await expect(sheet.locator('[data-task-list]')).toHaveAttribute('data-task-chip', 'none');
    const titles = await sheet.locator('[data-task-row-id] [data-task-title]').allTextContents();
    expect(titles).toEqual(['Hook options', 'Shot list', TASK_DUE_TITLE, 'Brand colours']);
    await expect(sheet).not.toContainText('Creators');
    await expect(sheet).not.toContainText('Approvers');
    await expect(sheet.locator('[data-task-due]')).toHaveCount(0);
    await expect(sheet.locator('[data-task-save]')).toHaveCount(0);
    await expect(sheet.locator('[data-task-save-state]')).toHaveCount(0);
    // One header action: Share to chat (no ⋯, no search, no full screen).
    await expect(sheet.getByRole('button', { name: 'More actions' })).toHaveCount(0);
    await expect(sheet.getByRole('button', { name: 'Share to chat', exact: true })).toBeVisible();
    await expect(sheet.locator('[data-task-search]')).toHaveCount(0);
    expectMinTouchTarget(
      await rowOf(sheet, 'Hook options').locator('[data-task-tick]').boundingBox(),
    );

    // The priority menu on the last row stays fully on screen.
    await rowOf(sheet, 'Brand colours').locator('[data-task-chip]').click();
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
    await rowOf(sheet, 'Shot list').locator('[data-task-title]').click();
    const title = sheet.locator('[data-task-title-input]');
    await expect(title).toBeFocused();
    await title.fill('Shot list v2');
    await title.press('Enter');
    await rowOf(sheet, 'Hook options').locator('[data-task-tick]').click();
    await rowOf(sheet, 'Hook options').locator('[data-task-tick]').click();
    const add = sheet.getByRole('textbox', { name: 'Add a task' });
    // No date, so the new task stays on this chip, unsaved (its dot).
    await sheet.locator('[data-task-days="add"] [data-task-day="none"]').click();
    await add.fill('Story frames');
    await add.press('Enter');
    await expect(add).toBeFocused();

    // Nothing to press: the changes go out once they settle (one or more
    // saves, by timing), and the header lands on Saved.
    await expectSaved(sheet);
    const batches = batchesOf(network);
    expect(batches.length).toBeGreaterThanOrEqual(1);
    expect(batches.flatMap((b) => b.creates)).toEqual([
      { title: 'Story frames', priority: 1, side: 'agency' },
    ]);
    const changes = batches.flatMap((b) => b.edits.map((e) => e.changes));
    expect(changes).toHaveLength(2);
    expect(changes).toEqual(expect.arrayContaining([{ priority: 0 }, { title: 'Shot list v2' }]));
    const bases = batches.flatMap((b) => b.edits.map((e) => e.base_updated_at));
    expect(bases.every((b) => typeof b === 'string')).toBe(true);
    const call = network.rpcCalls.find((c) => c.name === 'chat_task_save_batch');
    expect(typeof call?.args.p_trace_id).toBe('string');
    await expect(rowOf(sheet, 'Story frames')).not.toHaveAttribute('data-task-marked', '');

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
    const marked = rowOf(again, 'Shot list v3');
    await expect(marked).toHaveAttribute('data-task-marked', '');
    await expect(marked.locator('[data-task-mark]')).toHaveText('was Shot list v2');
    await expect(rowOf(again, 'Hook options')).not.toHaveAttribute('data-task-marked', '');
    expectClean(network);
  },
);

test('both edit the same task: the second saver sees Keep mine / Keep theirs', async ({ page }) => {
  const network = await installHarnessNetwork(page);
  seedTasks(network.world);
  await openChat(page, GROUP_NAME);
  const sheet = await openSheet(page);
  // The other member saves task 8 first; this sheet still holds its old row.
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
  await rowOf(sheet, 'Hook options').locator('[data-task-title]').click();
  await sheet.locator('[data-task-title-input]').fill('Hook (mine)');
  await sheet.locator('[data-task-title-input]').press('Enter');
  await rowOf(sheet, 'Brand colours').locator('[data-task-tick]').click();

  // Everything else saves itself; task 8 is held back and asks.
  const conflict = sheet.locator('[data-task-conflict]');
  await expect(conflict).toContainText('changed this to "Hook (Leo)"', { timeout: 8000 });
  await expect(sheet.locator('[data-task-keep-mine]')).toHaveText('Keep mine');
  await expect(sheet.locator('[data-task-keep-theirs]')).toHaveText('Keep theirs');
  await expect.poll(() => taskRow(network, 11).status).toBe('done');
  expect(taskRow(network, 8).title).toBe('Hook (Leo)');

  await sheet.locator('[data-task-keep-mine]').click();
  await expect(sheet.locator('[data-task-conflict]')).toHaveCount(0);
  await expect.poll(() => taskRow(network, 8).title).toBe('Hook (mine)');
  expectClean(network);
});

test("Close with changes still waiting saves them, then closes; the Add button adds; a swipe left (or the row menu's Delete) queues a delete", async ({
  page,
}) => {
  const network = await installHarnessNetwork(page);
  seedTasks(network.world);
  await openChat(page, GROUP_NAME);
  const sheet = await openSheet(page);
  // The round Add button beside the well (44px, like the chat composer's
  // send) adds a task as Enter does; it waits for text.
  const add = sheet.getByRole('textbox', { name: 'Add a task' });
  const addButton = sheet.getByRole('button', { name: 'Add task' });
  await expect(addButton).toBeDisabled();
  expectMinTouchTarget(await addButton.boundingBox());
  // No date, so the sheet stays on this chip (a dated task moves it to Today).
  await sheet.locator('[data-task-days="add"] [data-task-day="none"]').click();
  await add.fill('Story frames');
  await addButton.click();
  await expect(rowOf(sheet, 'Story frames')).toHaveAttribute('data-task-marked', '');
  await expect(addButton).toBeDisabled();
  const row = rowOf(sheet, 'Shot list');
  // On a phone there is no bin button: the row swipes left. A short drag
  // springs back; past the trigger it is queued, with Undo; the row menu still
  // offers Delete.
  await expect(row.locator('[data-task-delete]')).toHaveCount(0);
  await swipeRow(row, -30);
  await expect(row).not.toHaveAttribute('data-task-deleting', '');
  await swipeRow(row, -90);
  await expect(row).toHaveAttribute('data-task-deleting', '');
  await expect(row.locator('[data-task-undo-delete]')).toBeVisible();
  await row.locator('[data-task-undo-delete]').click();
  await expect(row).not.toHaveAttribute('data-task-deleting', '');
  await rowMenuPick(page, row, 'Delete');
  await expect(row).toHaveAttribute('data-task-deleting', '');
  await sheet.getByRole('button', { name: 'Close tasks' }).click();
  // No question: what waits is sent, then the sheet closes.
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'Tasks' })).toHaveCount(0);
  await expect.poll(() => taskRow(network, 9).deleted_at).not.toBeNull();
  expect(batchesOf(network).flatMap((b) => b.deletes)).toHaveLength(1);
  expect(batchesOf(network).flatMap((b) => b.creates.map((c) => c.title))).toEqual([
    'Story frames',
  ]);
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
  await openSheet(page);
  await openShare(page);

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
