import { expect, test, type Page } from '@playwright/test';
import { expectMinTouchTarget } from '../helpers/touch-target';
import { installHarnessNetwork, type HarnessNetwork } from '../fixtures/harness-routes';
import { DM_CHANNEL, GROUP_NAME, PEER_NAME } from '../fixtures/chat-data';
import {
  OLDER_LINE_TITLE,
  seedOlderTaskHistory,
  seedTasks,
  TASK_CHANNEL,
  TASK_DUE_ID,
  TASK_DUE_TITLE,
  TASK_ROW_TITLE,
} from '../fixtures/tasks-data';

// The chat task list: the composer button, the sheet (groups, rows, add,
// expand and edit), the change lines in the thread, the bell's task rows,
// Share as a plain-text message and numbered list continuation. The real app
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
  const button = page.getByRole('button', { name: 'Task list' });
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

    const button = page.getByRole('button', { name: 'Task list' });
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
      `Leo Martins added 8 ${TASK_ROW_TITLE} · Agency`,
    );

    const sheet = await openSheet(page);
    await expect(sheet.locator('[data-task-group="agency"]')).toContainText('Agency');
    await expect(sheet.locator('[data-task-group="client"]')).toContainText('Client');
    await expect(sheet.locator('[data-task-group="done"]')).toContainText('Done today');
    await expect(sheet.locator('[data-task-counts]')).toHaveText('2 agency · 2 client · 0 done');
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

    const add = sheet.getByRole('textbox', { name: 'Add to Agency' });
    await expect(sheet.locator('[data-task-add="agency"] [data-task-preview]')).toHaveText('12');
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

test('expand a row: P0, Tomorrow 12 pm, Shared; the thread and footer show it', async ({
  page,
}) => {
  const network = await installHarnessNetwork(page);
  seedTasks(network.world);
  await openChat(page, GROUP_NAME);
  const sheet = await openSheet(page);

  const row = sheet.locator('[data-task-number="8"]');
  await row.locator('button[aria-expanded]').click();
  await expect(row).toHaveAttribute('data-task-expanded', '');
  await expect(sheet.locator('[data-task-number="9"]')).toHaveClass(/opacity-45/);

  await row.locator('[data-task-opt="p0"]').click();
  await expect(row.locator('[data-task-p="0"]')).toBeVisible();
  await row.locator('[data-task-opt="tomorrow"]').click();
  // The time is required: nothing saved until it is tapped.
  expect(network.rpcCalls.filter((c) => c.args.p_field === 'due')).toHaveLength(0);
  await row.locator('[data-task-hour="12"]').click();
  await expect(row.locator('[data-task-due]')).toHaveText('Tmrw 12 pm');
  await expect(row.locator('[data-task-commitment]')).toContainText(
    'Due tomorrow 12 pm · set by You',
  );
  await row.locator('[data-task-status="shared"]').click();
  // Still in place while expanded (the order holds until it collapses).
  await expect(row.locator('[data-task-glyph="shared"]').first()).toBeVisible();

  const sets = network.rpcCalls.filter((c) => c.name === 'chat_task_set');
  expect(sets.map((c) => [c.args.p_field, c.args.p_value])).toEqual([
    ['priority', '0'],
    ['due', sets[1]?.args.p_value],
    ['status', 'shared'],
  ]);
  expect(String(sets[1]?.args.p_value)).toMatch(/T12:00:00\.000Z$/);
  await expect(page.locator('[data-task-footer]')).toContainText(
    `Last change: You · 8 ${TASK_ROW_TITLE} → Shared · `,
  );

  await page.getByRole('button', { name: 'Close' }).last().click();
  await expect(page.getByRole('dialog', { name: 'Tasks' })).toHaveCount(0);
  await expect(page.locator('[data-task-line="priority"]')).toContainText('You 8 P1 → P0');
  await expect(page.locator('[data-task-line="due"]')).toContainText('You 8 due tomorrow 12 pm');
  await expect(page.locator('[data-task-line="status"]')).toContainText(
    `You 8 ${TASK_ROW_TITLE} → Shared`,
  );
  // A tap on a line opens the sheet on that item.
  await page.locator('[data-task-line="status"]').click();
  await expect(
    page.getByRole('dialog', { name: 'Tasks' }).locator('[data-task-number="8"]'),
  ).toHaveAttribute('data-task-expanded', '');
  expectClean(network);
});

test('bell: a missed due time opens the chat on that item; Back closes the sheet; Activity has none', async ({
  page,
}) => {
  const network = await installHarnessNetwork(page);
  seedTasks(network.world);

  // Activity is posts only: its read filters the task alerts out server-side.
  const activityRead = page.waitForRequest(
    (r) => r.url().includes('/rest/v1/inbox_entries') && r.url().includes('task_due'),
  );
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

test('Share: the snapshot lands as a text message in the picked chat', async ({ page }) => {
  const network = await installHarnessNetwork(page);
  seedTasks(network.world);
  await openChat(page, GROUP_NAME);
  const sheet = await openSheet(page);
  await sheet.getByRole('button', { name: 'Share task list' }).click();

  const picker = page.getByRole('dialog', { name: 'Forward to' });
  await expect(picker).toBeVisible();
  await picker.getByRole('button', { name: PEER_NAME }).click();
  await picker.getByRole('button', { name: 'Send to 1 chat' }).click();
  await expect(picker).toHaveCount(0);

  const sends = network.rpcCalls.filter(
    (c) => c.name === 'chat_message_send' && c.args.p_channel_id === DM_CHANNEL,
  );
  expect(sends).toHaveLength(1);
  const body = String(sends[0]?.args.p_body);
  expect(body.startsWith(`Task list · ${GROUP_NAME} · `)).toBe(true);
  expect(body).toContain('\nAgency\n8. Hook options · P1\n9. Shot list · P2 · today');
  expect(body).toContain(`\nClient\n10. ${TASK_DUE_TITLE} · P0 · today`);
  expect(body).toContain('(missed)');
  expect(sends[0]?.args.p_forwarded_from_message_id).toBeUndefined();

  await page.getByRole('button', { name: 'Close' }).last().click();
  await page.goto(`/chat?channel=${encodeURIComponent(DM_CHANNEL)}`);
  await expect(page.locator('[data-bubble]', { hasText: `Task list · ${GROUP_NAME}` })).toBeVisible(
    {
      timeout: 8000,
    },
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
