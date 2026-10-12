import { existsSync } from 'node:fs';
import { chromium, devices, expect, test, type Page } from '@playwright/test';
import { installHarnessNetwork, type HarnessNetwork } from '../fixtures/harness-routes';
import {
  COLLEAGUE_A,
  DM_CHANNEL,
  GROUP_CHANNEL,
  GROUP_NAME,
  ME,
  PEER,
  PEER_NAME,
} from '../fixtures/chat-data';
import { delaySupabaseReads, realisticDelay } from '../fixtures/read-delays';
import { installLiveAgora, type LiveAgora } from '../fixtures/live-agora';
import type { Row } from '../fixtures/postgrest';

// Chat remembers messages per chat. Per frame (and per DOM change) the
// recorder keeps the first and last message ids on screen, whether a thread
// skeleton is up, and every scroll the reader did not make; Chromium also sums
// layout shift. A reopen paints the remembered page in its first frame (no
// skeleton, no shift); peer edits, deletes and sends while the chat is closed
// are on that first frame (live) or land in place after it (catch-up, live
// suppressed); a scrolled-up reader holds position while new rows land; the
// unread divider sits above the first message the viewer has not read; a
// switch never shows another chat's rows; a sign-out and another user in the
// tab remember nothing. Runs on the WebKit projects (dark and light, CI) and,
// where a local Chromium is installed, in Chromium with the iPhone viewport
// and the project's colour scheme.

const CHROMIUM = process.env.E2E_CHROMIUM_PATH ?? '/opt/pw-browsers/chromium';
const MODULES = { cache: '/src/lib/chat/open-cache.ts', supabase: '/src/lib/supabase.ts' };
const NEW_ID_BASE = '0190f000-0000-7000-8000-';

interface Frame {
  at: number;
  first: string;
  last: string;
  count: number;
  skeleton: boolean;
}

interface Log {
  taps: number[];
  frames: Frame[];
  /** When the thread scrolled without the reader (a jump). */
  scrollJumps: number[];
  shift: number;
  /** When a frame was about to paint with a skeleton on screen (rAF samples only). */
  paintedSkeleton: number[];
}

declare global {
  interface Window {
    __remember?: Log;
  }
}

async function record(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const log: Log = { taps: [], frames: [], scrollJumps: [], shift: 0, paintedSkeleton: [] };
    window.__remember = log;
    document.addEventListener('pointerdown', () => log.taps.push(performance.now()), true);
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const shift = entry as PerformanceEntry & { value?: number; hadRecentInput?: boolean };
          if (shift.hadRecentInput !== true) log.shift += shift.value ?? 0;
        }
      }).observe({ type: 'layout-shift', buffered: false });
    } catch {
      // WebKit has no layout-shift entries: the scroll and frame checks stand alone.
    }
    let lastScroller: Element | null = null;
    let lastScroll: number | null = null;
    let lastHeight: number | null = null;
    let grown = 0;
    let userScroll = false;
    const markUser = (): void => {
      userScroll = true;
    };
    document.addEventListener('wheel', markUser, { capture: true, passive: true });
    document.addEventListener('touchmove', markUser, { capture: true, passive: true });
    const read = (): Omit<Frame, 'at'> => {
      const rows = document.querySelectorAll('[data-msg-id]');
      return {
        first: rows[0]?.getAttribute('data-msg-id') ?? '-',
        last: rows[rows.length - 1]?.getAttribute('data-msg-id') ?? '-',
        count: rows.length,
        skeleton:
          document.querySelector('[data-skeleton-bubble]') !== null ||
          document.querySelector('[data-thread-opening]') !== null,
      };
    };
    const sampleDom = (painted = false): void => {
      const s = read();
      if (painted && s.skeleton) log.paintedSkeleton.push(Math.round(performance.now()));
      const prev = log.frames[log.frames.length - 1];
      if (
        prev !== undefined &&
        prev.first === s.first &&
        prev.last === s.last &&
        prev.count === s.count &&
        prev.skeleton === s.skeleton
      ) {
        return;
      }
      log.frames.push({ at: Math.round(performance.now()), ...s });
    };
    const samplePaint = (): void => {
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
        userScroll = false;
        return;
      }
      // Growth since the scroll last moved: a pin may land a frame after it.
      grown += lastHeight !== null ? height - lastHeight : 0;
      lastHeight = height;
      if (lastScroll !== null && st !== lastScroll) {
        // A pin that follows the growth by the same amount keeps the reader still.
        if (!userScroll && Math.abs(st - lastScroll - grown) > 1)
          log.scrollJumps.push(Math.round(performance.now()));
        grown = 0;
      }
      userScroll = false;
      lastScroll = st;
    };
    const start = (): void => {
      new MutationObserver(() => sampleDom()).observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
      });
      const afterPaint = new MessageChannel();
      afterPaint.port1.onmessage = samplePaint;
      const frame = (): void => {
        sampleDom(true);
        afterPaint.port2.postMessage(null);
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    };
    if (document.body !== null) start();
    else document.addEventListener('DOMContentLoaded', start, { once: true });
  });
}

