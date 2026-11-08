import { expect, test, type Locator, type Page } from '@playwright/test';
import { installHarnessNetwork, type HarnessNetwork } from '../fixtures/harness-routes';
import { COLLEAGUE_A, ME, POST_IDS, WORKSPACE_ID } from '../fixtures/chat-data';

// Comment to task (8 Nov 2026). Every comment carries its action bar on its
// top edge (Reply, Resolve, To-do, Edit, | Delete), always shown. An agency
// member taps To-do: the "New task" sheet opens with the comment's plain text,
// one pick (Me here: the viewer's Personal notes), Add writes
// comment_task_create, and the comment paints "Task · You" at once with To-do
// gone. The tag opens that chat's Tasks on the task. A client never sees To-do
// and reads the bare state ("Task assigned"). The real app tree runs against
// fixture data; Linux WebKit approximates iOS WebKit, it is not iOS.

const POST = POST_IDS[0] ?? '';
const COMMENT_ID = '0190f200-0000-7000-8000-0000000000f7';
const COMMENT_BODY = 'Swap the **cover** for the morning shot';
const COMMENT_TEXT = 'Swap the cover for the morning shot';
const NOTES = `notes__${WORKSPACE_ID}__${ME}`;

function comment(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: COMMENT_ID,
    workspace_id: WORKSPACE_ID,
    entity_type: 'post',
    entity_id: POST,
    author_user_id: COLLEAGUE_A,
    body: COMMENT_BODY,
    parent_comment_id: null,
    attachment_asset_ids: null,
    mentions: null,
    created_at: new Date(Date.now() - 60_000).toISOString(),
    edited_at: null,
    deleted_at: null,
    legacy_author_name: null,
    legacy_author_email: null,
    ledger_seq: null,
    ledger_batch_id: null,
    resolved_at: null,
    resolved_by: null,
    resolved_version_id: null,
    resolution_note: null,
    asked_at: null,
    asked_by: null,
    sent_back_at: null,
    sent_back_by: null,
    closed_at: null,
    closed_by: null,
    accepted_at: null,
    accepted_by: null,
    unaccepted_at: null,
    unaccepted_by: null,
    task_state: null,
    comment_tasks: null,
    ...extra,
  };
}

function seed(network: HarnessNetwork, extra: Record<string, unknown> = {}): void {
  (network.world.tables.comments ??= []).push(comment(extra));
}

function asClient(network: HarnessNetwork): void {
  for (const m of network.world.tables.workspace_members ?? []) {
    if (m.user_id === ME) m.role = 'client';
  }
}

function rowOf(page: Page): Locator {
  return page.locator(`#post-comments [id="comment-${COMMENT_ID}"]`).first();
}

function barOf(page: Page): Locator {
  return rowOf(page).locator('[data-comment-row="root"] [data-comment-bar]').first();
}

async function openPost(page: Page): Promise<void> {
  await page.goto(`/posts/${POST}`);
  await expect(page.getByRole('heading', { name: 'Monday carousel', level: 1 })).toBeVisible({
    timeout: 15_000,
  });
  await expect(rowOf(page)).toContainText(COMMENT_TEXT);
  await rowOf(page).scrollIntoViewIfNeeded();
}

