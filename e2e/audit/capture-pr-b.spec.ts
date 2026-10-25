import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test, type Locator, type Page } from '@playwright/test';
import { installHarnessNetwork, type HarnessNetwork } from '../fixtures/harness-routes';
import { installDeletedRoutes } from '../fixtures/assets-recently-deleted';
import { ME, PEER_NAME, POST_IDS, seedPlanTab } from '../fixtures/chat-data';
import { AUDIT_BRIEF_ID, seedAudit, type AuditSeedOptions } from '../fixtures/audit-pr-b';

// PR B before/after captures (spec section 8). Not a test: every screen is
// reached with role/label/text selectors that hold on origin/main and on the
// branch (old trigger labels as fallbacks), then the viewport is saved as
// <screen>__<phone|laptop>__<light|dark>.png in AUDIT_OUT. A step that cannot
// be reached still saves the closest state, plus <same name>.note.txt saying
// why. Run through e2e/audit/playwright.audit.config.ts (see its header).
// AUDIT_ONLY=a,b limits the run to those screens.

const OUT = process.env.AUDIT_OUT ?? path.resolve('e2e/results/audit-shots');
const ONLY = (process.env.AUDIT_ONLY ?? '').split(',').filter(Boolean);
const POST = POST_IDS[0] ?? '';
const READY_MS = 20_000;

interface Screen {
  name: string;
  seed: AuditSeedOptions;
  /** Extra world edits after the seed. */
  extra?: (network: HarnessNetwork) => void;
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

/** A row in whichever ⋯ container is open: ActionMenu menuitem, or the old sheet's button. */
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
    page.getByRole('dialog'),
    page.getByRole('alertdialog'),
    page.getByRole('menu'),
    page.locator('[role="menuitem"]'),
  ];
}

const isLaptop = (page: Page): boolean => (page.viewportSize()?.width ?? 0) >= 768;

async function postDetailReady(page: Page): Promise<void> {
  await waitFor(page, [page.getByRole('heading', { name: 'Monday carousel', level: 1 })], 'post');
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
  await waitFor(page, menuRow(page, /Copy link/), 'post ⋯ menu');
}

async function openDm(page: Page): Promise<void> {
  await tap([page.getByText(PEER_NAME, { exact: true })], 'DM row');
  await waitFor(page, [page.locator('[data-bubble]', { hasText: 'Ready for your look' })], 'DM');
}

async function openChatPostSheet(page: Page): Promise<void> {
  await openDm(page);
  const card = page.getByRole('button', { name: 'Open post Monday carousel' }).last();
  await card.scrollIntoViewIfNeeded();
  await card.click();
  await waitFor(page, [page.locator('[data-post-sheet]'), page.getByRole('dialog')], 'PostSheet');
}

// ---------------------------------------------------------------------------
// Screens

const creator: AuditSeedOptions = { role: 'creator' };
const approver: AuditSeedOptions = { role: 'approver' };

const pipelineReady = async (page: Page): Promise<void> =>
  waitFor(page, [page.getByRole('button', { name: 'Open post Monday carousel' })], 'pipeline');

