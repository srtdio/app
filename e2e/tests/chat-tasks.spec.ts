import { expect, test, type Page } from '@playwright/test';
import { expectMinTouchTarget } from '../helpers/touch-target';
import { installHarnessNetwork, type HarnessNetwork } from '../fixtures/harness-routes';
import { DM_CHANNEL, GROUP_NAME, PEER_NAME } from '../fixtures/chat-data';
import {
  DUE_SOON_ID,
  DUE_SOON_TITLE,
  OLDER_LINE_TITLE,
  seedDueSoon,
  seedOlderTaskHistory,
  seedTasks,
  TASK_CHANNEL,
  TASK_DUE_ID,
  TASK_DUE_TITLE,
  TASK_ROW_TITLE,
} from '../fixtures/tasks-data';

// The chat Tasks: the composer button, the sheet (groups, rows, add,
// expand and edit), the change lines in the thread, the bell's task rows,
// Share through Forward, the due-time ring and numbered list continuation. The real app
// tree runs against fixture data; Linux WebKit approximates iOS WebKit.

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
  return sheet;
}

test(
  'task sheet: groups, rows, P tags, due labels; Enter adds and keeps focus',
  { tag: '@theme' },
  async ({ page }) => {
    const network = await installHarnessNetwork(page);
    seedTasks(network.world);
    await openChat(page, GROUP_NAME);

    const button = page.getByRole('button', { name: 'Tasks', exact: true });
    expectMinTouchTarget(await button.boundingBox());
    // Someone else changed the list and this device never opened it: the dot.
    await expect(button.locator('[data-task-dot]')).toBeVisible();
    // The four adds (one person, seconds apart) paint as one line with the
    // messages, and expand in place on tap.
    const burst = page.locator('[data-task-burst]');
    await expect(burst).toHaveText('Leo Martins made 4 task changes');
    await burst.click();
    await expect(page.locator('[data-task-line="created"]')).toHaveCount(4);
    await expect(page.locator('[data-task-line="created"]').first()).toContainText(
      `Leo Martins added 8 ${TASK_ROW_TITLE} · Creators`,
    );

    const sheet = await openSheet(page);
    await expect(sheet.locator('[data-task-group="agency"]')).toContainText('Creators');
    await expect(sheet.locator('[data-task-group="client"]')).toContainText('Approvers');
    await expect(sheet.locator('[data-task-group="done"]')).toContainText('Done today');
    await expect(sheet.locator('[data-task-counts]')).toHaveText(
      '2 open for creators · 2 for approvers',
    );
    // Agency: P1 (8) before P2 (9); Client: P0 (10) before P2 (11).
    const numbers = await sheet
      .locator('[data-task-row-id]')
      .evaluateAll((rows) => rows.map((r) => r.getAttribute('data-task-number')));
    expect(numbers).toEqual(['8', '9', '10', '11']);
    await expect(sheet.locator('[data-task-number="10"] [data-task-p="0"]')).toHaveText('P0');
    await expect(sheet.locator('[data-task-number="8"] [data-task-p="1"]')).toHaveText('P1');
    await expect(sheet.locator('[data-task-number="10"] [data-task-due="missed"]')).toBeVisible();
    await expect(sheet.locator('[data-task-number="11"]')).toContainText('–');
    expectMinTouchTarget(
      await sheet.locator('[data-task-number="8"] button[aria-expanded]').boundingBox(),
    );
    // Opening it cleared the dot.
    await expect(button.locator('[data-task-dot]')).toHaveCount(0);

    const add = sheet.getByRole('textbox', { name: 'Add to Creators' });
    // The next number shows only in the row being typed in.
    await expect(sheet.locator('[data-task-preview]')).toHaveCount(0);
    await add.focus();
    await expect(sheet.locator('[data-task-add="agency"] [data-task-preview]')).toHaveText('12');
    await expect(sheet.locator('[data-task-add="client"] [data-task-preview]')).toHaveCount(0);
    await add.fill('Story frames');
    await add.press('Enter');
    await expect(add).toBeFocused();
    await expect(add).toHaveValue('');
    await expect(sheet.locator('[data-task-add="agency"] [data-task-preview]')).toHaveText('13');
    await add.fill('Grid preview');
    await add.press('Enter');
    await expect(add).toBeFocused();
    await expect(sheet.locator('[data-task-row-id][data-task-number="12"]')).toContainText(
      'Story frames',
    );
    await expect(sheet.locator('[data-task-row-id][data-task-number="13"]')).toContainText(
      'Grid preview',
    );
    const created = network.rpcCalls.filter((c) => c.name === 'chat_task_create');
    expect(created.map((c) => c.args.p_title)).toEqual(['Story frames', 'Grid preview']);
    expect(created.every((c) => c.args.p_side === 'agency' && c.args.p_priority === 2)).toBe(true);
    expect(created.every((c) => typeof c.args.p_trace_id === 'string')).toBe(true);
    expectClean(network);
  },
);

