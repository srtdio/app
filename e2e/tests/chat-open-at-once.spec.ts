import { existsSync } from 'node:fs';
import { chromium, devices, expect, test, type Page } from '@playwright/test';
import { installHarnessNetwork, type HarnessNetwork } from '../fixtures/harness-routes';
import {
  DM_CHANNEL,
  DRAFT_PLAN_ID,
  DRAFT_PLAN_MESSAGE_ID,
  DRAFT_PLAN_TITLE,
  COLLEAGUE_A,
  GROUP_CHANNEL,
  GROUP_NAME,
  ME,
  PEER,
  PEER_NAME,
  WORKSPACE_ID,
  seedClientPlanWithDraft,
} from '../fixtures/chat-data';
import {
  delaySupabaseReads,
  dependencyChain,
  readSpans,
  realisticDelay,
} from '../fixtures/read-delays';
import { withSaveData } from '../helpers/save-data';

// Opening a chat is complete at once. Per frame (and per DOM change) the
// recorder keeps which chat is on screen, whether its messages, the plan
// card (or its skeleton), the mark badges and the ticker are painted, the
// card's node identity and on-screen top, and the thread's scroll. With
// realistic per-read latency: everything paints in one frame when it all
// settles inside the hold; with one read 2s late the rest paint without it
// and the late part fills its placeholder without moving the thread; a
// reopen paints the remembered card and ticker without a skeleton or an
// inert slot and a changed plan updates in place; sign-out and another user
// see nothing of the first user's memory; a chat switch never shows the
// other chat's card or counts. Runs on the WebKit projects (dark and light)
// and, where a local Chromium is installed, in Chromium with the iPhone
// viewport and the project's colour scheme.

const CHROMIUM = process.env.E2E_CHROMIUM_PATH ?? '/opt/pw-browsers/chromium';
const NEW_TITLE = 'Launch fortnight, revised';
/** The app's own module instances in the harness (the URLs Vite served them at). */
const MODULES = { cache: '/src/lib/chat/open-cache.ts', supabase: '/src/lib/supabase.ts' };

/** The served URL of each module the app loaded (the same instance on import). */
async function moduleUrls(page: Page): Promise<typeof MODULES> {
  return page.evaluate((paths) => {
    const loaded = performance.getEntriesByType('resource').map((e) => e.name);
    const find = (path: string): string => loaded.find((n) => n.includes(path)) ?? path;
    return { cache: find(paths.cache), supabase: find(paths.supabase) };
  }, MODULES);
}

interface Frame {
  at: number;
  /** The first message id on screen (which chat), or '-'. */
  chat: string;
  msgs: boolean;
  /** 'none', 'skel', or the card's plan id and title. */
  card: string;
  badges: number;
  ticker: string;
}

interface OpenLog {
  taps: number[];
  frames: Frame[];
  cardNodes: number;
  cardMoves: number;
  scrollJumps: number;
  skeletonHeights: number[];
  cardHeights: number[];
}

declare global {
  interface Window {
    __open?: OpenLog;
  }
}

