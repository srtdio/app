import { expect, test, type Locator, type Page } from '@playwright/test';
import { installHarnessNetwork, type HarnessNetwork } from '../fixtures/harness-routes';
import { installDeletedRoutes } from '../fixtures/assets-recently-deleted';
import {
  buildWorld,
  DM_CHANNEL,
  GROUP_NAME,
  ME,
  PEER_NAME,
  PLAN_CONCEPT_ITEM,
  PLAN_ID,
  POST_IDS,
  seedClientPlan,
  seedPlanTab,
  WORKSPACE_ID,
} from '../fixtures/chat-data';
import { AUDIT_BRIEF_ID, seedAudit, type AuditSeedOptions } from '../fixtures/audit-pr-b';
import { ONBOARDING_NOW, ONBOARDING_SCREENS, signOut } from './onboarding-steps';

// Visual lock: every screen of the consistency audit (24 Oct 2026), the chat
// PostSheet and the onboarding screens (onboarding-steps.ts: sign up, sign in,
// the invite link, every pre-app screen, the creator's setup in the shell and
// the approver tour's first steps), one toHaveScreenshot each, in every project of
// e2e/visual/playwright.visual.config.ts (iPhone 13 light and dark, laptop
// light). Run and update through that config (see its header):
//
//   pnpm exec playwright test --config e2e/visual/playwright.visual.config.ts --update-snapshots
//
// Deterministic by construction: the fixture world is built at a fixed instant
// and the page clock is pinned to it, so relative stamps ("2m") and "today"
// never move; zone and locale are fixed in the config; fonts are local
// (@fontsource) and awaited; images are decoded; animations are disabled and
// the caret hidden; the Vite HMR socket is stubbed (no reload mid-capture).
// Selectors are roles, labels, visible text and data- hooks only.

/** The fixed instant: a Wednesday morning (UTC, the fixture workspace's zone). */
const NOW = ONBOARDING_NOW;
const POST = POST_IDS[0] ?? '';
const READY_MS = 20_000;
/** A query no fixture row matches. */
const NO_MATCH = 'zzqx';
/** Long enough for any long-press (LONG_PRESS_MS) on touch. */
const HOLD_MS = 900;

const LIB_IMAGE = '0190e000-0000-7000-8000-0000000000f1';
const LIB_IMAGE_VERSION = '0190e100-0000-7000-8000-0000000000f1';

