import { existsSync } from 'node:fs';
import { chromium, devices, expect, test, type Page, type Request } from '@playwright/test';
import { installHarnessNetwork, type HarnessNetwork } from '../fixtures/harness-routes';
import {
  DM_CHANNEL,
  DRAFT_PLAN_ID,
  DRAFT_PLAN_MESSAGE_ID,
  ME,
  PEER,
  PEER_NAME,
  TEAM_PLAN_ID,
  TEAM_PLAN_MESSAGE_ID,
  WORKSPACE_ID,
  seedClientPlanWithDraft,
  seedTeamAndHiddenPlans,
} from '../fixtures/chat-data';

// A plan card's first paint is its final state: opening a DM that holds a plan
// card records every distinct state of that card (skeleton or card, its chips,
// progress, Forward and height) per frame and per DOM change, from mount until
// settled. The only allowed sequence is skeleton (the card's own height), then
// one card that never changes, never drops back to a skeleton and never
// remounts. Covers a client plan with a draft row (plan_bundle_read carries 1 draft row),
// a Draft plan, and a slow plan read. Runs on the config's WebKit
// projects (dark and light) and, where a local Chromium is installed, in
// Chromium with the same iPhone viewport and the project's colour scheme.

const CHROMIUM = process.env.E2E_CHROMIUM_PATH ?? '/opt/pw-browsers/chromium';

declare global {
  interface Window {
    __planPaints?: Array<{ at: number; state: string }>;
  }
}

/** Record every distinct state of the message's plan card, per frame and per mutation. */
async function recordPaints(page: Page, messageId: string): Promise<void> {
  await page.addInitScript((id) => {
    const paints: Array<{ at: number; state: string }> = [];
    window.__planPaints = paints;
    const read = (): string => {
      const msg = document.querySelector(`[data-msg-id="${CSS.escape(id)}"]`);
      if (msg === null) return 'absent';
      const skeleton = msg.querySelector('[data-plan-skeleton]');
      const card = msg.querySelector('[data-plan-card]');
      if (card !== null) {
        const chips = [...card.querySelectorAll('[data-plan-chip]')]
          .map((c) => c.textContent ?? '')
          .join('|');
        const progress = card.querySelector('[data-plan-progress]')?.textContent ?? '';
        const forward = card.querySelector('[data-plan-forward]') !== null ? 'fwd' : 'nofwd';
        const h = Math.round(card.getBoundingClientRect().height);
        return `card[${card.getAttribute('data-plan-card')}] ${chips} / ${progress} / ${forward} / h${h}`;
      }
      if (skeleton !== null) {
        return `skeleton h${Math.round(skeleton.getBoundingClientRect().height)}`;
      }
      return 'none';
    };
    const sample = (): void => {
      const state = read();
      if (paints[paints.length - 1]?.state !== state) {
        paints.push({ at: Math.round(performance.now()), state });
      }
    };
    const start = (): void => {
      new MutationObserver(sample).observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
      });
      const frame = (): void => {
        sample();
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    };
    if (document.body !== null) start();
    else document.addEventListener('DOMContentLoaded', start, { once: true });
  }, messageId);
}

/** The recorded states from the card's mount on (the leading absent states dropped). */
async function paintsOf(page: Page): Promise<string[]> {
  const raw = await page.evaluate(() => window.__planPaints ?? []);
  const states = raw.map((p) => p.state);
  const first = states.findIndex((s) => s !== 'absent');
  return first < 0 ? [] : states.slice(first);
}

/** Skeleton states, then exactly one card state, at the skeleton's height. */
function expectOnePaint(seq: readonly string[], planId: string): void {
  const firstCard = seq.findIndex((s) => s.startsWith('card['));
  expect(firstCard, `no card painted: ${JSON.stringify(seq)}`).toBeGreaterThanOrEqual(0);
  const before = seq.slice(0, firstCard);
  const after = seq.slice(firstCard);
  expect(
    before.every((s) => s.startsWith('skeleton')),
    `only skeletons before the card: ${JSON.stringify(seq)}`,
  ).toBe(true);
  expect(after, `one card state after the first paint: ${JSON.stringify(seq)}`).toHaveLength(1);
  const card = after[0] ?? '';
  expect(card).toContain(`card[${planId}]`);
  const cardH = /h(\d+)$/.exec(card)?.[1];
  for (const s of before) {
    expect(/h(\d+)$/.exec(s)?.[1], `skeleton height = card height: ${JSON.stringify(seq)}`).toBe(
      cardH,
    );
  }
}

