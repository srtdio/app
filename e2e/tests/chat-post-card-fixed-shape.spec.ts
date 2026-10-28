import { expect, test, type Page } from '@playwright/test';
import { installHarnessNetwork } from '../fixtures/harness-routes';
import { PEER_NAME, POST_IDS } from '../fixtures/chat-data';
import { delaySupabaseReads, realisticDelay } from '../fixtures/read-delays';

// Fixed card geometry (28 Oct): a shared post card never seen this session
// paints its final box on the first frame. The open's card read is slowed to
// 1.5s and the post carries a title long enough for three lines (the old
// placeholder was one line tall, so the row grew when the card landed). Every
// painted frame is sampled: no row on screen moves while the card lands, the
// placeholder is the card's height, and the thread stays pinned to its bottom.
// Runs on the WebKit phone projects, dark and light (@theme).

interface Log {
  /** Painted frames where a row already on screen moved (its on-screen top changed). */
  rowMoves: Array<{ at: number; id: string; from: number; to: number }>;
  /** The thread's distance from its bottom, per painted frame where it changed. */
  bottomGaps: Array<{ at: number; gap: number }>;
}

declare global {
  interface Window {
    __cardShape?: Log;
  }
}

const LONG_TITLE =
  'Festive launch week carousel: the hero shot, the price cards for all twelve products and the booking link';

async function record(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const log: Log = { rowMoves: [], bottomGaps: [] };
    window.__cardShape = log;
    let tops = new Map<string, number>();
    let lastGap: number | null = null;
    const sample = (): void => {
      const now = Math.round(performance.now());
      const next = new Map<string, number>();
      for (const row of document.querySelectorAll('[data-msg-id]')) {
        const rect = row.getBoundingClientRect();
        if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
        const id = row.getAttribute('data-msg-id') ?? '';
        const top = Math.round(rect.top);
        next.set(id, top);
        const from = tops.get(id);
        if (from !== undefined && from !== top) log.rowMoves.push({ at: now, id, from, to: top });
      }
      tops = next;
      const list = document.querySelector('[data-thread-viewport] > ul');
      if (list !== null) {
        const gap = Math.round(list.scrollHeight - list.scrollTop - list.clientHeight);
        if (gap !== lastGap) log.bottomGaps.push({ at: now, gap });
        lastGap = gap;
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
}

/** Each row's top and the thread's distance from its bottom, now. */
async function rowOffsets(
  page: Page,
): Promise<{ at: number; tops: Record<string, number>; gap: number }> {
  return page.evaluate(() => {
    const tops: Record<string, number> = {};
    for (const row of document.querySelectorAll('[data-msg-id]')) {
      tops[row.getAttribute('data-msg-id') ?? ''] = Math.round(row.getBoundingClientRect().top);
    }
    const list = document.querySelector('[data-thread-viewport] > ul');
    const gap =
      list !== null ? Math.round(list.scrollHeight - list.scrollTop - list.clientHeight) : 0;
    return { at: Math.round(performance.now()), tops, gap };
  });
}

test('an unseen shared post card fills its fixed box in place: 0 px row shift @theme', async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== 'webkit', 'the WebKit projects run this');
  test.setTimeout(90_000);
  const network = await installHarnessNetwork(page);
  const post = (network.world.tables.posts ?? []).find((p) => p.id === POST_IDS[0]);
  if (post === undefined) throw new Error('no shared post in the fixture');
  post.title = LONG_TITLE;
  // The card read is slow: its box must hold the final height meanwhile.
  await delaySupabaseReads(page, (name) => (name === 'posts' ? 1_500 : realisticDelay(name)));
  await record(page);
  await page.goto('/chat');
  await page.getByText(PEER_NAME, { exact: true }).first().click();
  await page.locator('[data-msg-id]').first().waitFor({ timeout: 10_000 });

  const placeholder = page.locator('[data-card-skeleton]').first();
  await expect(placeholder).toBeAttached();
  const before = await rowOffsets(page);
  const skeletonHeight = await placeholder.evaluate((el) =>
    Math.round(el.getBoundingClientRect().height),
  );

  const card = page.locator('[data-card-footer]').first().locator('..');
  await expect(card).toBeAttached({ timeout: 10_000 });
  await expect(page.locator('[data-card-skeleton]')).toHaveCount(0);
  await page.waitForTimeout(1_000);
  const after = await rowOffsets(page);
  const cardHeight = await card.evaluate((el) => Math.round(el.getBoundingClientRect().height));
  // The long title is clamped to its two-line area, never grows the card.
  const titleLines = await card
    .locator('[data-card-title]')
    .evaluate((el) => Math.round(el.getBoundingClientRect().height));

  const log = await page.evaluate(() => window.__cardShape);
  if (log === undefined) throw new Error('no log');
  const moves = log.rowMoves.filter((m) => m.at >= before.at && m.at <= after.at);
  const gaps = log.bottomGaps.filter((g) => g.at >= before.at && g.at <= after.at);
  test.info().annotations.push({
    type: 'card shape',
    description: JSON.stringify({ skeletonHeight, cardHeight, titleLines, moves, gaps }),
  });

  expect(cardHeight, 'the placeholder is the card height').toBe(skeletonHeight);
  // Two title lines: 20px each on touch, 19px on a laptop project.
  expect([38, 40], 'two title lines, clamped').toContain(titleLines);
  expect(after.tops, 'row offsets before and after the card landed').toEqual(before.tops);
  expect(moves, 'no row on screen moved while it landed').toEqual([]);
  expect(Math.abs(before.gap), 'pinned to the bottom before the card landed').toBeLessThanOrEqual(
    1,
  );
  expect(Math.abs(after.gap), 'still pinned after the card landed').toBeLessThanOrEqual(1);
  for (const g of gaps) expect(Math.abs(g.gap), JSON.stringify(gaps)).toBeLessThanOrEqual(1);
  expect(network.blocked, 'blocked non-fixture requests').toEqual([]);
  expect([...new Set(network.unmatched)], 'unrecognised fixture requests').toEqual([]);
});