async function logOf(page: Page): Promise<Log> {
  const log = await page.evaluate(() => window.__remember);
  if (log === undefined) throw new Error('no log');
  return log;
}

function framesSince(log: Log, tap: number): Frame[] {
  return log.frames.filter((f) => f.at >= tap).map((f) => ({ ...f, at: Math.round(f.at - tap) }));
}

/** The jumps from the last tap on, timed from it (earlier opens are not this reopen's). */
function jumpsSince(log: Log, tap: number): number[] {
  return log.scrollJumps.filter((at) => at >= tap).map((at) => Math.round(at - tap));
}

function show(frames: readonly Frame[]): string {
  return frames
    .map(
      (f) =>
        `${f.at} first=${f.first.slice(-4)} last=${f.last.slice(-4)} n=${f.count} skel=${f.skeleton ? 'y' : 'n'}`,
    )
    .join('\n');
}

function report(label: string, value: unknown): void {
  test.info().annotations.push({ type: label, description: JSON.stringify(value) });
  console.log(`[${label}] ${JSON.stringify(value, null, 1)}`);
}

function expectClean(network: HarnessNetwork): void {
  expect(network.blocked, 'blocked non-fixture requests').toEqual([]);
  expect([...new Set(network.unmatched)], 'unrecognised fixture requests').toEqual([]);
}

/** Count GET reads of chat_messages from now on. */
function countMessageReads(page: Page): () => number {
  let n = 0;
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (request.method() !== 'GET' || url.pathname !== '/rest/v1/chat_messages') return;
    if (url.searchParams.get('select') === 'shared_plan_ids') return;
    n += 1;
  });
  return () => n;
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

async function openAndSettle(page: Page, name: string): Promise<void> {
  await tapChat(page, name);
  await page.locator('[data-msg-id]').first().waitFor({ timeout: 10_000 });
  await page.waitForTimeout(1_500);
}

/** A row of `rows` by sender, counting from the newest (0 = the newest). */
function nthFrom(rows: readonly Row[], channelId: string, sender: string, n: number): Row {
  const list = rows
    .filter(
      (r) => r.channel_id === channelId && r.sender_user_id === sender && r.deleted_at === null,
    )
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  const row = list[list.length - 1 - n];
  if (row === undefined) throw new Error('no such row');
  return row;
}

function newId(n: number): string {
  return `${NEW_ID_BASE}${String(n).padStart(12, '0')}`;
}

async function setup(
  page: Page,
): Promise<{ network: HarnessNetwork; live: LiveAgora; rows: Row[]; reactions: Row[] }> {
  const network = await installHarnessNetwork(page);
  const live = await installLiveAgora(page);
  const rows = (network.world.tables.chat_messages ??= []);
  const reactions = (network.world.tables.chat_reactions ??= []);
  return { network, live, rows, reactions };
}