function viewAsClient(network: HarnessNetwork): void {
  for (const m of network.world.tables.workspace_members ?? []) {
    if (m.user_id === ME) m.role = 'client';
    if (m.user_id === PEER) m.role = 'agency';
  }
}

function expectClean(network: HarnessNetwork): void {
  expect(network.blocked, 'blocked non-fixture requests').toEqual([]);
  expect([...new Set(network.unmatched)], 'unrecognised fixture requests').toEqual([]);
}

interface Scenario {
  name: string;
  messageId: string;
  planId: string;
  seed: (network: HarnessNetwork) => void;
  /** Gate the plans read this long (a slow read). */
  slowMs?: number;
  /** What the settled card shows. */
  chips: string[];
  progress: string;
  forward: boolean;
}

const SCENARIOS: Scenario[] = [
  {
    name: 'client plan with a draft row',
    messageId: DRAFT_PLAN_MESSAGE_ID,
    planId: DRAFT_PLAN_ID,
    seed: (network) => {
      viewAsClient(network);
      seedClientPlanWithDraft(network.world, { channelId: DM_CHANNEL, sender: PEER });
    },
    chips: ['1 concept', '1 post'],
    progress: 'Approved 0 of 2',
    forward: true,
  },
  {
    name: 'Draft plan',
    messageId: TEAM_PLAN_MESSAGE_ID,
    planId: TEAM_PLAN_ID,
    seed: (network) => seedTeamAndHiddenPlans(network.world, { channelId: DM_CHANNEL, sender: ME }),
    chips: ['1 concept', '0 posts', 'Draft'],
    // X3 / FT56: a Draft plan's progress names the creators.
    progress: 'Creators 0 of 1',
    forward: true,
  },
  {
    name: 'slow plan read',
    messageId: DRAFT_PLAN_MESSAGE_ID,
    planId: DRAFT_PLAN_ID,
    seed: (network) => {
      viewAsClient(network);
      seedClientPlanWithDraft(network.world, { channelId: DM_CHANNEL, sender: PEER });
    },
    slowMs: 2_500,
    chips: ['1 concept', '1 post'],
    progress: 'Approved 0 of 2',
    forward: true,
  },
];

/**
 * Whether a request is a plan bundle read: plan_bundle_read by id (the cards'
 * one call; the ticker's list of current shared plans is a separate GET).
 */
function isBundlePlansRead(request: { method(): string; url(): string }): boolean {
  const url = new URL(request.url());
  return request.method() === 'POST' && url.pathname === '/rest/v1/rpc/plan_bundle_read';
}

/** The plan_bundle_read calls the page made. */
function countPlanReads(page: Page): () => number {
  let n = 0;
  page.on('request', (request) => {
    if (isBundlePlansRead(request)) n += 1;
  });
  return () => n;
}