interface Screen {
  name: string;
  /** The audit world on top of the fixture world; null leaves the fixture world as built. */
  seed: AuditSeedOptions | null;
  /** Extra world edits after the seed. */
  extra?: (network: HarnessNetwork) => void;
  /** World edits that may also add page routes (the onboarding screens). */
  prepare?: (network: HarnessNetwork, page: Page, now: number) => Promise<void> | void;
  /** No session (the guest routes and the invite link's Join card). */
  signedOut?: boolean;
  url: string;
  /** Waits for the page, then walks to the state to capture. */
  steps: (page: Page) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Helpers

/** The first candidate that becomes visible within the timeout. */
async function firstVisible(candidates: Locator[], what: string): Promise<Locator> {
  const until = Date.now() + READY_MS;
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

async function waitFor(candidates: Locator[], what: string): Promise<void> {
  await firstVisible(candidates, what);
}

async function tap(candidates: Locator[], what: string): Promise<void> {
  const target = await firstVisible(candidates, what);
  await target.click();
}

/** A row in whichever ⋯ container is open: an ActionMenu menuitem, or a sheet's button. */
function menuRow(page: Page, name: RegExp): Locator[] {
  return [
    page.getByRole('menuitem', { name }),
    page.getByRole('dialog').getByRole('button', { name }),
    page.getByRole('menu').getByRole('button', { name }),
  ];
}

/** Any open sheet, dialog, menu or popover. */
function anyOverlay(page: Page): Locator[] {
  return [
    page.getByRole('menu'),
    page.getByRole('alertdialog'),
    page.getByRole('dialog'),
    page.locator('[role="menuitem"]'),
  ];
}

const isLaptop = (page: Page): boolean => (page.viewportSize()?.width ?? 0) >= 768;

/** Long-press on touch, right-click with a mouse: both open the same menu. */
async function openMenuGesture(page: Page, target: Locator): Promise<void> {
  await target.scrollIntoViewIfNeeded();
  if (isLaptop(page)) {
    await target.click({ button: 'right' });
    return;
  }
  const box = await target.boundingBox();
  if (box === null) throw new Error('long-press target has no box');
  const at = { clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 };
  await target.dispatchEvent('pointerdown', { ...at, pointerType: 'touch', isPrimary: true });
  await page.waitForTimeout(HOLD_MS);
  await target.dispatchEvent('pointerup', { ...at, pointerType: 'touch', isPrimary: true });
}

/** Types a query no row matches into a search field and waits for NoResults. */
async function searchNoMatch(page: Page, field: Locator[], what: string): Promise<void> {
  const input = await firstVisible(field, `${what} search field`);
  await input.fill(NO_MATCH);
  await waitFor([page.getByText(`"${NO_MATCH}"`, { exact: false })], `${what} no results`);
}

async function postDetailReady(page: Page): Promise<void> {
  await waitFor([page.getByRole('heading', { name: 'Monday carousel', level: 1 })], 'post');
}

async function openPostMenu(page: Page): Promise<void> {
  await postDetailReady(page);
  await tap(
    [
      page.getByRole('button', { name: 'More actions', exact: true }),
      page.getByRole('button', { name: 'Post actions', exact: true }),
    ],
    'post ⋯ trigger',
  );
  await waitFor(menuRow(page, /Copy link/), 'post ⋯ menu');
}

async function briefReady(page: Page): Promise<void> {
  await waitFor([page.getByRole('heading', { name: 'Autumn range launch', level: 1 })], 'brief');
}

async function chatListReady(page: Page): Promise<void> {
  await waitFor([page.getByText(PEER_NAME, { exact: true })], 'chat list');
}

async function openChat(page: Page, name: string): Promise<void> {
  await chatListReady(page);
  await tap([page.getByText(name, { exact: true })], `${name} row`);
  await waitFor([page.locator('[data-msg-id]')], `${name} thread`);
}

async function openDm(page: Page): Promise<void> {
  await openChat(page, PEER_NAME);
  await waitFor([page.locator('[data-bubble]', { hasText: 'Ready for your look' })], 'DM');
}

async function openChatPostSheet(page: Page): Promise<void> {
  await openDm(page);
  const card = page.getByRole('button', { name: 'Open post Monday carousel' }).last();
  await card.scrollIntoViewIfNeeded();
  await card.click();
  await waitFor([page.locator('[data-post-sheet]'), page.getByRole('dialog')], 'PostSheet');
}

const pipelineReady = async (page: Page): Promise<void> =>
  waitFor([page.getByRole('button', { name: 'Open post Monday carousel' })], 'pipeline');

const assetsReady = async (page: Page): Promise<void> =>
  waitFor([page.getByText('Hero banner.png')], 'assets');

const briefsReady = async (page: Page): Promise<void> =>
  waitFor([page.getByText('Autumn range launch')], 'briefs');

async function openPaletteFrom(page: Page): Promise<void> {
  await chatListReady(page);
  await tap([page.getByRole('button', { name: /^Search( ⌘K)?$/ })], 'Search');
  await waitFor([page.getByRole('dialog', { name: 'Command palette' })], 'command palette');
}

/** A client plan (one concept with a library photo, one post) carded into the DM by ME. */
function seedChatPlan(network: HarnessNetwork): void {
  (network.world.tables.assets ??= []).push({
    id: LIB_IMAGE,
    workspace_id: WORKSPACE_ID,
    filename: 'reel-moodboard.png',
    display_name: null,
    uploaded_at: new Date(NOW - 3 * 86_400_000).toISOString(),
    current_version_id: LIB_IMAGE_VERSION,
    folder_id: null,
    origin: 'library',
    uploaded_by: ME,
    deleted_at: null,
    current_version: {
      id: LIB_IMAGE_VERSION,
      kind: 'image',
      mime_type: 'image/png',
      size_bytes: 4321,
      width: 64,
      height: 48,
      duration_ms: null,
    },
  });
  // 30s after the audit's post card, so the plan card is the thread's newest.
  seedClientPlan(network.world, {
    channelId: DM_CHANNEL,
    sender: ME,
    fileVersionId: LIB_IMAGE_VERSION,
    now: NOW + 30_000,
  });
}

async function openChatPlanCard(page: Page): Promise<Locator> {
  await openChat(page, PEER_NAME);
  const card = page.locator(`[data-plan-card="${PLAN_ID}"]`).last();
  await card.scrollIntoViewIfNeeded();
  await waitFor([card], 'plan card');
  return card;
}

async function openChatPlan(page: Page): Promise<void> {
  const card = await openChatPlanCard(page);
  await card.locator('[data-plan-open]').click();
  await waitFor([page.locator('[data-plan-page="plan"]')], 'plan screen');
}

// ---------------------------------------------------------------------------
// Screens

const creator: AuditSeedOptions = { role: 'creator' };
const approver: AuditSeedOptions = { role: 'approver' };

const SCREENS: Screen[] = [
  {
    name: 'approve-confirm-approver',
    seed: approver,
    url: `/posts/${POST}`,
    steps: async (page) => {
      await postDetailReady(page);
      await tap([page.getByRole('button', { name: 'Approve', exact: true })], 'Approve');
      await waitFor(
        [page.getByRole('dialog', { name: /Approve this post/ }), page.getByRole('alertdialog')],
        'approve confirm',
      );
    },
  },
  {
    name: 'asset-more-menu',
    seed: creator,
    url: '/assets',
    steps: async (page) => {
      await assetsReady(page);
      await page
        .getByRole('button', { name: 'View Hero banner.png' })
        .hover()
        .catch(() => undefined);
      await tap(
        [page.getByRole('button', { name: 'More actions for Hero banner.png', exact: true })],
        'asset ⋯ trigger',
      );
      await waitFor(anyOverlay(page), 'asset ⋯ menu');
    },
  },
  { name: 'assets', seed: creator, url: '/assets', steps: assetsReady },
  { name: 'assets-approver', seed: approver, url: '/assets', steps: assetsReady },
  {
    name: 'assets-empty',
    seed: { ...creator, noAssets: true },
    url: '/assets',
    steps: async (page) => {
      await waitFor([page.getByPlaceholder('Search files')], 'assets');
      await waitFor([page.getByText('Files show up here.', { exact: false })], 'assets zero');
    },
  },
  {
    // Assets has no Files tab: the approver on the Media tab (?type=media).
    name: 'assets-files-approver',
    seed: approver,
    url: '/assets?type=media',
    steps: async (page) => {
      await assetsReady(page);
      await waitFor(
        [page.getByRole('tab', { name: /^Media(\s\d+)?$/, selected: true })],
        'Media tab',
      );
    },
  },
  {
    name: 'assets-search-empty',
    seed: creator,
    url: '/assets',
    steps: async (page) => {
      await assetsReady(page);
      await searchNoMatch(page, [page.getByPlaceholder('Search files')], 'assets');
    },
  },
  { name: 'brief-detail', seed: creator, url: `/briefs/${AUDIT_BRIEF_ID}`, steps: briefReady },
  {
    name: 'brief-more-menu',
    seed: creator,
    url: `/briefs/${AUDIT_BRIEF_ID}`,
    steps: async (page) => {
      await briefReady(page);
      await tap(
        [
          page.getByRole('button', { name: 'More actions', exact: true }),
          page.getByRole('button', { name: 'Brief actions', exact: true }),
        ],
        'brief ⋯ trigger',
      );
      await waitFor(anyOverlay(page), 'brief ⋯ menu');
    },
  },
  { name: 'briefs-approver', seed: approver, url: '/briefs', steps: briefsReady },
  {
    name: 'briefs-empty',
    seed: { ...approver, noBriefs: true },
    url: '/briefs',
    steps: async (page) => {
      await waitFor([page.getByPlaceholder('Search briefs')], 'briefs');
      await waitFor([page.getByText('Briefs show up here.', { exact: false })], 'briefs zero');
    },
  },
  {
    name: 'briefs-search-empty',
    seed: approver,
    url: '/briefs',
    steps: async (page) => {
      await briefsReady(page);
      await searchNoMatch(page, [page.getByPlaceholder('Search briefs')], 'briefs');
    },
  },
  {
    name: 'chat-actions-menu',
    seed: creator,
    url: '/chat',
    steps: async (page) => {
      await chatListReady(page);
      await page
        .getByRole('button', { name: /^Open Priya Raman/ })
        .first()
        .hover()
        .catch(() => undefined);
      await tap(
        [page.getByRole('button', { name: `Actions for ${PEER_NAME}`, exact: true })],
        'chat row ⋯ trigger',
      );
      await waitFor(anyOverlay(page), 'chat row menu');
    },
  },
  { name: 'chat-list', seed: creator, url: '/chat', steps: chatListReady },
  {
    name: 'chat-plan-card',
    seed: creator,
    extra: seedChatPlan,
    url: '/chat',
    steps: async (page) => {
      await openChatPlanCard(page);
    },
  },
  {
    name: 'chat-search-empty',
    seed: creator,
    url: '/chat',
    steps: async (page) => {
      await chatListReady(page);
      await searchNoMatch(page, [page.getByRole('searchbox', { name: 'Search chats' })], 'chat');
    },
  },
  { name: 'chat-thread', seed: creator, url: '/chat', steps: openDm },
  {
    name: 'chat-thread-group',
    seed: creator,
    url: '/chat',
    steps: async (page) => openChat(page, GROUP_NAME),
  },
  { name: 'command-palette', seed: creator, url: '/chat', steps: openPaletteFrom },
  {
    name: 'command-palette-search-empty',
    seed: creator,
    url: '/chat',
    steps: async (page) => {
      await openPaletteFrom(page);
      await searchNoMatch(page, [page.getByPlaceholder('Search anything')], 'command palette');
    },
  },
  {
    // An irreversible delete: one file's Delete forever in Recently deleted.
    name: 'confirm-dialog-delete',
    seed: creator,
    url: '/deleted',
    steps: async (page) => {
      await waitFor([page.getByText('Old logo.png')], 'recently deleted');
      await tap(
        [
          page.getByRole('button', { name: /^Delete (now|forever)$/ }),
          page.getByRole('button', { name: /^More actions/ }),
        ],
        'Delete forever',
      );
      const row = page.getByRole('menuitem', { name: /^Delete (now|forever)/ });
      if (await row.isVisible().catch(() => false)) await row.click();
      await waitFor([page.getByRole('alertdialog'), page.getByRole('dialog')], 'confirm');
    },
  },
  {
    // Closing a create sheet with a typed title asks before it drops the work.
    name: 'confirm-dialog-discard',
    seed: creator,
    url: '/pipeline',
    steps: async (page) => {
      await pipelineReady(page);
      await tap([page.getByRole('button', { name: 'New post', exact: true })], 'New post');
      const sheet = await firstVisible([page.getByRole('dialog')], 'create post sheet');
      await sheet.getByLabel('Title', { exact: false }).first().fill('Spring sale teaser');
      await sheet.getByRole('button', { name: 'Close', exact: true }).first().click();
      await waitFor([page.getByText('Discard changes?')], 'discard confirm');
    },
  },
  {
    name: 'create-brief-sheet-approver',
    seed: approver,
    url: '/briefs',
    steps: async (page) => {
      await briefsReady(page);
      await tap([page.getByRole('button', { name: 'New brief', exact: true })], 'New brief');
      await waitFor([page.getByRole('dialog')], 'create brief sheet');
    },
  },
  {
    name: 'create-post-sheet',
    seed: creator,
    url: '/pipeline',
    steps: async (page) => {
      await pipelineReady(page);
      await tap([page.getByRole('button', { name: 'New post', exact: true })], 'New post');
      await waitFor([page.getByRole('dialog')], 'create post sheet');
    },
  },
  {
    name: 'help',
    seed: creator,
    url: '/help',
    steps: async (page) => waitFor([page.getByText('Help articles', { exact: true })], 'help'),
  },
  {
    name: 'message-action-menu',
    seed: creator,
    url: '/chat',
    steps: async (page) => {
      await openDm(page);
      const bubble = page.locator('[data-bubble]', { hasText: 'Done, it reads well now.' }).last();
      const menu = page.getByRole('menu').or(page.getByRole('dialog'));
      // A synthetic hold can be cut short by a scroll settling under it: try again.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await openMenuGesture(page, bubble);
        if (
          await menu
            .first()
            .isVisible()
            .catch(() => false)
        ) {
          break;
        }
      }
      await waitFor([menu], 'message menu');
    },
  },
  {
    name: 'new-chat-sheet',
    seed: creator,
    url: '/chat',
    steps: async (page) => {
      await chatListReady(page);
      await tap([page.getByRole('button', { name: 'New chat', exact: true })], 'New chat');
      await waitFor([page.getByRole('dialog')], 'new chat sheet');
    },
  },
  {
    name: 'notifications',
    seed: creator,
    url: '/activity',
    steps: async (page) => waitFor([page.getByText('Priya Raman mentioned you')], 'activity'),
  },
  {
    name: 'on-behalf-confirm',
    seed: creator,
    url: `/posts/${POST}`,
    steps: async (page) => {
      await postDetailReady(page);
      const direct = page.getByRole('button', { name: /^Approve on their behalf/ });
      if (
        !(await direct
          .first()
          .isVisible()
          .catch(() => false))
      ) {
        await openPostMenu(page);
      }
      await tap([...menuRow(page, /^Approve on their behalf/), direct], 'Approve on their behalf');
      await waitFor(
        [
          page.getByRole('dialog', { name: /on their behalf/ }),
          page.locator('[data-on-behalf-sheet]'),
        ],
        'on-behalf confirm',
      );
    },
  },
  { name: 'pipeline', seed: creator, url: '/pipeline', steps: pipelineReady },
  { name: 'pipeline-approver', seed: approver, url: '/pipeline', steps: pipelineReady },
  {
    name: 'pipeline-search-empty',
    seed: creator,
    url: '/pipeline',
    steps: async (page) => {
      await pipelineReady(page);
      await searchNoMatch(page, [page.getByPlaceholder('Search posts')], 'pipeline');
    },
  },
  {
    name: 'plan-item',
    seed: creator,
    extra: seedChatPlan,
    url: '/chat',
    steps: async (page) => {
      await openChatPlan(page);
      await page
        .locator('[data-plan-page="plan"]')
        .locator(`[data-plan-row="${PLAN_CONCEPT_ITEM}"]`)
        .click();
      await waitFor([page.locator('[data-plan-page="item"]')], 'plan item');
    },
  },
  {
    name: 'plan-screen',
    seed: creator,
    extra: seedChatPlan,
    url: '/chat',
    steps: openChatPlan,
  },
  {
    name: 'plan-tab',
    seed: creator,
    extra: (network) => seedPlanTab(network.world, { sender: ME, now: NOW }),
    url: '/plan',
    steps: async (page) =>
      waitFor([page.locator('[data-plan-tab-list]'), page.getByText('Autumn launch')], 'plan'),
  },
  { name: 'post-detail', seed: creator, url: `/posts/${POST}`, steps: postDetailReady },
  { name: 'post-detail-approver', seed: approver, url: `/posts/${POST}`, steps: postDetailReady },
  { name: 'post-more-menu', seed: creator, url: `/posts/${POST}`, steps: openPostMenu },
  {
    name: 'recently-deleted',
    seed: creator,
    url: '/deleted',
    steps: async (page) => waitFor([page.getByText('Old logo.png')], 'recently deleted'),
  },
  {
    name: 'settings-workspace',
    seed: creator,
    url: '/settings?panel=workspace',
    steps: async (page) =>
      waitFor([page.getByText('Brand name', { exact: true })], 'settings workspace'),
  },
  { name: 'chat-post-sheet', seed: creator, url: '/chat', steps: openChatPostSheet },
  { name: 'chat-post-sheet-approver', seed: approver, url: '/chat', steps: openChatPostSheet },
  {
    // The sheet's lower half: Comment on this post and Talk about this post.
    name: 'chat-post-sheet-scrolled',
    seed: creator,
    url: '/chat',
    steps: async (page) => {
      await openChatPostSheet(page);
      const talk = page.getByText('Talk about this post').last();
      const comment = page.getByText('Comment on this post').last();
      const target = (await talk.count()) > 0 ? talk : comment;
      await target.scrollIntoViewIfNeeded();
    },
  },
  {
    name: 'recently-deleted-empty',
    seed: { ...creator, noAssets: true },
    url: '/deleted',
    steps: async (page) =>
      waitFor(
        [page.getByText('Deleted posts and files show up here.')],
        'recently deleted (empty)',
      ),
  },
  {
    name: 'chat-info-group',
    seed: creator,
    url: '/chat',
    steps: async (page) => {
      await openChat(page, GROUP_NAME);
      await tap(
        [page.getByRole('button', { name: `Group info for ${GROUP_NAME}`, exact: true })],
        'group info trigger',
      );
      await waitFor(
        [page.getByRole('button', { name: 'Close group info', exact: true })],
        'group info',
      );
    },
  },
  {
    name: 'members',
    seed: creator,
    url: '/settings?panel=members',
    steps: async (page) =>
      waitFor([page.getByText('Creators', { exact: true })], 'settings members'),
  },
  {
    name: 'composer-tray',
    seed: creator,
    url: '/chat',
    steps: async (page) => {
      await openDm(page);
      await tap([page.getByRole('button', { name: 'Add attachment', exact: true })], 'attach');
      await waitFor([page.locator('[data-tray]')], 'composer tray');
    },
  },
];

// The onboarding screens (onboarding-steps.ts), on the fixture world as built.
SCREENS.push(...ONBOARDING_SCREENS.map((screen): Screen => ({ ...screen, seed: null })));

// ---------------------------------------------------------------------------

/**
 * No hover, no focus ring, no transition mid-flight. The pointer parks at the
 * page corner (a step's last click leaves it on whatever renders there next:
 * plan-item's "Remove from plan" took its hover fill on some runs), the active
 * element blurs, then every finite animation and transition must end. Infinite
 * ones (the guide hand's press loop) never end; animations: 'disabled' holds
 * those still in the shot.
 */
async function stabilise(page: Page): Promise<void> {
  await page.mouse.move(0, 0);
  await page.evaluate(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
  });
  await page.waitForFunction(
    () =>
      document
        .getAnimations()
        .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
        .every((a) => !a.pending && a.playState !== 'running'),
    undefined,
    { timeout: 5_000 },
  );
}