/** Peer edits one DM message, deletes another and sends a new one; returns their ids. */
async function peerChanges(
  live: LiveAgora,
  rows: Row[],
  reactions: Row[],
  n: number,
): Promise<{ edited: string; deleted: string; sent: string; reacted: string }> {
  const editRow = nthFrom(rows, DM_CHANNEL, PEER, 1);
  const deleteRow = nthFrom(rows, DM_CHANNEL, PEER, 2);
  const reactRow = nthFrom(rows, DM_CHANNEL, ME, 0);
  await live.edit({ row: editRow, body: `Edited while away ${n}` });
  await live.remove({ row: deleteRow });
  await live.react({ reactions, messageId: String(reactRow.id), from: PEER, emoji: '🔥' });
  const sent = newId(n);
  await live.send({
    rows,
    id: sent,
    channelId: DM_CHANNEL,
    from: PEER,
    body: `New while away ${n}`,
    createdAt: new Date().toISOString(),
  });
  return {
    edited: String(editRow.id),
    deleted: String(deleteRow.id),
    sent,
    reacted: String(reactRow.id),
  };
}

async function bubbleText(page: Page, id: string): Promise<string> {
  return (await page.locator(`[data-msg-id="${id}"]`).first().textContent()) ?? '';
}

// ---------------------------------------------------------------------------

/** Open A, open B, reopen A: A's rows in the first frame, no skeleton, no shift. */
async function runFirstFrame(page: Page): Promise<void> {
  const { network } = await setup(page);
  await delaySupabaseReads(page, realisticDelay);
  await record(page);
  const reads = countMessageReads(page);
  await page.goto('/chat');
  await page.getByText(PEER_NAME, { exact: true }).first().waitFor();
  const firstTap = await tapChat(page, PEER_NAME);
  await page.locator('[data-msg-id]').first().waitFor({ timeout: 10_000 });
  await page.waitForTimeout(1_500);
  const fresh = framesSince(await logOf(page), firstTap);
  const freshFirst = fresh.find((f) => f.count > 0)?.at ?? null;
  await backToList(page);
  await openAndSettle(page, GROUP_NAME);
  await backToList(page);
  const before = reads();
  const shiftBefore = (await logOf(page)).shift;
  const tap = await tapChat(page, PEER_NAME);
  await page.waitForTimeout(2_000);
  const log = await logOf(page);
  const frames = framesSince(log, tap);
  const first = frames.findIndex((f) => f.count > 0);
  report('first frame', {
    paintedSkeleton: log.paintedSkeleton
      .filter((at) => at >= tap)
      .map((at) => Math.round(at - tap)),
    freshOpenMs: freshFirst,
    reopenMs: frames[first]?.at ?? null,
    frames: show(frames),
    shift: log.shift - shiftBefore,
    jumps: jumpsSince(log, tap),
  });
  expect(first, show(frames)).toBeGreaterThanOrEqual(0);
  // Never a skeleton on the reopen: not in the DOM, not in a painted frame.
  expect(
    frames.some((f) => f.skeleton),
    show(frames),
  ).toBe(false);
  expect(log.paintedSkeleton.filter((at) => at >= tap)).toEqual([]);
  // Only DM rows, and the same window from the first frame on.
  const dm = new Set(network.world.dmMessages.map((m) => String(m.id)));
  const firstFrame = frames[first];
  expect(dm.has(firstFrame?.first ?? '')).toBe(true);
  for (const f of frames.slice(first)) {
    expect(f.first).toBe(firstFrame?.first);
    expect(f.last).toBe(firstFrame?.last);
  }
  expect(log.shift - shiftBefore, 'no layout shift').toBe(0);
  expect(jumpsSince(log, tap)).toEqual([]);
  // The background revalidation reads (forward, by ids, cursors) never the latest page first.
  expect(reads() - before).toBeGreaterThanOrEqual(1);
  await page.screenshot({ path: test.info().outputPath('reopen-first-frame.png') });
  expectClean(network);
}