/** Record the open chat per DOM change and after each painted frame. */
async function recordOpen(page: Page): Promise<void> {
  await page.addInitScript((planId) => {
    // The page's real clock and frames, kept before a spec installs the
    // Playwright page clock (which fakes Date, timers and frames for the app).
    const now = performance.now.bind(performance);
    const raf = window.requestAnimationFrame.bind(window);
    performance.setResourceTimingBufferSize(100_000);
    const log: OpenLog = {
      taps: [],
      frames: [],
      cardNodes: 0,
      cardMoves: 0,
      scrollJumps: 0,
      skeletonHeights: [],
      cardHeights: [],
    };
    window.__open = log;
    document.addEventListener('pointerdown', () => log.taps.push(now()), true);
    const seenCards = new WeakSet<Element>();
    let lastCard: Element | null = null;
    let lastTop: number | null = null;
    let lastScroller: Element | null = null;
    let lastScroll: number | null = null;
    let lastHeight: number | null = null;
    let grown = 0;
    const read = (): Omit<Frame, 'at'> => {
      const first = document.querySelector('[data-msg-id]');
      const card = document.querySelector(`[data-plan-card="${CSS.escape(planId)}"]`);
      const skeleton = document.querySelector('[data-plan-skeleton]');
      const slot = document.querySelector('[data-loops-strip]');
      const items = [...document.querySelectorAll('[data-status-item]')]
        .map((el) => el.getAttribute('data-status-item'))
        .join(',');
      return {
        chat: first?.getAttribute('data-msg-id') ?? '-',
        msgs: first !== null,
        card:
          card !== null
            ? `${planId}:${card.querySelector('[data-plan-title]')?.textContent ?? card.textContent?.slice(0, 40) ?? ''}`
            : skeleton !== null
              ? 'skel'
              : 'none',
        badges: document.querySelectorAll('[data-msg-id] [data-mark-badge]').length,
        ticker: `${slot?.getAttribute('data-loops-strip') ?? 'none'}${items !== '' ? `:${items}` : ''}`,
      };
    };
    const sampleDom = (): void => {
      const state = read();
      const last = log.frames[log.frames.length - 1];
      const same =
        last !== undefined &&
        last.chat === state.chat &&
        last.msgs === state.msgs &&
        last.card === state.card &&
        last.badges === state.badges &&
        last.ticker === state.ticker;
      if (!same) log.frames.push({ at: Math.round(now()), ...state });
      const card = document.querySelector(`[data-plan-card="${CSS.escape(planId)}"]`);
      if (card !== null && !seenCards.has(card)) {
        seenCards.add(card);
        log.cardNodes += 1;
        log.cardHeights.push(Math.round(card.getBoundingClientRect().height));
      }
      if (card === null) lastTop = null;
      lastCard = card;
      const skeleton = document.querySelector('[data-plan-skeleton]');
      if (skeleton !== null) {
        const h = Math.round(skeleton.getBoundingClientRect().height);
        if (log.skeletonHeights[log.skeletonHeights.length - 1] !== h) log.skeletonHeights.push(h);
      }
    };
    const samplePaint = (): void => {
      if (lastCard !== null && lastCard.isConnected) {
        const top = Math.round(lastCard.getBoundingClientRect().top);
        if (lastTop !== null && top !== lastTop) log.cardMoves += 1;
        lastTop = top;
      }
      const scroller = document.querySelector('[data-thread-viewport] > ul');
      if (scroller === null) {
        lastScroller = null;
        return;
      }
      const st = Math.round(scroller.scrollTop);
      const height = scroller.scrollHeight;
      if (scroller !== lastScroller) {
        lastScroller = scroller;
        lastScroll = st;
        lastHeight = height;
        grown = 0;
        return;
      }
      // Growth since the scroll last moved: a pin may land a frame after it.
      grown += lastHeight !== null ? height - lastHeight : 0;
      lastHeight = height;
      if (lastScroll !== null && st !== lastScroll) {
        // A pin that follows the growth by the same amount keeps the reader still.
        if (Math.abs(st - lastScroll - grown) > 1) log.scrollJumps += 1;
        grown = 0;
      }
      lastScroll = st;
    };
    const start = (): void => {
      new MutationObserver(sampleDom).observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
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
  }, DRAFT_PLAN_ID);
}

/** A harness session for `userId` (the token the app's auth client accepts). */
function signedInAs(userId: string): { accessToken: string; user: Record<string, unknown> } {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const b64 = (value: object): string => Buffer.from(JSON.stringify(value)).toString('base64url');
  const email = 'peer@harness.test';
  return {
    accessToken: [
      b64({ alg: 'HS256', typ: 'JWT' }),
      b64({ sub: userId, exp, role: 'authenticated', aud: 'authenticated', email }),
      'harness',
    ].join('.'),
    user: {
      id: userId,
      aud: 'authenticated',
      role: 'authenticated',
      email,
      app_metadata: { provider: 'email' },
      user_metadata: {},
      created_at: '2026-01-01T00:00:00Z',
    },
  };
}

async function logOf(page: Page): Promise<OpenLog> {
  const log = await page.evaluate(() => window.__open);
  if (log === undefined) throw new Error('no open log');
  return log;
}

/** The frames from the last tap on, timed from it. */
function framesSince(log: OpenLog, tap: number): Frame[] {
  return log.frames.filter((f) => f.at >= tap).map((f) => ({ ...f, at: Math.round(f.at - tap) }));
}

function show(frames: readonly Frame[]): string[] {
  return frames.map(
    (f) =>
      `${f.at} chat=${f.chat.slice(-4)} msgs=${f.msgs ? 'y' : 'n'} card=${f.card} badges=${f.badges} ticker=${f.ticker}`,
  );
}

function viewAsClient(network: HarnessNetwork): void {
  for (const m of network.world.tables.workspace_members ?? []) {
    if (m.user_id === ME) m.role = 'client';
    if (m.user_id === PEER) m.role = 'agency';
  }
}

/** The plan DM with an open mark on the plan message (a badge and a ticker item). */
function seedPlanChat(network: HarnessNetwork): void {
  viewAsClient(network);
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

function expectClean(network: HarnessNetwork): void {
  expect(network.blocked, 'blocked non-fixture requests').toEqual([]);
  expect([...new Set(network.unmatched)], 'unrecognised fixture requests').toEqual([]);
}

/**
 * Count GET reads of a REST table (or the ticker's current shared plan ids
 * select); the plan bundle read (POST rpc/plan_bundle_read) counts as 'plans'.
 */
function countReads(page: Page): (name: string) => number {
  const counts = new Map<string, number>();
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (request.method() === 'POST' && url.pathname === '/rest/v1/rpc/plan_bundle_read') {
      counts.set('plans', (counts.get('plans') ?? 0) + 1);
      return;
    }
    if (request.method() !== 'GET' || !url.pathname.startsWith('/rest/v1/')) return;
    const table = url.pathname.replace('/rest/v1/', '');
    // The ticker's list of the workspace's current shared plans is its own
    // read (select=id), not the plan bundle read the card and ticker share.
    const name =
      table === 'plans' && url.searchParams.get('audience') === 'eq.client'
        ? 'current_plan_ids'
        : table;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  });
  return (name) => counts.get(name) ?? 0;
}