async function run(page: Page, scenario: Scenario): Promise<void> {
  const network = await installHarnessNetwork(page);
  scenario.seed(network);
  const planReads = countPlanReads(page);
  await recordPaints(page, scenario.messageId);
  await page.goto('/chat');
  const row = page.getByText(PEER_NAME, { exact: true }).first();
  await row.waitFor({ state: 'visible' });
  const gate = scenario.slowMs !== undefined ? network.holdRpc('plan_bundle_read') : null;
  await row.click();
  // The hold is timed from the held request, not from the thread's paint: on a
  // loaded runner the two can be seconds apart, and the read's own 5s timeout
  // (a retry, so a second read) must never be what this scenario measures.
  let askedAt = 0;
  if (gate !== null) {
    await expect.poll(planReads).toBe(1);
    askedAt = Date.now();
  }
  await page.locator('[data-msg-id]').first().waitFor({ state: 'visible', timeout: 8000 });
  if (gate !== null) {
    await page.waitForTimeout(Math.max(0, (scenario.slowMs ?? 0) - (Date.now() - askedAt)));
    // The skeleton holds while the read is slow.
    expect(await paintsOf(page)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^skeleton/)]),
    );
    gate.release();
  }
  const card = page.locator(`[data-plan-card="${scenario.planId}"]`);
  await card.waitFor({ state: 'attached', timeout: 10_000 });
  // Settle: the ticker round, the viewer side and any refetch have landed.
  await page.waitForTimeout(3_000);
  const seq = await paintsOf(page);
  test.info().annotations.push({ type: 'paint sequence', description: JSON.stringify(seq) });
  console.log(`[${scenario.name}] ${JSON.stringify(seq)}`);
  expectOnePaint(seq, scenario.planId);
  // One batched bundle read per plan per open: the card and the ticker share it.
  expect(planReads(), 'one plan_bundle_read per open').toBe(1);
  // The draft rows come inside the bundle read: never a call of their own.
  expect(
    network.rpcCalls.filter((c) => c.name === 'plan_draft_rows'),
    'no separate plan_draft_rows',
  ).toHaveLength(0);
  // A background re-read with the same data (a plan-changed event) changes nothing.
  await page.evaluate(
    (planId) =>
      window.dispatchEvent(new CustomEvent('sorted:plan-changed', { detail: { planId } })),
    scenario.planId,
  );
  await expect.poll(planReads).toBe(2);
  await page.waitForTimeout(1_000);
  expect(await paintsOf(page), 'a same-data refetch never repaints').toEqual(seq);
  await expect(card.locator('[data-plan-chip]')).toHaveText(scenario.chips);
  await expect(card.locator('[data-plan-progress]')).toHaveText(scenario.progress);
  await expect(card.locator('[data-plan-forward]')).toHaveCount(scenario.forward ? 1 : 0);
  expectClean(network);
}

for (const scenario of SCENARIOS) {
  test(`webkit: ${scenario.name}: the card paints once`, async ({ page, browserName }) => {
    test.skip(browserName !== 'webkit', 'the WebKit projects run this');
    test.setTimeout(60_000);
    await run(page, scenario);
  });

  test(`chromium: ${scenario.name}: the card paints once`, async () => {
    test.skip(!existsSync(CHROMIUM), 'no local Chromium');
    test.setTimeout(60_000);
    const browser = await chromium.launch({ executablePath: CHROMIUM });
    try {
      const iphone = { ...devices['iPhone 13'] };
      delete (iphone as { defaultBrowserType?: string }).defaultBrowserType;
      const context = await browser.newContext({
        ...iphone,
        baseURL: test.info().project.use.baseURL ?? 'http://localhost:4178',
        colorScheme: test.info().project.use.colorScheme ?? 'dark',
      });
      const page = await context.newPage();
      await run(page, scenario);
      await context.close();
    } finally {
      await browser.close();
    }
  });
}

// ---------------------------------------------------------------------------
// The ticker filling in after the card. The card's own reads (plans, items,
// reviews, draft rows, post stages, the viewer side it shares with the ticker)
// answer at once; the ticker's other inputs (open posts list and count, open
// briefs list and count, marks, the channel's shared plan ids) are held and
// released one by one after the card's first paint; then a catch-up (the
// browser coming back online) re-reads chat_messages, and a plan-changed event
// re-reads the plan, 3s later. Per frame and per DOM change the recorder keeps
// the card element's identity (a remount is a new node), every skeleton, the
// card's text and on-screen top, the thread list's scrollTop and the ticker
// slot's state. From the card's first paint on: the same node throughout, no
// skeleton, no content or position change, no scroll jump.

type TickerInput = 'posts' | 'postCount' | 'briefs' | 'briefCount' | 'marks' | 'planIds';

