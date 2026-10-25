import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test, type Locator, type Page } from '@playwright/test';
import { installHarnessNetwork } from '../fixtures/harness-routes';
import { GROUP_NAME, PEER_NAME, POST_IDS } from '../fixtures/chat-data';
import { seedAudit, type AuditSeedOptions } from '../fixtures/audit-pr-b';

// PR C before/after captures (avatars, count badges, icons, one breakpoint,
// gestures). Not a test: every screen is reached with role/label/text
// selectors that hold on origin/main and on the branch (PR C changes icons,
// avatars, badges and breakpoints, never copy), then the viewport is saved as
// <screen>__<phone|laptop|ipad>__<light|dark>.png in AUDIT_OUT. The -ipad
// screens run in the phone projects only (touch, iPhone UA) at 820x1180, the
// iPad portrait width that PR C moves to the laptop layout. A step that cannot
// be reached still saves the closest state, plus <same name>.note.txt saying
// why. Run through e2e/audit/playwright.audit.config.ts with
// AUDIT_MATCH=capture-pr-c.spec.ts. AUDIT_ONLY=a,b limits the run to those screens.

const OUT = process.env.AUDIT_OUT ?? path.resolve('e2e/results/audit-shots');
const ONLY = (process.env.AUDIT_ONLY ?? '').split(',').filter(Boolean);
const POST = POST_IDS[0] ?? '';
const READY_MS = 20_000;
const IPAD = { width: 820, height: 1180 };