async function tapChat(page: Page, name: string): Promise<number> {
  const row = page.getByText(name, { exact: true }).first();
  await row.waitFor({ state: 'visible' });
  await row.click();
  const log = await logOf(page);
  return log.taps[log.taps.length - 1] ?? 0;
}

async function backToList(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Back to conversations' }).first().click();
  await page.getByText(GROUP_NAME, { exact: true }).first().waitFor({ state: 'visible' });
}

/** Settled: the card, the open ticker and the badge are on screen. */
async function settled(page: Page): Promise<void> {
  await page.locator(`[data-plan-card="${DRAFT_PLAN_ID}"]`).waitFor({ timeout: 10_000 });
  await page.locator('[data-loops-strip="open"]').waitFor({ timeout: 10_000 });
  await page.locator('[data-msg-id] [data-mark-badge]').first().waitFor({ timeout: 10_000 });
}

function report(label: string, value: unknown): void {
  test.info().annotations.push({ type: label, description: JSON.stringify(value) });
  console.log(`[${label}] ${JSON.stringify(value, null, 1)}`);
}

/** When each part was first on screen in its final form, from the tap. */
function partTimes(frames: readonly Frame[]): Record<string, number | null> {
  const first = (ok: (f: Frame) => boolean): number | null => frames.find(ok)?.at ?? null;
  return {
    messages: first((f) => f.msgs),
    cardSkeleton: first((f) => f.card === 'skel'),
    card: first((f) => f.card.startsWith(DRAFT_PLAN_ID)),
    badges: first((f) => f.badges > 0),
    ticker: first((f) => /^(open|empty)/.test(f.ticker)),
  };
}