/** Which held ticker input a request is, or null (answered at once). */
function tickerInputOf(method: string, url: URL): TickerInput | null {
  const table = url.pathname.replace('/rest/v1/', '');
  const p = url.searchParams;
  if (table === 'posts' && p.get('stage') === 'eq.review') {
    return method === 'HEAD' ? 'postCount' : 'posts';
  }
  if (table === 'briefs' && p.get('status') === 'eq.open') {
    return method === 'HEAD' ? 'briefCount' : 'briefs';
  }
  if (table === 'chat_message_marks') return 'marks';
  if (table === 'chat_messages' && p.get('select') === 'shared_plan_ids') return 'planIds';
  return null;
}

const TICKER_INPUTS: readonly TickerInput[] = [
  'posts',
  'postCount',
  'briefs',
  'briefCount',
  'marks',
  'planIds',
];

/** The app's OPEN_HOLD_MS: the longest a chat open holds its first paint. */
const OPEN_HOLD_MS = 1_000;

/** Hold every ticker input until its gate opens (routes over the harness's). */
async function holdTickerInputs(page: Page): Promise<{
  /** Open one gate; resolves once every request it held has been answered. */
  release: (input: TickerInput) => Promise<void>;
  releaseAll: () => void;
}> {
  const opened = new Set<TickerInput>();
  const waiting = new Map<TickerInput, Array<() => void>>();
  const heldRequests = new Map<TickerInput, Request[]>();
  const answered = new Set<Request>();
  const onAnswered = new Set<() => void>();
  const settle = (request: Request): void => {
    answered.add(request);
    for (const fn of onAnswered) fn();
  };
  page.on('requestfinished', settle);
  page.on('requestfailed', settle);
  await page.route(/\/rest\/v1\//, async (route) => {
    const request = route.request();
    const input = tickerInputOf(request.method(), new URL(request.url()));
    if (input !== null && !opened.has(input)) {
      heldRequests.set(input, [...(heldRequests.get(input) ?? []), request]);
      await new Promise<void>((resolve) => {
        waiting.set(input, [...(waiting.get(input) ?? []), resolve]);
      });
    }
    await route.fallback();
  });
  const open = (input: TickerInput): void => {
    opened.add(input);
    for (const resolve of waiting.get(input) ?? []) resolve();
    waiting.delete(input);
  };
  return {
    release: async (input) => {
      open(input);
      const held = heldRequests.get(input) ?? [];
      await new Promise<void>((resolve) => {
        const check = (): void => {
          if (!held.every((r) => answered.has(r))) return;
          onAnswered.delete(check);
          resolve();
        };
        onAnswered.add(check);
        check();
      });
    },
    releaseAll: () => {
      for (const input of TICKER_INPUTS) open(input);
    },
  };
}

/** Two real painted frames (the page clock may be paused): what is committed is on screen. */
async function twoFrames(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const frames = window.__twoFrames;
    if (frames === undefined) throw new Error('no frame recorder');
    await frames();
  });
}

interface FrameLog {
  events: Array<{ at: number; what: string }>;
  cardNodes: number;
  bubbleNodes: number;
  skeletonsAfterCard: number;
  contentChanges: number;
  moves: number;
  /** Painted scrollTop changes not matched by the same content growth. */
  scrollJumps: number;
  cardAt: number | null;
}

declare global {
  interface Window {
    __frameLog?: FrameLog;
    __twoFrames?: () => Promise<void>;
  }
}

/**
 * Record the card. Per DOM change: the card and bubble element identity (a
 * remount is a new node), every skeleton, the ticker slot. After each painted
 * frame (a task posted from requestAnimationFrame runs after that frame's
 * layout, resize observers and paint): the card's text and on-screen top and
 * the thread list's scrollTop, so a move fixed before paint is not counted.
 */