/** While on B, a peer edits, deletes, reacts and sends in A (live): A's first frame has it all. */
async function runLiveWhileClosed(page: Page): Promise<void> {
  const { network, live, rows, reactions } = await setup(page);
  const delays = await delaySupabaseReads(page, realisticDelay);
  await record(page);
  await page.goto('/chat');
  await openAndSettle(page, PEER_NAME);
  await backToList(page);
  await openAndSettle(page, GROUP_NAME);
  const changed = await peerChanges(live, rows, reactions, 1);
  await page.waitForTimeout(1_000);
  await backToList(page);
  // The record answers slowly now: what the first frame shows came from memory.
  delays.setDelay((name) => (name === 'chat_messages' || name === 'chat_reactions' ? 2_500 : 300));
  const tap = await tapChat(page, PEER_NAME);
  // The record answers in 2.5s: rows on screen before then came from memory,
  // and the first frame (below) must already hold them.
  await page.locator(`[data-msg-id="${changed.sent}"]`).waitFor({ timeout: 2_000 });
  const atFirst = framesSince(await logOf(page), tap);
  const first = atFirst.find((f) => f.count > 0);
  expect(first?.last, show(atFirst)).toBe(changed.sent);
  expect(await bubbleText(page, changed.edited)).toContain('Edited while away 1');
  expect(await bubbleText(page, changed.deleted)).toContain('This message was deleted');
  expect(await bubbleText(page, changed.reacted)).toContain('🔥');
  await page.waitForTimeout(3_500);
  const log = await logOf(page);
  const frames = framesSince(log, tap);
  report('live while closed', { frames: show(frames), jumps: jumpsSince(log, tap) });
  expect(frames.some((f) => f.skeleton)).toBe(false);
  expect(log.paintedSkeleton.filter((at) => at >= tap)).toEqual([]);
  expect(jumpsSince(log, tap)).toEqual([]);
  // The revalidation found nothing new: the same rows, still in place.
  expect(frames[frames.length - 1]?.last).toBe(changed.sent);
  await page.screenshot({ path: test.info().outputPath('live-while-closed.png') });
  expectClean(network);
}

/** Live suppressed (asleep): the reopen paints the memory, the catch-up lands it all in place. */
async function runCatchUp(page: Page): Promise<void> {
  const { network, live, rows, reactions } = await setup(page);
  await delaySupabaseReads(page, realisticDelay);
  await record(page);
  await page.goto('/chat');
  await openAndSettle(page, PEER_NAME);
  await backToList(page);
  await openAndSettle(page, GROUP_NAME);
  await live.suppress(true);
  const changed = await peerChanges(live, rows, reactions, 2);
  await backToList(page);
  const tap = await tapChat(page, PEER_NAME);
  await page.locator(`[data-msg-id="${changed.sent}"]`).waitFor({ timeout: 6_000 });
  await expect(page.locator(`[data-msg-id="${changed.edited}"]`).first()).toContainText(
    'Edited while away 2',
  );
  await expect(page.locator(`[data-msg-id="${changed.deleted}"]`).first()).toContainText(
    'This message was deleted',
  );
  await expect(page.locator(`[data-msg-id="${changed.reacted}"]`).first()).toContainText('🔥');
  await page.waitForTimeout(1_000);
  const log = await logOf(page);
  const frames = framesSince(log, tap);
  report('catch-up', { frames: show(frames), jumps: jumpsSince(log, tap) });
  expect(
    frames.some((f) => f.skeleton),
    show(frames),
  ).toBe(false);
  expect(log.paintedSkeleton.filter((at) => at >= tap)).toEqual([]);
  // The first frame was the memory (the new row came after), then it appended.
  const first = frames.find((f) => f.count > 0);
  expect(first?.last).not.toBe(changed.sent);
  expect(frames[frames.length - 1]?.last).toBe(changed.sent);
  expect(jumpsSince(log, tap)).toEqual([]);
  await page.screenshot({ path: test.info().outputPath('catch-up.png') });
  expectClean(network);
}