test('edit a row: P0, Tomorrow 12 pm, Shared, then Save: one write, one line', async ({ page }) => {
  const network = await installHarnessNetwork(page);
  seedTasks(network.world);
  await openChat(page, GROUP_NAME);
  const sheet = await openSheet(page);

  const row = sheet.locator('[data-task-number="8"]');
  await row.locator('button[aria-expanded]').click();
  await expect(row).toHaveAttribute('data-task-expanded', '');
  await expect(sheet.locator('[data-task-number="9"]')).toHaveClass(/opacity-45/);

  await row.locator('[data-task-opt="p0"]').click();
  await row.locator('[data-task-opt="tomorrow"]').click();
  // A day without a time is 9 pm, and says so.
  await expect(row.locator('[data-task-due-line]')).toHaveText('Due 9 pm');
  // Tapping the picked day again keeps it.
  await row.locator('[data-task-opt="tomorrow"]').click();
  await expect(row.locator('[data-task-due-line]')).toHaveText('Due 9 pm');
  await row.locator('[data-task-hour="12"]').click();
  await expect(row.locator('[data-task-due-line]')).toHaveText('Due 12 pm');
  await row.locator('[data-task-status="shared"]').click();
  // Nothing is written until Save.
  expect(network.rpcCalls.filter((c) => c.name.startsWith('chat_task_'))).toHaveLength(0);
  await row.locator('[data-task-save]').click();

  // The write leaves after the tap: wait for it to be recorded.
  await expect
    .poll(() => network.rpcCalls.filter((c) => c.name === 'chat_task_save').length)
    .toBe(1);
  const saves = network.rpcCalls.filter((c) => c.name === 'chat_task_save');
  const changes = saves[0]?.args.p_changes as Record<string, unknown>;
  expect(Object.keys(changes).sort()).toEqual(['due', 'priority', 'status']);
  expect(changes.priority).toBe(0);
  expect(changes.status).toBe('shared');
  expect(String(changes.due)).toMatch(/T12:00:00\.000Z$/);
  expect(network.rpcCalls.filter((c) => c.name === 'chat_task_set')).toHaveLength(0);
  await expect(page.locator('[data-task-footer]')).toContainText(
    'Last change: You · #8 updated: status, priority, due · ',
  );

  await page.getByRole('button', { name: 'Close' }).last().click();
  await expect(page.getByRole('dialog', { name: 'Tasks' })).toHaveCount(0);
  await expect(page.locator('[data-task-line="edited"]')).toHaveCount(1);
  await expect(page.locator('[data-task-line="edited"]')).toContainText(
    'You #8 updated: status, priority, due',
  );
  // A tap on a line opens the sheet on that task.
  await page.locator('[data-task-line="edited"]').click();
  await expect(
    page.getByRole('dialog', { name: 'Tasks' }).locator('[data-task-number="8"]'),
  ).toHaveAttribute('data-task-expanded', '');
  expectClean(network);
});

