import { expect, test, type Locator, type Page } from '@playwright/test';
import { installHarnessNetwork, type HarnessNetwork } from '../fixtures/harness-routes';
import { installDeletedRoutes } from '../fixtures/assets-recently-deleted';
import type { Row } from '../fixtures/postgrest';
import {
  buildWorld,
  COLLEAGUE_A,
  COLLEAGUE_B,
  DM_CHANNEL,
  GROUP_CHANNEL,
  GROUP_NAME,
  ME,
  PEER,
  PEER_NAME,
  PLAN_CONCEPT_ITEM,
  PLAN_ID,
  PLAN_POST_ITEM,
  POST_IDS,
  seedClientPlan,
  seedPlanTab,
  TAB_OK_ITEM_TITLE,
  TAB_SHARED_PLAN_ID,
  WORKSPACE_ID,
} from '../fixtures/chat-data';
import { AUDIT_BRIEF_ID, seedAudit, type AuditSeedOptions } from '../fixtures/audit-pr-b';
import {
  ALBUM_PHOTOS,
  REMOVED_BODY,
  seedRemovableFiles,
  seedRemovedLine,
} from '../fixtures/remove-files';
import { installLinkPreviewStub } from '../fixtures/link-previews';
import { seedTasks, TASK_CHANNEL } from '../fixtures/tasks-data';
import { installMediaSearch, type MediaKind } from '../fixtures/search-data';
import {
  ONBOARDING_NOW,
  ONBOARDING_SCREENS,
  routeVerify,
  signOut,
  toSignInCode,
} from './onboarding-steps';
import { CHECK_EMAIL_COPY } from '../../src/lib/induction-copy';

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
  /** The harness user is the platform operator (the Cockpit dot shows), at this answer level. */
  operator?: 'green' | 'red';
  /** Capture in one layout only (the Cockpit's side panel vs sheet). */
  only?: 'laptop' | 'phone';
  /** Force the dark scheme (the laptop project is light; these add its dark shots). */
  dark?: boolean;
  /** Light projects only (the homepage is light-only): skipped in every *-dark project. */
  lightOnly?: true;
  /**
   * The steps own the pointer and focus: the shot keeps the hover, the open
   * menu or the focused field they leave (stabilise() then neither parks the
   * pointer nor blurs). Steps that set this park the pointer themselves when
   * the state is not a hover.
   */
  hold?: true;
  /** Parts painted over in the shot (moving media: the homepage's clips and photos). */
  mask?: (page: Page) => Locator[];
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

/**
 * Never-resolving mode: the named reads are held for the whole test (the hold
 * is never released), so a screen with nothing on the device or in the session
 * shows its loading boxes (sweepBoxes, docs/motion.md). The sweep is an
 * infinite animation: stabilise() skips it and the capture freezes it.
 */