/** A reader scrolled up holds position while the catch-up's new rows land. */
async function runScrolledUp(page: Page): Promise<void> {
  const { network, live, rows } = await setup(page);
  const delays = await delaySupabaseReads(page, realisticDelay);
  await record(page);
  await page.goto('/chat');
  await openAndSettle(page, PEER_NAME);
  await backToList(page);
  await openAndSettle(page, GROUP_NAME);
  await live.suppress(true);
  for (let k = 0; k < 3; k += 1) {
    await live.send({
      rows,
      id: newId(30 + k),
      channelId: DM_CHANNEL,
      from: PEER,
      body: `Away ${k}`,
      createdAt: new Date(Date.now() + k).toISOString(),
    });
  }
  await backToList(page);
  delays.setDelay((name) => (name === 'chat_messages' ? 2_000 : 250));
  await tapChat(page, PEER_NAME);
  await page.locator('[data-msg-id]').first().waitFor();
  // Scroll up as a reader's finger would (mobile WebKit has no wheel): a touch
  // on the list, the list moves, the touch ends; the thread lets go of the bottom.
  await page.evaluate(() => {
    const list = document.querySelector('[data-thread-viewport] > ul');
    if (list === null) return;
    list.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, cancelable: true }));
    list.scrollTop = Math.max(0, list.scrollTop - 900);
  });
  await page.waitForTimeout(100);
  await page.evaluate(() => {
    window.dispatchEvent(new TouchEvent('touchend', { bubbles: true }));
  });
  await page.waitForTimeout(500);
  const anchorId = await page.evaluate(() => {
    const list = document.querySelector('[data-thread-viewport] > ul');
    const box = list?.getBoundingClientRect();
    if (list === null || list === undefined || box === undefined) return null;
    for (const el of list.querySelectorAll('[data-msg-id]')) {
      const r = el.getBoundingClientRect();
      if (r.top >= box.top) return el.getAttribute('data-msg-id');
    }
    return null;
  });
  if (anchorId === null) throw new Error('no anchor');
  const topOf = (): Promise<number> =>
    page
      .locator(`[data-msg-id="${anchorId}"]`)
      .first()
      .evaluate((el) => Math.round(el.getBoundingClientRect().top));
  const before = await topOf();
  await page.locator(`[data-msg-id="${newId(32)}"]`).waitFor({ state: 'attached', timeout: 6_000 });
  await page.waitForTimeout(500);
  const after = await topOf();
  report('scrolled up', { anchorId, before, after });
  expect(after, 'the reader holds position').toBe(before);
  await page.screenshot({ path: test.info().outputPath('scrolled-up.png') });
  expectClean(network);
}

/** The unread divider sits above the first message the viewer has not read. */
async function runUnreadDivider(page: Page): Promise<void> {
  const { network, live, rows } = await setup(page);
  await delaySupabaseReads(page, realisticDelay);
  await record(page);
  await page.goto('/chat');
  await openAndSettle(page, PEER_NAME);
  await backToList(page);
  // The cursor the app wrote on the way out (the harness proc keeps none).
  const written = [...network.rpcCalls].reverse().find((c) => c.name === 'chat_read_cursor_set');
  const cursorId = String(written?.args.p_message_id ?? '');
  expect(cursorId).not.toBe('');
  const cursors = network.world.tables.chat_read_cursors ?? [];
  const own = cursors.find((c) => c.user_id === ME && c.channel_id === DM_CHANNEL);
  if (own !== undefined) {
    own.last_read_message_id = cursorId;
    own.last_read_at = new Date().toISOString();
  }
  await openAndSettle(page, GROUP_NAME);
  const firstNew = newId(40);
  await live.send({
    rows,
    id: firstNew,
    channelId: DM_CHANNEL,
    from: PEER,
    body: 'First unread',
    createdAt: new Date().toISOString(),
  });
  await live.send({
    rows,
    id: newId(41),
    channelId: DM_CHANNEL,
    from: PEER,
    body: 'Second unread',
    createdAt: new Date(Date.now() + 1).toISOString(),
  });
  await page.waitForTimeout(800);
  await backToList(page);
  await tapChat(page, PEER_NAME);
  await page.locator('[data-unread-divider]').waitFor({ timeout: 2_000 });
  const placed = await page.evaluate((id) => {
    const divider = document.querySelector('[data-unread-divider]');
    const first = document.querySelector(`[data-msg-id="${id}"]`);
    if (divider === null || first === null) return null;
    const rows = [...document.querySelectorAll('[data-msg-id]')];
    const index = rows.indexOf(first);
    const prev = rows[index - 1];
    const d = divider.getBoundingClientRect().top;
    return {
      aboveFirst: d < first.getBoundingClientRect().top,
      belowPrev: prev === undefined || d >= prev.getBoundingClientRect().top,
    };
  }, firstNew);
  report('unread divider', placed);
  expect(placed).toEqual({ aboveFirst: true, belowPrev: true });
  await page.screenshot({ path: test.info().outputPath('unread-divider.png') });
  expectClean(network);
}