test('Cancel with changes asks first; Delete hides at once and Undo brings it back', async ({
  page,
}) => {
  const network = await installHarnessNetwork(page);
  seedTasks(network.world);
  await openChat(page, GROUP_NAME);
  const sheet = await openSheet(page);

  const row = sheet.locator('[data-task-number="9"]');
  await row.locator('button[aria-expanded]').click();
  await row.locator('[data-task-opt="p0"]').click();
  await row.locator('[data-task-cancel]').click();
  const ask = page.getByRole('alertdialog', { name: 'Discard your changes?' });
  await expect(ask).toBeVisible();
  await ask.getByRole('button', { name: 'Keep editing' }).click();
  await expect(ask).toHaveCount(0);
  await expect(row).toHaveAttribute('data-task-expanded', '');
  await row.locator('[data-task-cancel]').click();
  await page
    .getByRole('alertdialog', { name: 'Discard your changes?' })
    .getByRole('button', { name: 'Discard' })
    .click();
  await expect(row).not.toHaveAttribute('data-task-expanded', '');

  await row.locator('button[aria-expanded]').click();
  await row.locator('[data-task-delete]').click();
  await expect(sheet.locator('[data-task-number="9"]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(sheet.locator('[data-task-number="9"]')).toHaveCount(1);
  expect(network.rpcCalls.filter((c) => c.name === 'chat_task_delete')).toHaveLength(0);
  expectClean(network);
});

test('bell: a missed due time opens the chat on that item; Back closes the sheet; Activity has none', async ({
  page,
}) => {
  const network = await installHarnessNetwork(page);
  seedTasks(network.world);

  // Activity is posts only: its read filters the task alerts out server-side.
  // The top-bar bell reads the same table on every screen (its rows are the
  // event_type.in.(...) filter), so wait for the read that is not the bell's.
  const activityRead = page.waitForRequest((r) => {
    const url = decodeURIComponent(r.url());
    return (
      url.includes('/rest/v1/inbox_entries') &&
      url.includes('task_due') &&
      !url.includes('or=(event_type.in.(reminder')
    );
  });
  await page.goto('/activity');
  expect(decodeURIComponent((await activityRead).url())).toContain(
    'not.in.(reminder,scheduled_sent,scheduled_failed',
  );
  await expect(page.getByText(TASK_DUE_TITLE, { exact: false })).toHaveCount(0);

  await page.goto('/chat');
  const bell = page.locator('[data-bell-button]');
  await bell.click();
  await expect(page.getByRole('dialog', { name: 'Notifications' })).toBeVisible();
  const row = page.locator('[data-bell-row="task-due"]');
  await expect(row).toContainText(`passed · 10 ${TASK_DUE_TITLE}`);
  await row.locator('[data-bell-open]').click();

  const sheet = page.getByRole('dialog', { name: 'Tasks' });
  await expect(sheet).toBeVisible({ timeout: 8000 });
  await expect(page).toHaveURL(new RegExp(`channel=${encodeURIComponent(TASK_CHANNEL)}`));
  const item = sheet.locator(`[data-task-row-id="${TASK_DUE_ID}"]`);
  await expect(item).toHaveAttribute('data-task-expanded', '');
  await expect(item.locator('[data-task-commitment]')).toContainText('Missed: due today');

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
  await sheet.getByRole('button', { name: 'Share tasks' }).click();

  const picker = page.getByRole('dialog', { name: 'Forward to' });
  await expect(picker).toBeVisible();
  await picker.getByRole('button', { name: PEER_NAME }).click();
  await picker.getByRole('button', { name: 'Send to 1 chat' }).click();
  await expect(picker).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'Tasks' })).toHaveCount(0);

  // This chat: the normal send, then the thread's forward of that message.
  const here = page.locator('[data-bubble]', { hasText: `Tasks · ${GROUP_NAME} · ` });
  await expect(here).toBeVisible();
  await expect(here.locator('[data-forwarded]')).toHaveCount(0);
  const sends = network.rpcCalls.filter((c) => c.name === 'chat_message_send');
  const own = sends.filter((c) => c.args.p_channel_id === TASK_CHANNEL);
  const copy = sends.filter((c) => c.args.p_channel_id === DM_CHANNEL);
  expect(own).toHaveLength(1);
  expect(copy).toHaveLength(1);
  const body = String(own[0]?.args.p_body);
  expect(body.startsWith(`Tasks · ${GROUP_NAME} · `)).toBe(true);
  expect(body).toContain('\nCreators\n8. Hook options · P1\n9. Shot list · P2 · today');
  expect(body).toContain(`\nApprovers\n10. ${TASK_DUE_TITLE} · P0 · today`);
  expect(body).toContain('(missed)');
  expect(copy[0]?.args.p_body).toBe(body);
  expect(copy[0]?.args.p_forwarded_from_message_id).toBe(own[0]?.args.p_id);

  // The list: the DM's preview is the snapshot's first line.
  await page.getByRole('button', { name: /back/i }).first().click();
  const firstLine = body.split('\n')[0] ?? '';
  const dmRow = page.getByRole('button', { name: new RegExp(PEER_NAME) }).first();
  await expect(dmRow).toContainText(firstLine);
  await dmRow.click();
  const there = page.locator('[data-bubble]', { hasText: firstLine });
  await expect(there).toBeVisible({ timeout: 8000 });
  await expect(there.locator('[data-forwarded]')).toHaveText('Forwarded');
  expectClean(network);
});

test('a due time comes up while the app is open: toast, tap opens the item', async ({ page }) => {
  const start = new Date();
  start.setSeconds(0, 0);
  await page.clock.install({ time: start });
  const network = await installHarnessNetwork(page);
  seedTasks(network.world, start.getTime());
  seedDueSoon(network.world, start.getTime() + 60_000);

  const dues = page.waitForResponse(
    (r) => r.url().includes('/rest/v1/chat_tasks') && r.url().includes('due_passed_at'),
  );
  await page.goto('/chat');
  // Every first read is in (the jump never times one out), then the minute passes.
  await page.getByText(GROUP_NAME, { exact: true }).first().waitFor({ state: 'visible' });
  await expect(page.locator('[data-bell-badge]')).toBeVisible();
  await dues;
  await page.clock.fastForward(60_000);

  const toast = page.getByText(`Due now: 12 ${DUE_SOON_TITLE}`);
  await expect(toast).toBeVisible();
  await toast.click();
  const sheet = page.getByRole('dialog', { name: 'Tasks' });
  await expect(sheet).toBeVisible({ timeout: 8000 });
  await expect(page).toHaveURL(new RegExp(`channel=${encodeURIComponent(TASK_CHANNEL)}`));
  await expect(sheet.locator(`[data-task-row-id="${DUE_SOON_ID}"]`)).toHaveAttribute(
    'data-task-expanded',
    '',
  );
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
  seedTasks(network.world);
  seedOlderTaskHistory(network.world);
  const olderTask = network.world.tables.chat_tasks?.find((t) => t.title === OLDER_LINE_TITLE);
  const olderLines = `[data-task-id="${String(olderTask?.id)}"]`;
  await openChat(page, GROUP_NAME);
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