interface Screen {
  name: string;
  seed: AuditSeedOptions;
  url: string;
  /** Waits for the page, then walks to the state to capture. */
  steps: (page: Page) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Helpers

/** The first candidate that becomes visible within the timeout. */
async function firstVisible(
  candidates: Locator[],
  timeout = READY_MS,
  what = 'element',
): Promise<Locator> {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    for (const candidate of candidates) {
      const count = await candidate.count().catch(() => 0);
      for (let i = 0; i < count; i += 1) {
        const one = candidate.nth(i);
        if (await one.isVisible().catch(() => false)) return one;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`not reached: ${what}`);
}

async function waitFor(page: Page, candidates: Locator[], what: string): Promise<void> {
  await firstVisible(candidates, READY_MS, what);
  await page.waitForTimeout(400);
}

async function tap(candidates: Locator[], what: string): Promise<void> {
  const target = await firstVisible(candidates, READY_MS, what);
  await target.click();
}

const isLaptop = (page: Page): boolean => (page.viewportSize()?.width ?? 0) >= 768;

async function postDetailReady(page: Page): Promise<void> {
  await waitFor(page, [page.getByRole('heading', { name: 'Monday carousel', level: 1 })], 'post');
}

async function chatListReady(page: Page): Promise<void> {
  await waitFor(page, [page.getByText(PEER_NAME, { exact: true })], 'chat list');
}

async function openChat(page: Page, name: string): Promise<void> {
  await chatListReady(page);
  await tap([page.getByText(name, { exact: true })], `${name} row`);
  await waitFor(page, [page.locator('[data-msg-id]')], `${name} thread`);
}

async function openDm(page: Page): Promise<void> {
  await openChat(page, PEER_NAME);
  await waitFor(page, [page.locator('[data-bubble]', { hasText: 'Ready for your look' })], 'DM');
}

const pipelineReady = async (page: Page): Promise<void> =>
  waitFor(page, [page.getByRole('button', { name: 'Open post Monday carousel' })], 'pipeline');

// ---------------------------------------------------------------------------
// Screens

const creator: AuditSeedOptions = { role: 'creator' };
const approver: AuditSeedOptions = { role: 'approver' };

const SCREENS: Screen[] = [
  { name: 'chat-list', seed: creator, url: '/chat', steps: chatListReady },
  { name: 'chat-thread', seed: creator, url: '/chat', steps: openDm },
  {
    name: 'chat-thread-group',
    seed: creator,
    url: '/chat',
    steps: async (page) => openChat(page, GROUP_NAME),
  },
  {
    // A search with no hits: the zero state and the list avatars it replaces.
    name: 'chat-search-empty',
    seed: creator,
    url: '/chat',
    steps: async (page) => {
      await chatListReady(page);
      await page.getByRole('searchbox', { name: 'Search chats' }).fill('zqxvw');
      await waitFor(page, [page.getByText(/Try another word/).first()], 'search zero state');
    },
  },
  {
    name: 'chat-info-group',
    seed: creator,
    url: '/chat',
    steps: async (page) => {
      await openChat(page, GROUP_NAME);
      await tap(
        [
          page.getByRole('button', { name: `Group info for ${GROUP_NAME}` }),
          page.locator('[data-group-info-open]'),
        ],
        'group info trigger',
      );
      await waitFor(
        page,
        [page.getByRole('dialog', { name: 'Group info' }), page.getByText('Group info')],
        'group info',
      );
    },
  },
  {
    name: 'members',
    seed: creator,
    url: '/settings?panel=members',
    steps: async (page) =>
      waitFor(page, [page.getByText(PEER_NAME, { exact: true }).first()], 'members'),
  },
  { name: 'pipeline', seed: creator, url: '/pipeline', steps: pipelineReady },
  {
    name: 'notifications',
    seed: creator,
    url: '/activity',
    steps: async (page) =>
      waitFor(page, [page.getByText('Priya Raman mentioned you').first()], 'activity'),
  },
  {
    name: 'post-more-menu',
    seed: creator,
    url: `/posts/${POST}`,
    steps: async (page) => {
      await postDetailReady(page);
      await tap([page.getByRole('button', { name: 'More actions', exact: true })], 'post ⋯');
      await waitFor(page, [page.getByRole('menuitem', { name: /Copy link/ })], 'post ⋯ menu');
    },
  },
  {
    name: 'message-action-menu',
    seed: creator,
    url: '/chat',
    steps: async (page) => {
      await openDm(page);
      const bubble = page.locator('[data-bubble]', { hasText: 'Done, it reads well now.' }).last();
      await bubble.scrollIntoViewIfNeeded();
      if (isLaptop(page)) {
        await bubble.click({ button: 'right' });
      } else {
        const box = await bubble.boundingBox();
        if (box === null) throw new Error('bubble has no box');
        const at = { clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 };
        await bubble.dispatchEvent('pointerdown', { ...at, pointerType: 'touch', isPrimary: true });
        await page.waitForTimeout(1100);
        await bubble.dispatchEvent('pointerup', { ...at, pointerType: 'touch', isPrimary: true });
      }
      await waitFor(page, [page.getByRole('menu'), page.getByRole('dialog')], 'message menu');
    },
  },
  {
    name: 'composer-tray',
    seed: creator,
    url: '/chat',
    steps: async (page) => {
      await openDm(page);
      await tap([page.getByRole('button', { name: 'Add attachment' })], 'Add attachment');
      await waitFor(page, [page.locator('[data-tray]'), page.getByRole('menu')], 'tray');
    },
  },
  { name: 'post-detail-approver', seed: approver, url: `/posts/${POST}`, steps: postDetailReady },
  { name: 'chat-list-ipad', seed: creator, url: '/chat', steps: chatListReady },
  { name: 'pipeline-ipad', seed: creator, url: '/pipeline', steps: pipelineReady },
];

// ---------------------------------------------------------------------------

function capture(screen: Screen, ipad: boolean): void {
  test(screen.name, async ({ page }, info) => {
    const [device, scheme] = info.project.name.split('-');
    if (ipad) test.skip(device !== 'phone', 'iPad shots run in the touch (phone) projects');
    const file = path.join(OUT, `${screen.name}__${ipad ? 'ipad' : device}__${scheme}`);
    mkdirSync(OUT, { recursive: true });
    const network = await installHarnessNetwork(page);
    seedAudit(network, screen.seed);
    let note: string | null = null;
    try {
      await page.goto(screen.url);
      await screen.steps(page);
    } catch (error) {
      note = error instanceof Error ? (error.message.split('\n')[0] ?? 'failed') : String(error);
    }
    await page.screenshot({ path: `${file}.png`, animations: 'disabled' });
    if (note !== null) writeFileSync(`${file}.note.txt`, `${note}\n`);
  });
}

const selected = SCREENS.filter((s) => ONLY.length === 0 || ONLY.includes(s.name));

for (const screen of selected.filter((s) => !s.name.endsWith('-ipad'))) capture(screen, false);

test.describe('ipad', () => {
  test.use({ viewport: IPAD });
  for (const screen of selected.filter((s) => s.name.endsWith('-ipad'))) capture(screen, true);
});