// ---------------------------------------------------------------------------

/** STEP 0 / after: the open's timeline with realistic delays (reported). */
async function runTimeline(page: Page): Promise<void> {
  const network = await installHarnessNetwork(page);
  seedPlanChat(network);
  await delaySupabaseReads(page, realisticDelay);
  await recordOpen(page);
  await page.goto('/chat');
  await page.getByText(PEER_NAME, { exact: true }).first().waitFor();
  await page.waitForTimeout(1_500);
  const tap = await tapChat(page, PEER_NAME);
  await settled(page);
  await page.waitForTimeout(2_000);
  const frames = framesSince(await logOf(page), tap);
  const spans = await readSpans(page, tap);
  report('open timeline', {
    ...partTimes(frames),
    frames: show(frames),
    reads: spans.map((s) => `${s.name} ${s.start}-${s.end}`),
    chain: dependencyChain(spans),
  });
  expectClean(network);
}

/** Everything settles inside the hold: one frame paints it all. */
async function runAtOnce(page: Page): Promise<void> {
  const network = await installHarnessNetwork(page);
  // Measures the cold open: no pre-warm (Save-Data).
  await withSaveData(page);
  seedPlanChat(network);
  // Messages 200ms, every other read 80ms: three rounds on each path (the
  // page, its chips, their files; the plan ids, the plans, their reviews).
  await delaySupabaseReads(page, (name) => (name === 'chat_messages' ? 200 : 80));
  await recordOpen(page);
  const reads = countReads(page);
  await page.goto('/chat');
  await page.getByText(PEER_NAME, { exact: true }).first().waitFor();
  await page.waitForTimeout(1_500);
  // "Settled inside the hold" is the scenario. The hold is the app's own
  // clock (Date.now and a 1s timer from the tap), so it must not hinge on how
  // fast the runner serves the stubbed reads: a busy runner takes over 1s of
  // wall time for them, the cap fires first and this scenario never happens
  // (the one-late scenario covers the cap). So the app's clock stands still
  // from just before the tap until the open has painted: the cap cannot fire
  // and the only way anything paints is the hold's all-settled release.
  // Rendering, network, DOM changes and the recorder's frames run as usual.
  await page.clock.install();
  // (A moment ahead: the list is idle, and the clock runs while this travels.)
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1_000));
  const tap = await tapChat(page, PEER_NAME);
  await settled(page);
  // Time flows again: the cap fires (a no-op once released), then 2s of
  // frames that must show nothing changing.
  await page.clock.resume();
  await page.waitForTimeout(2_000);
  const log = await logOf(page);
  const frames = framesSince(log, tap);
  const spans = await readSpans(page, tap);
  report('at once', {
    ...partTimes(frames),
    frames: show(frames),
    reads: spans.map((s) => `${s.name} ${s.start}-${s.end}`),
  });
  const firstPaint = frames.findIndex((f) => f.msgs);
  expect(firstPaint, show(frames).join('\n')).toBeGreaterThanOrEqual(0);
  const first = frames[firstPaint];
  // One frame: messages, card, badge and ticker together.
  expect(first?.card, show(frames).join('\n')).toBe(`${DRAFT_PLAN_ID}:${DRAFT_PLAN_TITLE}`);
  expect(first?.badges ?? 0).toBeGreaterThan(0);
  expect(first?.ticker ?? '').toMatch(/^open:/);
  // Nothing after it changes: no skeleton, no ticker refill, no new badge.
  for (const f of frames.slice(firstPaint)) {
    expect(f.card).toBe(first?.card);
    expect(f.ticker).toBe(first?.ticker);
    expect(f.badges).toBe(first?.badges);
  }
  expect(log.skeletonHeights, 'never a card skeleton').toEqual([]);
  expect(log.cardNodes).toBe(1);
  expect(log.scrollJumps).toBe(0);
  // One read each per open (no read waits on, or repeats, another).
  // The plan bundle read is one plan_bundle_read (plans, items, reviews and
  // draft rows together); the ticker's current plan ids are their own read.
  expect(reads('plans'), 'plans reads').toBe(1);
  // The current shared plan ids come inside the chat's one chat_open_bundle call.
  expect(reads('current_plan_ids'), 'current_plan_ids reads').toBe(0);
  expect(network.rpcCalls.filter((c) => c.name === 'chat_open_bundle')).toHaveLength(1);
  for (const name of ['plan_items', 'plan_item_reviews']) {
    expect(reads(name), `${name} reads`).toBe(0);
  }
  expect(network.rpcCalls.filter((c) => c.name === 'plan_draft_rows')).toHaveLength(0);
  expectClean(network);
}