function neverAnswers(
  network: HarnessNetwork,
  reads: { tables?: string[]; rpcs?: string[]; history?: boolean },
): void {
  for (const table of reads.tables ?? []) network.holdTable(table);
  for (const rpc of reads.rpcs ?? []) network.holdRpc(rpc);
  if (reads.history === true) network.holdHistory();
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

/** The chat composer with formatted text typed and a word selected: live
 *  styling (faded markers) and the format strip open. */
async function openFormatStrip(page: Page): Promise<void> {
  await openDm(page);
  const box = page.locator('form textarea').first();
  await box.click();
  await box.fill('*bold* _italic_ ~strike~ +underline+ ```mono``` today');
  await box.evaluate((el: HTMLTextAreaElement) => {
    el.focus();
    el.setSelectionRange(el.value.length - 5, el.value.length);
    el.dispatchEvent(new Event('select', { bubbles: true }));
    document.dispatchEvent(new Event('selectionchange'));
  });
  await waitFor([page.locator('[data-format-strip]')], 'format strip');
}

/**
 * The group chat's tasks with due days around NOW (Wednesday 21 Oct, UTC,
 * week from Monday): #8 today, #9 later this week, #10 overdue, #11 done
 * last week, plus #12 with no date and #13 after this week.
 */
function seedDatedTasks(network: HarnessNetwork): void {
  seedTasks(network.world, NOW);
  const rows = network.world.tables.chat_tasks ?? [];
  const at = (n: number): Row | undefined =>
    rows.find((t) => t.channel_id === TASK_CHANNEL && Number(t.number) === n);
  const dated: Array<[number, string | null, string | null]> = [
    [8, '2026-10-21', null],
    [9, '2026-10-23', null],
    [10, '2026-10-19', null],
    [11, '2026-10-16', '2026-10-15T12:00:00Z'],
  ];
  for (const [n, dueOn, doneAt] of dated) {
    const row = at(n);
    if (row === undefined) throw new Error(`no task ${n}`);
    row.due_on = dueOn;
    row.done_at = doneAt;
    if (doneAt !== null) row.status = 'done';
  }
  const base = at(11);
  if (base === undefined) throw new Error('no task 11');
  rows.push(
    {
      ...base,
      id: '0190e100-0000-7000-8000-000000000012',
      number: 12,
      title: 'Caption bank',
      status: 'todo',
      due_on: null,
      done_at: null,
    },
    {
      ...base,
      id: '0190e100-0000-7000-8000-000000000013',
      number: 13,
      title: 'Diwali carousel',
      status: 'todo',
      due_on: '2026-11-02',
      done_at: null,
    },
  );
}

/** The group chat's Tasks sheet, open on its opening chip (Today). */
async function openTasks(page: Page): Promise<Locator> {
  await openChat(page, GROUP_NAME);
  await tap([page.getByRole('button', { name: /^Tasks(, new)?$/ })], 'Tasks button');
  const sheet = page.getByRole('dialog', { name: 'Tasks' });
  await waitFor([sheet.locator('[data-task-list]')], 'Tasks sheet');
  return sheet;
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

/** Ten palette recents with cached titles, on this device for ME in the workspace. */
async function seedPaletteRecents(
  _network: HarnessNetwork,
  page: Page,
  now: number,
): Promise<void> {
  const items = Array.from({ length: 10 }, (_, i) => ({
    type: 'post',
    id: `visual-recent-${i + 1}`,
    openedAt: now - i * 60_000,
    title: ['Diwali launch reel', 'Monday carousel', 'Autumn range teaser'][i % 3] + ` ${i + 1}`,
    target: { path: `/posts/visual-recent-${i + 1}` },
  }));
  await page.addInitScript(([key, value]) => window.localStorage.setItem(key, value), [
    `sorted:recent:${ME}:${WORKSPACE_ID}`,
    JSON.stringify(items),
  ] as const);
}

/** Alerts on this device paused for 3 hours from the pinned clock, for ME on this device. */
async function seedAlertsPaused(_network: HarnessNetwork, page: Page, now: number): Promise<void> {
  const prefs = {
    sound: true,
    notifications: true,
    pausedUntilMs: now + 3 * 3_600_000,
    pausedHours: 3,
  };
  await page.addInitScript(([key, value]) => window.localStorage.setItem(key, value), [
    `sorted:alert-prefs:v1:${ME}`,
    JSON.stringify(prefs),
  ] as const);
}

/** One library photo (origin library: the composer's Add from Assets lists it). */
function seedLibraryImage(network: HarnessNetwork): void {
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
}

/** A client plan (one concept with a library photo, one post) carded into the DM by ME. */
function seedChatPlan(network: HarnessNetwork): void {
  seedLibraryImage(network);
  // 30s after the audit's post card, so the plan card is the thread's newest.
  seedClientPlan(network.world, {
    channelId: DM_CHANNEL,
    sender: ME,
    fileVersionId: LIB_IMAGE_VERSION,
    now: NOW + 30_000,
  });
  // The concept files read embeds the version and the asset (one select), so
  // the item screen's tile shows the file's name under it.
  for (const link of network.world.tables.asset_attachments ?? []) {
    if (link.entity_id !== PLAN_CONCEPT_ITEM) continue;
    link.asset_versions = { mime_type: 'image/png', kind: 'image' };
    link.assets = { display_name: null, filename: 'reel-moodboard.png' };
  }
}

/** The chat plan plus a Not OK note on its post item (the item's Plan notes). */
function seedChatPlanNote(network: HarnessNetwork): void {
  seedChatPlan(network);
  (network.world.tables.plan_item_comments ??= []).push({
    id: '0190d300-0000-7000-8000-00000000d3f1',
    workspace_id: WORKSPACE_ID,
    item_id: PLAN_POST_ITEM,
    author_user_id: ME,
    body: 'Swap the cover for the morning shot.',
    visibility: 'everyone',
    created_at: '2026-10-09T10:30:00Z',
    edited_at: null,
    deleted_at: null,
  });
}

/**
 * The chat plan plus a conversation on its concept: two runs from a colleague
 * (one tags ME), ME's reply, and (agency view only) a creators-only note, over
 * two days so a day line shows.
 */
function seedChatPlanThread(network: HarnessNetwork, withTeamNote: boolean): void {
  seedChatPlan(network);
  const at = (msAgo: number): string => new Date(NOW - msAgo).toISOString();
  const comment = (id: string, author: string, body: string, visibility: string, when: string) => ({
    id,
    workspace_id: WORKSPACE_ID,
    item_id: PLAN_CONCEPT_ITEM,
    author_user_id: author,
    body,
    visibility,
    created_at: when,
    edited_at: null,
    deleted_at: null,
  });
  const rows = [
    comment(
      '0190d300-0000-7000-8000-00000000d401',
      COLLEAGUE_A,
      'Moodboard is up.',
      'everyone',
      at(26 * 3_600_000),
    ),
    comment(
      '0190d300-0000-7000-8000-00000000d402',
      COLLEAGUE_A,
      `@[${ME}] can you check the hook?`,
      'everyone',
      at(26 * 3_600_000 - 60_000),
    ),
    comment(
      '0190d300-0000-7000-8000-00000000d403',
      ME,
      'Looks good, keep it under 30 seconds.',
      'everyone',
      at(40 * 60_000),
    ),
  ];
  if (withTeamNote) {
    rows.push(
      comment(
        '0190d300-0000-7000-8000-00000000d404',
        ME,
        'Drone shots land Tuesday.',
        'team',
        at(38 * 60_000),
      ),
    );
  }
  (network.world.tables.plan_item_comments ??= []).push(...rows);
}

/** Open the chat plan's concept item and bring its comments into view. */
async function openPlanItemThread(page: Page): Promise<void> {
  await openChatPlan(page);
  await page
    .locator('[data-plan-page="plan"]')
    .locator(`[data-plan-row="${PLAN_CONCEPT_ITEM}"]`)
    .click();
  const thread = page.locator('[data-plan-page="item"] [data-plan-thread]');
  await waitFor([thread], 'plan item thread');
  await thread.scrollIntoViewIfNeeded();
}

async function openChatPlanCard(page: Page): Promise<Locator> {
  await openChat(page, PEER_NAME);
  const card = page.locator(`[data-plan-card="${PLAN_ID}"]`).last();
  await card.scrollIntoViewIfNeeded();
  await waitFor([card], 'plan card');
  return card;
}

/** The Plan tab seeded at the fixed instant (items on today, Wed 21 Oct 2026). */
const seedTab = (network: HarnessNetwork): void =>
  seedPlanTab(network.world, { sender: ME, now: NOW });

/** The laptop Plan tab switched to Week (the week of today), today's column filled. */
async function planTabWeek(page: Page): Promise<void> {
  await waitFor([page.locator('[data-plan-tab-month]')], 'plan tab month');
  await tap([page.locator('[data-plan-tab-view="week"]')], 'Week');
  await waitFor([page.locator('[data-plan-tab-week]')], 'plan tab week');
  await waitFor([page.locator('[data-plan-tab-today-head] [data-plan-tab-today-pill]')], 'today');
  await waitFor(
    [page.locator('[data-plan-tab-today-cell]').getByText(TAB_OK_ITEM_TITLE)],
    'today items',
  );
}

/** The shared plan "Autumn launch" (/plan/:id) with today's tile and pill in view. */
async function planScreenToday(page: Page): Promise<void> {
  const plan = page.locator('[data-plan-page="plan"]');
  await waitFor([plan.locator('[data-plan-today]')], 'plan screen today');
  const pill = plan.locator('[data-plan-today-pill]');
  await pill.scrollIntoViewIfNeeded();
  await waitFor([pill], 'today pill');
}

async function openChatPlan(page: Page): Promise<void> {
  const card = await openChatPlanCard(page);
  await card.locator('[data-plan-open]').click();
  await waitFor([page.locator('[data-plan-page="plan"]')], 'plan screen');
}

/** The DM's open-items drawer, opened from the ticker under the header. */
async function openStatusDrawer(page: Page): Promise<void> {
  await openDm(page);
  await tap([page.locator('[data-status-ticker]')], 'status ticker');
  await waitFor([page.locator('[data-status-drawer="open"]')], 'status drawer');
}

/** Long-press (phone) or right-click (laptop) a DM message: its action menu. */
async function openDmMessageMenu(page: Page): Promise<void> {
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
}

/** The DM's composer tray open, then one tile picked (the tray closes on the pick). */
async function pickTrayTile(page: Page, tile: string): Promise<void> {
  await tap([page.getByRole('button', { name: 'Add attachment', exact: true })], 'attach');
  await waitFor([page.locator('[data-tray]')], 'composer tray');
  await tap([page.locator(`[data-tray-tile="${tile}"]:not([disabled])`)], `${tile} tile`);
}

/** A tray picker sheet by its title, painted past its loading rows. */
async function pickerSheet(page: Page, title: string, ready: string[]): Promise<void> {
  const sheet = page.getByRole('dialog', { name: title });
  await waitFor([sheet], `${title} sheet`);
  await waitFor(
    ready.map((selector) => sheet.locator(selector)),
    `${title} rows`,
  );
  await expect(sheet.locator('[aria-busy="true"]')).toHaveCount(0, { timeout: READY_MS });
}

/** The DM's contact info on one tab (Media, Files, ...). */
async function openContactTab(page: Page, label: string): Promise<void> {
  await openDm(page);
  await tap([page.locator('[data-contact-open]')], 'contact info trigger');
  await waitFor([page.getByRole('button', { name: 'Close contact info', exact: true })], 'contact');
  await tap(
    [page.getByRole('tablist').getByRole('tab', { name: label, exact: true })],
    `${label} tab`,
  );
  await waitFor([page.locator(`[data-contact-tab="${label.toLowerCase()}"]`)], `${label} tab`);
}

/** Select mode on a contact info tab with the first own file ticked. */
async function contactSelect(page: Page, label: string): Promise<void> {
  await openContactTab(page, label);
  await tap([page.getByTestId('info-select')], 'Select');
  await waitFor([page.getByTestId('info-select-bar')], 'select bar');
  await tap([page.locator('[data-info-tick][aria-pressed="false"]')], 'own file');
  await waitFor([page.locator('[data-info-tick][aria-pressed="true"]')], 'ticked file');
}

// ---------------------------------------------------------------------------
// Screens

const creator: AuditSeedOptions = { role: 'creator' };
const approver: AuditSeedOptions = { role: 'approver' };

/** Ana (an agency member) has catch-up emails off, turned off by the owner (ME). */
function seedMemberEmailOffByOwner(network: HarnessNetwork): void {
  for (const u of network.world.tables.users ?? []) {
    u.email_opt_out_by = null;
    if (u.id === COLLEAGUE_B) {
      u.email_opt_in = false;
      u.email_opt_out_by = ME;
    }
  }
}

/** Members panel, Ana's row ⋯, Change role: the member sheet. */
async function openMemberSheet(page: Page): Promise<void> {
  await waitFor([page.getByText('Emails off', { exact: true }).first()], 'settings members');
  await tap(
    [page.getByRole('button', { name: 'Actions for Ana Silva', exact: true })],
    'member actions',
  );
  await tap(menuRow(page, /^Change role$/), 'change role');
  await waitFor([page.getByText('Turned off by', { exact: false })], 'member sheet email row');
}

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
  // The format strip open over the composer, live styling in the box.
  { name: 'chat-format-strip', seed: creator, url: '/chat', steps: openFormatStrip },
  {
    // The DM's open-items drawer from its ticker: grey sheet, lit cards.
    name: 'chat-status-drawer',
    seed: creator,
    url: '/chat',
    steps: openStatusDrawer,
  },
  {
    // The drawer with a plan section locked (progress bar and pills).
    name: 'chat-status-drawer-plan',
    seed: creator,
    extra: seedChatPlan,
    url: '/chat',
    steps: openStatusDrawer,
  },
  {
    // The Tasks sheet at the height of what it holds, on Today: the chips,
    // the row, the add row with its day choices.
    name: 'chat-tasks-sheet',
    seed: creator,
    extra: seedDatedTasks,
    url: '/chat',
    steps: async (page) => {
      await openTasks(page);
    },
  },
  {
    // Full screen (from the menu) on Past: Not done (overdue, bad tone) above Done.
    name: 'chat-tasks-past-full',
    seed: creator,
    extra: seedDatedTasks,
    url: '/chat',
    steps: async (page) => {
      const sheet = await openTasks(page);
      await tap([sheet.getByRole('button', { name: 'More actions' })], 'Tasks menu');
      await tap([page.getByRole('menuitem', { name: 'Full screen' })], 'Full screen');
      await tap([sheet.locator('[data-task-when-chip="past"]')], 'Past chip');
      await waitFor([sheet.locator('[data-task-section="done"]')], 'Past sections');
    },
  },
  {
    // A row's menu (long-press, right-click): Today, Tomorrow, Pick a date, No date, Delete.
    name: 'chat-tasks-row-menu',
    seed: creator,
    extra: seedDatedTasks,
    url: '/chat',
    steps: async (page) => {
      const sheet = await openTasks(page);
      const row = sheet.locator('[data-task-row-id]', { hasText: 'Hook options' });
      await openMenuGesture(page, row.locator('[data-task-title]'));
      await waitFor([page.getByRole('menuitem', { name: 'Delete' })], 'row menu');
    },
  },
  {
    // Search (from the menu) takes the chip line: one flat list across every chip.
    name: 'chat-tasks-search',
    seed: creator,
    extra: seedDatedTasks,
    url: '/chat',
    hold: true,
    steps: async (page) => {
      const sheet = await openTasks(page);
      await tap([sheet.getByRole('button', { name: 'More actions' })], 'Tasks menu');
      await tap([page.getByRole('menuitem', { name: 'Search tasks' })], 'Search tasks');
      await sheet.locator('[data-task-search] input').fill('ca');
      await waitFor([sheet.locator('[data-task-list][data-task-chip="search"]')], 'results');
    },
  },
  {
    name: 'chat-thread-group',
    seed: creator,
    url: '/chat',
    steps: async (page) => openChat(page, GROUP_NAME),
  },
  { name: 'command-palette', seed: creator, url: '/chat', steps: openPaletteFrom },
  {
    // Recent from the device: more than 8, so "Show all (N)" shows.
    name: 'command-palette-recents',
    seed: creator,
    prepare: seedPaletteRecents,
    url: '/chat',
    steps: async (page) => {
      await openPaletteFrom(page);
      await waitFor([page.getByText('Show all (10)')], 'recents');
    },
  },
  {
    // Clear all: the zero line under the Undo strip.
    name: 'command-palette-recents-cleared',
    seed: creator,
    prepare: seedPaletteRecents,
    url: '/chat',
    steps: async (page) => {
      await openPaletteFrom(page);
      await tap([page.locator('[data-palette-clear-recents]')], 'Clear all');
      await waitFor([page.getByText('Things you open show up here.')], 'recents zero line');
    },
  },
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
    steps: openDmMessageMenu,
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
  // Loading boxes (sweepBoxes): each read below never answers, and a fresh
  // browser holds nothing for the screen, so its boxes are what paints.
  {
    // Activity: card-shaped boxes in ActivityCard's layout ("Loading activity").
    name: 'boxes-activity',
    seed: creator,
    extra: (network) => neverAnswers(network, { tables: ['inbox_entries'] }),
    url: '/activity',
    steps: async (page) => waitFor([page.locator('[data-activity-boxes]')], 'activity boxes'),
  },
  {
    // Plan tab: plan-card boxes on the phone, the month grid's entry boxes on laptop.
    name: 'boxes-plan-tab',
    seed: creator,
    extra: (network) => {
      seedTab(network);
      neverAnswers(network, { rpcs: ['plan_bundle_read', 'plan_search'] });
    },
    url: '/plan',
    steps: async (page) => waitFor([page.locator('[data-plan-tab-loading]')], 'plan tab boxes'),
  },
  {
    // Settings > Members: row-shaped boxes (a 40px avatar circle and two lines).
    name: 'boxes-members',
    seed: creator,
    extra: (network) => neverAnswers(network, { tables: ['workspace_members'] }),
    url: '/settings?panel=members',
    steps: async (page) => waitFor([page.locator('[data-settings-row-boxes]')], 'members boxes'),
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
    // Phone: the search is the centre. Tapped: ink line, lift, full row, the
    // sort and New glided aside, Cancel at the right end (keyboard not needed).
    name: 'pipeline-search-focused',
    seed: creator,
    only: 'phone',
    hold: true,
    url: '/pipeline',
    steps: async (page) => {
      await pipelineReady(page);
      await page.getByPlaceholder('Search posts').focus();
      await waitFor([page.locator('[data-search-cancel]')], 'search cancel');
    },
  },
  {
    // Laptop: "carousel" typed, the field focused (line and lift), clear X showing.
    name: 'pipeline-search-typed',
    seed: creator,
    only: 'laptop',
    hold: true,
    url: '/pipeline',
    steps: async (page) => {
      await pipelineReady(page);
      const field = page.getByPlaceholder('Search posts');
      await field.click();
      await field.fill('carousel');
      await waitFor([page.getByRole('button', { name: 'Clear search', exact: true })], 'clear');
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
      await waitFor([page.locator('[data-plan-file-name]')], 'plan item files');
    },
  },
  {
    name: 'plan-item-thread',
    seed: creator,
    extra: (network) => seedChatPlanThread(network, true),
    url: '/chat',
    steps: openPlanItemThread,
  },
  {
    name: 'plan-item-thread-approver',
    seed: approver,
    extra: (network) => seedChatPlanThread(network, false),
    url: '/chat',
    steps: openPlanItemThread,
  },
  {
    name: 'plan-item-more-menu',
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
      await tap([page.locator('[data-plan-item-more]')], 'item more');
      await waitFor([page.getByRole('menuitem', { name: /Remove from plan/ })], 'more menu');
    },
  },
  {
    name: 'plan-item-mention-picker',
    seed: creator,
    extra: (network) => seedChatPlanThread(network, true),
    url: '/chat',
    steps: async (page) => {
      await openPlanItemThread(page);
      const box = page.locator('[data-plan-comment-input]');
      await box.click();
      await box.fill('@');
      await waitFor([page.locator('[data-mention-picker]')], 'mention picker');
    },
  },
  {
    name: 'plan-item-notes',
    seed: creator,
    extra: seedChatPlanNote,
    url: '/chat',
    steps: async (page) => {
      await openChatPlan(page);
      await page
        .locator('[data-plan-page="plan"]')
        .locator(`[data-plan-row="${PLAN_POST_ITEM}"]`)
        .click();
      const notes = page.locator('[data-plan-page="item"] [data-plan-notes]');
      await waitFor([notes], 'plan notes');
      await notes.scrollIntoViewIfNeeded();
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
    extra: seedTab,
    url: '/plan',
    steps: async (page) =>
      waitFor([page.locator('[data-plan-tab-list]'), page.getByText('Autumn launch')], 'plan'),
  },
  {
    // The phone's week chips: a chip with no plans in it shows the zero line.
    name: 'plan-tab-week-zero',
    only: 'phone',
    seed: creator,
    extra: seedTab,
    url: '/plan',
    steps: async (page) => {
      await waitFor([page.getByText('Autumn launch')], 'plan');
      await tap([page.locator('[data-plan-tab-when="earlier"]')], 'Past');
      await waitFor([page.locator('[data-plan-tab-chip-zero]')], 'week zero');
    },
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
    // Owner viewer: every active row carries the catch-up email tag; Ana has
    // opted out, so both "On" and "Emails off" paint.
    name: 'members',
    seed: creator,
    extra: (network) => {
      for (const u of network.world.tables.users ?? []) {
        if (u.id === COLLEAGUE_B) u.email_opt_in = false;
      }
    },
    url: '/settings?panel=members',
    steps: async (page) =>
      waitFor([page.getByText('Emails off', { exact: true }).first()], 'settings members'),
  },
  {
    // Owner viewer: Ana's member sheet (row ⋯, Change role) with the Catch-up
    // emails row under Role. The owner turned Ana's emails off, so the row is
    // the unticked box with "Turned off by" the owner.
    name: 'member-sheet',
    seed: creator,
    extra: seedMemberEmailOffByOwner,
    url: '/settings?panel=members',
    steps: openMemberSheet,
  },
  {
    // The laptop sheet in dark (the laptop project is light).
    name: 'member-sheet-dark',
    seed: creator,
    extra: seedMemberEmailOffByOwner,
    only: 'laptop',
    dark: true,
    url: '/settings?panel=members',
    steps: openMemberSheet,
  },
  {
    // Settings > Profile: the Catch-up emails tick box under the fields.
    name: 'settings-profile',
    seed: creator,
    url: '/settings?panel=profile',
    steps: async (page) =>
      waitFor([page.getByText('Catch-up emails', { exact: true })], 'settings profile'),
  },
  {
    // Settings > Profile: Alerts on this device while paused for 3 hours (the
    // banner with Resume above Pause for, the 3 hours chip selected). The
    // pause is seeded on the device before load, so the first frame has it.
    name: 'settings-profile-paused',
    seed: creator,
    prepare: seedAlertsPaused,
    url: '/settings?panel=profile',
    steps: async (page) => {
      const banner = page.locator('[data-alerts-paused]');
      await waitFor([banner], 'settings profile paused');
      await page.locator('[data-alerts-block]').scrollIntoViewIfNeeded();
    },
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
  {
    // Contact info -> Media in select mode: own photos ticked, a peer's without a check.
    name: 'contact-media-select',
    seed: creator,
    extra: (network) => seedRemovableFiles(network.world),
    url: '/chat',
    steps: async (page) => contactSelect(page, 'Media'),
  },
  {
    // Contact info -> Files in select mode with the own PDF ticked.
    name: 'contact-files-select',
    seed: creator,
    extra: (network) => seedRemovableFiles(network.world),
    url: '/chat',
    steps: async (page) => contactSelect(page, 'Files'),
  },
  {
    // The photo viewer on an own photo: the bin left of Download.
    name: 'viewer-remove',
    seed: creator,
    extra: (network) => seedRemovableFiles(network.world),
    url: '/chat',
    steps: async (page) => {
      await openContactTab(page, 'Media');
      const own = ALBUM_PHOTOS[0].name;
      const media = page.locator('[data-contact-tab="media"]');
      await tap([media.getByRole('button', { name: own, exact: true })], 'own photo tile');
      const viewer = page.getByRole('dialog', { name: 'Image viewer' });
      await waitFor([viewer.getByRole('button', { name: 'Remove photo' })], 'viewer bin');
    },
  },
  {
    // An own message that lost two photos and kept its text: the removed line.
    name: 'chat-thread-files-removed',
    seed: creator,
    extra: (network) => seedRemovedLine(network.world),
    url: '/chat',
    steps: async (page) => {
      await openDm(page);
      const kept = page.locator('[data-bubble]', { hasText: REMOVED_BODY }).last();
      const list = page.locator('[data-thread-viewport] ul').first();
      // A reader's scroll (a wheel first: a script scroll alone never lets the
      // thread's stick-to-bottom go). A pin of the open between the wheel and
      // the scroll takes the scroll back as its own: start again from the
      // bottom until the reader's state holds (Scroll to latest shows).
      await expect(async () => {
        await list.evaluate((el) => {
          el.scrollTop = el.scrollHeight;
        });
        await list.dispatchEvent('wheel');
        await kept.scrollIntoViewIfNeeded();
        await expect(page.locator('[data-latest-button][aria-hidden="false"]')).toHaveCount(1, {
          timeout: 1_000,
        });
      }).toPass({ timeout: READY_MS });
      await waitFor([kept.getByTestId('files-removed-line')], 'files removed line');
    },
  },
];

// The operator's Cockpit (e2e/fixtures/cockpit-data.ts): the dot green and red
// on every project (plus laptop dark), the laptop side panel beside Pipeline on
// Needs you and Users (light and dark), the phone sheet on Users and Traffic
// (iPhone light and dark).
async function cockpitDot(page: Page, level: 'green' | 'red'): Promise<void> {
  await pipelineReady(page);
  await waitFor([page.locator(`[data-cockpit-dot="${level}"]`)], `cockpit dot ${level}`);
}

async function openCockpit(page: Page, level: 'green' | 'red', tab: string | null, text: string) {
  await cockpitDot(page, level);
  await page.locator('[data-cockpit-dot]').click();
  const surface = isLaptop(page)
    ? page.locator('aside[aria-label="Cockpit"]')
    : page.getByRole('dialog', { name: 'Cockpit' });
  await waitFor([surface.getByRole('tab', { name: 'Needs you' })], 'cockpit open');
  // The sheet (translateY) and the side panel (translateX on its child) slide in.
  // A tab clicked mid-slide makes Playwright retry the click, and each retry
  // scrolls the tab row to a different offset. Wait until the surface is at
  // rest: identity transform and no running animation on it or its children.
  const handle = await surface.elementHandle();
  await page.waitForFunction(
    (el) => {
      if (el === null) return false;
      const parts = [el, ...Array.from(el.children)];
      return parts.every((part) => {
        const t = getComputedStyle(part).transform;
        const atRest = t === 'none' || t === 'matrix(1, 0, 0, 1, 0, 0)';
        return atRest && part.getAnimations().every((a) => a.playState !== 'running');
      });
    },
    handle,
    { timeout: 5_000 },
  );
  await handle?.dispose();
  if (tab !== null) await surface.getByRole('tab', { name: tab }).click();
  await waitFor(
    [surface.getByRole('tabpanel').getByText(text).first()],
    `cockpit ${tab ?? 'needs'}`,
  );
  // The tab row scrolls sideways. Set its offset from the picked tab alone, the
  // same on every capture: 0 while the tab and the row's end padding fit,
  // otherwise just far enough to show both (the last tab pins the row's end).
  const row = surface.getByRole('tablist', { name: 'Cockpit' });
  const target = await row.evaluate((el) => {
    const picked = el.querySelector('[role="tab"][aria-selected="true"]');
    if (picked === null) return 0;
    const pad = parseFloat(getComputedStyle(el).paddingRight) || 0;
    const right = picked.getBoundingClientRect().right - el.getBoundingClientRect().left;
    const want = el.scrollLeft + right + pad - el.clientWidth;
    const max = el.scrollWidth - el.clientWidth;
    const next = Math.round(Math.min(max, Math.max(0, want)));
    el.scrollLeft = next;
    return next;
  });
  await expect
    .poll(() => row.evaluate((el) => el.scrollLeft), { timeout: 5_000 })
    .toBeGreaterThanOrEqual(target - 1);
}

for (const level of ['green', 'red'] as const) {
  SCREENS.push({
    name: `cockpit-dot-${level}`,
    seed: creator,
    operator: level,
    url: '/pipeline',
    steps: (page) => cockpitDot(page, level),
  });
  SCREENS.push({
    name: `cockpit-dot-${level}-dark`,
    seed: creator,
    operator: level,
    only: 'laptop',
    dark: true,
    url: '/pipeline',
    steps: (page) => cockpitDot(page, level),
  });
}
for (const dark of [false, true]) {
  const suffix = dark ? '-dark' : '';
  SCREENS.push({
    name: `cockpit-panel-needs${suffix}`,
    seed: creator,
    operator: 'red',
    only: 'laptop',
    dark,
    url: '/pipeline',
    steps: (page) => openCockpit(page, 'red', null, 'Failing: invite-send'),
  });
  SCREENS.push({
    name: `cockpit-panel-users${suffix}`,
    seed: creator,
    operator: 'red',
    only: 'laptop',
    dark,
    url: '/pipeline',
    steps: (page) => openCockpit(page, 'red', 'Users', 'People by country'),
  });
}
SCREENS.push({
  name: 'cockpit-sheet-users',
  seed: creator,
  operator: 'green',
  only: 'phone',
  url: '/pipeline',
  steps: (page) => openCockpit(page, 'green', 'Users', 'People by country'),
});
SCREENS.push({
  name: 'cockpit-sheet-traffic',
  seed: creator,
  operator: 'green',
  only: 'phone',
  url: '/pipeline',
  steps: (page) => openCockpit(page, 'green', 'Traffic', 'Home to sign-up'),
});

// The Plan tab's Week (laptop) and a plan screen holding today (Wed 21 Oct, the
// solid accent tile and its "Today" pill): laptop light and dark; the plan
// screen also on the phone (iPhone light and dark projects).
for (const dark of [false, true]) {
  const suffix = dark ? '-dark' : '';
  SCREENS.push({
    name: `plan-tab-week${suffix}`,
    seed: creator,
    extra: seedTab,
    only: 'laptop',
    dark,
    url: '/plan',
    steps: planTabWeek,
  });
}
SCREENS.push({
  name: 'plan-screen-today',
  seed: creator,
  extra: seedTab,
  url: `/plan/${TAB_SHARED_PLAN_ID}`,
  steps: planScreenToday,
});
SCREENS.push({
  name: 'plan-screen-today-dark',
  seed: creator,
  extra: seedTab,
  only: 'laptop',
  dark: true,
  url: `/plan/${TAB_SHARED_PLAN_ID}`,
  steps: planScreenToday,
});

// The New chat sheet with New group blocked by the groups-per-workspace rule
// (20261029120000_group_limit.sql): the workspace's group_allowance (1, the
// default) is already used, so capabilities_for_workspace answers
// group.create_more false. The owner sees the note plus Contact us and Book a
// call; anyone else sees "Ask {owner} about adding more." with no rows. Every
// project (iPhone light and dark, laptop light) plus laptop dark.

/** The owner's blocked note (GROUP_LIMIT_OWNER in NewChatSheet.tsx). */
const GROUP_LIMIT_OWNER_COPY =
  'On the free plan a workspace has one group. Need another? Talk to us.';
/** Who the member is told to ask: the owner the member variant moves the workspace to. */
const GROUP_LIMIT_OWNER_NAME = 'Leo Martins';

/** The fixture workspace at its group allowance: its live groups already fill it. */
function fillGroupAllowance(network: HarnessNetwork): void {
  for (const w of network.world.tables.workspaces ?? []) {
    if (w.id === WORKSPACE_ID) w.group_allowance = 1;
  }
}

/** Leo Martins owns the workspace; ME is a plain agency member. */
function makeColleagueOwner(network: HarnessNetwork): void {
  fillGroupAllowance(network);
  for (const w of network.world.tables.workspaces ?? []) {
    if (w.id === WORKSPACE_ID) w.owner_user_id = COLLEAGUE_A;
  }
  for (const m of network.world.tables.workspace_members ?? []) {
    if (m.user_id === ME) m.role = 'agency';
    if (m.user_id === COLLEAGUE_A) m.role = 'owner';
  }
}

async function openNewChatBlocked(page: Page, owner: boolean): Promise<void> {
  await chatListReady(page);
  await tap([page.getByRole('button', { name: 'New chat', exact: true })], 'New chat');
  const sheet = await firstVisible([page.getByRole('dialog')], 'new chat sheet');
  await waitFor([sheet.locator('[data-new-group-row]:disabled')], 'New group blocked');
  if (owner) {
    await waitFor([sheet.getByText(GROUP_LIMIT_OWNER_COPY, { exact: true })], 'owner note');
    await waitFor([sheet.getByRole('button', { name: /Book a call/ })], 'support rows');
  } else {
    await waitFor(
      [sheet.getByText(`Ask ${GROUP_LIMIT_OWNER_NAME} about adding more.`, { exact: false })],
      'member note',
    );
  }
}

for (const dark of [false, true]) {
  const suffix = dark ? '-dark' : '';
  const laptopDark = dark ? { only: 'laptop' as const, dark } : {};
  SCREENS.push({
    name: `new-chat-group-limit-owner${suffix}`,
    seed: creator,
    extra: fillGroupAllowance,
    ...laptopDark,
    url: '/chat',
    steps: (page) => openNewChatBlocked(page, true),
  });
  SCREENS.push({
    name: `new-chat-group-limit-member${suffix}`,
    seed: creator,
    extra: makeColleagueOwner,
    ...laptopDark,
    url: '/chat',
    steps: (page) => openNewChatBlocked(page, false),
  });
}

// The support contact sheet (Contact us): the address with its icon-only Copy
// (clipboard), opened from the owner's group-limit support rows.
for (const dark of [false, true]) {
  const suffix = dark ? '-dark' : '';
  const laptopDark = dark ? { only: 'laptop' as const, dark } : {};
  SCREENS.push({
    name: `support-contact-sheet${suffix}`,
    seed: creator,
    extra: fillGroupAllowance,
    ...laptopDark,
    url: '/chat',
    steps: async (page) => {
      await openNewChatBlocked(page, true);
      await tap([page.getByRole('button', { name: /Contact us/ })], 'Contact us');
      await waitFor([page.getByRole('button', { name: 'Copy email', exact: true })], 'Copy email');
    },
  });
}

// The chat home's media chips (Photos, Videos, Links, Files, Voice notes) over
// the media fixtures (search-data.ts: a 3-photo album and a single photo a
// month back, a video with duration_ms 12000 and one without, a pdf with
// page_count and a docx, a message with 2 links, a voice note), and the photo
// viewer opened from the first Photos tile with its details on top. Phone
// light/dark and laptop light come from the projects; -dark adds laptop dark.

/** Seed the media rows and answer p_kind searches like the live proc (videos apart). */
async function seedMediaChips(network: HarnessNetwork, page: Page, now: number): Promise<void> {
  await installLinkPreviewStub(page);
  await installMediaSearch(page, network.world.tables, now);
}

/** The chat home with one media chip on and its results painted. */
async function openMediaChip(page: Page, kind: MediaKind): Promise<Locator> {
  await chatListReady(page);
  await tap([page.locator(`[data-search-chip="${kind}"]`)], `${kind} chip`);
  const results = page.locator(`[data-media-results="${kind}"]`);
  await waitFor([results], `${kind} results`);
  await waitFor(
    [results.locator('[data-media-tile]'), results.locator('[data-media-row]')],
    `${kind} items`,
  );
  if (kind === 'video') await waitFor([results.locator('[data-media-duration]')], 'duration');
  return results;
}

const MEDIA_CHIP_SCREENS: Array<{ kind: MediaKind; name: string }> = [
  { kind: 'photo', name: 'photos' },
  { kind: 'video', name: 'videos' },
  { kind: 'link', name: 'links' },
  { kind: 'file', name: 'files' },
  { kind: 'voice', name: 'voice-notes' },
];

for (const dark of [false, true]) {
  const suffix = dark ? '-dark' : '';
  const laptopDark = dark ? { only: 'laptop' as const, dark } : {};
  for (const chip of MEDIA_CHIP_SCREENS) {
    SCREENS.push({
      name: `chat-home-chip-${chip.name}${suffix}`,
      seed: creator,
      prepare: seedMediaChips,
      ...laptopDark,
      url: '/chat',
      steps: async (page) => {
        await openMediaChip(page, chip.kind);
      },
    });
  }
  SCREENS.push({
    name: `chat-media-lightbox-details${suffix}`,
    seed: creator,
    prepare: seedMediaChips,
    ...laptopDark,
    url: '/chat',
    steps: async (page) => {
      const results = await openMediaChip(page, 'photo');
      await tap([results.locator('[data-media-tile]').first()], 'first photo tile');
      await waitFor([page.locator('[data-lightbox-details]')], 'viewer details');
      await waitFor([page.locator('[data-show-in-chat]')], 'Show in chat');
    },
  });
}

// The person card and Reply privately (2 Nov 2026). The card opens from a
// person's photo, name or @mention ([data-person-trigger]): a Sheet on phone
// (iPhone light and dark projects), a popover beside the photo on laptop (light,
// plus a dark shot). Its three states: another member (Message), me (Message
// yourself) and a removed member (No longer in this workspace). Reply privately
// shows in a group message's menu and on a post comment row; the DM it opens
// carries the quote strip above the composer, and the sent message carries the
// quote in its bubble.

/** The group message Leo sends last (the menu's target). */
const GROUP_PLAIN_BODY = 'Moodboard is up in the brief.';
/** Leo's group message that tags ME (the "Message yourself" trigger). */
const GROUP_MENTION_BODY = `@[${ME}] can you check the hook before 5pm?`;
/** Priya's comment on Monday carousel (Reply privately on its row). */
const PEER_COMMENT_ID = '0190f200-0000-7000-8000-0000000000d1';
const PEER_COMMENT_BODY = 'Can the cover use the morning shot?';
/** The quote's words in the DM strip and in the received bubble. */
const QUOTE_EXCERPT = 'Love the new cover shot, ship it today.';
/** Priya's DM reply that carries a quote of ME's comment. */
const QUOTED_REPLY_BODY = 'Fair point, I will ask the team.';
const QUOTED_REPLY_ID = '0190b000-0000-7000-8a00-0000000000e1';
const ME_COMMENT_ID = '0190f200-0000-7000-8000-0000000000d2';

/** A group chat message row in the fixture shape. */
function groupMessage(id: string, sender: string, body: string, at: number): Row {
  return {
    id,
    channel_id: GROUP_CHANNEL,
    workspace_id: WORKSPACE_ID,
    sender_user_id: sender,
    body,
    mentions: null,
    attachment_asset_ids: null,
    shared_post_ids: null,
    shared_brief_ids: null,
    reply_to_message_id: null,
    forwarded_from_message_id: null,
    attachment_meta: null,
    agora_event_id: null,
    created_at: new Date(at).toISOString(),
    edited_at: null,
    deleted_at: null,
    thread_root_message_id: null,
    private_reply: null,
  };
}

/** Leo's two newest group messages: one tags ME, the last is plain. */
function seedGroupPeople(network: HarnessNetwork): void {
  (network.world.tables.chat_messages ??= []).push(
    groupMessage(
      '0190b000-0000-7000-8a00-0000000000c1',
      COLLEAGUE_A,
      GROUP_MENTION_BODY,
      NOW - 120_000,
    ),
    groupMessage(
      '0190b000-0000-7000-8a00-0000000000c2',
      COLLEAGUE_A,
      GROUP_PLAIN_BODY,
      NOW - 60_000,
    ),
  );
}

/** Ana left the workspace (her messages stay in the group). */
function seedRemovedColleague(network: HarnessNetwork): void {
  for (const m of network.world.tables.workspace_members ?? []) {
    if (m.user_id !== COLLEAGUE_B) continue;
    m.active = false;
    m.removed_at = new Date(NOW - 3 * 86_400_000).toISOString();
  }
}

/** A post comment row on Monday carousel in the fixture shape. */
function postComment(id: string, author: string, body: string, at: number): Row {
  return {
    id,
    workspace_id: WORKSPACE_ID,
    entity_type: 'post',
    entity_id: POST,
    author_user_id: author,
    body,
    parent_comment_id: null,
    attachment_asset_ids: null,
    mentions: null,
    created_at: new Date(at).toISOString(),
    edited_at: null,
    deleted_at: null,
    legacy_author_name: null,
    legacy_author_email: null,
    ledger_seq: null,
    ledger_batch_id: null,
    resolved_at: null,
    resolved_by: null,
    resolved_version_id: null,
    resolution_note: null,
    asked_at: null,
    asked_by: null,
    sent_back_at: null,
    sent_back_by: null,
    closed_at: null,
    closed_by: null,
    accepted_at: null,
    accepted_by: null,
    unaccepted_at: null,
    unaccepted_by: null,
  };
}

/** Priya's comment on Monday carousel: its row offers Reply privately. */
function seedPeerComment(network: HarnessNetwork): void {
  (network.world.tables.comments ??= []).push(
    postComment(PEER_COMMENT_ID, PEER, PEER_COMMENT_BODY, NOW - 60_000),
  );
}

/** The DM's draft holds a Reply privately quote of Priya's comment (device storage). */
async function seedPrivateReplyDraft(_network: HarnessNetwork, page: Page): Promise<void> {
  const blob = {
    userId: ME,
    byWorkspace: {
      [WORKSPACE_ID]: {
        [DM_CHANNEL]: {
          text: '',
          caret: 0,
          reply: null,
          sharedPosts: [],
          sharedBriefs: [],
          privateReply: {
            kind: 'comment',
            sourceId: PEER_COMMENT_ID,
            authorUserId: PEER,
            authorName: PEER_NAME,
            excerpt: QUOTE_EXCERPT,
            whereLabel: 'Monday carousel',
            link: {
              kind: 'comment',
              entityType: 'post',
              entityId: POST,
              commentId: PEER_COMMENT_ID,
            },
          },
        },
      },
    },
  };
  await page.addInitScript(([key, value]) => window.localStorage.setItem(key, value), [
    'sorted:chat:drafts:v1',
    JSON.stringify(blob),
  ] as const);
}

/** Priya's newest DM message quotes ME's comment on Monday carousel. */
function seedQuotedReply(network: HarnessNetwork): void {
  (network.world.tables.comments ??= []).push(
    postComment(ME_COMMENT_ID, ME, QUOTE_EXCERPT, NOW - 3_600_000),
  );
  (network.world.tables.chat_messages ??= []).push({
    ...groupMessage(QUOTED_REPLY_ID, PEER, QUOTED_REPLY_BODY, NOW - 10_000),
    channel_id: DM_CHANNEL,
    private_reply: {
      kind: 'comment',
      source_id: ME_COMMENT_ID,
      author_user_id: ME,
      excerpt: QUOTE_EXCERPT,
      where_label: 'Monday carousel',
      source_created_at: new Date(NOW - 3_600_000).toISOString(),
      link: { entity_type: 'post', entity_id: POST, comment_id: ME_COMMENT_ID },
    },
  });
}

/** A 200-char excerpt and a 60-char where label: the long Reply privately quote. */
const LONG_EXCERPT = (
  'Love the new cover shot, ship it today but please swap the second slide for the ' +
  'warmer morning frame and tighten the caption so the hook lands before the fold, ' +
  'then send it back to me for a final look.'
)
  .padEnd(200, '.')
  .slice(0, 200);
const LONG_WHERE = 'Monday carousel for the spring launch across all three market'
  .padEnd(60, 's')
  .slice(0, 60);
const LONG_MINE_BODY = 'On it, swapping the frame now.';
const LONG_THEIRS_BODY = 'Thanks, take a look when you can.';

/** The DM's two newest messages carry the long quote: mine, then theirs. */
function seedLongPrivateReplies(network: HarnessNetwork): void {
  (network.world.tables.comments ??= []).push(
    postComment(ME_COMMENT_ID, ME, LONG_EXCERPT, NOW - 3_600_000),
    postComment(PEER_COMMENT_ID, PEER, LONG_EXCERPT, NOW - 3_500_000),
  );
  const quote = (author: string, source: string): Row => ({
    kind: 'comment',
    source_id: source,
    author_user_id: author,
    excerpt: LONG_EXCERPT,
    where_label: LONG_WHERE,
    source_created_at: new Date(NOW - 3_600_000).toISOString(),
    link: { entity_type: 'post', entity_id: POST, comment_id: source },
  });
  (network.world.tables.chat_messages ??= []).push(
    {
      ...groupMessage('0190b000-0000-7000-8a00-0000000000e2', ME, LONG_MINE_BODY, NOW - 20_000),
      channel_id: DM_CHANNEL,
      private_reply: quote(PEER, PEER_COMMENT_ID),
    },
    {
      ...groupMessage('0190b000-0000-7000-8a00-0000000000e3', PEER, LONG_THEIRS_BODY, NOW - 10_000),
      channel_id: DM_CHANNEL,
      private_reply: quote(ME, ME_COMMENT_ID),
    },
  );
}

/**
 * The bubble stays inside its column (BUBBLE_MAX of the row: 76% touch, 65%
 * laptop) and inside the viewport, mine and theirs.
 */
async function expectBubbleInsideColumn(page: Page, body: string): Promise<void> {
  const bubble = await lastVisible(page.locator('[data-bubble]', { hasText: body }), body);
  await bubble.scrollIntoViewIfNeeded();
  const max = isLaptop(page) ? 0.65 : 0.76;
  const box = await bubble.evaluate((el, cap) => {
    const b = el.getBoundingClientRect();
    let col: Element | null = el.parentElement;
    while (col !== null && !/max-w-\[(76|65)%\]/.test(col.className)) col = col.parentElement;
    const c = col?.getBoundingClientRect() ?? null;
    const row = el.closest('li');
    const rowWidth = row !== null ? row.clientWidth : 0;
    return {
      left: b.left,
      right: b.right,
      width: b.width,
      colLeft: c?.left ?? Number.NaN,
      colRight: c?.right ?? Number.NaN,
      cap: rowWidth * cap,
      vw: window.innerWidth,
    };
  }, max);
  expect(box.left, `${body}: left edge inside column`).toBeGreaterThanOrEqual(box.colLeft - 0.5);
  expect(box.right, `${body}: right edge inside column`).toBeLessThanOrEqual(box.colRight + 0.5);
  expect(box.width, `${body}: width <= BUBBLE_MAX`).toBeLessThanOrEqual(box.cap + 0.5);
  expect(box.left, `${body}: on screen`).toBeGreaterThanOrEqual(0);
  expect(box.right, `${body}: on screen`).toBeLessThanOrEqual(box.vw);
}

/** The last visible match (the newest row in a thread). */
async function lastVisible(locator: Locator, what: string): Promise<Locator> {
  const until = Date.now() + READY_MS;
  while (Date.now() < until) {
    const count = await locator.count().catch(() => 0);
    for (let i = count - 1; i >= 0; i -= 1) {
      const one = locator.nth(i);
      if (await one.isVisible().catch(() => false)) return one;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`not reached: ${what}`);
}

/** Wait until the open thread stops moving (its newest row holds still for a few frames). */
async function threadStill(page: Page): Promise<void> {
  const rows = page.locator('[data-msg-id]');
  let last = '';
  let still = 0;
  const until = Date.now() + READY_MS;
  while (Date.now() < until && still < 4) {
    const box = await rows
      .last()
      .boundingBox()
      .catch(() => null);
    const now = box === null ? '' : `${Math.round(box.y)}:${Math.round(box.height)}`;
    still = now !== '' && now === last ? still + 1 : 0;
    last = now;
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
}

/** The group thread, then a tap on one person's photo or name: the card opens. */
async function openPersonCardFor(page: Page, userId: string): Promise<void> {
  await openChat(page, GROUP_NAME);
  await threadStill(page);
  const trigger = await lastVisible(
    page.locator(`[data-person-trigger="${userId}"]`),
    `person trigger ${userId}`,
  );
  await trigger.scrollIntoViewIfNeeded();
  await trigger.click();
  await waitFor([page.locator('[data-person-card]')], 'person card');
  await threadStill(page);
}

/** Long-press (phone) or right-click (laptop) Leo's last group message: its menu. */
async function openGroupMessageMenu(page: Page): Promise<void> {
  await openChat(page, GROUP_NAME);
  await threadStill(page);
  const bubble = await lastVisible(
    page.locator('[data-bubble]', { hasText: GROUP_PLAIN_BODY }),
    'Leo bubble',
  );
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
  await waitFor(menuRow(page, /Reply privately/), 'Reply privately in the message menu');
}

SCREENS.push(
  {
    name: 'person-card',
    seed: creator,
    extra: seedGroupPeople,
    url: '/chat',
    steps: (page) => openPersonCardFor(page, COLLEAGUE_A),
  },
  {
    // The laptop popover in dark (the laptop project is light).
    name: 'person-card-dark',
    seed: creator,
    extra: seedGroupPeople,
    only: 'laptop',
    dark: true,
    url: '/chat',
    steps: (page) => openPersonCardFor(page, COLLEAGUE_A),
  },
  {
    name: 'person-card-self',
    seed: creator,
    extra: seedGroupPeople,
    url: '/chat',
    steps: async (page) => {
      await openPersonCardFor(page, ME);
      await waitFor([page.getByRole('button', { name: /Message yourself/ })], 'Message yourself');
    },
  },
  {
    name: 'person-card-removed',
    seed: creator,
    extra: seedRemovedColleague,
    url: '/chat',
    steps: async (page) => {
      await openPersonCardFor(page, COLLEAGUE_B);
      await waitFor([page.getByText('No longer in this workspace', { exact: true })], 'removed');
    },
  },
  {
    name: 'chat-message-menu-reply-privately',
    seed: creator,
    extra: seedGroupPeople,
    url: '/chat',
    steps: openGroupMessageMenu,
  },
  {
    name: 'chat-dm-private-reply-strip',
    seed: creator,
    extra: seedPeerComment,
    prepare: seedPrivateReplyDraft,
    url: '/chat',
    steps: async (page) => {
      await openChat(page, PEER_NAME);
      await waitFor(
        [page.locator('[data-private-reply-bar]', { hasText: QUOTE_EXCERPT })],
        'quote strip',
      );
    },
  },
  {
    name: 'chat-dm-private-reply-bubble',
    seed: creator,
    extra: seedQuotedReply,
    url: '/chat',
    steps: async (page) => {
      await openChat(page, PEER_NAME);
      const bubble = await lastVisible(
        page.locator('[data-bubble]', { hasText: QUOTED_REPLY_BODY }),
        'quoted reply bubble',
      );
      await bubble.scrollIntoViewIfNeeded();
      await waitFor([page.getByText(QUOTE_EXCERPT, { exact: false })], 'bubble quote');
    },
  },
  {
    // A long Reply privately quote (200-char excerpt, 60-char where), mine
    // and theirs: each bubble stops at BUBBLE_MAX, the quote cuts with an
    // ellipsis, the body wraps below. Phone light/dark, laptop light.
    name: 'chat-dm-private-reply-long',
    seed: creator,
    extra: seedLongPrivateReplies,
    url: '/chat',
    steps: async (page) => {
      await openChat(page, PEER_NAME);
      await expectBubbleInsideColumn(page, LONG_MINE_BODY);
      await expectBubbleInsideColumn(page, LONG_THEIRS_BODY);
      const theirs = await lastVisible(
        page.locator('[data-bubble]', { hasText: LONG_THEIRS_BODY }),
        'theirs bubble',
      );
      await theirs.scrollIntoViewIfNeeded();
    },
  },
  {
    name: 'post-comment-reply-privately',
    seed: creator,
    extra: seedPeerComment,
    url: `/posts/${POST}`,
    steps: async (page) => {
      await postDetailReady(page);
      const text = page.getByText(PEER_COMMENT_BODY, { exact: true });
      await text.scrollIntoViewIfNeeded();
      const action = await lastVisible(
        page.locator('[data-row-action="reply-privately"]'),
        'Reply privately on the comment row',
      );
      await action.scrollIntoViewIfNeeded();
    },
  },
);

/** Priya's comment on the post: a tap on her name opens the inline card with its context line. */
async function openCommentAuthorCard(page: Page): Promise<void> {
  await postDetailReady(page);
  const text = page.getByText(PEER_COMMENT_BODY, { exact: true });
  await text.scrollIntoViewIfNeeded();
  const author = await lastVisible(
    page.locator(`[data-person-trigger="${PEER}"]`, { has: page.locator('[data-comment-author]') }),
    'comment author',
  );
  await author.click();
  await waitFor([page.locator('[data-person-card-message]')], 'inline message card');
  await waitFor([page.locator('[data-person-context]')], 'context line');
}

/** The DM header's photo: the photo-only viewer opens. */
async function openDmPhoto(page: Page): Promise<void> {
  await openDm(page);
  const photo = `[data-person-trigger="${PEER}"][data-person-view="photo"]`;
  await tap([page.locator(`[data-contact-open] ${photo}`)], 'DM header photo');
  await waitFor([page.locator(`[data-photo-viewer="${PEER}"]`)], 'photo viewer');
}

SCREENS.push(
  {
    // The inline message card from a group sender, the viewport cut to the
    // part above an iPhone keyboard (390x500): the sheet sits on its bottom
    // edge, input focused, reactions in the box. Phone light and dark.
    name: 'person-card-inline',
    seed: creator,
    extra: seedGroupPeople,
    only: 'phone',
    url: '/chat',
    steps: async (page) => {
      await page.setViewportSize({ width: 390, height: 500 });
      await openPersonCardFor(page, COLLEAGUE_A);
      await waitFor([page.locator('[data-person-reactions]')], 'quick reactions');
    },
  },
  {
    // From a post comment: header, the context line ("Monday carousel ·
    // "Can the cover use the morning shot?""), the inline composer. Phone
    // sheet light/dark; the laptop project shows the ~320px popover.
    name: 'person-card-inline-context',
    seed: creator,
    extra: seedPeerComment,
    url: `/posts/${POST}`,
    steps: openCommentAuthorCard,
  },
  {
    // The laptop popover in dark (the laptop project is light).
    name: 'person-card-inline-laptop',
    seed: creator,
    extra: seedPeerComment,
    only: 'laptop',
    dark: true,
    url: `/posts/${POST}`,
    steps: openCommentAuthorCard,
  },
  {
    // Reply privately on a comment row now opens the same inline card with
    // the comment as its source (no navigation into the DM).
    name: 'post-comment-reply-privately-card',
    seed: creator,
    extra: seedPeerComment,
    url: `/posts/${POST}`,
    steps: async (page) => {
      await postDetailReady(page);
      await page.getByText(PEER_COMMENT_BODY, { exact: true }).scrollIntoViewIfNeeded();
      const action = await lastVisible(
        page.locator('[data-row-action="reply-privately"]'),
        'Reply privately on the comment row',
      );
      await action.click();
      await waitFor([page.locator('[data-person-context]')], 'context line');
    },
  },
  {
    // Inside a DM the header photo opens the photo only: dark overlay, the
    // photo large, the full name, an X. Phone light/dark and laptop.
    name: 'person-photo-viewer',
    seed: creator,
    url: '/chat',
    steps: openDmPhoto,
  },
  {
    // The laptop viewer in dark (the laptop project is light).
    name: 'person-photo-viewer-laptop',
    seed: creator,
    only: 'laptop',
    dark: true,
    url: '/chat',
    steps: openDmPhoto,
  },
  {
    // The sent bubble with a long quote, mine and theirs, on the laptop in
    // dark (chat-dm-private-reply-long covers phone light/dark and laptop light).
    name: 'chat-dm-private-reply-long-sent',
    seed: creator,
    extra: seedLongPrivateReplies,
    only: 'laptop',
    dark: true,
    url: '/chat',
    steps: async (page) => {
      await openChat(page, PEER_NAME);
      await expectBubbleInsideColumn(page, LONG_MINE_BODY);
      await expectBubbleInsideColumn(page, LONG_THEIRS_BODY);
    },
  },
);

// The composer's pickers and sheets in the DM (creator: Plan is live), the
// Forward and Remind me sheets from a message's menu, an own message carrying
// a post card, and the guest homepage. Phone light/dark and laptop light.

/** The draft the Schedule sheet previews ("To Priya Raman: ..."). */
const SCHEDULE_DRAFT = 'Can we move the shoot to Monday?';

/** Serve the homepage fixture for "/" (the harness keeps "/" as its smoke page); clips 404. */
async function serveHomepage(_network: HarnessNetwork, page: Page): Promise<void> {
  await page.route('**/site-media/**', (route) => route.fulfill({ status: 404, body: '' }));
  await page.route(
    (url) => url.pathname === '/',
    async (route) => {
      const fixture = new URL('/home.html', route.request().url()).toString();
      const response = await route.fetch({ url: fixture });
      await route.fulfill({ response });
    },
  );
}

SCREENS.push(
  {
    name: 'post-picker',
    seed: creator,
    url: '/chat',
    steps: async (page) => {
      await openDm(page);
      await pickTrayTile(page, 'post');
      await pickerSheet(page, 'Share a post', ['li[data-section]', 'text=/show up here/']);
    },
  },
  {
    name: 'brief-picker',
    seed: creator,
    url: '/chat',
    steps: async (page) => {
      await openDm(page);
      await pickTrayTile(page, 'brief');
      await pickerSheet(page, 'Share a brief', ['text=Autumn range launch', 'text=/show up here/']);
    },
  },
  {
    // A library photo so the grid has a tile (the audit's files are not library).
    name: 'asset-picker',
    seed: creator,
    extra: seedLibraryImage,
    url: '/chat',
    steps: async (page) => {
      await openDm(page);
      await pickTrayTile(page, 'assets');
      await pickerSheet(page, 'Add from Assets', [`[data-asset-tile="${LIB_IMAGE}"]`]);
    },
  },
  {
    // The Plan tile's picker: upcoming plans (the Plan tab seed) and New plan.
    name: 'plan-picker',
    seed: creator,
    extra: seedTab,
    url: '/chat',
    steps: async (page) => {
      await openDm(page);
      await pickTrayTile(page, 'plan');
      await pickerSheet(page, 'Plans', ['[data-plan-pick]', '[data-plan-picker-empty]']);
    },
  },
  {
    // A message's menu, Forward: the chat list with checkmarks.
    name: 'forward-picker',
    seed: creator,
    url: '/chat',
    steps: async (page) => {
      await openDmMessageMenu(page);
      await tap([page.locator('[data-menu-item="forward"]')], 'Forward');
      // The menu's Forward starts a selection with this message; the selection
      // bar's Forward opens the picker.
      await tap([page.getByRole('button', { name: 'Forward', exact: true }).last()], 'Forward bar');
      // Any chat row (a toggle button) or the zero line, inside the open sheet.
      await waitFor(
        [
          page.locator('[role="dialog"] li button[aria-pressed]').first(),
          page.getByText('Chats show up here.', { exact: true }),
        ],
        'forward picker rows',
      );
    },
  },
  {
    // A message's menu, More, Remind me: the presets under the preview.
    name: 'reminder-sheet',
    seed: creator,
    url: '/chat',
    steps: async (page) => {
      await openDmMessageMenu(page);
      await tap([page.locator('[data-menu-item="more"]')], 'More');
      await tap([page.locator('[data-menu-item="remind"]')], 'Remind me');
      const sheet = page.getByRole('dialog', { name: 'Remind me' });
      await waitFor([sheet.locator('[data-reminder-row="1h"]')], 'reminder presets');
    },
  },
  {
    // A typed draft, then the tray's Schedule tile: the sheet on phone, the
    // menu under the Send chevron on laptop (both "Schedule message").
    name: 'schedule-sheet',
    seed: creator,
    url: '/chat',
    steps: async (page) => {
      await openDm(page);
      const draft = page.locator('form:has(textarea)').first().locator('textarea');
      await draft.fill(SCHEDULE_DRAFT);
      await pickTrayTile(page, 'schedule');
      const sheet = page.getByRole('dialog', { name: 'Schedule message' });
      await waitFor([sheet.locator('[data-schedule-options]')], 'schedule options');
      await waitFor([sheet.locator('[data-schedule-preview]')], 'schedule preview');
    },
  },
  {
    // ME's own DM message (the audit's "Ready for your look") with its post card in view.
    name: 'chat-own-post-card',
    seed: creator,
    url: '/chat',
    steps: async (page) => {
      await openDm(page);
      const own = page.locator('[data-msg-id]', { hasText: 'Ready for your look' }).last();
      const card = own.getByRole('button', { name: 'Open post Monday carousel' });
      await waitFor([card], 'own post card');
      await card.scrollIntoViewIfNeeded();
      await threadStill(page);
    },
  },
  {
    // The guest homepage (light only; its clips and photos masked).
    name: 'homepage',
    seed: null,
    signedOut: true,
    lightOnly: true,
    prepare: serveHomepage,
    mask: (page) => [page.locator('video, img')],
    url: '/',
    steps: async (page) => waitFor([page.locator('.home h1')], 'homepage'),
  },
);

// "Visible and lit" (PR 1): the states the lighting pass changed, each in the
// projects of the visual-coverage guard (src/__tests__/visual-coverage.test.ts).

/**
 * Lifts a draggable card and holds it over the first other column its role may
 * drop it in: a native dragstart on the card (it lifts one height, lit-float)
 * and a dragover on the column (lit-drop), never a drop, so nothing moves in
 * the world. The target is found by trying each other column (canRoleMove
 * decides which one lights), so the screen does not depend on the seed's stages.
 */
async function liftOverReview(page: Page): Promise<void> {
  await pipelineReady(page);
  const card = await firstVisible(
    [page.locator('[data-drag-container] [data-drag-item][draggable="true"]')],
    'a draggable card',
  );
  const from = await card.evaluate(
    (el) => el.closest('[data-drag-container]')?.getAttribute('data-stage') ?? '',
  );
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await card.dispatchEvent('dragstart', { dataTransfer });
  const columns = page.locator('[data-drag-container]');
  const count = await columns.count();
  for (let i = 0; i < count; i += 1) {
    const column = columns.nth(i);
    if ((await column.getAttribute('data-stage')) === from) continue;
    await column.scrollIntoViewIfNeeded();
    await column.dispatchEvent('dragenter', { dataTransfer });
    await column.dispatchEvent('dragover', { dataTransfer });
    if (/(^|\s)lit-drop(\s|$)/.test((await column.getAttribute('class')) ?? '')) {
      await expect(card).toHaveClass(/(^|\s)lit-float(\s|$)/);
      return;
    }
    await column.dispatchEvent('dragleave', { dataTransfer });
  }
  throw new Error('not reached: a column that takes the lifted card');
}

/** The Profile panel's alerts block in view (Sound, Notifications, Pause for). */
async function alertsBlock(page: Page): Promise<void> {
  const block = page.locator('[data-alerts-block]');
  await waitFor([block], 'alerts block');
  await block.scrollIntoViewIfNeeded();
}

SCREENS.push(
  {
    // Laptop board: a card lifted (lit-float) over a column it may drop in (lit-drop,
    // the 1px dashed line plus its inset ring).
    name: 'pipeline-drag-drop',
    seed: creator,
    only: 'laptop',
    // The kanban (one column per stage) shows only on All; a single stage is
    // a grid with nowhere to drop.
    url: '/pipeline?stage=all',
    steps: liftOverReview,
  },
  {
    // ME's own voice note in the DM (n=28 in the fixture): played and unplayed
    // bars, the speed pill and the transcribe link in on-bubble ink (dark too).
    name: 'chat-thread-own-voice',
    seed: creator,
    url: '/chat',
    steps: async (page) => {
      await openDm(page);
      const note = await lastVisible(
        page.locator('[data-own] [data-voice-note]'),
        'own voice note',
      );
      await note.scrollIntoViewIfNeeded();
      await waitFor([note.locator('[data-voice-bars]')], 'voice bars');
      await threadStill(page);
    },
  },
  {
    // Settings > Profile with Sound switched off: the off ink pill (clear well,
    // 1.5px field line, ink knob) beside the on Notifications pill.
    name: 'settings-profile-switch-off',
    seed: creator,
    url: '/settings?panel=profile',
    steps: async (page) => {
      await alertsBlock(page);
      const sound = page.getByRole('switch', { name: 'Sound', exact: true });
      await sound.click();
      await expect(sound).toHaveAttribute('aria-checked', 'false');
    },
  },
  {
    // Laptop: the pointer over an unselected Pause for chip (1 hour) beside the
    // selected one (3 hours): the --hover-fill overlay on the chip's light.
    name: 'chip-row-hover',
    seed: creator,
    only: 'laptop',
    hold: true,
    prepare: seedAlertsPaused,
    url: '/settings?panel=profile',
    steps: async (page) => {
      await waitFor([page.locator('[data-alerts-paused]')], 'paused banner');
      await alertsBlock(page);
      await page.locator('[data-pause-hours="1"]').hover();
    },
  },
  {
    // The create-brief sheet's Format select open: the option list (lit-overlay)
    // with the picked option ticked.
    name: 'select-open',
    seed: approver,
    hold: true,
    url: '/briefs',
    steps: async (page) => {
      await briefsReady(page);
      await tap([page.getByRole('button', { name: 'New brief', exact: true })], 'New brief');
      const sheet = page.getByRole('dialog');
      await waitFor([sheet], 'create brief sheet');
      // The brief sheet always shows its Format select (the post sheet only
      // with a platform preset).
      await tap(
        [sheet.getByRole('button', { name: 'Format', exact: true })],
        'Format select trigger',
      );
      await waitFor([page.getByRole('listbox')], 'select options');
      // No hover on an option: the open list as it lands.
      await page.mouse.move(0, 0);
    },
  },
  {
    // The sign-in code step after a wrong code, the field focused again: the
    // invalid boxes (lit-bad) with the focus line still on the active box.
    name: 'code-step-error-focused',
    seed: null,
    signedOut: true,
    hold: true,
    prepare: (_network, page) => routeVerify(page, 'wrong'),
    url: '/signin',
    steps: async (page) => {
      await toSignInCode(page);
      await page.locator('#auth-code').fill('000000');
      await waitFor([page.getByText(CHECK_EMAIL_COPY.wrongCode)], 'wrong code');
      await page.mouse.move(0, 0);
      await page.locator('#auth-code').focus();
      await waitFor([page.locator('[data-code-box].lit-focus')], 'focused code box');
    },
  },
);

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
async function stabilise(page: Page, hold = false): Promise<void> {
  if (!hold) {
    await page.mouse.move(0, 0);
    await page.evaluate(() => {
      const active = document.activeElement;
      if (active instanceof HTMLElement) active.blur();
    });
  }
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

async function capture(screen: Screen, page: Page): Promise<void> {
  if (screen.only !== undefined) {
    test.skip((screen.only === 'laptop') !== isLaptop(page), `${screen.only} only`);
  }
  if (screen.lightOnly === true) {
    test.skip(test.info().project.name.includes('dark'), 'light only');
  }
  if (screen.dark === true) await page.emulateMedia({ colorScheme: 'dark' });
  // The page's clock is pinned (Date only; timers keep running).
  await page.clock.setFixedTime(NOW);
  // Vite's HMR socket answers nothing, so a file saved mid-run never
  // reloads or patches the page under a screenshot.
  await page.routeWebSocket(
    (url) => url.protocol === 'ws:' && url.hostname === 'localhost',
    () => undefined,
  );
  const network = await installHarnessNetwork(
    page,
    screen.operator !== undefined ? { operator: true, cockpitLevel: screen.operator } : {},
  );
  // Rebuild the world at the fixed instant (the handlers read world.tables per request).
  Object.assign(network.world, buildWorld(NOW));
  if (screen.signedOut === true) await signOut(page);
  if (screen.seed !== null) seedAudit(network, screen.seed, NOW);
  screen.extra?.(network);
  await screen.prepare?.(network, page, NOW);
  await installDeletedRoutes(page, network);
  await page.goto(screen.url);
  await screen.steps(page);
  await stabilise(page, screen.hold === true);
  await settle(page);
  await expect(page).toHaveScreenshot(`${screen.name}.png`, {
    maxDiffPixelRatio: 0.002,
    animations: 'disabled',
    caret: 'hide',
    ...(screen.mask !== undefined ? { mask: screen.mask(page) } : {}),
  });
  expect(network.blocked, 'blocked non-fixture requests').toEqual([]);
}

// Laptop dark: these screens also run in the laptop-dark project
// (playwright.visual.config.ts greps @laptop-dark there). The tag rides on the
// screen's one test title, so the iPhone and laptop-light projects still run
// it; the snapshot name stays the screen name (laptop-dark/<name>.png).
const LAPTOP_DARK_SCREENS = new Set([
  'pipeline',
  'plan-tab',
  'plan-screen-today',
  'chat-thread',
  'chat-thread-own-voice',
  'post-detail',
  'briefs-approver',
  'assets',
  'settings-profile',
  'post-picker',
  'chat-status-drawer',
  'chat-status-drawer-plan',
]);

for (const screen of SCREENS) {
  const tag = LAPTOP_DARK_SCREENS.has(screen.name) ? ' @laptop-dark' : '';
  test(`${screen.name}${tag}`, async ({ page }) => capture(screen, page));
}

// Touch tablet page mode (src/lib/scroll-mode.ts TOUCH_TABLET_QUERY): the
// document scrolls on these screens. Only the ipad-* projects run @tablet
// (playwright.visual.config.ts); their baselines live in their own folders.
const TABLET_SCREENS = new Set([
  'pipeline',
  'briefs-approver',
  'assets',
  'plan-tab',
  'post-detail',
]);
for (const screen of SCREENS.filter((s) => TABLET_SCREENS.has(s.name))) {
  test(`${screen.name} @tablet`, async ({ page }) => capture(screen, page));
}
