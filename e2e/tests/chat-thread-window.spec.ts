import { expect, test, type Page } from '@playwright/test';
import { installHarnessNetwork, type HarnessNetwork } from '../fixtures/harness-routes';
import { DM_CHANNEL, ME, PEER, PEER_NAME, WORKSPACE_ID } from '../fixtures/chat-data';
import type { Row } from '../fixtures/postgrest';

// The chat thread mounts a bounded window of rows (src/lib/chat/thread-window.ts):
// the latest 50 on open, 50 more each time the reader scrolls to the top
// (loaded rows first, else the older page), never more than 300. Each prepend
// keeps the first message on screen exactly where it was, whether the rows
// came from the network (an older page) or from memory (rows still loaded
// after Scroll to latest). Tagged @theme so it runs in dark and light. Linux
// WebKit approximates iOS WebKit; it is not iOS.

const MAX_MOUNTED = 300;
const STEP = 50;
/** Older DM rows before the fixture's 40: eight pages in all. */
const SEEDED = 360;
const HOUR = 3_600_000;

function olderId(n: number): string {
  return `0190b000-0000-7000-8a00-${String(n).padStart(12, '0')}`;
}

/** Plain text rows (no media, so no late height changes), oldest last. */
function seedOlder(network: HarnessNetwork): void {
  const rows: Row[] = (network.world.tables.chat_messages ??= []);
  const before = Date.now() - 31 * HOUR;
  for (let n = 1; n <= SEEDED; n += 1) {
    rows.push({
      id: olderId(n),
      channel_id: DM_CHANNEL,
      workspace_id: WORKSPACE_ID,
      sender_user_id: n % 2 === 0 ? ME : PEER,
      body: `Window note ${n}`,
      mentions: null,
      attachment_asset_ids: null,
      shared_post_ids: null,
      shared_brief_ids: null,
      reply_to_message_id: null,
      forwarded_from_message_id: null,
      attachment_meta: null,
      agora_event_id: null,
      created_at: new Date(before - n * 60_000).toISOString(),
      edited_at: null,
      deleted_at: null,
      thread_root_message_id: null,
    });
  }
}

async function mounted(page: Page): Promise<number> {
  return page.locator('[data-msg-id]').count();
}

interface Anchor {
  id: string;
  /** The row's top, from the list's top edge. */
  top: number;
}

/**
 * The reader scrolls to the top: a wheel (the reader's gesture), then the
 * list at 0. The first message on screen is read in the same task, before
 * the scroll event lands and anything is prepended.
 */
async function scrollToTop(page: Page): Promise<Anchor | null> {
  return page.evaluate(() => {
    const list = document.querySelector('[data-msg-id]')?.closest('ul');
    if (!list) return null;
    list.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -120 }));
    list.scrollTop = 0;
    const listTop = list.getBoundingClientRect().top;
    for (const row of Array.from(list.querySelectorAll<HTMLElement>('[data-msg-id]'))) {
      const r = row.getBoundingClientRect();
      if (r.bottom > listTop) return { id: row.dataset.msgId ?? '', top: r.top - listTop };
    }
    return null;
  });
}

async function rowTop(page: Page, id: string): Promise<number | null> {
  return page.evaluate((target) => {
    const row = document.querySelector<HTMLElement>(`[data-msg-id="${target}"]`);
    const list = row?.closest('ul');
    if (!row || !list) return null;
    return row.getBoundingClientRect().top - list.getBoundingClientRect().top;
  }, id);
}

/** Two frames: the prepend's commit and its restore have painted. */
async function frames(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

async function firstMounted(page: Page): Promise<string | null> {
  return page.locator('[data-msg-id]').first().getAttribute('data-msg-id');
}

/** Rows landed above (a new first row), and the anchor row did not move. */
async function expectPrependHolds(page: Page, anchor: Anchor | null, firstBefore: string | null) {
  expect(anchor, 'a message on screen at the top').not.toBeNull();
  if (anchor === null) return;
  await expect.poll(() => firstMounted(page), { timeout: 8_000 }).not.toBe(firstBefore);
  await frames(page);
  const after = await rowTop(page, anchor.id);
  expect(after, `${anchor.id} still mounted`).not.toBeNull();
  expect(Math.abs((after ?? 0) - anchor.top), 'first visible message moved').toBeLessThanOrEqual(1);
}

test('chat thread window: prepends keep the first visible message in place @theme', async ({
  page,
}) => {
  const network = await installHarnessNetwork(page);
  seedOlder(network);
  await page.goto('/chat');
  await page.getByText(PEER_NAME, { exact: true }).first().click();
  await page.locator('[data-msg-id]').first().waitFor({ state: 'visible', timeout: 8_000 });
  await page.waitForTimeout(600);
  // Open: the latest page, no more than one window step.
  const open = await mounted(page);
  expect(open).toBeGreaterThan(0);
  expect(open).toBeLessThanOrEqual(STEP);

  // 1. The older page from the network: held until the anchor is read.
  const gate = network.holdHistory();
  let first = await firstMounted(page);
  const fromNetwork = await scrollToTop(page);
  await expect(page.getByText('Loading earlier messages')).toHaveCount(1);
  gate.release();
  await expectPrependHolds(page, fromNetwork, first);
  const afterPage = await mounted(page);
  expect(afterPage).toBeGreaterThan(open);

  // 2. Scroll to latest: the latest rows only; the rest stay loaded, so the
  // next scroll to the top mounts them from memory (no skeleton).
  await page.locator('[data-latest-button]').click();
  await expect.poll(() => mounted(page)).toBe(STEP);
  await frames(page);
  first = await firstMounted(page);
  const fromMemory = await scrollToTop(page);
  await expectPrependHolds(page, fromMemory, first);
  expect(await mounted(page)).toBe(afterPage);

  // 3. Page to the oldest row: never more than MAX_MOUNTED rows mounted.
  const oldest = page.locator(`[data-msg-id="${olderId(SEEDED)}"]`);
  for (let k = 0; k < 12 && (await oldest.count()) === 0; k += 1) {
    first = await firstMounted(page);
    const anchor = await scrollToTop(page);
    await expectPrependHolds(page, anchor, first);
    expect(await mounted(page)).toBeLessThanOrEqual(MAX_MOUNTED);
  }
  await expect(oldest).toHaveCount(1);
  expect(await mounted(page)).toBe(MAX_MOUNTED);
  expect(network.blocked, 'blocked non-fixture requests').toEqual([]);
});