async function recordFrames(page: Page, messageId: string): Promise<void> {
  await page.addInitScript((id) => {
    // The page's real clock and frames, kept before the spec installs the
    // Playwright page clock (which fakes Date, timers and frames for the app).
    const now = performance.now.bind(performance);
    const raf = window.requestAnimationFrame.bind(window);
    window.__twoFrames = () => new Promise((resolve) => raf(() => raf(() => resolve())));
    const log: FrameLog = {
      events: [],
      cardNodes: 0,
      bubbleNodes: 0,
      skeletonsAfterCard: 0,
      contentChanges: 0,
      moves: 0,
      scrollJumps: 0,
      cardAt: null,
    };
    window.__frameLog = log;
    const seenCards = new WeakSet<Element>();
    const seenBubbles = new WeakSet<Element>();
    let lastCard: Element | null = null;
    let lastSkeleton = false;
    let lastTicker: string | null = null;
    let lastText: string | null = null;
    let lastTop: number | null = null;
    let lastScroll: number | null = null;
    let lastScroller: Element | null = null;
    let lastHeight: number | null = null;
    const push = (what: string): void => {
      log.events.push({ at: Math.round(now()), what });
    };
    const bubbleOf = (): Element | null =>
      document.querySelector(`[data-msg-id="${CSS.escape(id)}"]`);
    const sampleDom = (): void => {
      const slot = document.querySelector('[data-loops-strip]');
      const items = [...document.querySelectorAll('[data-status-item]')]
        .map((el) => el.getAttribute('data-status-item'))
        .join(',');
      const ticker = `${slot?.getAttribute('data-loops-strip') ?? 'none'}${items !== '' ? `:${items}` : ''}`;
      if (ticker !== lastTicker) {
        lastTicker = ticker;
        push(`ticker ${ticker}`);
      }
      const bubble = bubbleOf();
      if (bubble !== null && !seenBubbles.has(bubble)) {
        seenBubbles.add(bubble);
        log.bubbleNodes += 1;
        push(`bubble node #${log.bubbleNodes}`);
      }
      const card = bubble?.querySelector('[data-plan-card]') ?? null;
      if (card !== null && !seenCards.has(card)) {
        seenCards.add(card);
        log.cardNodes += 1;
        log.cardAt ??= Math.round(now());
        push(`card node #${log.cardNodes}`);
      }
      if (card === null && lastCard !== null) push('card gone');
      lastCard = card;
      const skeleton = bubble?.querySelector('[data-plan-skeleton]') != null;
      if (skeleton && !lastSkeleton) {
        push('skeleton');
        if (log.cardAt !== null) log.skeletonsAfterCard += 1;
      }
      lastSkeleton = skeleton;
    };
    const samplePaint = (): void => {
      const card = bubbleOf()?.querySelector('[data-plan-card]') ?? null;
      if (card !== null) {
        const text = card.textContent ?? '';
        if (lastText !== null && text !== lastText) {
          log.contentChanges += 1;
          push(`card text ${text}`);
        }
        lastText = text;
        const top = Math.round(card.getBoundingClientRect().top);
        if (lastTop !== null && top !== lastTop) {
          log.moves += 1;
          push(`card top ${lastTop} -> ${top}`);
        }
        lastTop = top;
      }
      const scroller = document.querySelector('[data-thread-viewport] > ul');
      if (scroller === null) return;
      const st = Math.round(scroller.scrollTop);
      const height = scroller.scrollHeight;
      if (scroller !== lastScroller) {
        if (lastScroller !== null) push('scroller replaced');
        lastScroller = scroller;
      } else if (lastScroll !== null && st !== lastScroll && log.cardAt !== null) {
        // A scroll with the same content height moves what the reader sees; a
        // pin that follows growth by the same amount keeps it still.
        const grew = lastHeight !== null ? height - lastHeight : 0;
        if (st - lastScroll !== grew) log.scrollJumps += 1;
        push(`scrollTop ${lastScroll} -> ${st} (scrollHeight ${lastHeight ?? '?'} -> ${height})`);
      }
      lastScroll = st;
      lastHeight = height;
    };
    const start = (): void => {
      new MutationObserver(sampleDom).observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
      });
      const afterPaint = new MessageChannel();
      afterPaint.port1.onmessage = samplePaint;
      const frame = (): void => {
        sampleDom();
        afterPaint.port2.postMessage(null);
        raf(frame);
      };
      raf(frame);
    };
    if (document.body !== null) start();
    else document.addEventListener('DOMContentLoaded', start, { once: true });
  }, messageId);
}