/** Switching back and forth never shows another chat's rows. */
async function runSwitch(page: Page): Promise<void> {
  const { network, live, rows } = await setup(page);
  await delaySupabaseReads(page, realisticDelay);
  await record(page);
  await page.goto('/chat');
  const dmIds = new Set(network.world.dmMessages.map((m) => String(m.id)));
  const groupIds = new Set(network.world.groupMessages.map((m) => String(m.id)));
  for (let round = 0; round < 3; round += 1) {
    const dmTap = await tapChat(page, PEER_NAME);
    await page.locator('[data-msg-id]').first().waitFor();
    await page.waitForTimeout(700);
    await backToList(page);
    const groupTap = await tapChat(page, GROUP_NAME);
    await page.locator('[data-msg-id]').first().waitFor();
    // A group message lands live while the DM is closed (and remembered).
    const id = newId(50 + round);
    groupIds.add(id);
    await live.send({
      rows,
      id,
      channelId: GROUP_CHANNEL,
      from: COLLEAGUE_A,
      body: `Group live ${round}`,
      createdAt: new Date().toISOString(),
    });
    await page.waitForTimeout(700);
    await backToList(page);
    const log = await logOf(page);
    const inDm = framesSince(log, dmTap).filter((f) => f.at < groupTap - dmTap);
    const inGroup = framesSince(log, groupTap);
    report(`switch ${round + 1}`, { dm: show(inDm), group: show(inGroup) });
    for (const f of inDm) {
      if (f.count > 0) expect(dmIds.has(f.first) && dmIds.has(f.last), show(inDm)).toBe(true);
    }
    for (const f of inGroup) {
      if (f.count > 0) {
        expect(groupIds.has(f.first) && groupIds.has(f.last), show(inGroup)).toBe(true);
      }
    }
  }
  expectClean(network);
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

/** Sign-out, then another user in the same tab: nothing remembered, a fresh open. */
async function runSignOut(page: Page): Promise<void> {
  const { network } = await setup(page);
  const other = signedInAs(PEER);
  let signedInOther = false;
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
  await record(page);
  const reads = countMessageReads(page);
  await page.goto('/chat');
  await openAndSettle(page, GROUP_NAME);
  await backToList(page);
  const urls = await page.evaluate((paths) => {
    const loaded = performance.getEntriesByType('resource').map((e) => e.name);
    const find = (path: string): string => loaded.find((n) => n.includes(path)) ?? path;
    return { cache: find(paths.cache), supabase: find(paths.supabase) };
  }, MODULES);
  const remembered = (): Promise<number> =>
    page.evaluate(async (paths) => {
      const mod = (await import(/* @vite-ignore */ paths.cache)) as {
        openCache: { holding: (part: string) => unknown[] };
      };
      return mod.openCache.holding('thread').length;
    }, urls);
  expect(await remembered(), 'the group is remembered').toBe(1);
  await page.evaluate(async (paths) => {
    const auth = (await import(/* @vite-ignore */ paths.supabase)) as {
      supabase: { auth: { signOut: (o: { scope: 'local' }) => Promise<unknown> } };
    };
    await auth.supabase.auth.signOut({ scope: 'local' });
  }, urls);
  expect(await remembered(), 'sign-out forgot every page').toBe(0);
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
  await page.getByRole('link', { name: 'Chat' }).last().click();
  const before = reads();
  await tapChat(page, GROUP_NAME);
  await page.locator('[data-msg-id]').first().waitFor({ timeout: 10_000 });
  // A first open for this user: the latest page is read, nothing came from memory.
  expect(reads() - before).toBeGreaterThanOrEqual(1);
  await page.screenshot({ path: test.info().outputPath('other-user.png') });
  expectClean(network);
}

// ---------------------------------------------------------------------------

const SCENARIOS: Array<{ name: string; run: (page: Page) => Promise<void> }> = [
  { name: 'reopen paints remembered rows in the first frame', run: runFirstFrame },
  { name: 'live edit, delete, reaction and send while closed', run: runLiveWhileClosed },
  { name: 'live suppressed: the catch-up lands it all in place', run: runCatchUp },
  { name: 'scrolled-up position holds while new rows land', run: runScrolledUp },
  { name: 'unread divider correct on reopen', run: runUnreadDivider },
  { name: "switching never shows another chat's rows", run: runSwitch },
  { name: 'sign-out then another user: nothing remembered', run: runSignOut },
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