/** One read 2s late: the rest paint at the hold's cap, the late part fills in place. */
async function runOneLate(page: Page): Promise<void> {
  const network = await installHarnessNetwork(page);
  seedPlanChat(network);
  await delaySupabaseReads(page, (name) =>
    name === 'rpc plan_bundle_read' ? 2_000 : realisticDelay(name),
  );
  await recordOpen(page);
  await page.goto('/chat');
  await page.getByText(PEER_NAME, { exact: true }).first().waitFor();
  await page.waitForTimeout(1_500);
  const tap = await tapChat(page, PEER_NAME);
  await settled(page);
  await page.waitForTimeout(2_000);
  const log = await logOf(page);
  const frames = framesSince(log, tap);
  const times = partTimes(frames);
  report('one late read', { ...times, log: { ...log, frames: show(frames) } });
  // The messages and badges paint without the plan (its skeleton and the
  // inert ticker slot hold their places), then the card and ticker fill in.
  expect(times.messages).not.toBeNull();
  expect(times.cardSkeleton, 'the card skeleton held the place').toBe(times.messages);
  expect(times.badges).toBe(times.messages);
  expect(times.card ?? 0).toBeGreaterThan(times.messages ?? 0);
  // The hold is capped at 1s from the tap: the messages never wait for the late read.
  expect(times.card ?? 0, 'the card came with the late read').toBeGreaterThan(2_000);
  // Zero movement: the skeleton is the card's height, the card never moves,
  // the thread never jumps, the card mounts once.
  expect(log.skeletonHeights).toEqual([log.cardHeights[0]]);
  expect(log.cardNodes).toBe(1);
  expect(log.cardMoves).toBe(0);
  expect(log.scrollJumps).toBe(0);
  expectClean(network);
}

/** A reopen paints the remembered card and ticker at once; a changed plan updates in place. */
async function runReopen(page: Page): Promise<void> {
  const network = await installHarnessNetwork(page);
  seedPlanChat(network);
  const delays = await delaySupabaseReads(page, realisticDelay);
  await recordOpen(page);
  const reads = countReads(page);
  await page.goto('/chat');
  await page.getByText(PEER_NAME, { exact: true }).first().waitFor();
  await tapChat(page, PEER_NAME);
  await settled(page);
  await page.waitForTimeout(1_000);
  await backToList(page);
  // The plan changes while the chat is closed.
  const plan = (network.world.tables.plans ?? []).find((p) => p.id === DRAFT_PLAN_ID);
  if (plan === undefined) throw new Error('no plan');
  plan.title = NEW_TITLE;
  // The revalidation answers after the messages: the change lands on screen.
  delays.setDelay((name) => (name === 'rpc plan_bundle_read' ? 2_500 : realisticDelay(name)));
  await page.waitForTimeout(2_500);
  const plansBefore = reads('plans');
  const nodesBefore = (await logOf(page)).cardNodes;
  const tap = await tapChat(page, PEER_NAME);
  await expect(page.locator(`[data-plan-card="${DRAFT_PLAN_ID}"]`)).toContainText(NEW_TITLE, {
    timeout: 10_000,
  });
  await page.waitForTimeout(1_500);
  const log = await logOf(page);
  const frames = framesSince(log, tap);
  report('reopen', { ...partTimes(frames), frames: show(frames) });
  const firstPaint = frames.findIndex((f) => f.msgs);
  const first = frames[firstPaint];
  expect(first?.badges ?? 0, show(frames).join('\n')).toBeGreaterThan(0);
  // No plan bundle is remembered from the earlier open: the card waits at its
  // final size (skeleton) for this open's read and never paints the old title.
  expect(
    frames.some((f) => f.card === `${DRAFT_PLAN_ID}:${DRAFT_PLAN_TITLE}`),
    'a stale bundle is never painted',
  ).toBe(false);
  // This open's read brought the new title in place: one card node, no move.
  expect(frames[frames.length - 1]?.card).toBe(`${DRAFT_PLAN_ID}:${NEW_TITLE}`);
  expect(frames[frames.length - 1]?.ticker ?? '').toMatch(/^open:/);
  expect(log.cardNodes - nodesBefore, 'the reopened card mounts once').toBe(1);
  expect(log.cardMoves).toBe(0);
  expect(log.scrollJumps).toBe(0);
  expect(reads('plans') - plansBefore, 'one revalidation read per reopen').toBe(1);
  expectClean(network);
}

