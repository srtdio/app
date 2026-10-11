import { existsSync } from 'node:fs';
import { chromium, devices, expect, test, type Page } from '@playwright/test';
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
  seedClientPlanWithDraft,
  seedTeamAndHiddenPlans,
} from '../fixtures/chat-data';

// A plan card's first paint is its final state: opening a DM that holds a plan
// card records every distinct state of that card (skeleton or card, its chips,
// progress, Forward and height) per frame and per DOM change, from mount until
// settled. The only allowed sequence is skeleton (the card's own height), then
// one card that never changes, never drops back to a skeleton and never
// remounts. Covers a client plan with a draft row (plan_draft_rows returns 1),
// an Agency only plan, and a slow plan read. Runs on the config's WebKit
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
    progress: '0 of 2 approved by client',
    forward: true,
  },
  {
    name: 'Agency only plan',
    messageId: TEAM_PLAN_MESSAGE_ID,
    planId: TEAM_PLAN_ID,
    seed: (network) => seedTeamAndHiddenPlans(network.world, { channelId: DM_CHANNEL, sender: ME }),
    chips: ['1 concept', '0 posts', 'Agency only'],
    progress: 'Agency 0 of 1 · Client 0 of 1',
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
    progress: '0 of 2 approved by client',
    forward: true,
  },
];

/** The plans GETs the page made (the bundle read's first select). */
function countPlanReads(page: Page): () => number {
  let n = 0;
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (request.method() === 'GET' && url.pathname === '/rest/v1/plans') n += 1;
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
  const gate = scenario.slowMs !== undefined ? network.holdTable('plans') : null;
  await row.click();
  await page.locator('[data-msg-id]').first().waitFor({ state: 'visible', timeout: 8000 });
  if (gate !== null) {
    await page.waitForTimeout(scenario.slowMs ?? 0);
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
  expect(planReads(), 'one plans read per open').toBe(1);
  expect(
    network.rpcCalls.filter((c) => c.name === 'plan_draft_rows'),
    'one plan_draft_rows per open',
  ).toHaveLength(1);
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
  await page.screenshot({ path: test.info().outputPath('settled.png') });
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