async function runTickerFill(page: Page): Promise<void> {
  const network = await installHarnessNetwork(page);
  viewAsClient(network);
  seedClientPlanWithDraft(network.world, { channelId: DM_CHANNEL, sender: PEER });
  // An open mark on the plan message: the ticker has a marks item.
  (network.world.tables.chat_message_marks ??= []).push({
    message_id: String(network.world.dmMessages[0]?.id),
    channel_id: DM_CHANNEL,
    workspace_id: WORKSPACE_ID,
    mark_type: 'pending',
    priority: null,
    marked_by: PEER,
    marked_at: new Date(Date.now() - 60_000).toISOString(),
    resolved_by: null,
    resolved_at: null,
  });
  await recordFrames(page, DRAFT_PLAN_MESSAGE_ID);
  const reads = { history: 0, plans: 0 };
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (isBundlePlansRead(request)) reads.plans += 1;
    if (request.method() !== 'GET') return;
    if (
      url.pathname === '/rest/v1/chat_messages' &&
      url.searchParams.get('select') !== 'shared_plan_ids'
    ) {
      reads.history += 1;
    }
  });
  await page.goto('/chat');
  const row = page.getByText(PEER_NAME, { exact: true }).first();
  await row.waitFor({ state: 'visible' });
  const gates = await holdTickerInputs(page);
  // The held ticker reads must stay pending until the card has painted, but
  // the app gives up on a read after its own 5s deadline (READ_TIMEOUT_MS,
  // the page's timers). On a slow runner the card alone can take 4 to 5s of
  // wall time to appear, so holding on the wall clock ran into that deadline:
  // the ticker (correctly) gave up, never filled, and the scenario under test
  // never happened. So the app's clock stands still from just before the tap
  // until every held read has been answered, moved on only by the open hold
  // (so the card paints at the hold's cap, as on a device). Rendering,
  // network, DOM changes and the recorder's frames run in real time.
  await page.clock.install();
  // (A moment ahead: the list is idle, and the clock runs while this travels.)
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1_000));
  try {
    await row.click();
    // The thread is up (its ticker slot holds the place) and its hold timer is set.
    await page.locator('[data-loops-strip]').waitFor({ state: 'attached', timeout: 10_000 });
    await twoFrames(page);
    await page.clock.runFor(OPEN_HOLD_MS);
    const card = page.locator(`[data-plan-card="${DRAFT_PLAN_ID}"]`);
    await card.waitFor({ state: 'attached', timeout: 10_000 });
    // The card is painted while every ticker input is still held.
    await expect(page.locator('[data-status-item]')).toHaveCount(0);
    await twoFrames(page);
    // Then released one by one: each input is answered and painted before
    // the next opens.
    const order: TickerInput[] = ['postCount', 'briefs', 'marks', 'posts', 'planIds', 'briefCount'];
    for (const input of order) {
      await gates.release(input);
      await twoFrames(page);
    }
    // Nothing is held any more: the app's clock runs again.
    await page.clock.resume();
    await page.locator('[data-loops-strip="open"]').waitFor({ state: 'visible' });
    // The catch-up after the live connection: chat_messages and the plan again.
    await page.waitForTimeout(3_000);
    const before = { ...reads };
    await page.evaluate((planId) => {
      window.dispatchEvent(new Event('online'));
      window.dispatchEvent(new CustomEvent('sorted:plan-changed', { detail: { planId } }));
    }, DRAFT_PLAN_ID);
    // The catch-up really re-read the history and the plan.
    await expect.poll(() => reads.history).toBeGreaterThan(before.history);
    await expect.poll(() => reads.plans).toBeGreaterThan(before.plans);
    await page.waitForTimeout(2_000);
  } finally {
    gates.releaseAll();
  }
  const log = await page.evaluate(() => window.__frameLog);
  if (log === undefined) throw new Error('no frame log');
  const sequence = log.events.map((e) => `${e.at} ${e.what}`);
  test.info().annotations.push({ type: 'frame sequence', description: JSON.stringify(sequence) });
  console.log(`[ticker fills after the card] ${JSON.stringify(sequence, null, 1)}`);
  expect(log.cardNodes, `one card node: ${JSON.stringify(sequence)}`).toBe(1);
  expect(log.bubbleNodes, `one bubble node: ${JSON.stringify(sequence)}`).toBe(1);
  expect(log.skeletonsAfterCard, `no skeleton after the card: ${JSON.stringify(sequence)}`).toBe(0);
  expect(log.contentChanges, `card content never changes: ${JSON.stringify(sequence)}`).toBe(0);
  expect(log.moves, `the card never moves on screen: ${JSON.stringify(sequence)}`).toBe(0);
  expect(log.scrollJumps, `the thread never jumps: ${JSON.stringify(sequence)}`).toBe(0);
  // The paint log is opt-in: nothing of it without ?paintlog=1.
  await expect(page.locator('[data-paint-log]')).toHaveCount(0);
  expectClean(network);
}

