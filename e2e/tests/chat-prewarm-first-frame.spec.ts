import { expect, test, type Page } from '@playwright/test';
import { installHarnessNetwork, type HarnessNetwork } from '../fixtures/harness-routes';
import {
  DM_CHANNEL,
  DRAFT_PLAN_MESSAGE_ID,
  PEER_NAME,
  ME,
  PEER,
  WORKSPACE_ID,
  seedClientPlanWithDraft,
} from '../fixtures/chat-data';
import { delaySupabaseReads, realisticDelay } from '../fixtures/read-delays';

// B2: a chat in the list that the list pre-warmed opens with its rows in the
// first frame. The DM holds a current shared plan (its card on the page and in
// the ticker): before the fix the open hold waited on this open's plan read,
// so the thread showed skeleton bubbles until it landed. Now the pre-warm's
// one batched plan read is the open's own (no second plan read) and teaches
// the card's shape, the kept rows paint at once, and the shared post card on
// the page (its own read slowed to 1.5s here) waits in a placeholder of its
// final height and fills in place. Every frame (rAF) and DOM change from the
// tap on is sampled: no skeleton bubble, no row moving on screen when the
// post card lands, and the bottom anchor held. The press on the row
// (pointerdown) and the tap read no second chat bundle either. Runs in dark
// and light (@theme).

interface Frame {
  at: number;
  msgs: number;
  skeleton: boolean;
}

interface Log {
  taps: number[];
  frames: Frame[];
  /** rAF samples that were about to paint with a skeleton bubble on screen. */
  paintedSkeleton: number[];
  /** Painted frames where a row already on screen moved (its on-screen top changed). */
  rowMoves: Array<{ at: number; id: string; from: number; to: number }>;
  /** The thread's distance from its bottom, per painted frame where it changed. */
  bottomGaps: Array<{ at: number; gap: number }>;
}

declare global {
  interface Window {
    __b2?: Log;
  }
}

async function record(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const now = performance.now.bind(performance);
    const log: Log = { taps: [], frames: [], paintedSkeleton: [], rowMoves: [], bottomGaps: [] };
    window.__b2 = log;
    document.addEventListener('pointerdown', () => log.taps.push(now()), true);
    let tops = new Map<string, number>();
    let lastGap: number | null = null;
    const sampleRows = (): void => {
      const next = new Map<string, number>();
      for (const row of document.querySelectorAll('[data-msg-id]')) {
        const id = row.getAttribute('data-msg-id') ?? '';
        const top = Math.round(row.getBoundingClientRect().top);
        next.set(id, top);
        const was = tops.get(id);
        if (was !== undefined && was !== top) {
          log.rowMoves.push({ at: Math.round(now()), id, from: was, to: top });
        }
      }
      tops = next;
      const list = document.querySelector('[data-thread-viewport] > ul');
      if (list === null) {
        lastGap = null;
        return;
      }
      const gap = Math.round(list.scrollHeight - list.scrollTop - list.clientHeight);
      if (gap !== lastGap) log.bottomGaps.push({ at: Math.round(now()), gap });
      lastGap = gap;
    };
    const sample = (painted: boolean): void => {
      const msgs = document.querySelectorAll('[data-msg-id]').length;
      const skeleton = document.querySelector('[data-skeleton-bubble]') !== null;
      if (painted && skeleton) log.paintedSkeleton.push(Math.round(now()));
      const last = log.frames[log.frames.length - 1];
      if (last !== undefined && last.msgs === msgs && last.skeleton === skeleton) return;
      log.frames.push({ at: Math.round(now()), msgs, skeleton });
    };
    const start = (): void => {
      new MutationObserver(() => sample(false)).observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
      });
      const frame = (): void => {
        sample(true);
        sampleRows();
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    };
    if (document.body !== null) start();
    else document.addEventListener('DOMContentLoaded', start, { once: true });
  });
}

async function logOf(page: Page): Promise<Log> {
  const log = await page.evaluate(() => window.__b2);
  if (log === undefined) throw new Error('no log');
  return log;
}

/** The DM as the client sees it, with a current shared plan on its page. */
function seedPlanDm(network: HarnessNetwork): void {
  for (const m of network.world.tables.workspace_members ?? []) {
    if (m.user_id === ME) m.role = 'client';
    if (m.user_id === PEER) m.role = 'agency';
  }
  seedClientPlanWithDraft(network.world, { channelId: DM_CHANNEL, sender: PEER });
  (network.world.tables.chat_message_marks ??= []).push({
    message_id: DRAFT_PLAN_MESSAGE_ID,
    channel_id: DM_CHANNEL,
    workspace_id: WORKSPACE_ID,
    mark_type: 'pending',
    priority: null,
    marked_by: PEER,
    marked_at: new Date(Date.now() - 60_000).toISOString(),
    resolved_by: null,
    resolved_at: null,
  });
}

/** Each row's on-screen top and the thread's distance from its bottom, now. */
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

