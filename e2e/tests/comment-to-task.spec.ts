import { expect, test, type Locator, type Page } from '@playwright/test';
import { installHarnessNetwork, type HarnessNetwork } from '../fixtures/harness-routes';
import { COLLEAGUE_A, ME, POST_IDS, WORKSPACE_ID } from '../fixtures/chat-data';

// Comment to task (8 Nov 2026; comments as a chat, 11 Nov 2026). A comment is
// chat's row: no action bar. Its long-press (touch) or right-click (laptop)
// opens chat's MessageActionMenu, whose Add to Tasks is the comment's To-do:
// the "New task" sheet opens with the comment's plain text, one pick (Me here:
// the viewer's Personal notes), Add writes comment_task_create, and the
// comment paints "Task · You" at once with Add to Tasks gone from its menu.
// The tag opens that chat's Tasks on the task. A client is never offered Add
// to Tasks and reads the bare state ("Task assigned"). The real app tree runs
// against fixture data; Linux WebKit approximates iOS WebKit, it is not iOS.

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
  return page.locator(`#post-comments [data-comments-list] [data-comment-id="${COMMENT_ID}"]`);
}

/** Chat's message menu on the comment: right-click on a laptop, a held finger on touch. */
async function openMenu(page: Page): Promise<Locator> {
  const bubble = rowOf(page).locator('[data-bubble]').first();
  await bubble.scrollIntoViewIfNeeded();
  if ((page.viewportSize()?.width ?? 0) >= 768) {
    await bubble.click({ button: 'right' });
  } else {
    const box = await bubble.boundingBox();
    if (box === null) throw new Error('comment bubble has no box');
    const at = { clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 };
    const touch = { ...at, pointerType: 'touch', pointerId: 7, isPrimary: true };
    await bubble.dispatchEvent('pointerdown', touch);
    await page.waitForTimeout(900);
    await bubble.dispatchEvent('pointerup', touch);
  }
  const menu = page.getByRole('menu', { name: 'Message actions' });
  await expect(menu).toBeVisible();
  return menu;
}

async function closeMenu(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu', { name: 'Message actions' })).toHaveCount(0);
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

  // No action bar: the comment is chat's row; its menu carries Add to Tasks
  // on someone else's comment, never Reply (a tap opens the thread instead).
  await expect(page.locator('#post-comments [data-comment-bar]')).toHaveCount(0);
  const menu = await openMenu(page);
  await expect(menu.locator('[data-menu-item="reply"]')).toHaveCount(0);

  // Add to Tasks: the "New task" sheet, the comment's plain text in the field.
  await menu.locator('[data-menu-item="add-task"]').click();
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

  // The tag paints at once; Add to Tasks is gone (one task per comment).
  const tag = rowOf(page).locator('[data-comment-task-tag]').first();
  await expect(tag).toHaveText('Task · You');
  const again = await openMenu(page);
  await expect(again.locator('[data-menu-item="add-task"]')).toHaveCount(0);
  await closeMenu(page);

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

test('a client never sees Add to Tasks and reads the bare task state', async ({ page }) => {
  const network = await installHarnessNetwork(page);
  asClient(network);
  seed(network, {
    task_state: 'assigned',
    // RLS gives a client no link row: the embed reads null.
    comment_tasks: null,
  });
  await openPost(page);

  const menu = await openMenu(page);
  await expect(menu.locator('[data-menu-item="add-task"]')).toHaveCount(0);
  await closeMenu(page);
  const tag = rowOf(page).locator('[data-comment-task-tag]').first();
  await expect(tag).toHaveText('Task assigned');
  await expect(tag.locator('[data-comment-task-open]')).toHaveCount(0);
});

test('a done task reads "Task done · {name}" for the agency, with no second task', async ({
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
  const menu = await openMenu(page);
  await expect(menu.locator('[data-menu-item="add-task"]')).toHaveCount(0);
});