/** Fonts loaded, images decoded, two frames painted. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await page.evaluate(() =>
    Promise.all(
      Array.from(document.images)
        .filter((img) => !img.complete)
        .map(
          (img) =>
            new Promise<void>((resolve) => {
              img.addEventListener('load', () => resolve(), { once: true });
              img.addEventListener('error', () => resolve(), { once: true });
            }),
        ),
    ).then(() => undefined),
  );
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

for (const screen of SCREENS) {
  test(screen.name, async ({ page }) => {
    // The page's clock is pinned (Date only; timers keep running).
    await page.clock.setFixedTime(NOW);
    // Vite's HMR socket answers nothing, so a file saved mid-run never
    // reloads or patches the page under a screenshot.
    await page.routeWebSocket(
      (url) => url.protocol === 'ws:' && url.hostname === 'localhost',
      () => undefined,
    );
    const network = await installHarnessNetwork(page);
    // Rebuild the world at the fixed instant (the handlers read world.tables per request).
    Object.assign(network.world, buildWorld(NOW));
    if (screen.signedOut === true) await signOut(page);
    if (screen.seed !== null) seedAudit(network, screen.seed, NOW);
    screen.extra?.(network);
    await screen.prepare?.(network, page, NOW);
    await installDeletedRoutes(page, network);
    await page.goto(screen.url);
    await screen.steps(page);
    await stabilise(page);
    await settle(page);
    await expect(page).toHaveScreenshot(`${screen.name}.png`, {
      maxDiffPixelRatio: 0.002,
      animations: 'disabled',
      caret: 'hide',
    });
    expect(network.blocked, 'blocked non-fixture requests').toEqual([]);
  });
}