const SCREENS: Screen[] = [
  { name: 'pipeline', seed: creator, url: '/pipeline', steps: pipelineReady },
  { name: 'pipeline-approver', seed: approver, url: '/pipeline', steps: pipelineReady },
  {
    name: 'plan-tab',
    seed: creator,
    extra: (network) => seedPlanTab(network.world, { sender: ME }),
    url: '/plan',
    steps: async (page) =>
      waitFor(
        page,
        [page.locator('[data-plan-tab-list]'), page.getByText('Autumn launch')],
        'plan',
      ),
  },
  {
    name: 'briefs-approver',
    seed: approver,
    url: '/briefs',
    steps: async (page) => waitFor(page, [page.getByText('Autumn range launch')], 'briefs'),
  },
  {
    // The approver (who can create briefs) sees the zero state's create button on main.
    name: 'briefs-empty',
    seed: { ...approver, noBriefs: true },
    url: '/briefs',
    steps: async (page) => {
      await waitFor(page, [page.getByRole('searchbox', { name: 'Search briefs' })], 'briefs');
      await page.waitForTimeout(2500);
    },
  },
  {
    name: 'assets',
    seed: creator,
    url: '/assets',
    steps: async (page) => waitFor(page, [page.getByText('Hero banner.png').first()], 'assets'),
  },
  {
    name: 'assets-empty',
    seed: { ...creator, noAssets: true },
    url: '/assets',
    steps: async (page) => {
      await waitFor(page, [page.getByRole('searchbox', { name: 'Search files' })], 'assets');
      await page.waitForTimeout(2500);
    },
  },
  {
    name: 'chat-list',
    seed: creator,
    url: '/chat',
    steps: async (page) => waitFor(page, [page.getByText(PEER_NAME, { exact: true })], 'chat'),
  },
  { name: 'post-detail', seed: creator, url: `/posts/${POST}`, steps: postDetailReady },
  { name: 'post-detail-approver', seed: approver, url: `/posts/${POST}`, steps: postDetailReady },
  { name: 'chat-post-sheet', seed: creator, url: '/chat', steps: openChatPostSheet },
  { name: 'chat-post-sheet-approver', seed: approver, url: '/chat', steps: openChatPostSheet },
  {
    name: 'brief-detail',
    seed: creator,
    url: `/briefs/${AUDIT_BRIEF_ID}`,
    steps: async (page) =>
      waitFor(
        page,
        [page.getByRole('heading', { name: 'Autumn range launch', level: 1 })],
        'brief',
      ),
  },
  { name: 'post-more-menu', seed: creator, url: `/posts/${POST}`, steps: openPostMenu },
  {
    name: 'brief-more-menu',
    seed: creator,
    url: `/briefs/${AUDIT_BRIEF_ID}`,
    steps: async (page) => {
      await waitFor(
        page,
        [page.getByRole('heading', { name: 'Autumn range launch', level: 1 })],
        'brief',
      );
      await tap(
        [
          page.getByRole('button', { name: 'More actions', exact: true }),
          page.getByRole('button', { name: 'Brief actions', exact: true }),
        ],
        'brief ⋯ trigger',
      );
      await waitFor(page, anyOverlay(page), 'brief ⋯ menu');
    },
  },
  {
    name: 'asset-more-menu',
    seed: creator,
    url: '/assets',
    steps: async (page) => {
      await waitFor(page, [page.getByText('Hero banner.png').first()], 'assets');
      const card = page.getByRole('button', { name: 'View Hero banner.png' });
      await card.hover().catch(() => undefined);
      await tap(
        [
          page.getByRole('button', { name: /^More actions for Hero banner\.png$/ }),
          page.getByRole('button', { name: /^(More )?actions for Hero banner\.png$/i }),
          page.getByRole('button', { name: 'More actions', exact: true }),
        ],
        'asset ⋯ trigger',
      );
      await waitFor(page, anyOverlay(page), 'asset ⋯ menu');
    },
  },
  {
    name: 'chat-actions-menu',
    seed: creator,
    url: '/chat',
    steps: async (page) => {
      const row = page.getByRole('button', { name: /^Open Priya Raman/ });
      await waitFor(page, [row], 'chat');
      await row.hover().catch(() => undefined);
      await tap(
        [
          page.getByRole('button', { name: `Actions for ${PEER_NAME}`, exact: true }),
          page.getByRole('button', { name: `More actions for ${PEER_NAME}`, exact: true }),
          page.getByRole('listitem').filter({ has: row }).getByRole('button', {
            name: 'More actions',
          }),
        ],
        'chat row ⋯ trigger',
      );
      await waitFor(page, anyOverlay(page), 'chat row menu');
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
        await page.waitForTimeout(700);
        await bubble.dispatchEvent('pointerup', { ...at, pointerType: 'touch', isPrimary: true });
      }
      await waitFor(page, [page.getByRole('menu'), page.getByRole('dialog')], 'message menu');
    },
  },
  {
    name: 'create-post-sheet',
    seed: creator,
    url: '/pipeline',
    steps: async (page) => {
      await pipelineReady(page);
      await tap([page.getByRole('button', { name: 'New post', exact: true })], 'New post');
      await waitFor(page, [page.getByRole('dialog')], 'create post sheet');
    },
  },
  {
    name: 'new-chat-sheet',
    seed: creator,
    url: '/chat',
    steps: async (page) => {
      await waitFor(page, [page.getByText(PEER_NAME, { exact: true })], 'chat');
      await tap([page.getByRole('button', { name: 'New chat', exact: true })], 'New chat');
      await waitFor(page, [page.getByRole('dialog')], 'new chat sheet');
    },
  },
  {
    // An irreversible delete: one file's Delete now / Delete forever in Recently deleted.
    name: 'confirm-dialog-delete',
    seed: creator,
    url: '/deleted',
    steps: async (page) => {
      await waitFor(page, [page.getByText('Old logo.png')], 'recently deleted');
      await tap(
        [
          page.getByRole('button', { name: /^Delete (now|forever)$/ }),
          page.getByRole('button', { name: /^More actions/ }),
        ],
        'Delete forever',
      );
      await page.waitForTimeout(300);
      // After: the row may sit behind a ⋯ menu first.
      const row = page.getByRole('menuitem', { name: /^Delete (now|forever)/ });
      if (await row.isVisible().catch(() => false)) await row.click();
      await waitFor(page, [page.getByRole('alertdialog'), page.getByRole('dialog')], 'confirm');
    },
  },
  {
    name: 'undo-strip-after-delete',
    seed: creator,
    url: `/posts/${POST}`,
    steps: async (page) => {
      await openPostMenu(page);
      await tap(menuRow(page, /^Delete( post)?/), 'Delete post');
      await firstVisible(
        [page.locator('[data-undo-strip]'), page.getByText('Post deleted')],
        6_000,
        'undo strip',
      );
      await page.waitForTimeout(350);
    },
  },
  {
    name: 'approve-confirm-approver',
    seed: approver,
    url: `/posts/${POST}`,
    steps: async (page) => {
      await postDetailReady(page);
      await tap([page.getByRole('button', { name: 'Approve', exact: true })], 'Approve');
      await waitFor(
        page,
        [page.getByRole('dialog', { name: /Approve this post/ }), page.getByRole('dialog')],
        'approve confirm',
      );
    },
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
        page,
        [
          page.getByRole('dialog', { name: /on their behalf/ }),
          page.locator('[data-on-behalf-sheet]'),
        ],
        'on-behalf confirm',
      );
    },
  },
  {
    name: 'recently-deleted',
    seed: creator,
    url: '/deleted',
    steps: async (page) => waitFor(page, [page.getByText('Old logo.png')], 'recently deleted'),
  },
  {
    name: 'toast-copy-link',
    seed: creator,
    url: `/posts/${POST}`,
    steps: async (page) => {
      await openPostMenu(page);
      await tap(menuRow(page, /^Copy link/), 'Copy link');
      await firstVisible(
        [page.getByText('Link copied'), page.getByText(/copied/i)],
        6_000,
        'Link copied toast',
      );
      await page.waitForTimeout(250);
    },
  },
];

// ---------------------------------------------------------------------------

for (const screen of SCREENS) {
  if (ONLY.length > 0 && !ONLY.includes(screen.name)) continue;
  test(screen.name, async ({ page }, info) => {
    const [device, scheme] = info.project.name.split('-');
    const file = path.join(OUT, `${screen.name}__${device}__${scheme}`);
    mkdirSync(OUT, { recursive: true });
    const network = await installHarnessNetwork(page);
    seedAudit(network, screen.seed);
    screen.extra?.(network);
    await installDeletedRoutes(page, network);
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