/** The User Timing marks by name (the ?paintlog marks), first entry's time. */
async function marks(page: Page): Promise<Record<string, number>> {
  return page.evaluate(() => {
    const out: Record<string, number> = {};
    for (const e of performance.getEntriesByType('mark')) {
      if (out[e.name] === undefined) out[e.name] = Math.round(e.startTime);
    }
    return out;
  });
}

test('a pre-warmed chat paints its rows in the first frame, never skeleton bubbles @theme', async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== 'webkit', 'the WebKit projects run this');
  test.setTimeout(90_000);
  const network = await installHarnessNetwork(page);
  seedPlanDm(network);
  // The open's own shared post card read is slow (its placeholder must hold
  // the card's final height meanwhile).
  await delaySupabaseReads(page, (name) => (name === 'posts' ? 1_500 : realisticDelay(name)));
  await record(page);
  await page.goto('/chat');
  const row = page.getByText(PEER_NAME, { exact: true }).first();
  await row.waitFor({ state: 'visible' });
  // The list pre-warms at idle: its bundles, then the one plan read the kept
  // chats' opens will take, then the members.
  await page.waitForFunction(
    () => performance.getEntriesByName('chat:prewarm:plans').length > 0,
    undefined,
    { timeout: 20_000 },
  );
  await page.waitForTimeout(1_500);
  const bundlesBefore = network.rpcCalls.filter((c) => c.name === 'chat_open_bundle').length;
  const plansBefore = network.rpcCalls.filter((c) => c.name === 'plan_bundle_read').length;
  expect(plansBefore, 'the pre-warm made one plan read').toBe(1);

  await row.click();
  await page.locator('[data-msg-id]').first().waitFor({ timeout: 10_000 });
  // The rows are up while this open's post card read is still out: the card
  // waits in its placeholder, at its final height.
  const placeholder = page.locator('[data-card-skeleton]').first();
  await expect(placeholder).toBeVisible();
  const before = await rowOffsets(page);
  const skeletonHeight = await placeholder.evaluate((el) =>
    Math.round(el.getBoundingClientRect().height),
  );
  // The slow post card read lands (the card fills in place); the plan card is in.
  const postCard = page.locator('[data-card-footer]').first().locator('..');
  await expect(postCard).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('[data-plan-card]').first()).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(1_000);
  const after = await rowOffsets(page);
  const cardHeight = await postCard.evaluate((el) =>
    Math.round(el.getBoundingClientRect().height),
  );

  const log = await logOf(page);
  const tap = log.taps[log.taps.length - 1] ?? 0;
  const frames = log.frames
    .filter((f) => f.at >= tap)
    .map((f) => ({ ...f, at: Math.round(f.at - tap) }));
  const shown = frames.map((f) => `${f.at} msgs=${f.msgs} skel=${f.skeleton ? 'y' : 'n'}`);
  const timing = await marks(page);
  // The window the card read landed in: from the rows-up snapshot to the settled one.
  const moves = log.rowMoves.filter((m) => m.at >= before.at && m.at <= after.at);
  const gaps = log.bottomGaps.filter((g) => g.at >= before.at && g.at <= after.at);
  test.info().annotations.push({
    type: 'b2 first frame',
    description: JSON.stringify({ frames: shown, marks: timing, moves, gaps }),
  });

  // Never a skeleton bubble: not in the DOM, not in a painted frame.
  expect(
    frames.some((f) => f.skeleton),
    shown.join('\n'),
  ).toBe(false);
  expect(log.paintedSkeleton.filter((at) => at >= tap)).toEqual([]);
  // The rows came, and from the pre-warm: the open took its bundle (the
  // press and the tap read none), and the open hold never applied.
  expect(frames.some((f) => f.msgs > 0)).toBe(true);
  expect(timing['chat:bundle:prewarmed'], 'the open took the pre-warmed bundle').toBeDefined();
  expect(timing['chat:hold:kept'], 'the kept open skipped the hold').toBeDefined();
  expect(timing['chat:hold:release']).toBeUndefined();
  expect(timing['chat:hold:cap']).toBeUndefined();
  expect(network.rpcCalls.filter((c) => c.name === 'chat_open_bundle')).toHaveLength(bundlesBefore);
  // One plan read per open in all: the open took the pre-warm's.
  expect(network.rpcCalls.filter((c) => c.name === 'plan_bundle_read')).toHaveLength(plansBefore);
  // No layout shift: the card filled its placeholder at the same height, no
  // row on screen moved when it landed, and the bottom anchor held throughout.
  expect(cardHeight, 'the placeholder is the card height').toBe(skeletonHeight);
  expect(after.tops, 'row offsets before and after the card landed').toEqual(before.tops);
  expect(moves, 'no row on screen moved while it landed').toEqual([]);
  expect(Math.abs(before.gap), 'pinned to the bottom with the rows up').toBeLessThanOrEqual(1);
  expect(Math.abs(after.gap), 'still pinned after the card landed').toBeLessThanOrEqual(1);
  for (const g of gaps) expect(Math.abs(g.gap), JSON.stringify(gaps)).toBeLessThanOrEqual(1);
  expect(network.blocked, 'blocked non-fixture requests').toEqual([]);
  expect([...new Set(network.unmatched)], 'unrecognised fixture requests').toEqual([]);
});