/** Sign-out forgets everything; another user never sees the first one's memory. */
async function runSignOut(page: Page): Promise<void> {
  const network = await installHarnessNetwork(page);
  // A group both users are in (the DM's row reads differently for each).
  viewAsClient(network);
  seedClientPlanWithDraft(network.world, { channelId: GROUP_CHANNEL, sender: COLLEAGUE_A });
  // The second user's session (the harness signs in as ME).
  const other = signedInAs(PEER);
  await page.route(/\/auth\/v1\/(logout|user)/, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/logout')) {
      await route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' } });
      return;
    }
    if (!signedInOther) {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' },
      body: JSON.stringify(other.user),
    });
  });
  let signedInOther = false;
  await recordOpen(page);
  const reads = countReads(page);
  await page.goto('/chat');
  await tapChat(page, GROUP_NAME);
  await page.locator(`[data-plan-card="${DRAFT_PLAN_ID}"]`).waitFor({ timeout: 10_000 });
  await page.waitForTimeout(1_000);
  await backToList(page);
  const urls = await moduleUrls(page);
  const size = (): Promise<number> =>
    page.evaluate(async (paths) => {
      const mod = (await import(/* @vite-ignore */ paths.cache)) as {
        openCache: { size: () => number };
      };
      return mod.openCache.size();
    }, urls);
  expect(await size(), 'the chat is remembered').toBeGreaterThan(0);
  // Sign out (the app's own local sign-out: the SIGNED_OUT auth event).
  await page.evaluate(async (paths) => {
    const auth = (await import(/* @vite-ignore */ paths.supabase)) as {
      supabase: { auth: { signOut: (o: { scope: 'local' }) => Promise<unknown> } };
    };
    await auth.supabase.auth.signOut({ scope: 'local' });
  }, urls);
  expect(await size(), 'sign-out cleared the memory').toBe(0);
  // The plan changes: a memory shown to the next user would show the old title.
  const plan = (network.world.tables.plans ?? []).find((p) => p.id === DRAFT_PLAN_ID);
  if (plan === undefined) throw new Error('no plan');
  plan.title = NEW_TITLE;
  // Another user signs in in the same tab and opens the same chat.
  signedInOther = true;
  await page.evaluate(
    async ({ paths, session }) => {
      const auth = (await import(/* @vite-ignore */ paths.supabase)) as {
        supabase: {
          auth: {
            setSession: (s: { access_token: string; refresh_token: string }) => Promise<unknown>;
          };
        };
      };
      await auth.supabase.auth.setSession(session);
    },
    { paths: urls, session: { access_token: other.accessToken, refresh_token: 'harness-refresh' } },
  );
  // In the app: the Chat tab, then the same chat.
  await page.getByRole('link', { name: 'Chat' }).last().click();
  const plansBefore = reads('plans');
  const tap = await tapChat(page, GROUP_NAME);
  await page.locator(`[data-plan-card="${DRAFT_PLAN_ID}"]`).waitFor({ timeout: 10_000 });
  await page.waitForTimeout(1_500);
  const frames = framesSince(await logOf(page), tap);
  report('other user', { frames: show(frames) });
  // A first open for this user: fresh reads, never the first user's card.
  expect(reads('plans') - plansBefore).toBeGreaterThanOrEqual(1);
  for (const f of frames) {
    expect(f.card, show(frames).join('\n')).not.toBe(`${DRAFT_PLAN_ID}:${DRAFT_PLAN_TITLE}`);
  }
  // The sorted sign-out event alone clears too (a sign-out that never reached auth).
  expect(await size()).toBeGreaterThan(0);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('sorted:signout')));
  await expect.poll(size, { message: 'the sign-out event cleared the memory' }).toBe(0);
  expectClean(network);
}

