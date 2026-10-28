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
// the ticker), whose bundle read is slow (1.5s): before the fix the open hold
// waited on it, so the thread showed skeleton bubbles until the hold's cap.
// Now the kept rows paint at once and only the plan card and the ticker fill
// their same-size placeholders in place. Every frame (rAF) and DOM change from
// the tap on is sampled for skeleton bubbles; there must be none. The press
// on the row (pointerdown) and the tap read no second bundle: the pre-warm's is
// the open's own. Runs in dark and light (@theme).

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
}

declare global {
  interface Window {
    __b2?: Log;
  }
}

async function record(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const now = performance.now.bind(performance);
    const log: Log = { taps: [], frames: [], paintedSkeleton: [] };
    window.__b2 = log;
    document.addEventListener('pointerdown', () => log.taps.push(now()), true);
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
  // The plan bundle read is slow: the old hold showed the skeleton until its cap.
  await delaySupabaseReads(page, (name) =>
    name === 'rpc plan_bundle_read' ? 1_500 : realisticDelay(name),
  );
  await record(page);
  await page.goto('/chat');
  const row = page.getByText(PEER_NAME, { exact: true }).first();
  await row.waitFor({ state: 'visible' });
  // The list pre-warms at idle: wait for it to finish, then for the members.
  await page.waitForFunction(() => performance.getEntriesByName('chat:prewarm:end').length > 0, {
    timeout: 15_000,
  });
  await page.waitForTimeout(1_500);
  const bundlesBefore = network.rpcCalls.filter((c) => c.name === 'chat_open_bundle').length;

  await row.click();
  await page.locator('[data-msg-id]').first().waitFor({ timeout: 10_000 });
  // The slow plan read lands (the card and ticker fill in place).
  await page.waitForTimeout(2_500);

  const log = await logOf(page);
  const tap = log.taps[log.taps.length - 1] ?? 0;
  const frames = log.frames
    .filter((f) => f.at >= tap)
    .map((f) => ({ ...f, at: Math.round(f.at - tap) }));
  const shown = frames.map((f) => `${f.at} msgs=${f.msgs} skel=${f.skeleton ? 'y' : 'n'}`);
  const timing = await marks(page);
  test.info().annotations.push({
    type: 'b2 first frame',
    description: JSON.stringify({ frames: shown, marks: timing }),
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
  // The plan card filled its placeholder once its read landed.
  await expect(page.locator('[data-plan-card]').first()).toBeVisible();
  expect(network.blocked, 'blocked non-fixture requests').toEqual([]);
  expect([...new Set(network.unmatched)], 'unrecognised fixture requests').toEqual([]);
});