/** ?paintlog=1: the overlay lists the card, the ticker and the thread, with Copy. */
async function runPaintLog(page: Page): Promise<void> {
  const network = await installHarnessNetwork(page);
  viewAsClient(network);
  seedClientPlanWithDraft(network.world, { channelId: DM_CHANNEL, sender: PEER });
  await page.goto('/chat?paintlog=1');
  const row = page.getByText(PEER_NAME, { exact: true }).first();
  await row.waitFor({ state: 'visible' });
  await row.click();
  await page.locator(`[data-plan-card="${DRAFT_PLAN_ID}"]`).waitFor({ state: 'attached' });
  const panel = page.locator('[data-paint-log]');
  await expect(panel).toHaveCount(1);
  await expect(panel).toContainText(`plan cards ${DRAFT_PLAN_ID} [`);
  await expect(panel).toContainText('mount');
  await expect(panel).toContainText(/ticker (pending|full|compact|empty)/);
  await expect(panel).toContainText('thread list mounted');
  const copy = page.locator('[data-paint-log-copy]');
  const box = await copy.boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
  expectClean(network);
}

test('webkit: ?paintlog=1 shows the paint log', async ({ page, browserName }) => {
  test.skip(browserName !== 'webkit', 'the WebKit projects run this');
  test.setTimeout(60_000);
  await runPaintLog(page);
});

test('chromium: ?paintlog=1 shows the paint log', async () => {
  test.skip(!existsSync(CHROMIUM), 'no local Chromium');
  test.setTimeout(60_000);
  const browser = await chromium.launch({ executablePath: CHROMIUM });
  try {
    const iphone = { ...devices['iPhone 13'] };
    delete (iphone as { defaultBrowserType?: string }).defaultBrowserType;
    const context = await browser.newContext({
      ...iphone,
      baseURL: test.info().project.use.baseURL ?? 'http://localhost:4178',
      colorScheme: test.info().project.use.colorScheme ?? 'dark',
    });
    const page = await context.newPage();
    await runPaintLog(page);
    await context.close();
  } finally {
    await browser.close();
  }
});

test(`webkit: the ticker filling in never remounts, re-skeletons or moves the card`, async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== 'webkit', 'the WebKit projects run this');
  test.setTimeout(60_000);
  await runTickerFill(page);
});

test(`chromium: the ticker filling in never remounts, re-skeletons or moves the card`, async () => {
  test.skip(!existsSync(CHROMIUM), 'no local Chromium');
  test.setTimeout(60_000);
  const browser = await chromium.launch({ executablePath: CHROMIUM });
  try {
    const iphone = { ...devices['iPhone 13'] };
    delete (iphone as { defaultBrowserType?: string }).defaultBrowserType;
    const context = await browser.newContext({
      ...iphone,
      baseURL: test.info().project.use.baseURL ?? 'http://localhost:4178',
      colorScheme: test.info().project.use.colorScheme ?? 'dark',
    });
    const page = await context.newPage();
    await runTickerFill(page);
    await context.close();
  } finally {
    await browser.close();
  }
});
