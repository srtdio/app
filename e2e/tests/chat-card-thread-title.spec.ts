import { expect, test, type Page } from '@playwright/test';
import { installHarnessNetwork, type HarnessNetwork } from '../fixtures/harness-routes';
import {
  DM_CHANNEL,
  ME,
  PEER,
  PEER_NAME,
  PLAN_ID,
  PLAN_MESSAGE_ID,
  PLAN_THREAD_REPLY_BODY,
  PLAN_TITLE,
  planThreadReply,
  seedClientPlan,
} from '../fixtures/chat-data';

// A thread on any card takes the card's name and shows the card: a reply to
// a plan card message opens a thread titled with the plan's title over the
// chat's name, and the thread's root draws the same plan card as the chat.
// Real app tree against fixture data, light and dark projects. Linux WebKit
// approximates iOS WebKit, it is not iOS.

const LIB_IMAGE_VERSION = '0190e100-0000-7000-8000-0000000000b1';

function expectClean(network: HarnessNetwork): void {
  expect(network.blocked, 'blocked non-fixture requests').toEqual([]);
  expect([...new Set(network.unmatched)], 'unrecognised fixture requests').toEqual([]);
}

async function openChat(page: Page, name: string): Promise<void> {
  await page.goto('/chat');
  const target = page.getByText(name, { exact: true }).first();
  await target.waitFor({ state: 'visible' });
  await target.click();
  await page.locator('[data-msg-id]').first().waitFor({ state: 'visible', timeout: 8000 });
}

test(
  'a thread on a plan card: Chat reply in the bar, the chat name under it, the plan card in the root',
  { tag: '@theme' },
  async ({ page }) => {
    const network = await installHarnessNetwork(page);
    seedClientPlan(network.world, {
      channelId: DM_CHANNEL,
      sender: PEER,
      fileVersionId: LIB_IMAGE_VERSION,
    });
    (network.world.tables.chat_messages ??= []).push(planThreadReply(DM_CHANNEL, ME));
    await openChat(page, PEER_NAME);

    // The main chat: the plan card root with its replies row; the reply stays out.
    const rootRow = page.locator(`li[data-msg-id="${PLAN_MESSAGE_ID}"]`).first();
    await expect(rootRow.locator(`[data-plan-card="${PLAN_ID}"]`)).toBeVisible();
    await expect(page.locator('li[data-msg-id]', { hasText: PLAN_THREAD_REPLY_BODY })).toHaveCount(
      0,
    );
    const replies = page.locator('[data-replies-row]', { hasText: '1 reply' }).last();
    await expect(replies).toBeVisible();
    await replies.locator('button').click();

    const view = page.locator('[data-thread-view]');
    await expect(view).toBeVisible();
    await expect(view.locator('[data-thread-view-title]')).toHaveText('Chat reply');
    await expect(view.locator('[data-thread-view-subtitle]')).toHaveText(PEER_NAME);
    // The title is one line (truncates, never wraps).
    const lines = await view
      .locator('[data-thread-view-title]')
      .evaluate((el) => el.getClientRects().length);
    expect(lines).toBe(1);

    // The root draws the plan card exactly as the chat does.
    const viewRoot = view.locator(`li[data-msg-id="${PLAN_MESSAGE_ID}"]`);
    await expect(viewRoot.locator(`[data-plan-card="${PLAN_ID}"]`)).toBeVisible();
    await expect(viewRoot).toContainText(PLAN_TITLE);
    await expect(view.locator('[data-thread-separator]')).toHaveText('1 reply');
    await expect(
      view.locator('li[data-msg-id]', { hasText: PLAN_THREAD_REPLY_BODY }),
    ).toBeVisible();
    expectClean(network);
  },
);