/** Switching chats never shows the other chat's card or counts. */
async function runSwitch(page: Page): Promise<void> {
  const network = await installHarnessNetwork(page);
  seedPlanChat(network);
  await delaySupabaseReads(page, realisticDelay);
  await recordOpen(page);
  await page.goto('/chat');
  await page.getByText(PEER_NAME, { exact: true }).first().waitFor();
  const dmIds = new Set(network.world.dmMessages.map((m) => String(m.id)));
  dmIds.add(DRAFT_PLAN_MESSAGE_ID);
  const groupIds = new Set(network.world.groupMessages.map((m) => String(m.id)));
  for (let round = 0; round < 2; round += 1) {
    const dmTap = await tapChat(page, PEER_NAME);
    await settled(page);
    await page.waitForTimeout(500);
    await backToList(page);
    const groupTap = await tapChat(page, GROUP_NAME);
    await page.locator('[data-msg-id]').first().waitFor({ timeout: 10_000 });
    await page.waitForTimeout(2_000);
    await backToList(page);
    const log = await logOf(page);
    const inGroup = framesSince(log, groupTap);
    const inDm = framesSince(log, dmTap).filter((f) => f.at < groupTap - dmTap);
    report(`switch round ${round + 1}`, { dm: show(inDm), group: show(inGroup) });
    // The group never shows the DM's plan card or its badge. Its ticker may
    // read the plan: the bar shows the workspace's current shared plans in
    // every chat.
    for (const f of inGroup) {
      expect(f.card, show(inGroup).join('\n')).toBe('none');
      expect(f.badges).toBe(0);
      if (f.msgs) expect(groupIds.has(f.chat) || f.chat === '-').toBe(true);
    }
    // The DM never shows the group's rows.
    for (const f of inDm) if (f.msgs) expect(dmIds.has(f.chat)).toBe(true);
  }
  expectClean(network);
}

// ---------------------------------------------------------------------------

const SCENARIOS: Array<{ name: string; run: (page: Page) => Promise<void> }> = [
  { name: 'open timeline with realistic delays (report)', run: runTimeline },
  { name: 'everything settled under 1s paints in one frame', run: runAtOnce },
  { name: 'one read 2s late: the rest paint, the late part fills in place', run: runOneLate },
  { name: 'reopen paints from memory; a changed plan updates in place', run: runReopen },
  { name: 'sign-out clears the memory; another user sees none of it', run: runSignOut },
  { name: "switching chats never shows the other chat's card or counts", run: runSwitch },
];

for (const scenario of SCENARIOS) {
  test(`webkit: ${scenario.name}`, async ({ page, browserName }) => {
    test.skip(browserName !== 'webkit', 'the WebKit projects run this');
    test.setTimeout(90_000);
    await scenario.run(page);
  });

  test(`chromium: ${scenario.name}`, async () => {
    test.skip(!existsSync(CHROMIUM), 'no local Chromium');
    test.setTimeout(90_000);
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
      await scenario.run(page);
      await context.close();
    } finally {
      await browser.close();
    }
  });
}