test('an agency member turns a comment into a task for Me @theme', async ({ page }) => {
  const network = await installHarnessNetwork(page);
  seed(network);
  await openPost(page);

  // The bar is always shown: Reply, Resolve, To-do on someone else's comment;
  // no Copy, no Reply privately, no role label, no ⋯.
  const bar = barOf(page);
  await expect(bar).toBeVisible();
  const names = await bar
    .locator('button')
    .evaluateAll((els) => els.map((el) => el.getAttribute('aria-label') ?? ''));
  expect(names).toEqual(['Reply', 'Resolve', 'To-do']);
  await expect(rowOf(page).locator('[data-row-action="copy"]')).toHaveCount(0);
  await expect(rowOf(page).getByRole('button', { name: 'Reply privately' })).toHaveCount(0);

  // The bar rides half above the row, right aligned.
  const row = await rowOf(page).locator('[data-comment-row="root"]').first().boundingBox();
  const pill = await bar.boundingBox();
  if (row === null || pill === null) throw new Error('no boxes');
  expect(Math.abs(pill.y + pill.height / 2 - row.y)).toBeLessThanOrEqual(2);
  expect(Math.abs(pill.x + pill.width - (row.x + row.width))).toBeLessThanOrEqual(2);

  // To-do: the "New task" sheet, the comment's plain text in the field.
  await bar.getByRole('button', { name: 'To-do' }).click();
  const sheet = page.getByRole('dialog', { name: 'New task' });
  await expect(sheet).toBeVisible();
  await expect(sheet.locator('[data-comment-task-title]')).toHaveValue(COMMENT_TEXT);
  // People are agency side only: the client (Priya) is never offered.
  await expect(sheet.locator('[data-comment-task-people]')).not.toContainText('Priya');
  const add = sheet.locator('[data-comment-task-add]');
  await expect(add).toBeDisabled();

  await sheet.locator('[data-task-target="me"]').click();
  await expect(add).toBeEnabled();
  await add.click();
  await expect(sheet).toBeHidden();

  const call = network.rpcCalls.find((c) => c.name === 'comment_task_create');
  expect(call?.args).toMatchObject({
    p_comment_id: COMMENT_ID,
    p_channel_id: NOTES,
    p_title: COMMENT_TEXT,
    p_priority: 1,
    p_due_on: null,
  });
  expect(typeof call?.args.p_trace_id).toBe('string');

  // The tag paints at once; To-do is gone (one task per comment).
  const tag = rowOf(page).locator('[data-comment-task-tag]').first();
  await expect(tag).toHaveText('Task · You');
  await expect(bar.getByRole('button', { name: 'To-do' })).toHaveCount(0);
  // Finishing a task never resolves the comment: Resolve is still offered.
  await expect(bar.getByRole('button', { name: 'Resolve' })).toBeVisible();

  // The tag opens that chat's Tasks sheet on the task: it navigates to the chat
  // task link. ChatConnected consumes and drops `task` from the URL at once, so
  // the link is read from the history push, not from the settled URL.
  await page.evaluate(() => {
    const w = window as unknown as { __pushed: string[] };
    w.__pushed = [];
    const push = history.pushState.bind(history);
    history.pushState = (data: unknown, unused: string, url?: string | URL | null) => {
      if (url !== undefined && url !== null) w.__pushed.push(String(url));
      push(data, unused, url);
    };
  });
  await tag.locator('[data-comment-task-open]').click();
  await expect(page).toHaveURL(new RegExp(`/chat\\?channel=${encodeURIComponent(NOTES)}`));
  const pushed = await page.evaluate(() => (window as unknown as { __pushed: string[] }).__pushed);
  expect(pushed.some((u) => u.includes(`channel=${encodeURIComponent(NOTES)}&task=`))).toBe(true);
});

test('a client never sees To-do and reads the bare task state', async ({ page }) => {
  const network = await installHarnessNetwork(page);
  asClient(network);
  seed(network, {
    task_state: 'assigned',
    // RLS gives a client no link row: the embed reads null.
    comment_tasks: null,
  });
  await openPost(page);

  const bar = barOf(page);
  await expect(bar.getByRole('button', { name: 'Reply' })).toBeVisible();
  await expect(bar.getByRole('button', { name: 'To-do' })).toHaveCount(0);
  await expect(bar.getByRole('button', { name: 'Resolve' })).toHaveCount(0);
  const tag = rowOf(page).locator('[data-comment-task-tag]').first();
  await expect(tag).toHaveText('Task assigned');
  await expect(tag.locator('[data-comment-task-open]')).toHaveCount(0);
});

test('a done task reads "Task done · {name}" for the agency, never resolving the comment', async ({
  page,
}) => {
  const network = await installHarnessNetwork(page);
  seed(network, {
    task_state: 'done',
    comment_tasks: {
      task_id: '0190e100-0000-7000-8000-0000000000f8',
      channel_id: `dm__${WORKSPACE_ID}__${ME}__${COLLEAGUE_A}`,
      assignee_user_id: COLLEAGUE_A,
      group_name: null,
    },
  });
  await openPost(page);
  await expect(rowOf(page).locator('[data-comment-task-tag]').first()).toHaveText(
    'Task done · Leo',
  );
  await expect(barOf(page).getByRole('button', { name: 'Resolve' })).toBeVisible();
  await expect(barOf(page).getByRole('button', { name: 'To-do' })).toHaveCount(0);
});
