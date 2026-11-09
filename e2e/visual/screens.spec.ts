import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  FIXTURE_PDF_PAGES,
  installHarnessNetwork,
  solidPng,
  type HarnessNetwork,
} from '../fixtures/harness-routes';
import {
  assertCommentBars,
  assertCommentTray,
  assertThreadHeader,
  assertListCards,
  assertNoUploadBar,
  assertPinnedBarOnScroll,
  assertProgressRowUnderBar,
  assertSameWidth,
  assertTopbarSlotsStill,
  assertWritingBox,
  assertAlignment,
  assertCatchUpLayout,
  checkCatchUpComposer,
  checkLayout,
  type AlignScope,
  readTopbarSlots,
  assertActivityTwinsPlan,
  readActivityBoxes,
  readListTwin,
} from './layout-checks';
import { installDeletedRoutes } from '../fixtures/assets-recently-deleted';
import type { Row } from '../fixtures/postgrest';
import {
  assetId,
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
  planThreadReply,
  PLAN_POST_ITEM,
  POST_IDS,
  REFUSED_SEND,
  seedClientPlan,
  seedPlanTab,
  seedTeamAndHiddenPlans,
  TEAM_PLAN_ID,
  planMessage,
  TAB_SHARED_PLAN_ID,
  THREAD_DM,
  THREAD_GROUP,
  THREAD_IDS,
  WORKSPACE_ID,
  civilPlus,
  mondayOf,
  MAYA_NAME,
} from '../fixtures/chat-data';
import {
  AUDIT_BRIEF_ID,
  AUDIT_POST_IDS,
  seedAudit,
  type AuditSeedOptions,
} from '../fixtures/audit-pr-b';
import {
  ALBUM_PHOTOS,
  REMOVED_BODY,
  seedRemovableFiles,
  seedRemovedLine,
} from '../fixtures/remove-files';
import {
  installLinkPreviewStub,
  TEXT_LINE,
  TEXT_TITLE,
  TEXT_URL,
  YOUTUBE_LINE,
  YOUTUBE_TITLE,
} from '../fixtures/link-previews';
import { PPTX_MIME } from '../fixtures/office-files';
import {
  CU_BLANK_LINES_ENTRY,
  CU_BRIEF_ENTRY,
  CU_CHAT_MAIN_ENTRY,
  CU_EMOJI_ENTRY,
  CU_FEEDBACK_ENTRY,
  CU_FEEDBACK_POST,
  CU_GROUP_MAIN_ENTRY,
  CU_IDEA_ENTRY,
  CU_LINK_ENTRY,
  CU_LONG_CAPTION_ENTRY,
  CU_LONG_NAME_ENTRY,
  CU_LONG_TITLE_ENTRY,
  CU_MANY_ENTRY,
  CU_PLAN_ENTRY,
  CU_REST_ENTRY,
  CU_TEXT_ENTRY,
  CU_VIDEO_ENTRY,
  seedCatchUpBankIdea,
  seedCatchUpBlankLines,
  seedCatchUpBrief,
  seedCatchUpChatMain,
  seedCatchUpEmoji,
  seedCatchUpFeedback,
  seedCatchUpGroupMain,
  seedCatchUpLongCaption,
  seedCatchUpLongLink,
  seedCatchUpLongName,
  seedCatchUpLongTitle,
  seedCatchUpManyComments,
  seedCatchUpPlanItem,
  seedCatchUpRest,
  seedCatchUpTextOnly,
  seedCatchUpVideo,
} from '../fixtures/catch-up-data';
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
import { stubVoiceRecorder } from '../helpers/voice-recorder';
import { selectGesture } from '../helpers/select-mode';

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
  /** Checks after the shot (they may scroll or open things; the baseline never sees them). */
  after?: (page: Page) => Promise<void>;
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

/**
 * A finger drags a target by dx px (left when negative) on touch and, unless
 * `release` is false, lets go: the task row's swipe to delete.
 */
async function swipeRow(
  target: Locator,
  dx: number,
  options: { release: boolean } = { release: true },
): Promise<void> {
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (box === null) throw new Error('swipe target has no box');
  const y = box.y + box.height / 2;
  const x0 = box.x + box.width / 2;
  const touch = { pointerType: 'touch', pointerId: 7, isPrimary: true, clientY: y };
  await target.dispatchEvent('pointerdown', { ...touch, clientX: x0 });
  const steps = 8;
  for (let i = 1; i <= steps; i += 1) {
    await target.dispatchEvent('pointermove', { ...touch, clientX: x0 + (dx * i) / steps });
  }
  if (options.release) await target.dispatchEvent('pointerup', { ...touch, clientX: x0 + dx });
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

/**
 * The chat home with all three row kinds on screen: Personal notes (built from
 * the session), a group (GROUP_NAME) and a person (PEER_NAME), one row style.
 */
async function chatListAllRows(page: Page): Promise<void> {
  await chatListReady(page);
  await waitFor([page.locator('[data-notes-tile]')], 'Personal notes row');
  await waitFor(
    [page.locator('[data-chat-list]').getByText(GROUP_NAME, { exact: true })],
    'group row',
  );
  await waitFor(
    [page.locator('[data-chat-list]').getByText(PEER_NAME, { exact: true })],
    'person row',
  );
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
  await tap([page.getByRole('button', { name: 'Add attachment', exact: true })], 'tray');
  await tap([page.locator('[data-tray-tile="tasks"]')], 'Tasks tile');
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

/** Assets select mode: Hero banner.png ticked by the select gesture, the bar up. */
async function assetsSelect(page: Page): Promise<void> {
  await assetsReady(page);
  await selectGesture(
    page,
    page.locator('[data-asset-card]').filter({ hasText: 'Hero banner.png' }).first(),
  );
  await waitFor([page.locator('[data-select-bar]')], 'assets select bar');
}

/** A Pipeline post's card (ui/ListCard root). */
const pipelineCard = (page: Page, postId: string): Locator =>
  page.locator(`[data-list-card][data-post-id="${postId}"]`);

/** Pipeline select mode with the first `count` Review posts ticked (gesture, then taps). */
async function pipelineSelect(page: Page, count: 1 | 2): Promise<void> {
  await pipelineReady(page);
  await selectGesture(page, pipelineCard(page, POST_IDS[0] ?? ''));
  await waitFor([page.locator('[data-pipeline-select-bar]')], 'pipeline select bar');
  if (count === 2) await pipelineCard(page, POST_IDS[1] ?? '').click();
  await waitFor(
    [page.locator('[data-select-bar-count]', { hasText: `${count} selected` })],
    `${count} selected`,
  );
}

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

const CHAT_PLAN_BUCKETS = [
  '0190d500-0000-7000-8000-00000000e6b1',
  '0190d500-0000-7000-8000-00000000e6b2',
] as const;
const IDEA_MESSAGE_ID = '0190d500-0000-7000-8000-00000000e6c1';

/** The bank idea sent into the DM as an idea card (chat_plan_item_share's row). */
function seedIdeaCard(network: HarnessNetwork): void {
  seedBankIdea(network);
  (network.world.tables.chat_messages ??= []).push({
    ...planMessage(IDEA_MESSAGE_ID, DM_CHANNEL, ME, [], NOW + 60_000),
    shared_plan_ids: null,
    shared_plan_item_ids: [PLAN_CONCEPT_ITEM],
  });
}

const TRACE_ITEM = '0190d500-0000-7000-8000-00000000e6d1';
const FROM_BANK_IDEAS = [
  '0190d500-0000-7000-8000-00000000e6e1',
  '0190d500-0000-7000-8000-00000000e6e2',
] as const;

/** A bank idea (no plan) for the visual fixtures. */
function bankIdeaRow(id: string, title: string, extra: Partial<Row> = {}): Row {
  return {
    id,
    workspace_id: WORKSPACE_ID,
    plan_id: null,
    kind: 'concept',
    position: 0,
    title,
    description: null,
    post_id: null,
    target_date: null,
    linked_post_id: null,
    created_by: ME,
    created_at: new Date(NOW - 3 * 86_400_000).toISOString(),
    updated_at: new Date(NOW - 86_400_000).toISOString(),
    last_active_at: new Date(NOW - 86_400_000).toISOString(),
    show_to_client: false,
    archived_at: null,
    starred_at: null,
    came_from_plan_title: null,
    deleted_at: null,
    ...extra,
  };
}

/**
 * A concept that left `planId` for the bank this morning: the idea row (no
 * plan) and plan_item_to_bank's audit row. The flat payload key stands in for
 * PostgREST's `payload->>from_plan_id` filter in the harness.
 */
function seedTrace(
  network: HarnessNetwork,
  planId: string,
  title: string,
  movedAt: number = NOW - 60 * 60_000,
): void {
  const t = network.world.tables;
  (t.plan_items ??= []).push(bankIdeaRow(TRACE_ITEM, title, { came_from_plan_title: 'Plan' }));
  (t.audit_log ??= []).push({
    id: '0190d500-0000-7000-8000-00000000e6d2',
    workspace_id: WORKSPACE_ID,
    action: 'plan_item_to_bank',
    entity_type: 'plan_item',
    entity_id: TRACE_ITEM,
    outcome: 'success',
    created_at: new Date(movedAt).toISOString(),
    payload: { from_plan_id: planId },
    'payload->>from_plan_id': planId,
  });
}

/** The chat plan plus one concept moved to the bank from it. */
function seedChatPlanTrace(network: HarnessNetwork): void {
  seedChatPlan(network);
  seedTrace(network, PLAN_ID, 'Monsoon teaser');
}

/** The chat plan plus two bank ideas (one starred) for From bank. */
function seedChatPlanBank(network: HarnessNetwork): void {
  seedChatPlan(network);
  (network.world.tables.plan_items ??= []).push(
    bankIdeaRow(FROM_BANK_IDEAS[0], 'Founder story reel', {
      starred_at: new Date(NOW - 86_400_000).toISOString(),
    }),
    bankIdeaRow(FROM_BANK_IDEAS[1], 'Diwali gifting guide'),
  );
}

/** A team (Draft) plan carded into the group by ME, to forward into the client DM. */
function seedDraftPlanCard(network: HarnessNetwork): void {
  seedTeamAndHiddenPlans(network.world, { channelId: GROUP_CHANNEL, sender: ME, now: NOW });
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
  // Two buckets, the concept in both: the Plan row's line reads
  // "{format} · Product, Festive" and the item screen's Buckets card picks them.
  (network.world.tables.workspace_buckets ??= []).push(
    {
      id: CHAT_PLAN_BUCKETS[0],
      workspace_id: WORKSPACE_ID,
      name: 'Product',
      color_hex: '#6b7280',
      position: 1,
      archived: false,
      created_at: '2026-01-01T00:00:00Z',
    },
    {
      id: CHAT_PLAN_BUCKETS[1],
      workspace_id: WORKSPACE_ID,
      name: 'Festive',
      color_hex: '#6b7280',
      position: 2,
      archived: false,
      created_at: '2026-01-01T00:00:00Z',
    },
  );
  (network.world.tables.plan_item_buckets ??= []).push(
    {
      item_id: PLAN_CONCEPT_ITEM,
      bucket_id: CHAT_PLAN_BUCKETS[0],
      workspace_id: WORKSPACE_ID,
      workspace_buckets: { name: 'Product', position: 1 },
    },
    {
      item_id: PLAN_CONCEPT_ITEM,
      bucket_id: CHAT_PLAN_BUCKETS[1],
      workspace_id: WORKSPACE_ID,
      workspace_buckets: { name: 'Festive', position: 2 },
    },
  );
  // The concept files read embeds the version and the asset (one select), so
  // the item screen's tile shows the file's name under it.
  for (const link of network.world.tables.asset_attachments ?? []) {
    if (link.entity_id !== PLAN_CONCEPT_ITEM) continue;
    link.asset_versions = { mime_type: 'image/png', kind: 'image' };
    link.assets = { display_name: null, filename: 'reel-moodboard.png' };
  }
}

/**
 * The chat plan's concept moved to the idea bank (plan_item_to_bank's result):
 * no plan, no date, the plan it came from by title, team only.
 */
function seedBankIdea(network: HarnessNetwork): void {
  seedChatPlan(network);
  for (const row of network.world.tables.plan_items ?? []) {
    if (row.id !== PLAN_CONCEPT_ITEM) continue;
    row.plan_id = null;
    row.target_date = null;
    row.came_from_plan_title = 'Week of 12 Oct';
    row.show_to_client = false;
    row.archived_at = null;
    row.starred_at = null;
    row.last_active_at = '2026-10-09T10:00:00Z';
  }
}

/**
 * Activity's idea bank rows: one of each bank event from Priya, newest first
 * (added, shown, hidden, moved, planned). Each row renders from its payload
 * alone (title, plan_title, target_date): no item read.
 */
function seedBankActivity(network: HarnessNetwork): void {
  const entry = (n: number, eventType: string, payload: Row): Row => ({
    id: `0190f1b0-0000-7000-8000-00000000b00${n}`,
    user_id: ME,
    actor_user_id: PEER,
    workspace_id: WORKSPACE_ID,
    event_type: eventType,
    entity_type: 'plan_item',
    entity_id: PLAN_CONCEPT_ITEM,
    scope: 'posts',
    scope_key: eventType === 'bank_idea_planned' ? PLAN_ID : 'bank',
    tier: 'active',
    payload,
    read_at: n > 2 ? new Date(NOW - n * 60_000).toISOString() : null,
    snoozed_until: null,
    email_sent_at: null,
    deleted_at: null,
    created_at: new Date(NOW - n * 600_000).toISOString(),
  });
  network.world.tables.inbox_entries = [
    entry(1, 'bank_idea_added', { title: 'Reels week', plan_id: null }),
    entry(2, 'bank_idea_shown', { title: 'Reels week', plan_id: null }),
    entry(3, 'bank_idea_hidden', { title: 'Reels week', plan_id: null }),
    entry(4, 'bank_idea_moved', {
      title: 'Monsoon teaser',
      from_plan_id: PLAN_ID,
      from_plan_title: 'Week of 12 Oct',
      target_date: '2026-10-14',
      plan_id: PLAN_ID,
    }),
    entry(5, 'bank_idea_planned', {
      title: 'Festive carousel',
      plan_title: 'Week of 19 Oct',
      target_date: '2026-10-21',
      plan_id: PLAN_ID,
    }),
  ];
}

// Catch up (9 Nov 2026 rebuild: one card per ITEM): a mention in the "Thread
// crew" post-card thread, that thread's start on the post (both ride the one
// thread card), and a comment on a post, all unread, on top of the fixture
// world's DM mention. The other cards' worlds live in fixtures/catch-up-data.ts.
const CATCH_UP_MENTION = '0190f1c0-0000-7000-8000-00000000c001';
const CATCH_UP_STARTED = '0190f1c0-0000-7000-8000-00000000c002';
const CATCH_UP_COMMENT = '0190f1c0-0000-7000-8000-00000000c003';
const CATCH_UP_COMMENT_ID = '0190f1c0-0000-7000-8000-00000000c0c3';

function seedCatchUp(network: HarnessNetwork, opts: { mention?: boolean } = {}): void {
  const t = network.world.tables;
  const root = THREAD_IDS.gr ?? '';
  const reply = THREAD_IDS.gd ?? '';
  // The reply that mentions me (the mention token the chat resolves to @name).
  for (const row of t.chat_messages ?? []) {
    if (row.id === reply) row.body = `Thanks both! @[${ME}] can you post it today?`;
  }
  const entry = (id: string, minsAgo: number, row: Row): Row => ({
    id,
    user_id: ME,
    workspace_id: WORKSPACE_ID,
    tier: 'active',
    scope_key: null,
    read_at: null,
    snoozed_until: null,
    email_sent_at: null,
    deleted_at: null,
    created_at: new Date(NOW - minsAgo * 60_000).toISOString(),
    ...row,
  });
  const mention = entry(CATCH_UP_MENTION, 1, {
    actor_user_id: COLLEAGUE_A,
    event_type: 'mention',
    entity_type: 'chat_channel',
    entity_id: THREAD_GROUP,
    scope: 'groups',
    tier: 'urgent',
    payload: { message_id: reply, thread_root_id: root },
  });
  (t.inbox_entries ??= []).push(
    ...(opts.mention === false ? [] : [mention]),
    entry(CATCH_UP_STARTED, 2, {
      actor_user_id: COLLEAGUE_B,
      event_type: 'system',
      entity_type: 'chat_channel',
      entity_id: THREAD_GROUP,
      scope: 'groups',
      payload: {
        kind: 'thread_started',
        message_id: THREAD_IDS.ga ?? '',
        thread_root_id: root,
        card_kind: 'post',
        card_id: POST,
      },
    }),
    entry(CATCH_UP_COMMENT, 3, {
      actor_user_id: PEER,
      event_type: 'comment',
      entity_type: 'post',
      entity_id: POST,
      scope: 'posts',
      payload: { comment_id: CATCH_UP_COMMENT_ID },
    }),
  );
  (t.comments ??= []).push({
    id: CATCH_UP_COMMENT_ID,
    workspace_id: WORKSPACE_ID,
    entity_type: 'post',
    entity_id: POST,
    parent_comment_id: null,
    author_user_id: PEER,
    body: 'Can we try a warmer cover for this one?',
    mentions: null,
    attachment_asset_ids: null,
    resolved_at: null,
    resolved_by: null,
    unaccepted_by: null,
    // The card reads the ledger columns (the harness answers every column).
    ledger_batch_id: null,
    ledger_seq: null,
    closed_at: null,
    accepted_at: null,
    created_at: new Date(NOW - 3 * 60_000).toISOString(),
    edited_at: null,
    deleted_at: null,
  });
}

/**
 * One post with exactly 8 unread comment notifications (Activity's item card:
 * 5 lines + "+3 more"): the many-comments seed with its 42 oldest entries
 * dropped (its comments stay; Activity reads the entries).
 */
/** Long comments (9 Nov 2026): one past 3 lines at every width, one just past 3 on a phone. */
const LONG_COMMENT =
  'Can we swap the hero photo for the warmer one from Tuesday, move the price line under the ' +
  'headline, tighten the caption so it fits on two lines, and check the logo size on every ' +
  'slide before this goes out? The second slide still reads a little busy to me.';
const MID_COMMENT =
  'The second slide still reads a little busy: could we drop the badge and give the product ' +
  'shot more room on the left?';

function seedEightComments(network: HarnessNetwork): void {
  seedCatchUpManyComments(network, NOW);
  const t = network.world.tables;
  const all = t.inbox_entries ?? [];
  t.inbox_entries = [...all.slice(0, all.length - 50), ...all.slice(all.length - 8)];
  // Short AND long comments: the newest is long, the third newest mid length.
  const comments = t.comments ?? [];
  const newest = comments[comments.length - 1];
  const third = comments[comments.length - 3];
  if (newest !== undefined) newest.body = LONG_COMMENT;
  if (third !== undefined) third.body = MID_COMMENT;
}

/** A long post title for the "3 new" row: the name truncates, the chip never does. */
const LONG_ACTIVITY_TITLE =
  'Autumn knitwear carousel for the weekend sale with the warmer hero photo and new price line';

/**
 * Activity's three sections (10 Nov 2026), and nothing else in the feed:
 * Weekend sale with `saleCount` unread comments today ("8 new" by default), a
 * long-titled post with 3 unread comments yesterday ("3 new"), and a read
 * post three days back (Earlier, no chip). A phone's first page holds 10
 * (Calm) to 11 (Cozy) entries, so the rows screens take 5 on Weekend sale and
 * every section lands on page one in every density.
 */
function seedActivitySections(network: HarnessNetwork, saleCount = 8): void {
  seedEightComments(network);
  const t = network.world.tables;
  const entries = (t.inbox_entries ?? []).slice(-saleCount);
  const sale = entries[entries.length - 1];
  const postOf = (id: unknown): Row | undefined => (t.posts ?? []).find((p) => p.id === id);
  const salePost = postOf(sale?.entity_id);
  if (sale === undefined || salePost === undefined) throw new Error('no Weekend sale entry');
  const day = 86_400_000;
  const clone = (n: number, title: string, at: number, count: number, read: boolean): void => {
    const postId = `0190d8f0-0000-7000-8000-0000000000${n}0`;
    (t.posts ??= []).push({ ...salePost, id: postId, number: 90 + n, title });
    for (let k = 0; k < count; k += 1) {
      const commentId = `0190d8f0-0000-7000-8000-0000000000${n}${k + 1}`;
      const createdAt = new Date(at - k * 60_000).toISOString();
      (t.comments ??= []).push({
        ...((t.comments ?? []).find((c) => c.entity_id === salePost.id) ?? {}),
        id: commentId,
        entity_id: postId,
        body: `Round ${k + 1}: tighten the caption and swap the hero.`,
        created_at: createdAt,
      });
      entries.push({
        ...sale,
        id: `0190d8f1-0000-7000-8000-0000000000${n}${k + 1}`,
        entity_id: postId,
        payload: { comment_id: commentId },
        created_at: createdAt,
        read_at: read ? new Date(NOW - day).toISOString() : null,
      });
    }
  };
  clone(1, LONG_ACTIVITY_TITLE, NOW - day, 3, false);
  clone(2, 'Spring lookbook', NOW - 3 * day, 1, true);
  t.inbox_entries = entries;
}

/** The rows screens' feed: every section on page one in every density. */
const seedActivityRows = (network: HarnessNetwork): void => seedActivitySections(network, 5);

/**
 * Activity's sections painted (below the fold on a phone): Today and
 * Yesterday with their rows, Earlier too when `earlier` (the 8-new feed holds
 * 12 entries, past a phone's first page).
 */
async function activitySectionsReady(page: Page, earlier = true): Promise<void> {
  await waitFor([page.locator('[data-activity-new-chip]').first()], 'N new');
  for (const key of earlier ? ['today', 'yesterday', 'earlier'] : ['today', 'yesterday']) {
    await expect(
      page.locator(`[data-activity-section="${key}"] [data-list-card]`).first(),
      `${key} section`,
    ).toBeAttached();
  }
}

/**
 * Catch up open on one card with its body painted: the read rows
 * ([data-catch-up-rows]), never the Bone rows that hold the footprint while
 * the batched read runs.
 */
async function catchUpReady(page: Page): Promise<void> {
  const card = page.locator('[data-catch-up] [data-catch-up-card]');
  await waitFor([card], 'catch up card');
  await waitFor([card.locator('[data-catch-up-rows]')], 'catch up rows');
}

/** The open card's reply box (CatchUpReply). */
const catchUpReply = (page: Page): Locator =>
  page.locator('[data-catch-up] [data-catch-up-card] [data-catch-up-reply]');

/** The card's context strip opened (its reading window shows). */
async function openCatchUpStrip(page: Page): Promise<void> {
  await catchUpReady(page);
  await tap([page.locator('[data-catch-up-strip-toggle]')], 'context strip');
  await waitFor([page.locator('[data-catch-up-strip-window]')], 'strip window');
}

/** The reply box's + tray open (Photos, File, Assets). */
async function openCatchUpTray(page: Page): Promise<void> {
  await catchUpReady(page);
  await tap(
    [catchUpReply(page).getByRole('button', { name: 'Add attachment', exact: true })],
    'reply + key',
  );
  // In the reply box, or page-wide (the phone editor may lift the box to <body>).
  await waitFor(
    [catchUpReply(page).locator('[data-tray]'), page.locator('[data-tray]')],
    'reply tray',
  );
  await page.mouse.move(0, 0);
}

/** A recording running in the card's reply box (the stub microphone). */
async function catchUpRecording(page: Page): Promise<void> {
  await catchUpReady(page);
  await tap(
    [
      page.locator('[data-catch-up-mic] button'),
      catchUpReply(page).getByRole('button', { name: 'Record voice note', exact: true }),
    ],
    'reply mic',
  );
  await waitFor([page.locator('[data-catch-up-recording]')], 'recording row');
}

/** Type into the reply box and send it (the send's proc is refused: "Not sent"). */
async function catchUpSendRefused(page: Page, text: string): Promise<void> {
  await catchUpReady(page);
  await tap([page.locator('[data-catch-up-reply-input]')], 'reply box');
  await page.keyboard.type(text);
  await tap([catchUpReply(page).getByRole('button', { name: 'Send', exact: true })], 'Send');
  await waitFor([page.locator('[data-catch-up-not-sent]')], 'Not sent');
}

/**
 * Hold a swipe on the card mid-way in `dir`, the pointer kept down for the
 * shot. The travel is a share of the card width: past the tint at 15%, short
 * of the decision at 30%.
 */
async function holdSwipe(page: Page, dir: 1 | -1): Promise<void> {
  const card = page.locator('[data-catch-up] [data-catch-up-card]');
  const box = await card.boundingBox();
  if (box === null) throw new Error('catch up card has no box');
  const dx = dir * Math.round(box.width * 0.22);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 3;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let step = 1; step <= 8; step += 1) await page.mouse.move(x + (dx * step) / 8, y);
  await waitFor([page.locator('[data-catch-up-tint]')], 'swipe tint');
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

/** Bank ideas' ids (no plan): a starred one, one shown to the client, one untouched for 90 days. */
const BANK_IDEAS = [
  '0190d500-0000-7000-8000-00000000e501',
  '0190d500-0000-7000-8000-00000000e502',
  '0190d500-0000-7000-8000-00000000e503',
  '0190d500-0000-7000-8000-00000000e504',
] as const;
const BANK_BUCKETS = [
  '0190d500-0000-7000-8000-00000000e5b1',
  '0190d500-0000-7000-8000-00000000e5b2',
] as const;
const BANK_FIRST_TITLE = 'Founder story reel';

/**
 * The Plan tab plus the idea bank: four ideas (one starred, one shown to the
 * client, one with the library photo, one untouched for 120 days), two
 * buckets, comments on two of them.
 */
function seedBank(network: HarnessNetwork): void {
  seedTab(network);
  seedLibraryImage(network);
  const t = network.world.tables;
  const at = (daysAgo: number): string => new Date(NOW - daysAgo * 86_400_000).toISOString();
  const idea = (
    id: string,
    title: string,
    daysAgo: number,
    extra: Partial<Record<string, unknown>> = {},
  ): Row => ({
    id,
    workspace_id: WORKSPACE_ID,
    plan_id: null,
    kind: 'concept',
    position: 0,
    title,
    description: null,
    post_id: null,
    target_date: null,
    linked_post_id: null,
    created_by: ME,
    created_at: at(daysAgo + 3),
    updated_at: at(daysAgo),
    last_active_at: at(daysAgo),
    show_to_client: false,
    archived_at: null,
    starred_at: null,
    came_from_plan_title: null,
    deleted_at: null,
    ...extra,
  });
  (t.plan_items ??= []).push(
    idea(BANK_IDEAS[0], BANK_FIRST_TITLE, 1, { starred_at: at(1) }),
    idea(BANK_IDEAS[1], 'Behind the scenes carousel', 2, {
      show_to_client: true,
      came_from_plan_title: 'Week of 12 Oct',
    }),
    idea(BANK_IDEAS[2], 'Diwali gifting guide', 4),
    idea(BANK_IDEAS[3], 'Customer FAQ series', 120),
  );
  (t.workspace_buckets ??= []).push(
    {
      id: BANK_BUCKETS[0],
      workspace_id: WORKSPACE_ID,
      name: 'Product',
      color_hex: '#6b7280',
      position: 1,
      archived: false,
      created_at: '2026-01-01T00:00:00Z',
    },
    {
      id: BANK_BUCKETS[1],
      workspace_id: WORKSPACE_ID,
      name: 'Festive',
      color_hex: '#6b7280',
      position: 2,
      archived: false,
      created_at: '2026-01-01T00:00:00Z',
    },
  );
  (t.plan_item_buckets ??= []).push(
    { item_id: BANK_IDEAS[0], bucket_id: BANK_BUCKETS[0], workspace_id: WORKSPACE_ID },
    { item_id: BANK_IDEAS[2], bucket_id: BANK_BUCKETS[1], workspace_id: WORKSPACE_ID },
  );
  (t.asset_attachments ??= []).push({
    id: '0190d500-0000-7000-8000-00000000e5a1',
    workspace_id: WORKSPACE_ID,
    entity_type: 'plan_item',
    entity_id: BANK_IDEAS[0],
    asset_version_id: LIB_IMAGE_VERSION,
    position: 0,
    attached_at: at(1),
    deleted_at: null,
    asset_versions: { mime_type: 'image/png', kind: 'image' },
  });
  const comment = (id: string, item: string, body: string): Row => ({
    id,
    workspace_id: WORKSPACE_ID,
    item_id: item,
    author_user_id: ME,
    body,
    visibility: 'everyone',
    created_at: at(1),
    edited_at: null,
    deleted_at: null,
  });
  (t.plan_item_comments ??= []).push(
    comment('0190d500-0000-7000-8000-00000000e5c1', BANK_IDEAS[0], 'Open on the factory floor.'),
    comment('0190d500-0000-7000-8000-00000000e5c2', BANK_IDEAS[0], 'Keep it under a minute.'),
    comment('0190d500-0000-7000-8000-00000000e5c3', BANK_IDEAS[1], 'Approver asked for this.'),
  );
}

/**
 * The Bank with more ideas than one screen: seedBank plus 44 plain ideas
 * (past the 40-row fill ceiling on every device), so the first page ends with
 * Load more.
 */
function seedBankMany(network: HarnessNetwork): void {
  seedBank(network);
  const rows = (network.world.tables.plan_items ??= []);
  const template = rows.find((r) => r.id === BANK_IDEAS[2]);
  if (template === undefined) throw new Error('seedBankMany: no template idea');
  for (let i = 0; i < 44; i += 1) {
    const at = new Date(NOW - (10 + i) * 86_400_000).toISOString();
    rows.push({
      ...template,
      id: `0190d500-0000-7000-8000-0000000e6${String(i).padStart(3, '0')}`,
      title: `Idea ${String(i + 1).padStart(2, '0')}`,
      created_at: at,
      updated_at: at,
      last_active_at: at,
    });
  }
}

/** The Plan tab on the Bank chip (phone and laptop: the idea cards in the grid). */
async function bankReady(page: Page): Promise<void> {
  await waitFor([page.locator('[data-bank-row]').getByText(BANK_FIRST_TITLE)], 'bank');
}

/**
 * Select mode on the Bank: a long-press (phone) or right-click (laptop) on the
 * first idea's card ticks it and brings up the Bank's select bar.
 */
async function bankSelect(page: Page): Promise<void> {
  await bankReady(page);
  await selectGesture(page, page.locator(`[data-bank-row="${BANK_IDEAS[0]}"]`));
  await waitFor([page.locator('[data-bank-select-bar]')], 'bank select bar');
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
  await waitFor([page.locator('[data-member-email-mark="off"]').first()], 'settings members');
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
  { name: 'assets', seed: creator, url: '/assets', steps: assetsReady },
  { name: 'assets-approver', seed: approver, url: '/assets', steps: assetsReady },
  {
    name: 'assets-empty',
    seed: { ...creator, noAssets: true },
    url: '/assets',
    steps: async (page) => {
      await waitFor([page.locator('[data-chip-row]')], 'assets chip row');
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
      await waitFor([page.locator('[data-chip-row]')], 'briefs chip row');
      await waitFor([page.getByText('Briefs show up here.', { exact: false })], 'briefs zero');
    },
  },
  { name: 'chat-list', seed: creator, url: '/chat', steps: chatListAllRows },
  {
    name: 'chat-plan-card',
    seed: creator,
    extra: seedChatPlan,
    url: '/chat',
    steps: async (page) => {
      await openChatPlanCard(page);
    },
  },
  { name: 'chat-thread', seed: creator, url: '/chat', steps: openDm },
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
    // Past: Not done (overdue, bad tone) above Done.
    name: 'chat-tasks-past',
    seed: creator,
    extra: seedDatedTasks,
    url: '/chat',
    steps: async (page) => {
      const sheet = await openTasks(page);
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
    // Delete one gesture away: on a phone a row swiped left past the trigger
    // is queued (struck, Undo); on laptop the bin at the row's end does the
    // same, and every other row shows its bin.
    name: 'chat-tasks-delete',
    seed: creator,
    extra: seedDatedTasks,
    url: '/chat',
    steps: async (page) => {
      const sheet = await openTasks(page);
      const row = sheet.locator('[data-task-row-id]', { hasText: 'Hook options' });
      if (isLaptop(page)) {
        await tap([row.locator('[data-task-delete]')], 'row bin');
      } else {
        await swipeRow(row.locator('[data-task-title]'), -90);
      }
      await waitFor([row.locator('[data-task-undo-delete]')], 'queued row');
    },
  },
  {
    // Phone, mid-swipe: the row follows the finger left and the bin behind its
    // right edge is armed (ink fill) past the trigger.
    name: 'chat-tasks-swipe',
    seed: creator,
    extra: seedDatedTasks,
    only: 'phone',
    hold: true,
    url: '/chat',
    steps: async (page) => {
      const sheet = await openTasks(page);
      const row = sheet.locator('[data-task-row-id]', { hasText: 'Hook options' });
      await swipeRow(row.locator('[data-task-title]'), -80, { release: false });
      await waitFor([row.locator('[data-task-swipe-icon][data-armed]')], 'armed bin');
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
      await sheet.getByRole('button', { name: 'Back', exact: true }).first().click();
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
    // L10: the sheet's second page ("<" More actions).
    name: 'message-action-menu-more',
    seed: creator,
    url: '/chat',
    steps: async (page) => {
      await openDmMessageMenu(page);
      await tap([page.locator('[data-menu-item="more-actions"]')], 'More actions');
      await waitFor([page.locator('[data-menu-page="more"]')], 'More actions page');
    },
  },
  {
    // L1: the group chat, everyone on the left, square photos, name + time lines.
    name: 'chat-group-work',
    seed: creator,
    url: '/chat',
    steps: async (page) => {
      await openChat(page, GROUP_NAME);
      await threadStill(page);
    },
  },
  {
    // L3: a root's replies row in the main chat (a post-card thread).
    name: 'chat-replies-row',
    seed: creator,
    url: '/chat',
    steps: async (page) => {
      await openChat(page, MAYA_NAME);
      await waitFor([page.locator('[data-replies-row]').first()], 'replies row');
    },
  },
  {
    // L4: the thread screen (post-card title), root, "N replies", replies.
    name: 'chat-thread-screen',
    seed: creator,
    url: '/chat',
    steps: async (page) => {
      await openChat(page, MAYA_NAME);
      await tap(
        [page.locator('[data-replies-row]', { hasText: '4 replies' }).first().locator('button')],
        'replies row',
      );
      await waitFor([page.locator('[data-thread-separator]')], 'thread screen');
      await assertThreadHeader(page, 'chat-thread-screen');
    },
  },
  {
    // A thread on a plan card: the plan's title over the chat's name, the
    // plan card in the root (every card kind names its thread the same way).
    name: 'chat-thread-screen-plan',
    seed: creator,
    url: '/chat',
    extra: (network) => {
      seedChatPlan(network);
      (network.world.tables.chat_messages ??= []).push(
        planThreadReply(DM_CHANNEL, PEER, NOW + 30_000),
      );
    },
    steps: async (page) => {
      await openChat(page, PEER_NAME);
      await tap(
        [page.locator('[data-replies-row]', { hasText: '1 reply' }).last().locator('button')],
        'plan card replies row',
      );
      await waitFor(
        [
          page.locator('[data-thread-separator]'),
          page.locator(`[data-thread-view] [data-plan-card="${PLAN_ID}"]`),
        ],
        'plan card thread screen',
      );
      await assertThreadHeader(page, 'chat-thread-screen-plan');
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
    steps: async (page) => {
      await waitFor([page.getByText('Priya Raman mentioned you')], 'activity');
      // Unread rows on All: Mark all read fills the top bar's primary slot.
      await waitFor(
        [page.locator('[data-topbar-slot="primary"] [data-activity-mark-all]')],
        'Mark all read',
      );
    },
  },
  {
    // The idea bank's Activity rows (team viewer): added, shown, hidden, moved, planned.
    name: 'activity-bank',
    seed: creator,
    extra: seedBankActivity,
    url: '/activity',
    steps: async (page) =>
      waitFor([page.locator('[data-activity-event="bank_idea_planned"]')], 'bank activity'),
  },
  {
    // Activity twins Plan (10 Nov 2026): Today / Yesterday / Earlier, one
    // ui/ListCard row per item; "8 new" on Weekend sale, a long title with
    // "3 new" (the name truncates, the chip never does), a read item Earlier.
    name: 'activity-sections',
    seed: creator,
    extra: seedActivitySections,
    url: '/activity',
    steps: async (page) => {
      await waitFor([page.locator('[data-activity-new-chip]', { hasText: '8 new' })], '8 new');
      await activitySectionsReady(page, isLaptop(page));
    },
  },
  {
    // A chat thread card with replies: the mention's thread (root, replies,
    // the New line at the reply that mentions me).
    name: 'catch-up-thread-mention',
    seed: creator,
    extra: seedCatchUp,
    url: `/activity?catchup=${CATCH_UP_MENTION}`,
    steps: catchUpReady,
  },
  {
    // The same thread opened from its thread start alone (no mention): the
    // New line at the first reply.
    name: 'catch-up-thread-started',
    seed: creator,
    extra: (network) => seedCatchUp(network, { mention: false }),
    url: `/activity?catchup=${CATCH_UP_STARTED}`,
    steps: async (page) => {
      await catchUpReady(page);
      await waitFor([page.locator('[data-catch-up-card] [data-new-line]')], 'New line');
    },
  },
  {
    // A post card from a comment: name row, the strip (closed), the comment.
    name: 'catch-up-comment',
    seed: creator,
    extra: seedCatchUp,
    url: `/activity?catchup=${CATCH_UP_COMMENT}`,
    steps: async (page) => {
      await catchUpReady(page);
      await waitFor([page.locator(`[data-catch-up-message="${CATCH_UP_COMMENT_ID}"]`)], 'comment');
    },
  },
  {
    // Swipe right past half the threshold: the ink Mark as read tint.
    name: 'catch-up-swipe-read',
    seed: creator,
    extra: seedCatchUp,
    hold: true,
    url: `/activity?catchup=${CATCH_UP_MENTION}`,
    steps: async (page) => {
      await catchUpReady(page);
      await holdSwipe(page, 1);
    },
  },
  {
    // Swipe left: the soft Keep unread tint.
    name: 'catch-up-swipe-keep',
    seed: creator,
    extra: seedCatchUp,
    hold: true,
    url: `/activity?catchup=${CATCH_UP_MENTION}`,
    steps: async (page) => {
      await catchUpReady(page);
      await holdSwipe(page, -1);
    },
  },
  {
    // Typing in the reply box: phone hides the bar's Undo and the buttons and
    // shows Hide keyboard and the ink check; laptop keeps the buttons.
    name: 'catch-up-typing',
    seed: creator,
    extra: seedCatchUp,
    hold: true,
    url: `/activity?catchup=${CATCH_UP_MENTION}`,
    steps: async (page) => {
      await catchUpReady(page);
      await tap([page.locator('[data-catch-up-reply-input]')], 'reply box');
      await page.keyboard.type('On it');
      if (!isLaptop(page)) {
        await waitFor([page.locator('[data-catch-up-typing-read]')], 'typing check');
      }
    },
  },
  {
    // The end screen after the last card: "Everything's sorted."
    name: 'catch-up-end',
    seed: creator,
    extra: seedCatchUp,
    url: `/activity?catchup=${CATCH_UP_COMMENT}`,
    steps: async (page) => {
      await catchUpReady(page);
      const end = page.locator('[data-catch-up-end]');
      for (let n = 0; n < 40 && (await end.count()) === 0; n += 1) {
        const read = page.locator('[data-catch-up-read]');
        if ((await read.count()) > 0 && (await read.isEnabled())) await read.click();
        await page.waitForTimeout(300);
      }
      await waitFor([end], 'catch up end');
    },
  },
  {
    // A post card at rest: name row, the strip closed ("Caption · 5
    // pictures", due, first line), two comments (one with "1 reply"), the
    // reply pill, Keep unread | Mark as read.
    name: 'catch-up-rest',
    seed: creator,
    extra: (network) => seedCatchUpRest(network, NOW),
    url: `/activity?catchup=${CU_REST_ENTRY}`,
    steps: async (page) => {
      await catchUpReady(page);
      await waitFor([page.locator('[data-catch-up-strip] img')], 'strip thumbnail');
      await waitFor([page.locator('[data-catch-up-replies]')], '1 reply');
    },
  },
  {
    // The rest card's strip open on the carousel: the big picture with 1/5.
    name: 'catch-up-carousel',
    seed: creator,
    extra: (network) => seedCatchUpRest(network, NOW),
    url: `/activity?catchup=${CU_REST_ENTRY}`,
    steps: async (page) => {
      await openCatchUpStrip(page);
      await waitFor([page.locator('[data-catch-up-strip-picture]', { hasText: '1/5' })], '1/5');
    },
  },
  {
    // The carousel's big picture tapped: the lightbox over catch up.
    name: 'catch-up-lightbox',
    seed: creator,
    extra: (network) => seedCatchUpRest(network, NOW),
    url: `/activity?catchup=${CU_REST_ENTRY}`,
    steps: async (page) => {
      await openCatchUpStrip(page);
      await tap([page.locator('[data-catch-up-strip-picture]')], 'strip picture');
      await waitFor([page.getByRole('dialog', { name: 'Image viewer' })], 'lightbox');
    },
  },
  {
    // The name row tapped: the card's menu (Open post, Copy link).
    name: 'catch-up-menu',
    seed: creator,
    extra: (network) => seedCatchUpRest(network, NOW),
    hold: true,
    url: `/activity?catchup=${CU_REST_ENTRY}`,
    steps: async (page) => {
      await catchUpReady(page);
      await tap([page.locator('[data-catch-up-name-row-button]')], 'name row');
      await waitFor(menuRow(page, /Copy link/), 'card menu');
      await page.mouse.move(0, 0);
    },
  },
  {
    // The comment card's reply box with its + tray open (Photos, File, Assets).
    name: 'catch-up-tray-comment',
    seed: creator,
    extra: (network) => seedCatchUpRest(network, NOW),
    hold: true,
    url: `/activity?catchup=${CU_REST_ENTRY}`,
    steps: openCatchUpTray,
  },
  {
    // The chat card's reply box with its + tray open.
    name: 'catch-up-tray-chat',
    seed: creator,
    extra: seedCatchUp,
    hold: true,
    url: `/activity?catchup=${CATCH_UP_MENTION}`,
    steps: openCatchUpTray,
  },
  {
    // The chat card's mic tapped: the recording row in the reply box (the
    // stub microphone; the running clock is masked).
    name: 'catch-up-recording',
    seed: creator,
    extra: seedCatchUp,
    prepare: stubRecorder,
    url: `/activity?catchup=${CATCH_UP_MENTION}`,
    mask: (page) => [page.locator('[data-catch-up-recording]').getByText(/^\d+:\d{2}$/)],
    steps: catchUpRecording,
  },
  {
    // Stop and keep: the voice note waits in the box as a chip, its upload
    // held in flight (the ring, no bar).
    name: 'catch-up-voice-chip',
    seed: creator,
    extra: seedCatchUp,
    prepare: stubUploadingVoice,
    url: `/activity?catchup=${CATCH_UP_MENTION}`,
    steps: async (page) => {
      await catchUpRecording(page);
      // Over MIN_VOICE_NOTE_MS, so the note is kept and not dropped.
      await page.waitForTimeout(1_100);
      await tap(
        [page.getByRole('button', { name: 'Stop and keep voice note', exact: true })],
        'Stop and keep',
      );
      await waitFor([page.locator('[data-catch-up-voice-chip]')], 'voice chip');
    },
  },
  {
    // The main chat's "4 replies" tapped: the thread full screen (bar
    // "Thread" over the chat, the root, "N replies", the replies, Reply in thread).
    name: 'catch-up-thread-full',
    seed: creator,
    extra: (network) => seedCatchUpGroupMain(network, NOW),
    url: `/activity?catchup=${CU_GROUP_MAIN_ENTRY}`,
    steps: async (page) => {
      await catchUpReady(page);
      await tap([page.locator('[data-catch-up-replies]', { hasText: '4 replies' })], '4 replies');
      await waitFor(
        [page.locator('[data-catch-up-thread-replies] [data-catch-up-message]')],
        'replies',
      );
      await waitFor([page.locator('[data-catch-up-thread-title]')], 'Thread title');
    },
  },
  {
    // A one-message chat (chat-main): one DM message that mentions me.
    name: 'catch-up-chat-main',
    seed: creator,
    extra: (network) => seedCatchUpChatMain(network, NOW),
    url: `/activity?catchup=${CU_CHAT_MAIN_ENTRY}`,
    steps: async (page) => {
      await catchUpReady(page);
      await waitFor([page.locator('[data-catch-up-mention-me]')], 'my @name lit');
    },
  },
  {
    // A comment by a 25-character name: one line, truncating before the time.
    name: 'catch-up-long-name',
    seed: creator,
    extra: (network) => seedCatchUpLongName(network, NOW),
    url: `/activity?catchup=${CU_LONG_NAME_ENTRY}`,
    steps: async (page) => {
      await catchUpReady(page);
      await waitFor(
        [page.locator('[data-catch-up-name]', { hasText: 'Bartholomew' })],
        'long name',
      );
    },
  },
  {
    // A 90-character post title: the name row truncates it on one line.
    name: 'catch-up-long-title',
    seed: creator,
    extra: (network) => seedCatchUpLongTitle(network, NOW),
    url: `/activity?catchup=${CU_LONG_TITLE_ENTRY}`,
    steps: async (page) => {
      await catchUpReady(page);
      await waitFor(
        [page.locator('[data-catch-up-title]', { hasText: 'Autumn lookbook carousel' })],
        'title',
      );
    },
  },
  {
    // A 1,200-character caption, the strip open: the reading window scrolls itself.
    name: 'catch-up-long-caption',
    seed: creator,
    extra: (network) => seedCatchUpLongCaption(network, NOW),
    url: `/activity?catchup=${CU_LONG_CAPTION_ENTRY}`,
    steps: openCatchUpStrip,
  },
  {
    // A comment of 34 emoji (wraps inside the text column).
    name: 'catch-up-emoji',
    seed: creator,
    extra: (network) => seedCatchUpEmoji(network, NOW),
    url: `/activity?catchup=${CU_EMOJI_ENTRY}`,
    steps: catchUpReady,
  },
  {
    // A comment with a 120-character unbroken link: a short label, never overflowing.
    name: 'catch-up-long-link',
    seed: creator,
    extra: (network) => seedCatchUpLongLink(network, NOW),
    url: `/activity?catchup=${CU_LINK_ENTRY}`,
    steps: async (page) => {
      await catchUpReady(page);
      await waitFor([page.locator('[data-catch-up-link]')], 'link');
    },
  },
  {
    // A comment with 10 blank lines inside: folded, never a tall gap.
    name: 'catch-up-blank-lines',
    seed: creator,
    extra: (network) => seedCatchUpBlankLines(network, NOW),
    url: `/activity?catchup=${CU_BLANK_LINES_ENTRY}`,
    steps: catchUpReady,
  },
  {
    // 50 new comments on one post: the newest page (older rows load on scroll
    // up, one Bone row above), placed by the fill rule.
    name: 'catch-up-many-comments',
    seed: creator,
    extra: (network) => seedCatchUpManyComments(network, NOW),
    url: `/activity?catchup=${CU_MANY_ENTRY}`,
    steps: catchUpReady,
  },
  {
    // A video post: the strip's thumbnail carries the play mark ("Caption · Video").
    name: 'catch-up-video',
    seed: creator,
    extra: (network) => seedCatchUpVideo(network, NOW),
    url: `/activity?catchup=${CU_VIDEO_ENTRY}`,
    steps: async (page) => {
      await catchUpReady(page);
      await waitFor([page.locator('[data-catch-up-strip]', { hasText: 'Video' })], 'video strip');
    },
  },
  {
    // A text-only post: the strip reads "Caption" with the first line, no thumbnail.
    name: 'catch-up-text-only',
    seed: creator,
    extra: (network) => seedCatchUpTextOnly(network, NOW),
    url: `/activity?catchup=${CU_TEXT_ENTRY}`,
    steps: async (page) => {
      await catchUpReady(page);
      await waitFor([page.locator('[data-catch-up-strip]')], 'strip');
    },
  },
  {
    // The text-only post's caption open in the strip's reading window.
    name: 'catch-up-caption-open',
    seed: creator,
    extra: (network) => seedCatchUpTextOnly(network, NOW),
    url: `/activity?catchup=${CU_TEXT_ENTRY}`,
    steps: openCatchUpStrip,
  },
  {
    // A plan item card: "Plan · Week of 19 Oct", its notes, the plan comments.
    name: 'catch-up-plan-item',
    seed: creator,
    extra: (network) => seedCatchUpPlanItem(network, NOW),
    url: `/activity?catchup=${CU_PLAN_ENTRY}`,
    steps: async (page) => {
      await catchUpReady(page);
      await waitFor([page.locator('[data-catch-up-kind="plan-item"]')], 'plan item card');
    },
  },
  {
    // A bank idea card: "Idea · Bank", a colleague's comment.
    name: 'catch-up-bank-idea',
    seed: creator,
    extra: (network) => seedCatchUpBankIdea(network, NOW),
    url: `/activity?catchup=${CU_IDEA_ENTRY}`,
    steps: async (page) => {
      await catchUpReady(page);
      await waitFor([page.locator('[data-catch-up-kind="idea"]')], 'idea card');
    },
  },
  {
    // A brief created for me with no due day: "Brief", no due words, the event row.
    name: 'catch-up-brief-no-due',
    seed: creator,
    extra: (network) => seedCatchUpBrief(network, NOW),
    url: `/activity?catchup=${CU_BRIEF_ENTRY}`,
    steps: async (page) => {
      await catchUpReady(page);
      await waitFor([page.locator('[data-catch-up-event]')], 'brief event row');
    },
  },
  {
    // A feedback batch with mixed states: three numbered points (the resolved
    // one folded), a comment and the stage change, on one post card.
    name: 'catch-up-feedback',
    seed: creator,
    extra: (network) => seedCatchUpFeedback(network, NOW),
    url: `/activity?catchup=${CU_FEEDBACK_ENTRY}`,
    steps: async (page) => {
      await catchUpReady(page);
      const card = page.locator(`[data-catch-up-card="post:${CU_FEEDBACK_POST}"]`);
      await waitFor([card.locator('[data-catch-up-point]')], 'points');
      await waitFor([page.locator('[data-catch-up-event]')], 'stage change row');
    },
  },
  {
    // Offline send failure: the chat send and comment create procs refused,
    // a reply typed and sent on the thread card: "Not sent" with Retry.
    name: 'catch-up-not-sent',
    seed: creator,
    extra: (network) => {
      seedCatchUp(network);
      network.refuseRpc.add('chat_message_send');
      network.refuseRpc.add('comment_create');
    },
    url: `/activity?catchup=${CATCH_UP_MENTION}`,
    steps: async (page) => catchUpSendRefused(page, 'Posting it at noon'),
  },
  {
    // A failed read: the posts read fails, so the post card shows its error
    // state with Retry (the reply box and buttons stay usable).
    name: 'catch-up-error',
    seed: creator,
    extra: (network) => {
      seedCatchUpTextOnly(network, NOW);
      network.failTable.add('posts');
    },
    url: `/activity?catchup=${CU_TEXT_ENTRY}`,
    steps: async (page) => {
      await waitFor([page.locator('[data-catch-up] [data-catch-up-card]')], 'catch up card');
      await waitFor([page.locator('[data-catch-up-error]')], 'card error');
    },
  },
  {
    // 9 Nov 2026: the one thread strip with replies ("4 replies", ink), the
    // keys on the right; the root 12 over it, the replies 8 under it.
    name: 'chat-thread-replies',
    seed: creator,
    url: '/chat',
    steps: async (page) => {
      await openChat(page, MAYA_NAME);
      await tap(
        [page.locator('[data-replies-row]', { hasText: '4 replies' }).first().locator('button')],
        'replies row',
      );
      await waitFor([page.locator('[data-thread-view] [data-thread-strip="replies"]')], 'strip');
    },
  },
  {
    // 9 Nov 2026: the replies row with the last reply today: photos, "4
    // replies" (semibold ink), "Today at 10:12 AM" (fg-3), the dot; no reply text.
    name: 'chat-replies-row-today',
    seed: creator,
    url: '/chat',
    steps: async (page) => {
      await openChat(page, MAYA_NAME);
      await waitFor(
        [page.locator('[data-replies-row]', { hasText: '4 replies' }).first()],
        'replies row',
      );
      await waitFor(
        [page.locator('[data-replies-row] [data-replies-time]', { hasText: 'Today at' }).first()],
        'today time',
      );
    },
  },
  {
    // The same row with the thread 3 days old: the date form ("18 Oct at
    // 10:12 AM"), never a weekday (rowWhen).
    name: 'chat-replies-row-older',
    seed: creator,
    extra: (network) => {
      const back = 3 * 24 * 60 * 60_000;
      for (const m of network.world.tables.chat_messages ?? []) {
        if (m.channel_id !== THREAD_DM || typeof m.created_at !== 'string') continue;
        m.created_at = new Date(Date.parse(m.created_at) - back).toISOString();
      }
    },
    url: '/chat',
    steps: async (page) => {
      await openChat(page, MAYA_NAME);
      await waitFor(
        [page.locator('[data-replies-row]', { hasText: '4 replies' }).first()],
        'replies row',
      );
      await waitFor(
        [page.locator('[data-replies-row] [data-replies-time]', { hasText: '18 Oct at' }).first()],
        'older time',
      );
    },
  },
  {
    // Catch up's thread view with no replies: the shared strip reads "Reply
    // in thread"; a tap focuses the reply box (checked after the shot).
    name: 'catch-up-thread-empty',
    seed: creator,
    extra: (network) => seedCatchUpChatMain(network, NOW),
    url: `/activity?catchup=${CU_CHAT_MAIN_ENTRY}`,
    steps: async (page) => {
      await catchUpReady(page);
      await tap([page.locator('[data-catch-up-open-thread]').first()], 'open thread');
      await waitFor([page.locator('[data-catch-up-thread] [data-thread-strip="empty"]')], 'strip');
    },
    after: async (page) => {
      await page.locator('[data-thread-strip-focus]').click();
      const focused = await page.evaluate(
        () => document.activeElement?.closest('[data-catch-up-thread-reply]') !== null,
      );
      expect(focused, 'Reply in thread focuses the reply box').toBe(true);
    },
  },
  {
    // Catch up's thread view with replies: the shared strip "4 replies".
    name: 'catch-up-thread-replies',
    seed: creator,
    extra: (network) => seedCatchUpGroupMain(network, NOW),
    url: `/activity?catchup=${CU_GROUP_MAIN_ENTRY}`,
    steps: async (page) => {
      await catchUpReady(page);
      await tap([page.locator('[data-catch-up-replies]', { hasText: '4 replies' })], '4 replies');
      await waitFor(
        [page.locator('[data-catch-up-thread] [data-thread-strip="replies"]')],
        'strip',
      );
      await waitFor(
        [page.locator('[data-catch-up-thread-replies] [data-catch-up-message]')],
        'replies',
      );
    },
  },
  {
    // The thread view redo: the root at the top, the "N replies" divider with
    // Add to Tasks, Forward and More actions on the root.
    name: 'chat-thread-view-divider',
    seed: creator,
    url: '/chat',
    steps: async (page) => {
      await openChat(page, MAYA_NAME);
      await tap(
        [page.locator('[data-replies-row]', { hasText: '4 replies' }).first().locator('button')],
        'replies row',
      );
      await waitFor(
        [page.locator('[data-thread-view]').getByRole('button', { name: 'More actions' })],
        'thread divider icons',
      );
    },
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
    // Plan tab: ListCard boxes in the list grid (phone and laptop).
    name: 'boxes-plan-tab',
    seed: creator,
    extra: (network) => {
      seedTab(network);
      neverAnswers(network, { rpcs: ['plan_bundle_read'] });
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
      // The Buckets card with both buckets picked (saved, so no signal).
      const card = page.locator('[data-plan-page="item"] [data-plan-buckets]');
      await waitFor(
        [card.locator(`[data-plan-bucket="${CHAT_PLAN_BUCKETS[1]}"][aria-pressed="true"]`)],
        'buckets card',
      );
      await card.scrollIntoViewIfNeeded();
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
    // The bank idea's ⋯ menu: Plan it, Edit idea, Send to chat, Show to
    // client, Star, Archive, Delete last.
    name: 'plan-item-bank-more-menu',
    seed: creator,
    extra: seedBankIdea,
    url: `/plan/bank?item=${PLAN_CONCEPT_ITEM}`,
    steps: async (page) => {
      await waitFor([page.locator('[data-plan-page="item"] [data-plan-who-can-see]')], 'bank idea');
      await tap([page.locator('[data-plan-item-more]')], 'item more');
      await waitFor([page.getByRole('menuitem', { name: /Plan it/ })], 'more menu');
    },
  },
  {
    // A team only idea sent into the DM with the client: "Show this idea to
    // the client?" with Cancel, Send in Team instead, Show and send.
    name: 'chat-idea-share-sheet',
    seed: creator,
    extra: seedBankIdea,
    url: `/plan/bank?item=${PLAN_CONCEPT_ITEM}`,
    steps: async (page) => {
      await waitFor([page.locator('[data-plan-page="item"] [data-plan-who-can-see]')], 'bank idea');
      await tap([page.locator('[data-plan-item-more]')], 'item more');
      await tap([page.getByRole('menuitem', { name: /Send to chat/ })], 'Send to chat');
      await tap([page.locator(`[data-plan-forward-target="${DM_CHANNEL}"]`)], 'client DM');
      await waitFor([page.locator('[data-idea-share-ask]')], 'idea share sheet');
    },
  },
  {
    // The idea card in the DM: eyebrow Idea, title, "Bank · 1 comments" line.
    name: 'chat-idea-card',
    seed: creator,
    extra: seedIdeaCard,
    url: '/chat',
    steps: async (page) => {
      await openChat(page, PEER_NAME);
      const card = page.locator(`[data-idea-card="${PLAN_CONCEPT_ITEM}"]`).last();
      await card.scrollIntoViewIfNeeded();
      await waitFor([card], 'idea card');
    },
  },
  {
    // Forward a Draft plan into the client DM: "Open this plan for approvers?".
    name: 'plan-share-draft-sheet',
    seed: creator,
    extra: seedDraftPlanCard,
    url: '/chat',
    steps: async (page) => {
      await openChat(page, GROUP_NAME);
      const card = page.locator(`[data-plan-card="${TEAM_PLAN_ID}"]`).last();
      await card.scrollIntoViewIfNeeded();
      await tap([card.locator('[data-plan-forward]')], 'Forward');
      await tap([page.locator(`[data-plan-forward-target="${DM_CHANNEL}"]`)], 'client DM');
      await waitFor([page.locator('[data-plan-open-send]')], 'open and send sheet');
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
    // A bank idea (no plan) on its own route: header Idea, subline Bank, the
    // Came from line, Date "No date", no Approvers row or plan menu.
    name: 'plan-item-bank',
    seed: creator,
    extra: seedBankIdea,
    url: `/plan/bank?item=${PLAN_CONCEPT_ITEM}`,
    steps: async (page) => {
      await waitFor([page.locator('[data-plan-page="item"] [data-plan-came-from]')], 'bank idea');
      await waitFor([page.locator('[data-plan-file-name]')], 'bank idea files');
      // The Who can see this card (agency, bank idea) below the details.
      const who = page.locator('[data-plan-page="item"] [data-plan-who-can-see]');
      await waitFor([who], 'who can see');
      await who.scrollIntoViewIfNeeded();
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
    // A concept moved to the bank leaves a quiet line on its day (agency).
    name: 'plan-screen-trace',
    seed: creator,
    extra: seedChatPlanTrace,
    url: '/chat',
    steps: async (page) => {
      await openChatPlan(page);
      const trace = page.locator(`[data-plan-page="plan"] [data-plan-trace="${TRACE_ITEM}"]`);
      await waitFor([trace], 'trace line');
      await trace.scrollIntoViewIfNeeded();
    },
  },
  {
    // The Plan screen's Add: From bank opens the bank picker (starred first).
    name: 'plan-from-bank',
    seed: creator,
    extra: seedChatPlanBank,
    url: '/chat',
    steps: async (page) => {
      await openChatPlan(page);
      await tap([page.locator('[data-plan-add-header]')], 'Add');
      await tap([page.locator('[data-plan-add-sheet]').getByText('From bank')], 'From bank');
      await waitFor(
        [page.locator(`[data-plan-from-bank-idea="${FROM_BANK_IDEAS[0]}"]`)],
        'from bank list',
      );
    },
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
    // The week chips: a chip with no plans in it shows the zero line.
    name: 'plan-tab-week-zero',
    only: 'phone',
    seed: creator,
    extra: seedTab,
    url: '/plan',
    steps: async (page) => {
      await waitFor([page.getByText('Autumn launch')], 'plan');
      await tap([page.locator('[data-plan-tab-when="past"]')], 'Past');
      await waitFor([page.locator('[data-plan-tab-chip-zero]')], 'week zero');
    },
  },
  {
    // The Bank chip: idea ListCards (picture, title, text, last active, bucket).
    name: 'plan-tab-bank',
    seed: creator,
    extra: seedBank,
    url: '/plan?week=bank',
    steps: bankReady,
  },
  {
    // More ideas than one screen: the first page (the fill count), scrolled
    // to the shared Load more (Button level, left aligned).
    name: 'plan-tab-bank-load-more',
    seed: creator,
    extra: seedBankMany,
    url: '/plan?week=bank',
    steps: async (page) => {
      await bankReady(page);
      const more = page.locator('[data-plan-tab-load-more]').first();
      await waitFor([more], 'bank Load more');
      await more.scrollIntoViewIfNeeded();
    },
  },
  {
    name: 'plan-tab-bank-filter',
    seed: creator,
    extra: seedBank,
    url: '/plan?week=bank',
    steps: async (page) => {
      await bankReady(page);
      await tap([page.locator('[data-bank-filter-open]').first()], 'Filter and sort');
      await waitFor(
        [page.locator('[data-bank-filter-sheet] [data-bank-bucket]').first()],
        'filter sheet',
      );
    },
  },
  {
    // A bucket's menu inside the Filter and sort sheet: phone swaps the
    // Buckets card's body for Back, Rename, Delete bucket (no second Sheet);
    // laptop opens the ActionMenu popover anchored to the chip.
    name: 'plan-tab-bank-filter-bucket-menu',
    seed: creator,
    extra: seedBank,
    url: '/plan?week=bank',
    steps: async (page) => {
      await bankReady(page);
      await tap([page.locator('[data-bank-filter-open]').first()], 'Filter and sort');
      const chip = page.locator(`[data-bank-filter-sheet] [data-bank-bucket="${BANK_BUCKETS[0]}"]`);
      await tap([chip], 'bucket chip');
      await tap([chip], 'picked bucket chip again');
      await waitFor(
        [
          page.locator(`[data-bank-bucket-menu="${BANK_BUCKETS[0]}"]`),
          page.getByRole('menuitem', { name: /Rename/ }),
        ],
        'bucket menu',
      );
    },
  },
  {
    name: 'plan-tab-bank-select',
    seed: creator,
    extra: seedBank,
    url: '/plan?week=bank',
    steps: async (page) => {
      // Bank select mode: the first idea ticked, the select bar at the bottom.
      await bankSelect(page);
    },
  },
  {
    name: 'plan-tab-bank-add',
    seed: creator,
    extra: seedBank,
    url: '/plan?week=bank',
    steps: async (page) => {
      await bankReady(page);
      await tap([page.locator('[data-topbar-plus][aria-label="Add idea"]')], 'Add idea');
      await waitFor([page.locator('[data-bank-add]')], 'add idea sheet');
    },
  },
  {
    name: 'plan-tab-bank-plan-it',
    seed: creator,
    extra: seedBank,
    url: '/plan?week=bank',
    steps: async (page) => {
      await bankSelect(page);
      await tap([page.locator('[data-bank-select-plan-it]')], 'Plan it');
      await waitFor([page.locator('[data-bank-plan-it]')], 'plan it sheet');
    },
  },
  {
    name: 'post-detail',
    seed: creator,
    url: `/posts/${POST}`,
    steps: postDetailReady,
    after: postScreenChecks,
  },
  {
    name: 'post-detail-approver',
    seed: approver,
    url: `/posts/${POST}`,
    steps: postDetailReady,
    after: postScreenChecks,
  },
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
    steps: async (page) => {
      await waitFor([page.getByText('Brand name', { exact: true })], 'settings workspace');
      // The approved addresses list loads after the panel paints: shoot once it settles,
      // so the frame never races the list read.
      const addresses = page.locator('[data-approved-addresses]');
      if ((await addresses.count()) > 0) {
        await page.locator('[data-approved-addresses="ready"]').waitFor({ timeout: 15_000 });
      }
    },
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
        [page.locator('[data-group-page]').getByRole('button', { name: 'Back', exact: true })],
        'group info',
      );
    },
  },
  {
    // Owner viewer: every active row carries the catch-up email mark; Ana has
    // opted out, so both the on and the off (struck) mail glyph paint.
    name: 'members',
    seed: creator,
    extra: (network) => {
      for (const u of network.world.tables.users ?? []) {
        if (u.id === COLLEAGUE_B) u.email_opt_in = false;
      }
    },
    url: '/settings?panel=members',
    steps: async (page) =>
      waitFor([page.locator('[data-member-email-mark="off"]').first()], 'settings members'),
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

// A plan screen holding today (Wed 21 Oct, the solid accent tile and its
// "Today" pill): laptop light and dark, and the phone (iPhone light and dark
// projects).
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

// Density (Compact / Cozy / Calm, 8 Nov 2026; Cozy is the default every other
// screen shows). The device's density is set before the app boots: the boot
// key (src/lib/density bootDensity) and this account's key (adoptUserDensity),
// with the users row agreeing so the profile read's reconcile keeps it.
type VisualDensity = 'compact' | 'cozy' | 'calm';

/** A prepare step that boots the app in `density` on this device for ME. */
function withDensity(density: VisualDensity) {
  return async (network: HarnessNetwork, page: Page): Promise<void> => {
    for (const u of network.world.tables.users ?? []) {
      if (u.id === ME) u.density = density;
    }
    await page.addInitScript(
      ([bootKey, userKey, value]) => {
        window.localStorage.setItem(bootKey, value);
        window.localStorage.setItem(userKey, value);
      },
      ['sorted-density', `sorted-density:${ME}`, density] as const,
    );
  };
}

/** <html data-density> is the density the screen was asked for (before the shot). */
async function expectDensity(page: Page, density: VisualDensity): Promise<void> {
  await expect(page.locator('html')).toHaveAttribute('data-density', density);
}

/** The account menu (Topbar avatar), open on its Density row. */
async function openAccountMenuDensity(page: Page): Promise<void> {
  await tap([page.getByRole('button', { name: 'Account menu' })], 'Account menu');
  await waitFor([page.locator('[data-density-row]')], 'Density row');
  await waitFor([page.locator('[data-density-pick="cozy"][data-selected="true"]')], 'Cozy picked');
}

// The account menu with the Density row under Appearance (Cozy picked).
SCREENS.push({
  name: 'account-menu-density',
  seed: creator,
  url: '/pipeline',
  steps: async (page) => {
    await pipelineReady(page);
    await openAccountMenuDensity(page);
  },
});

// New plan (agency): Add from bank opens the bank picker in many-pick mode.
SCREENS.push({
  name: 'new-plan-bank',
  seed: creator,
  extra: seedChatPlanBank,
  url: '/chat',
  steps: async (page) => {
    await openDm(page);
    await pickTrayTile(page, 'plan');
    const plans = page.getByRole('dialog', { name: 'Plans' });
    await tap([plans.locator('[data-plan-pick-new]')], 'New plan');
    const compose = page.locator('[data-plan-page="compose"]');
    await tap([compose.locator('[data-plan-add-bank]')], 'Add from bank');
    await waitFor(
      [page.locator(`[data-plan-from-bank-idea="${FROM_BANK_IDEAS[0]}"]`)],
      'bank picker list',
    );
  },
});

// The plan screen in each density.
for (const density of ['compact', 'cozy', 'calm'] as const) {
  SCREENS.push({
    name: `plan-screen-${density}`,
    seed: creator,
    extra: seedChatPlan,
    prepare: withDensity(density),
    url: '/chat',
    steps: async (page) => {
      await openChatPlan(page);
      await expectDensity(page, density);
    },
  });
}

// The two list screens in the non-default densities (rows 60 / 80, chips 32 /
// 40; layout-checks reads <html data-density> for the list-card and chip rules).
for (const density of ['compact', 'calm'] as const) {
  SCREENS.push({
    name: `pipeline-${density}`,
    seed: creator,
    prepare: withDensity(density),
    url: '/pipeline',
    steps: async (page) => {
      await pipelineReady(page);
      await expectDensity(page, density);
    },
  });
  SCREENS.push({
    name: `chat-list-${density}`,
    seed: creator,
    prepare: withDensity(density),
    url: '/chat',
    steps: async (page) => {
      await chatListAllRows(page);
      await expectDensity(page, density);
    },
  });
}

// Activity's rows in each density (10 Nov 2026, Activity twins Plan): the
// Cozy screen boots in Cozy explicitly, Compact and Calm are its twins.
const activityRowsSteps =
  (density: VisualDensity) =>
  async (page: Page): Promise<void> => {
    await activitySectionsReady(page);
    await expectDensity(page, density);
  };
SCREENS.push({
  name: 'activity-rows',
  seed: creator,
  extra: seedActivityRows,
  prepare: withDensity('cozy'),
  url: '/activity',
  steps: activityRowsSteps('cozy'),
});
for (const density of ['compact', 'calm'] as const) {
  SCREENS.push({
    name: `activity-rows-${density}`,
    seed: creator,
    extra: seedActivityRows,
    prepare: withDensity(density),
    url: '/activity',
    steps: activityRowsSteps(density),
  });
}

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
  // The picked chip shows its Clear (Clear <chip> filter) in every chip screen.
  await waitFor([page.locator('[data-chip-clear]')], `${kind} chip Clear`);
  const results = page.locator(`[data-media-results="${kind}"]`);
  await waitFor([results], `${kind} results`);
  await waitFor(
    [results.locator('[data-media-tile]'), results.locator('[data-media-row]')],
    `${kind} items`,
  );
  if (kind === 'video') await waitFor([results.locator('[data-media-duration]')], 'duration');
  return results;
}

/**
 * Open the photo viewer on the first tile. A tap that lands while the chip's
 * cached page swaps for the network page can hit a tile that is being
 * replaced, so tap again (at most three times) until the viewer is up.
 */
async function openFirstPhoto(page: Page, results: Locator): Promise<void> {
  const viewer = page.getByRole('dialog', { name: 'Image viewer' });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await tap([results.locator('[data-media-tile]').first()], 'first photo tile');
    const opened = await viewer
      .waitFor({ state: 'visible', timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    if (opened) return;
  }
  throw new Error('not reached: photo viewer');
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
      await openFirstPhoto(page, results);
      await waitFor([page.locator('[data-lightbox-title]')], 'viewer title');
      await waitFor([page.locator('[data-show-in-chat]')], 'Show in chat');
    },
  });
}

// The six ui/ListCard lists, chip by chip (7 Nov 2026): Pipeline (each stage
// chip and All), Assets (each tab and select mode), Activity (each chip) and
// the Plan tab (each chip; Bank is plan-tab-bank). The default chip of each is
// its base screen (pipeline: Review, assets: All, notifications: All,
// plan-tab: Upcoming). Phone light/dark and laptop light come from the
// projects; LAPTOP_DARK_SCREENS adds laptop dark. A chip with nothing under it
// shows its zero line, which is shot as it is.

/**
 * The list painted: a ListCard, or the chip's zero line ("{Things} show up
 * here.").
 */
async function listOrZero(page: Page, what: string, extra: Locator[] = []): Promise<void> {
  await waitFor(
    [
      page.locator('[data-list-card]'),
      ...extra,
      page.getByText(/show up here\./),
      page.getByText(/^No results/),
    ],
    what,
  );
}

const PIPELINE_CHIP_SCREENS = ['all', 'draft', 'approved', 'parked', 'rejected'] as const;
for (const stage of PIPELINE_CHIP_SCREENS) {
  SCREENS.push({
    name: `pipeline-chip-${stage}`,
    seed: creator,
    url: `/pipeline?stage=${stage}`,
    steps: async (page) => {
      await waitFor(
        [page.locator('[data-chip-row]').locator('button[aria-current="true"]')],
        `${stage} chip`,
      );
      await listOrZero(page, `pipeline ${stage}`);
    },
  });
}

// Docs holds PDFs, documents and sheets (?type=pdf and ?type=sheets land on it).
const ASSET_TAB_SCREENS = [
  { tab: 'media', label: 'Media' },
  { tab: 'docs', label: 'Docs' },
  { tab: 'links', label: 'Links' },
] as const;
for (const { tab, label } of ASSET_TAB_SCREENS) {
  SCREENS.push({
    name: `assets-tab-${tab}`,
    seed: creator,
    url: `/assets?type=${tab}`,
    steps: async (page) => {
      await waitFor(
        [page.getByRole('tab', { name: new RegExp(`^${label}(\\s\\d+)?$`), selected: true })],
        `${label} tab`,
      );
      await listOrZero(page, `assets ${tab}`);
    },
  });
}

// All, Unread, Mentions (the Briefs and Plans chips are gone; All is notifications).
const ACTIVITY_CHIP_SCREENS = [
  { chip: 'unread', label: 'Unread' },
  { chip: 'mentions', label: 'Mentions' },
] as const;
for (const { chip, label } of ACTIVITY_CHIP_SCREENS) {
  SCREENS.push({
    name: `activity-chip-${chip}`,
    seed: creator,
    url: '/activity',
    steps: async (page) => {
      await waitFor([page.getByText('Priya Raman mentioned you')], 'activity');
      const chips = page.locator('[data-activity-chips]');
      await tap([chips.getByRole('button', { name: new RegExp(`^${label}\\b`) })], `${label} chip`);
      await waitFor(
        [chips.locator('button[aria-pressed="true"]', { hasText: label })],
        `${label} chip on`,
      );
      await listOrZero(page, `activity ${chip}`);
    },
  });
}

// Bank, Upcoming, Past: Upcoming is plan-tab, Bank is plan-tab-bank.
const PLAN_TAB_CHIP_SCREENS = ['past'] as const;
for (const chip of PLAN_TAB_CHIP_SCREENS) {
  SCREENS.push({
    name: `plan-tab-chip-${chip}`,
    seed: creator,
    extra: seedTab,
    url: `/plan?week=${chip}`,
    steps: async (page) => {
      await waitFor(
        [page.locator(`[data-plan-tab-when="${chip}"][aria-pressed="true"]`)],
        `${chip} chip`,
      );
      await listOrZero(page, `plan tab ${chip}`, [page.locator('[data-plan-tab-chip-zero]')]);
    },
  });
}

// Assets in select mode: a long-press (phone) or right-click (laptop) on a
// card starts it with that file ticked (the tick on its picture); every card
// keeps its height; the select bar carries the one-file rows and Delete.
SCREENS.push({
  name: 'assets-select',
  seed: creator,
  url: '/assets',
  steps: assetsSelect,
});

// Pipeline in select mode (7 Nov 2026): a long-press (phone) or right-click
// (laptop) on Monday carousel ticks it; the bar carries Open, Copy link and
// the moves (one-post rows). With a second card tapped the bar holds Cancel
// and "2 selected" only (approval is never bulk).
SCREENS.push(
  {
    name: 'pipeline-select-1',
    seed: creator,
    url: '/pipeline',
    steps: async (page) => pipelineSelect(page, 1),
  },
  {
    name: 'pipeline-select-2',
    seed: creator,
    url: '/pipeline',
    steps: async (page) => pipelineSelect(page, 2),
  },
  {
    // A Review post whose due day passed three days ago: line 1's time reads
    // "3d late" in the bad token (formatOverdue).
    name: 'pipeline-overdue',
    seed: creator,
    extra: (network) => {
      const post = (network.world.tables.posts ?? []).find((p) => p.id === POST_IDS[2]);
      if (post === undefined) throw new Error('no Product teaser post');
      post.target_date = new Date(NOW - 3 * 86_400_000).toISOString();
    },
    url: '/pipeline',
    steps: async (page) => {
      await pipelineReady(page);
      const due = pipelineCard(page, POST_IDS[2] ?? '').locator('[data-post-card-due="overdue"]');
      await waitFor([due], 'overdue due words');
      await expect(due).toHaveText('3d late');
      await expect(due).toHaveAttribute('data-list-card-time-bad', '');
    },
  },
  {
    // The chat list in select mode: a long-press (phone) or right-click
    // (laptop) on Priya's card ticks it; the list's own bar carries Hide chat.
    name: 'chat-list-select',
    seed: creator,
    url: '/chat',
    steps: async (page) => {
      await chatListAllRows(page);
      const card = page
        .locator('[data-chat-list] [data-list-card]')
        .filter({ hasText: PEER_NAME })
        .first();
      await selectGesture(page, card);
      const bar = page.locator('[data-chat-select-bar]');
      await waitFor([bar.locator('[data-selection-hide]')], 'chat select bar');
      await expect(bar.locator('[data-selection-count]')).toHaveText('1 selected');
    },
  },
);

/** A shared plan that ran two weeks before NOW's week and is over. */
const ENDED_PLAN_ID = '0190d000-0000-7000-8000-00000000d0e1';

// The Plan tab's time words (formatPlanStart): a plan whose start has passed
// and whose end has not reads "Live" (Upcoming); one whose end day passed
// reads its end day ("11 Oct") on the Past chip.
SCREENS.push(
  {
    name: 'plan-tab-live',
    seed: creator,
    extra: seedTab,
    url: '/plan',
    steps: async (page) => {
      const time = page.locator(
        `[data-plan-tab-card="${TAB_SHARED_PLAN_ID}"] [data-plan-tab-start]`,
      );
      await waitFor([time], 'live plan');
      await expect(time).toHaveText('Live');
    },
  },
  {
    name: 'plan-tab-ended',
    seed: creator,
    extra: (network) => {
      seedTab(network);
      const plans = (network.world.tables.plans ??= []);
      const template = plans.find((p) => p.id === TAB_SHARED_PLAN_ID);
      if (template === undefined) throw new Error('no shared plan');
      const monday = mondayOf(NOW);
      plans.push({
        ...template,
        id: ENDED_PLAN_ID,
        title: 'Summer sale',
        starts_on: civilPlus(monday, -14),
        ends_on: civilPlus(monday, -8),
      });
    },
    url: '/plan?week=past',
    steps: async (page) => {
      const time = page.locator(`[data-plan-tab-card="${ENDED_PLAN_ID}"] [data-plan-tab-start]`);
      await waitFor([time], 'ended plan');
      await expect(time).toHaveText(/^\d{1,2} [A-Z][a-z]{2}$/);
    },
  },
);

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

/** ME's own comment on Monday carousel, edited half an hour after it was written. */
function seedOwnEditedComment(network: HarnessNetwork): void {
  (network.world.tables.comments ??= []).push({
    ...postComment(ME_COMMENT_ID, ME, QUOTE_EXCERPT, NOW - 3_600_000),
    edited_at: new Date(NOW - 1_800_000).toISOString(),
  });
}

/** Priya's comment on Monday carousel: a tap on her name offers Reply privately. */
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
 * L1 (8 Nov 2026): the message stays inside its column (the row's content
 * column right of the photo gutter, no bubble cap) and inside the viewport,
 * mine and theirs.
 */
async function expectBubbleInsideColumn(page: Page, body: string): Promise<void> {
  const bubble = await lastVisible(page.locator('[data-bubble]', { hasText: body }), body);
  await bubble.scrollIntoViewIfNeeded();
  const box = await bubble.evaluate((el) => {
    const b = el.getBoundingClientRect();
    let col: Element | null = el.parentElement;
    while (col !== null && !/\bflex-col\b/.test(col.className)) col = col.parentElement;
    const c = col?.getBoundingClientRect() ?? null;
    return {
      left: b.left,
      right: b.right,
      colLeft: c?.left ?? Number.NaN,
      colRight: c?.right ?? Number.NaN,
      vw: window.innerWidth,
    };
  });
  expect(box.left, `${body}: left edge inside column`).toBeGreaterThanOrEqual(box.colLeft - 0.5);
  expect(box.right, `${body}: right edge inside column`).toBeLessThanOrEqual(box.colRight + 0.5);
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
  // L10: Reply privately sits on the More actions page.
  await waitFor(menuRow(page, /More actions/), 'More actions in the message menu');
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
  // The open moves focus: a writing box that lost it collapses on its 200ms
  // blur fallback (ui/WritingBox), a timer stabilise does not see. Shoot after it.
  await page.waitForTimeout(300);
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
    // Inside a DM the header photo opens the photo only: dark overlay, the
    // photo large, the full name, a leading "<" (Back). Phone light/dark and laptop.
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
// Forward sheet from a message's menu, an own message carrying
// a post card, and the guest homepage. Phone light/dark and laptop light.

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

/** The Profile panel's alerts block in view (Sound, Notifications, Pause for). */
async function alertsBlock(page: Page): Promise<void> {
  const block = page.locator('[data-alerts-block]');
  await waitFor([block], 'alerts block');
  await block.scrollIntoViewIfNeeded();
}

SCREENS.push(
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
    // A ui/Select open: the option list (lit-overlay). The New brief sheet has
    // no Format select since 9 Nov 2026, so the on-behalf approve sheet's
    // "Approving on behalf of" select hosts it.
    name: 'select-open',
    seed: creator,
    hold: true,
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
      const sheet = page.locator('[data-on-behalf-sheet]');
      await waitFor([sheet], 'on-behalf sheet');
      await tap(
        [sheet.getByRole('button', { name: /^Approving on behalf of/ })],
        'on-behalf select trigger',
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

// ---------------------------------------------------------------------------
// Moment states: each held still on purpose. A read or write that never
// answers (holdRpc, holdUploads, a page route left pending) keeps the busy
// state up for the whole test; the recorder is the page's MediaRecorder and
// microphone stubbed in the test (no app hook). Busy controls also run
// assertSameWidth (layout-checks.ts check 5): idle and busy are one width.

/** Bytes in the stub recording: a blob of exactly this size never reads back. */
const HELD_VOICE_BYTES = 4099;

/**
 * The page's microphone and MediaRecorder, stubbed: recording starts at once
 * and stop hands back one chunk of HELD_VOICE_BYTES whose bytes never read, so
 * the composer stays in its voice-sending state (the file is typed from its
 * header before it is handed to the thread).
 */
async function stubRecorder(_network: HarnessNetwork, page: Page): Promise<void> {
  await stubVoiceRecorder(page, { heldBytes: HELD_VOICE_BYTES, recordedBytes: HELD_VOICE_BYTES });
}

/** Bytes in a stub recording that reads back: the note is sent and lands in the thread. */
const SENT_VOICE_BYTES = 2048;

/**
 * The stub microphone with a recording that reads back, and every upload held:
 * stop and send puts the own voice note in the thread, its upload in flight.
 */
async function stubUploadingVoice(network: HarnessNetwork, page: Page): Promise<void> {
  network.holdUploads();
  await stubVoiceRecorder(page, { heldBytes: HELD_VOICE_BYTES, recordedBytes: SENT_VOICE_BYTES });
}

/**
 * The DM's composer form. Found by the composer root ([data-composer]: the
 * writing box, or ui/Composer's frame while recording), not its textarea:
 * recording swaps the field's contents, so the textarea unmounts.
 */
const dmComposer = (page: Page): Locator => page.locator('form:has([data-composer])').first();

/**
 * The composer's send slot (send, mic, stop or the busy spinner): the
 * recording row's last slot, or the writing box row's trailing slot.
 */
const sendSlot = (page: Page): Locator =>
  dmComposer(page).locator('[data-composer-row] > :last-child, [data-writing-row] > :last-child');

/** The DM with a recording running (the stub microphone). */
async function startRecording(page: Page): Promise<void> {
  await openDm(page);
  await tap([page.getByRole('button', { name: 'Record voice note', exact: true })], 'mic');
  await waitFor([page.locator('[data-composer-state="recording"]')], 'recording composer');
}

/** The recording row's check: stop and keep; the note waits in the box as a chip. */
async function keepRecording(page: Page): Promise<void> {
  await tap(
    [page.getByRole('button', { name: 'Stop and keep voice note', exact: true })],
    'Stop and keep',
  );
  await waitFor([dmComposer(page).locator('[data-voice-chip]')], 'kept voice note chip');
}

/** Types a line into the DM composer and sends it. */
async function sendInDm(page: Page, body: string): Promise<void> {
  await openDm(page);
  await dmComposer(page).locator('textarea').fill(body);
  await tap([page.getByRole('button', { name: 'Send', exact: true })], 'Send');
}

/** Waits until an attribute holds one value across two reads 400ms apart. */
async function attributeStill(target: Locator, name: string): Promise<void> {
  let last = await target.getAttribute(name);
  for (let i = 0; i < 20; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    const now = await target.getAttribute(name);
    if (now === last) return;
    last = now;
  }
  throw new Error(`${name} never settled`);
}

/** A pending page route: requests to this path are never answered. */
async function neverAnswerPath(page: Page, path: string): Promise<void> {
  await page.route(
    (url) => url.pathname === path,
    () => undefined,
  );
}

const PENDING_BODY = 'Sending the cut now';

SCREENS.push(
  {
    // The composer while a voice note records (chat/VoiceDraft RecordingRow):
    // round X cancel, the dotted track with the live bars, the elapsed time
    // (the track and time masked: they tick), and the round check (stop and
    // keep).
    name: 'chat-composer-recording',
    seed: creator,
    prepare: stubRecorder,
    url: '/chat',
    mask: (page) => [
      page.locator('[data-recording-track]'),
      page.locator('[data-recording-elapsed]'),
    ],
    steps: startRecording,
  },
  {
    // Stop and keep, then Send: the kept note on its way, the spinner in the
    // send slot at send's own width.
    name: 'chat-voice-sending',
    seed: creator,
    prepare: stubRecorder,
    url: '/chat',
    steps: async (page) => {
      await startRecording(page);
      // Over MIN_VOICE_NOTE_MS, so the recording is kept and not dropped.
      await page.waitForTimeout(1_100);
      await keepRecording(page);
      await assertSameWidth(sendSlot(page), async () => {
        await tap([dmComposer(page).locator('[data-row-send]')], 'Send');
        await expect(
          page.getByRole('button', { name: 'Sending voice note', exact: true }),
        ).toHaveAttribute('aria-busy', 'true');
      });
    },
  },
  {
    // One sheet saving: Rename file with a new name, the save held. Save
    // spins at its own width and the sheet cannot close.
    name: 'asset-rename-saving',
    seed: creator,
    prepare: (_network, page) => neverAnswerPath(page, '/rename'),
    url: '/assets',
    steps: async (page) => {
      await assetsSelect(page);
      await tap([page.locator('[data-select-bar-action="rename"]')], 'Rename');
      const sheet = page.getByRole('dialog', { name: 'Rename file' });
      await waitFor([sheet], 'rename sheet');
      await sheet.getByRole('textbox').first().fill('Hero banner final.png');
      // The footer's submit, found by its slot: busy (ui/Button) hides the
      // label, so the button's name is empty while it spins.
      const save = sheet.locator('[data-sheet-footer] button[type="submit"]');
      await expect(save).toHaveAccessibleName('Save');
      await assertSameWidth(save, async () => {
        await save.click();
        await expect(save).toHaveAttribute('aria-busy', 'true');
      });
    },
  },
  {
    // Tasks: a tick autosaves, the save held: "Saving…" in the header's save
    // slot (the slot holds its width).
    name: 'chat-tasks-saving',
    seed: creator,
    extra: (network) => {
      seedDatedTasks(network);
      network.holdRpc('chat_task_save_batch');
    },
    url: '/chat',
    steps: async (page) => {
      const sheet = await openTasks(page);
      const tick = sheet.locator('[data-task-tick][aria-checked="false"]').first();
      const saved = page.waitForRequest((r) => r.url().includes('chat_task_save_batch'));
      await assertSameWidth(sheet.locator('[data-task-save-slot]'), async () => {
        await tick.click();
        await saved;
        await waitFor([sheet.locator('[data-task-save-state="saving"]')], 'Saving…');
      });
    },
  },
  {
    // A photo sent with its upload held (D5 uploading, photo): the own bubble
    // shows the local preview under the upload ring, its stop square named
    // "Stop sending".
    name: 'chat-upload-progress',
    seed: creator,
    extra: (network) => {
      network.holdUploads();
    },
    url: '/chat',
    steps: async (page) => {
      await openDm(page);
      await dmComposer(page)
        .locator('input[type="file"]')
        .first()
        .setInputFiles({
          name: 'moodboard.png',
          mimeType: 'image/png',
          buffer: solidPng(64, 48, [200, 120, 60]),
        });
      await waitFor([dmComposer(page).getByText('moodboard.png')], 'picked photo');
      await tap([page.getByRole('button', { name: 'Send', exact: true })], 'Send');
      const ring = await firstVisible([page.locator('[data-upload-ring]')], 'upload ring');
      await expect(ring).toHaveAccessibleName('Stop sending');
      await attributeStill(ring, 'data-upload-progress');
    },
  },
  {
    // An own message whose record write is held: the clock in its meta.
    name: 'chat-message-pending',
    seed: creator,
    extra: (network) => {
      network.holdRpc('chat_message_send');
    },
    url: '/chat',
    steps: async (page) => {
      await sendInDm(page, PENDING_BODY);
      const own = page.locator('[data-msg-id]', { hasText: PENDING_BODY });
      await waitFor([own.locator('[data-status="sending"]')], 'pending clock');
    },
  },
  {
    // An own message the record refused: "Not sent" with the reason and Delete.
    name: 'chat-message-not-sent',
    seed: creator,
    url: '/chat',
    steps: async (page) => {
      await sendInDm(page, REFUSED_SEND);
      const own = page.locator('[data-msg-id]', { hasText: REFUSED_SEND });
      await waitFor([own.locator('[data-failed-actions]')], 'Not sent line');
    },
  },
  {
    // The message menu's Select: one bubble's text selectable in place.
    name: 'chat-select-mode',
    seed: creator,
    hold: true,
    url: '/chat',
    steps: async (page) => {
      await openDmMessageMenu(page);
      // L10: select-text sits on the More actions page.
      await tap([page.locator('[data-menu-item="more-actions"]')], 'More actions');
      await tap([page.locator('[data-menu-item="select-text"]')], 'Select');
      await waitFor([page.locator('[data-selecting-text]')], 'select mode');
      await page.mouse.move(0, 0);
    },
  },
  {
    // Phone: the composer focused (the keyboard's state; WebKit here draws no
    // keyboard): the field's focus line, the row as it sits above the keys.
    name: 'chat-composer-keyboard',
    seed: creator,
    only: 'phone',
    hold: true,
    url: '/chat',
    steps: async (page) => {
      await openDm(page);
      const field = dmComposer(page).locator('textarea');
      await field.focus();
      await expect(field).toBeFocused();
    },
  },
  {
    // The post screen: Approve confirmed, the stage write held. The confirm's
    // Approve spins at its own width.
    name: 'post-approve-busy',
    seed: approver,
    extra: (network) => {
      network.holdRpc('stage_transition');
    },
    url: `/posts/${POST}`,
    steps: async (page) => {
      await postDetailReady(page);
      await tap([page.getByRole('button', { name: 'Approve', exact: true })], 'Approve');
      const confirm = await firstVisible(
        [page.getByRole('dialog', { name: /Approve this post/ }), page.getByRole('alertdialog')],
        'approve confirm',
      );
      // The confirm's Approve by its hook: busy (ui/Button) hides the label,
      // so the button's name is empty while it spins.
      const approve = confirm.locator('[data-approve-confirm-button]');
      await expect(approve).toHaveAccessibleName('Approve');
      await assertSameWidth(approve, async () => {
        await approve.click();
        await expect(approve).toHaveAttribute('aria-busy', 'true');
      });
    },
  },
);

// ---------------------------------------------------------------------------
// Delete for me (7 Nov 2026): the delete sheet (an own message inside 30 min:
// Delete for everyone and Delete for me; someone else's: Delete for me only),
// a tombstone and its one-row menu, the chat home's chip select bar, the photo
// viewer's bar (Forward, Delete, Download) and its sheet, an own voice note
// uploading (the ring in the play slot, the real bars at reduced emphasis),
// and the chat list with the Personal notes card showing the user's photo.
// Phone light/dark and laptop light come from the projects; LAPTOP_DARK_SCREENS
// adds laptop dark.

/** An own DM text two minutes before NOW: its Delete offers Delete for everyone. */
const FRESH_OWN_BODY = 'Final cut is in the folder';
/** The peer's DM line the message menu screens open (an hour old, not own). */
const PEER_LINE = 'Done, it reads well now.';

function seedFreshOwnMessage(network: HarnessNetwork): void {
  (network.world.tables.chat_messages ??= []).push({
    id: '0190b000-0000-7000-8100-0000000009f1',
    channel_id: DM_CHANNEL,
    workspace_id: WORKSPACE_ID,
    sender_user_id: ME,
    body: FRESH_OWN_BODY,
    mentions: null,
    attachment_asset_ids: null,
    shared_post_ids: null,
    shared_brief_ids: null,
    reply_to_message_id: null,
    forwarded_from_message_id: null,
    attachment_meta: null,
    agora_event_id: null,
    created_at: new Date(NOW - 2 * 60_000).toISOString(),
    edited_at: null,
    deleted_at: null,
    thread_root_message_id: null,
  });
}

/** The DM's newest peer row deleted: a tombstone sits at the bottom of the thread. */
function seedDmTombstone(network: HarnessNetwork): void {
  const row = network.world.dmMessages[network.world.dmMessages.length - 1];
  if (row === undefined) throw new Error('no DM row to delete');
  Object.assign(row, { body: null, deleted_at: new Date(NOW - 30 * 60_000).toISOString() });
}

/** The signed-in user's own photo (users.avatar_url): the notes card shows it. */
function seedOwnPhoto(network: HarnessNetwork): void {
  const photo = `data:image/png;base64,${solidPng(72, 72, [70, 110, 150]).toString('base64')}`;
  for (const user of network.world.tables.users ?? []) {
    if (user.id === ME) user.avatar_url = photo;
  }
}

/** Long-press (phone) or right-click (laptop) the DM bubble with `text`: its menu. */
async function openDmMenuOn(page: Page, text: string): Promise<void> {
  await openDm(page);
  const bubble = page.locator('[data-bubble]', { hasText: text }).last();
  const menu = page.getByRole('menu').or(page.getByRole('dialog'));
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

/** The message menu's Delete: the delete sheet opens. */
async function openDeleteSheetOn(page: Page, text: string): Promise<Locator> {
  await openDmMenuOn(page, text);
  // L10: delete sits on the More actions page.
  await tap([page.locator('[data-menu-item="more-actions"]')], 'More actions');
  await tap([page.locator('[data-menu-item="delete"]')], 'menu Delete');
  return firstVisible([page.getByTestId('delete-sheet')], 'delete sheet');
}

/** The Photos chip with the photo viewer open on the first tile. */
async function openPhotoViewer(page: Page): Promise<Locator> {
  const results = await openMediaChip(page, 'photo');
  await openFirstPhoto(page, results);
  const bar = await firstVisible([page.getByTestId('viewer-bar')], 'viewer bar');
  await waitFor([bar.getByRole('button', { name: 'Forward', exact: true })], 'viewer Forward');
  await waitFor([bar.getByRole('button', { name: 'Delete', exact: true })], 'viewer Delete');
  return bar;
}

SCREENS.push(
  {
    // An own message inside 30 minutes: Delete for everyone, Delete for me, Cancel.
    name: 'chat-delete-sheet-everyone',
    seed: creator,
    extra: seedFreshOwnMessage,
    url: '/chat',
    steps: async (page) => {
      const sheet = await openDeleteSheetOn(page, FRESH_OWN_BODY);
      await waitFor([sheet.locator('[data-delete-choice="everyone"]')], 'Delete for everyone');
      await waitFor([sheet.locator('[data-delete-choice="me"]')], 'Delete for me');
    },
  },
  {
    // Someone else's message: Delete for me and Cancel only.
    name: 'chat-delete-sheet-me',
    seed: creator,
    url: '/chat',
    steps: async (page) => {
      const sheet = await openDeleteSheetOn(page, PEER_LINE);
      await waitFor([sheet.locator('[data-delete-choice="me"]')], 'Delete for me');
      await expect(sheet.locator('[data-delete-choice="everyone"]')).toHaveCount(0);
    },
  },
  {
    // A deleted message: the peer bubble's shell in secondary ink, its time,
    // on one line (D8).
    name: 'chat-tombstone',
    seed: creator,
    extra: seedDmTombstone,
    url: '/chat',
    steps: async (page) => {
      await openDm(page);
      const tomb = await firstVisible([page.getByTestId('tombstone')], 'tombstone');
      await threadStill(page);
      await tomb.scrollIntoViewIfNeeded();
      await expectOneLine(tomb, 'tombstone');
    },
  },
  {
    // The tombstone's one-row menu: Delete for me.
    name: 'chat-tombstone-menu',
    seed: creator,
    extra: seedDmTombstone,
    url: '/chat',
    steps: async (page) => {
      await openDm(page);
      const tomb = await firstVisible([page.getByTestId('tombstone')], 'tombstone');
      await threadStill(page);
      const row = page.getByRole('menuitem', { name: 'Delete for me' });
      // Open once and give the menu time to show before trying again: a second
      // gesture while it is opening closes it or re-opens it at another spot.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await openMenuGesture(page, tomb);
        const shown = await row
          .waitFor({ state: 'visible', timeout: 3_000 })
          .then(() => true)
          .catch(() => false);
        if (shown) break;
      }
      await waitFor([row], 'tombstone menu');
    },
  },
  {
    // The Photos chip in select mode, the album's message picked (its three
    // tiles checked): Forward and Delete for me in the bottom bar.
    name: 'chat-home-chip-select',
    seed: creator,
    prepare: seedMediaChips,
    url: '/chat',
    steps: async (page) => {
      const results = await openMediaChip(page, 'photo');
      // The chip row's Select, pinned at the row's end.
      await tap([page.locator('[data-chip-row-select] [data-section-select]')], 'Select');
      const first = results.locator('[data-media-tile]').first();
      // The check sits over the tile's top right (over its centre on a laptop
      // tile): tap the check, which toggles the same message.
      const check = results
        .locator('[data-media-select-item]')
        .first()
        .locator('[data-select-circle]');
      await tap([check], 'first photo check');
      await expect(first).toHaveAttribute('aria-pressed', 'true');
      await waitFor([page.getByTestId('media-select-bar')], 'chip select bar');
    },
  },
  {
    // The photo viewer's bar: Show in chat, then Forward, Delete and Download.
    // It leaves with the leading "<" (Back) beside the title (D2/D3), never an X.
    name: 'chat-viewer-bar',
    seed: creator,
    prepare: seedMediaChips,
    url: '/chat',
    steps: async (page) => {
      await openPhotoViewer(page);
      const viewer = page.getByRole('dialog', { name: 'Image viewer' });
      const top = viewer.locator('[data-lightbox-back-bar]');
      await expect(top.getByRole('button', { name: 'Back', exact: true })).toBeVisible();
      await expect(top.locator('[data-lightbox-title]')).toBeVisible();
      await expect(viewer.getByRole('button', { name: /^Close/ })).toHaveCount(0);
    },
  },
  {
    // The viewer's Delete: the delete sheet (Delete for me), the viewer aside.
    name: 'chat-viewer-delete-sheet',
    seed: creator,
    prepare: seedMediaChips,
    url: '/chat',
    steps: async (page) => {
      const bar = await openPhotoViewer(page);
      await tap([bar.getByRole('button', { name: 'Delete', exact: true })], 'viewer Delete');
      const sheet = await firstVisible([page.getByTestId('delete-sheet')], 'delete sheet');
      await waitFor([sheet.locator('[data-delete-choice="me"]')], 'Delete for me');
    },
  },
  {
    // An own voice note sent with its upload held: the ring in the play slot
    // in the bubble's inks, the bars at reduced emphasis.
    name: 'chat-voice-uploading',
    seed: creator,
    prepare: stubUploadingVoice,
    url: '/chat',
    steps: async (page) => {
      await startRecording(page);
      // Over MIN_VOICE_NOTE_MS, so the recording is kept and not dropped.
      await page.waitForTimeout(1_100);
      await keepRecording(page);
      await tap([dmComposer(page).locator('[data-row-send]')], 'Send');
      const note = await firstVisible([page.getByTestId('voice-uploading')], 'voice uploading');
      await waitFor([note.locator('[data-voice-bars]')], 'voice bars');
      const ring = await firstVisible([note.locator('[data-upload-ring]')], 'voice upload ring');
      await attributeStill(ring, 'data-upload-progress');
    },
  },
  {
    // The chat home: the Personal notes card shows the user's own photo
    // (round, ui/Avatar 'card' at 40) among the person rows.
    name: 'chat-list-notes-photo',
    seed: creator,
    extra: seedOwnPhoto,
    url: '/chat',
    steps: async (page) => {
      await chatListAllRows(page);
      await waitFor(
        [page.locator('[data-notes-tile] img[data-avatar-role="card"]')],
        'notes photo',
      );
    },
  },
);

// ---------------------------------------------------------------------------
// Chat media sweep (7 Nov 2026): a single photo at its own ratio, never cropped
// (D1: portrait, landscape, square; the tile's box from thumb_w/thumb_h and
// the served photo at that size), the 2, 3 and 4 photo albums, the sending
// states of each type (D5: queued = the clock and an empty ring, uploading =
// the ring with its stop square "Stop sending", failed = "Not sent"), the
// YouTube link card with its picture and a link with no picture (D6: the
// compact 64px row, no picture box), the Plan dates sheet on ui/DatePicker
// (D9) and a sheet's header (D4a: the leading "<" Back, then the title).
// Phone light/dark and laptop light come from the projects; LAPTOP_DARK_SCREENS
// adds laptop dark. The uploading photo and voice note are chat-upload-progress
// and chat-voice-uploading above; the tombstone and the viewer bar are
// chat-tombstone and chat-viewer-bar.

/** Its text on one line: the text runs span less than one and a half of their tallest run. */
async function expectOneLine(target: Locator, what: string): Promise<void> {
  const span = await target.evaluate((root) => {
    let top = Infinity;
    let bottom = -Infinity;
    let tallest = 0;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
      if ((n.textContent ?? '').trim() === '') continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      for (const r of Array.from(range.getClientRects())) {
        if (r.width === 0 || r.height === 0) continue;
        top = Math.min(top, r.top);
        bottom = Math.max(bottom, r.bottom);
        tallest = Math.max(tallest, r.height);
      }
    }
    return { height: bottom - top, tallest };
  });
  expect(span.tallest, `${what} has text`).toBeGreaterThan(0);
  expect(span.height, `${what} on one line`).toBeLessThan(span.tallest * 1.5);
}

/** A sheet's header: the leading "<" (Back) first, then the title; no Close anywhere. */
async function expectBackHeader(sheet: Locator, title: string): Promise<void> {
  const head = sheet.locator('[data-sheet-grab]');
  await expect(head.locator('button').first()).toHaveAccessibleName('Back');
  await expect(head.getByRole('heading', { name: title, exact: true })).toBeVisible();
  const back = await head.getByRole('button', { name: 'Back', exact: true }).boundingBox();
  const heading = await head.getByRole('heading', { name: title, exact: true }).boundingBox();
  if (back === null || heading === null) throw new Error(`${title}: no header boxes`);
  expect(back.x, `${title}: Back leads the title`).toBeLessThan(heading.x);
  await expect(sheet.getByRole('button', { name: /^Close/ })).toHaveCount(0);
}

interface SeededPhoto {
  id: string;
  name: string;
  w: number;
  h: number;
  rgb: [number, number, number];
}

const MEDIA_MESSAGE = (n: number): string =>
  `0190b000-0000-7000-8100-0000000009${n.toString(16).padStart(2, '0')}`;

/** The single photos (D1): portrait 600x900, landscape 900x600, square 700x700. */
const SINGLE_PHOTOS: Record<'portrait' | 'landscape' | 'square', SeededPhoto> = {
  portrait: { id: assetId(1, 961), name: 'tall.png', w: 600, h: 900, rgb: [176, 112, 72] },
  landscape: { id: assetId(1, 962), name: 'wide.png', w: 900, h: 600, rgb: [72, 120, 160] },
  square: { id: assetId(1, 963), name: 'square.png', w: 700, h: 700, rgb: [96, 144, 96] },
};

/** Album photos: one colour each, so the grid's tiles read apart. */
const ALBUM_COLOURS: Array<[number, number, number]> = [
  [176, 112, 72],
  [72, 120, 160],
  [96, 144, 96],
  [150, 96, 150],
];

function albumPhotos(count: number): SeededPhoto[] {
  return Array.from({ length: count }, (_, k) => ({
    id: assetId(1, 970 + count * 10 + k),
    name: `album-${count}-${k + 1}.png`,
    w: 800,
    h: 800,
    rgb: ALBUM_COLOURS[k % ALBUM_COLOURS.length] ?? [128, 128, 128],
  }));
}

/** One DM row a minute before NOW (the thread's newest), from ME unless `sender` says. */
function pushDmRow(
  network: HarnessNetwork,
  id: string,
  fields: Partial<Row> & { sender?: string },
): void {
  const { sender, ...rest } = fields;
  (network.world.tables.chat_messages ??= []).push({
    id,
    channel_id: DM_CHANNEL,
    workspace_id: WORKSPACE_ID,
    sender_user_id: sender ?? ME,
    body: null,
    mentions: null,
    attachment_asset_ids: null,
    shared_post_ids: null,
    shared_brief_ids: null,
    reply_to_message_id: null,
    forwarded_from_message_id: null,
    attachment_meta: null,
    agora_event_id: null,
    created_at: new Date(NOW - 60_000).toISOString(),
    edited_at: null,
    deleted_at: null,
    thread_root_message_id: null,
    ...rest,
  });
}

/** An own photo message (one photo: the single tile; 2+: the album), sizes stored. */
function seedPhotoMessage(network: HarnessNetwork, id: string, photos: SeededPhoto[]): void {
  pushDmRow(network, id, {
    attachment_asset_ids: photos.map((p) => p.id),
    attachment_meta: Object.fromEntries(
      photos.map((p) => [
        p.id,
        { mime: 'image/png', name: p.name, size: 48_000, thumb_w: p.w, thumb_h: p.h },
      ]),
    ),
  });
}

/**
 * The asset-read blobs of these photos at their own pixel size (the harness
 * serves one 64x48 PNG for every image). Registered after the harness, so it
 * answers first; any other blob falls through to the harness.
 */
async function servePhotos(page: Page, photos: SeededPhoto[]): Promise<void> {
  const bodies = new Map(photos.map((p) => [p.id, solidPng(p.w, p.h, p.rgb)]));
  const isBlob = (url: URL): boolean =>
    url.hostname === 'asset-read.harness.test' && url.pathname.startsWith('/blob/image/');
  await page.route(isBlob, async (route) => {
    const id = new URL(route.request().url()).pathname.split('/').pop() ?? '';
    const body = bodies.get(id);
    if (body === undefined) {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      headers: { 'access-control-allow-origin': '*', 'content-type': 'image/png' },
      body,
    });
  });
}

/** The DM open on a seeded message: in view, its photos decoded, the thread still. */
async function openDmOn(page: Page, id: string): Promise<Locator> {
  await openDm(page);
  const message = await firstVisible([page.locator(`[data-msg-id="${id}"]`)], 'message');
  await threadStill(page);
  await message.scrollIntoViewIfNeeded();
  return message;
}

/** Every photo of the message decoded at its served size, in tile order. */
async function photosLoaded(message: Locator, photos: SeededPhoto[]): Promise<void> {
  const images = message.locator('[data-album] img');
  await expect(images).toHaveCount(photos.length, { timeout: READY_MS });
  for (const [i, photo] of photos.entries()) {
    await expect(images.nth(i)).toHaveJSProperty('naturalWidth', photo.w, { timeout: READY_MS });
  }
}

/** The DM composer's photo input (Photos) or file input (File). */
const composerInput = (page: Page, which: 'photo' | 'file'): Locator =>
  dmComposer(page)
    .locator('input[type="file"]')
    .nth(which === 'photo' ? 0 : 1);

interface PickedFile {
  name: string;
  mimeType: string;
  buffer: Buffer;
}

/** Pick files in the DM composer, wait for their chips, then Send. */
async function pickAndSend(
  page: Page,
  which: 'photo' | 'file',
  files: PickedFile[],
): Promise<void> {
  await composerInput(page, which).setInputFiles(files);
  for (const file of files) {
    await waitFor([dmComposer(page).getByText(file.name, { exact: false })], file.name);
  }
  await tap([page.getByRole('button', { name: 'Send', exact: true })], 'Send');
}

function pngFile(name: string, w: number, h: number, rgb: [number, number, number]): PickedFile {
  return { name, mimeType: 'image/png', buffer: solidPng(w, h, rgb) };
}

/** The own message holding a picked photo (its tile's image is named by the file). */
const messageWithPhoto = (page: Page, name: string): Locator =>
  page.locator('[data-msg-id]', { has: page.locator(`img[alt="${name}"]`) }).last();

/** An uploading send: its ring up, named "Stop sending", the progress settled. */
async function ringSettled(scope: Locator, what: string): Promise<Locator> {
  const ring = await firstVisible([scope.locator('[data-upload-ring]')], `${what} ring`);
  await expect(ring).toHaveAccessibleName('Stop sending');
  await attributeStill(ring, 'data-upload-progress');
  return ring;
}

/** A refused send: its "Not sent" line in view. */
async function notSentInView(page: Page): Promise<void> {
  const line = await firstVisible([page.locator('[data-failed="failed"]')], 'Not sent');
  await expect(line).toHaveText('Not sent');
  await threadStill(page);
  await line.scrollIntoViewIfNeeded();
}

const YOUTUBE_MESSAGE = MEDIA_MESSAGE(0x30);
const TEXT_MESSAGE = MEDIA_MESSAGE(0x31);

const VIDEO_FILE: PickedFile = {
  name: 'teaser-cut.mp4',
  mimeType: 'video/mp4',
  buffer: Buffer.alloc(2048),
};
const DECK_FILE: PickedFile = {
  name: 'Pitch deck.pptx',
  mimeType: PPTX_MIME,
  buffer: Buffer.alloc(4096),
};

for (const [shape, photo] of Object.entries(SINGLE_PHOTOS)) {
  const id = MEDIA_MESSAGE(0x10 + Object.keys(SINGLE_PHOTOS).indexOf(shape));
  SCREENS.push({
    // One photo: the whole photo at its own ratio (thumb_w / thumb_h), uncropped.
    name: `chat-photo-single-${shape}`,
    seed: creator,
    extra: (network) => seedPhotoMessage(network, id, [photo]),
    prepare: (_network, page) => servePhotos(page, [photo]),
    url: '/chat',
    steps: async (page) => {
      const message = await openDmOn(page, id);
      await photosLoaded(message, [photo]);
      const tile = message.getByRole('button', { name: 'Open photo 1 of 1', exact: true });
      const box = await tile.boundingBox();
      if (box === null) throw new Error(`${shape}: no tile box`);
      expect(box.width / box.height, `${shape} tile ratio`).toBeCloseTo(photo.w / photo.h, 1);
      await expect(message.locator('[data-album] img')).toHaveCSS('object-fit', 'contain');
    },
  });
}

for (const count of [2, 3, 4]) {
  const id = MEDIA_MESSAGE(0x20 + count);
  const photos = albumPhotos(count);
  SCREENS.push({
    // An album: 2 squares; 3 = a wide tile over two squares; 4 = a 2x2 grid.
    name: `chat-album-${count}`,
    seed: creator,
    extra: (network) => seedPhotoMessage(network, id, photos),
    prepare: (_network, page) => servePhotos(page, photos),
    url: '/chat',
    steps: async (page) => {
      const message = await openDmOn(page, id);
      await waitFor([message.locator(`[data-album="${count}"]`)], `album of ${count}`);
      await photosLoaded(message, photos);
    },
  });
}

SCREENS.push(
  {
    // Queued: a second photo sent while the first one's upload is held. It
    // waits its turn: the clock in its time chip, its ring empty (unknown).
    name: 'chat-send-queued-photo',
    seed: creator,
    extra: (network) => {
      network.holdUploads();
    },
    url: '/chat',
    steps: async (page) => {
      await openDm(page);
      await pickAndSend(page, 'photo', [pngFile('first-cut.png', 640, 480, [200, 120, 60])]);
      await ringSettled(messageWithPhoto(page, 'first-cut.png'), 'first photo');
      await pickAndSend(page, 'photo', [pngFile('second-cut.png', 480, 640, [60, 120, 200])]);
      const queued = messageWithPhoto(page, 'second-cut.png');
      await waitFor([queued.locator('[data-status="sending"]')], 'queued clock');
      const ring = await firstVisible([queued.locator('[data-upload-ring]')], 'queued ring');
      await expect(ring).toHaveAttribute('data-upload-progress', 'unknown');
      await threadStill(page);
    },
  },
  {
    // Uploading, album: three photos in one send, one ring over the grid.
    name: 'chat-send-uploading-album',
    seed: creator,
    extra: (network) => {
      network.holdUploads();
    },
    url: '/chat',
    steps: async (page) => {
      await openDm(page);
      await pickAndSend(page, 'photo', [
        pngFile('set-1.png', 640, 640, [176, 112, 72]),
        pngFile('set-2.png', 640, 640, [72, 120, 160]),
        pngFile('set-3.png', 640, 640, [96, 144, 96]),
      ]);
      // The newest album is the one sending (the thread may hold older albums).
      const album = await firstVisible([page.locator('[data-album="3"]').last()], 'sending album');
      await expect(album.locator('[data-upload-ring]')).toHaveCount(1);
      await ringSettled(album, 'album');
      await threadStill(page);
    },
  },
  {
    // Uploading, video: the video card at the sending ratio, the ring on it.
    name: 'chat-send-uploading-video',
    seed: creator,
    extra: (network) => {
      network.holdUploads();
    },
    url: '/chat',
    steps: async (page) => {
      await openDm(page);
      await pickAndSend(page, 'file', [VIDEO_FILE]);
      const card = await firstVisible(
        [page.locator('[data-file-bubble="video"][data-file-state="sending"]')],
        'sending video',
      );
      await ringSettled(card, 'video');
      await threadStill(page);
    },
  },
  {
    // Uploading, file: the file card, the ring in its icon spot.
    name: 'chat-send-uploading-file',
    seed: creator,
    extra: (network) => {
      network.holdUploads();
    },
    url: '/chat',
    steps: async (page) => {
      await openDm(page);
      await pickAndSend(page, 'file', [DECK_FILE]);
      const card = await firstVisible(
        [page.locator('[data-file-state="sending"]', { hasText: DECK_FILE.name })],
        'sending file',
      );
      await ringSettled(card, 'file');
      await threadStill(page);
    },
  },
  {
    // Failed, photo: uploaded, then the record refused: "Not sent" under it.
    name: 'chat-send-failed-photo',
    seed: creator,
    extra: (network) => {
      network.refuseRpc.add('chat_message_send');
    },
    url: '/chat',
    steps: async (page) => {
      await openDm(page);
      await pickAndSend(page, 'photo', [pngFile('refused.png', 640, 480, [150, 96, 150])]);
      await notSentInView(page);
      await expect(page.locator('[data-upload-ring]')).toHaveCount(0);
    },
  },
  {
    // Failed, file: the file card with "Not sent" under it.
    name: 'chat-send-failed-file',
    seed: creator,
    extra: (network) => {
      network.refuseRpc.add('chat_message_send');
    },
    url: '/chat',
    steps: async (page) => {
      await openDm(page);
      await pickAndSend(page, 'file', [DECK_FILE]);
      await notSentInView(page);
      await expect(page.locator('[data-upload-ring]')).toHaveCount(0);
    },
  },
  {
    // A YouTube link (D6): the tall card, its picture (the i.ytimg.com frame,
    // through the Worker's /image), the play badge, the title and "1:32".
    name: 'chat-link-youtube',
    seed: creator,
    extra: (network) => pushDmRow(network, YOUTUBE_MESSAGE, { sender: PEER, body: YOUTUBE_LINE }),
    prepare: async (_network, page) => {
      await installLinkPreviewStub(page);
    },
    url: '/chat',
    steps: async (page) => {
      const message = await openDmOn(page, YOUTUBE_MESSAGE);
      const card = message.locator('[data-link-card] [data-card-type="full"]');
      await waitFor([card], 'YouTube card');
      await waitFor([card.getByText(YOUTUBE_TITLE, { exact: true })], 'YouTube title');
      // The 480x360 frame (i.ytimg.com's hqdefault size), decoded.
      const picture = card.locator('[data-card-media] img');
      await expect(picture).toHaveJSProperty('naturalWidth', 480, { timeout: READY_MS });
      await message.scrollIntoViewIfNeeded();
    },
  },
  {
    // A link whose page has a title and no picture: the compact 64px row
    // (letter tile, title, domain), never an empty picture box.
    name: 'chat-link-no-picture',
    seed: creator,
    extra: (network) => pushDmRow(network, TEXT_MESSAGE, { sender: PEER, body: TEXT_LINE }),
    prepare: async (_network, page) => {
      await installLinkPreviewStub(page);
    },
    url: '/chat',
    steps: async (page) => {
      const message = await openDmOn(page, TEXT_MESSAGE);
      const row = message.locator('[data-link-card] [data-card-type="text"]');
      await waitFor([row.getByText(TEXT_TITLE, { exact: true })], 'no-picture card');
      await expect(message.locator('[data-card-media]')).toHaveCount(0);
      const box = await row.boundingBox();
      if (box === null) throw new Error('no-picture card has no box');
      expect(Math.round(box.height), 'compact row height').toBe(64);
      await message.scrollIntoViewIfNeeded();
    },
  },
  {
    // New plan -> Change dates: Plan dates, From and To on ui/DatePicker (D9),
    // never a native date input; the header's leading "<" then the title.
    name: 'plan-dates-sheet',
    seed: creator,
    url: '/chat',
    steps: async (page) => {
      await openDm(page);
      await pickTrayTile(page, 'plan');
      const plans = page.getByRole('dialog', { name: 'Plans' });
      await tap([plans.locator('[data-plan-pick-new]')], 'New plan');
      const compose = page.locator('[data-plan-page="compose"]');
      await tap([compose.locator('[data-plan-dates-change]')], 'Change plan dates');
      const sheet = page.getByRole('dialog', { name: 'Plan dates' });
      await waitFor([sheet.locator('[data-plan-date="startsOn"]')], 'From');
      await waitFor([sheet.locator('[data-plan-date="endsOn"]')], 'To');
      await expect(sheet.locator('input[type="date"]')).toHaveCount(0);
      await expectBackHeader(sheet, 'Plan dates');
    },
  },
  {
    // New plan -> a concept on the plan's first day -> tap it: Edit concept
    // with its day tiles, one picked (flat finish, 8 Nov 2026): idle tiles a
    // hairline outline, the picked one an ink line, no fill.
    name: 'plan-day-picker',
    seed: creator,
    url: '/chat',
    steps: async (page) => {
      await openDm(page);
      await pickTrayTile(page, 'plan');
      const plans = page.getByRole('dialog', { name: 'Plans' });
      await tap([plans.locator('[data-plan-pick-new]')], 'New plan');
      const compose = page.locator('[data-plan-page="compose"]');
      await tap([compose.locator('[data-plan-add-concept]')], 'Add concept');
      const add = page.getByRole('dialog', { name: 'Add concept' });
      await add.locator('[data-plan-concept-title]').fill('Opening reel');
      await tap([add.locator('[data-plan-day-tile]').first()], 'first day');
      await tap([add.locator('[data-plan-concept-save]')], 'Save concept');
      await expect(add).toBeHidden();
      const row = compose.locator('[data-plan-compose-item="concept"]').first();
      await tap([row.locator('[data-plan-draft-concept-edit]')], 'Edit concept');
      const sheet = page.getByRole('dialog', { name: 'Edit concept' });
      const picked = sheet.locator('[data-plan-day-tile][aria-pressed="true"]');
      await waitFor([picked], 'picked day');
      await expect(picked).toHaveCount(1);
      await picked.scrollIntoViewIfNeeded();
    },
  },
  {
    // A common sheet's header (D4a): Rename file, the leading "<" (Back) on
    // the content edge, then the title; no X or Close.
    name: 'sheet-header-back',
    seed: creator,
    url: '/assets',
    steps: async (page) => {
      await assetsSelect(page);
      await tap([page.locator('[data-select-bar-action="rename"]')], 'Rename');
      const sheet = page.getByRole('dialog', { name: 'Rename file' });
      await waitFor([sheet.getByRole('textbox')], 'rename field');
      await expectBackHeader(sheet, 'Rename file');
    },
  },
);

// ---------------------------------------------------------------------------
// Post screen redo (7 Nov 2026): the post screen for the agency, the client
// and an approved post (the pinned exit bar, the checkpoint progress row under
// it), a thread folded (resolved points on one line at the bottom, replies
// folded to the latest behind "View {n} earlier replies"), a PDF opened in the
// in-app file viewer from a comment, and the platform preview for each of the
// seven platforms (its own feed card or full screen, placed by the format).
// Phone light/dark and laptop light come from the projects; LAPTOP_DARK_SCREENS
// adds laptop dark. After the shot (never in it): the bar stays pinned when
// the page scrolls, the progress row sits directly under it, and the comment
// "+" tray holds exactly Photos, File and Assets (layout-checks.ts check 7).

const POST_PHOTOS = [
  {
    asset: '0190e600-0000-7000-8000-0000000000a1',
    version: '0190e600-0000-7000-8000-0000000000b1',
  },
  {
    asset: '0190e600-0000-7000-8000-0000000000a2',
    version: '0190e600-0000-7000-8000-0000000000b2',
  },
] as const;

/** Two stored photos on Monday carousel: its gallery, and the preview's media. */
function seedPostPhotos(network: HarnessNetwork): void {
  const t = network.world.tables;
  const at = new Date(NOW - 3 * 86_400_000).toISOString();
  POST_PHOTOS.forEach(({ asset, version }, position) => {
    const filename = `carousel-${position + 1}.png`;
    const row = {
      id: version,
      asset_id: asset,
      kind: 'image',
      mime_type: 'image/png',
      size_bytes: 180_000,
      width: 1200,
      height: 900,
      duration_ms: null,
      page_count: null,
      external_url: null,
      r2_key: `${WORKSPACE_ID}/${asset}/v1.png`,
      version_number: 1,
    };
    (t.assets ??= []).push({
      id: asset,
      workspace_id: WORKSPACE_ID,
      filename,
      display_name: null,
      folder_path: '/',
      folder_id: null,
      tags: [],
      uploaded_at: at,
      current_version_id: version,
      current_version: row,
      deleted_at: null,
    });
    (t.asset_versions ??= []).push({ ...row, assets: { display_name: null, filename } });
    (t.asset_attachments ??= []).push({
      id: `0190e600-0000-7000-8000-0000000000c${position + 1}`,
      asset_id: asset,
      asset_version_id: version,
      entity_type: 'post',
      entity_id: POST,
      workspace_id: WORKSPACE_ID,
      position,
      attached_by: ME,
      attached_at: at,
      deleted_at: null,
      asset_versions: row,
      assets: { filename, display_name: null },
    });
  });
}

/** A post comment with its checkpoint, resolve and reply columns set. */
function threadComment(
  id: string,
  author: string,
  body: string,
  at: number,
  extra: Partial<Row> = {},
): Row {
  return { ...postComment(id, author, body, at), ...extra };
}

const CHECKPOINT_BATCH = '0190f300-0000-7000-8000-0000000000e1';
const THREAD_ROOT = '0190f300-0000-7000-8000-0000000000a1';

/**
 * Priya's three checkpoints (one open, one resolved and confirmed, one
 * resolved waiting for her Confirm) and Leo's plain comment with three
 * replies: the resolved points fold to one line each at the bottom, the
 * replies fold to the latest behind "View 2 earlier replies".
 */
function seedFoldedThread(network: HarnessNetwork): void {
  const resolved = new Date(NOW - 90 * 60_000).toISOString();
  const point = (n: number, body: string, extra: Partial<Row> = {}): Row =>
    threadComment(
      `0190f300-0000-7000-8000-0000000000d${n}`,
      PEER,
      body,
      NOW - 4 * 3_600_000 + n * 1_000,
      { ledger_seq: n, ledger_batch_id: CHECKPOINT_BATCH, ...extra },
    );
  (network.world.tables.comments ??= []).push(
    point(1, 'Swap the cover for the morning shot.'),
    point(2, 'The logo is too small on the second slide.', {
      resolved_at: resolved,
      resolved_by: ME,
      accepted_at: resolved,
      accepted_by: PEER,
    }),
    point(3, 'Tighten the second line of the caption.', {
      resolved_at: resolved,
      resolved_by: ME,
    }),
    threadComment(THREAD_ROOT, COLLEAGUE_A, 'Draft two is in the folder.', NOW - 3 * 3_600_000),
    threadComment(
      '0190f300-0000-7000-8000-0000000000a2',
      PEER,
      'Can we see it on the grid?',
      NOW - 150 * 60_000,
      { parent_comment_id: THREAD_ROOT },
    ),
    threadComment(
      '0190f300-0000-7000-8000-0000000000a3',
      ME,
      'Added it as the first slide.',
      NOW - 120 * 60_000,
      { parent_comment_id: THREAD_ROOT },
    ),
    threadComment(
      '0190f300-0000-7000-8000-0000000000a4',
      PEER,
      'Perfect, that works.',
      NOW - 60 * 60_000,
      { parent_comment_id: THREAD_ROOT },
    ),
  );
}

const COMMENT_PDF_NAME = 'Launch deck.pdf';
const COMMENT_PDF_ASSET = '0190e600-0000-7000-8000-0000000000a9';
const COMMENT_PDF_VERSION = '0190e600-0000-7000-8000-0000000000b9';

/** Priya's comment with a stored PDF: its file card reads "PDF · 3 pages · {size}". */
function seedCommentPdf(network: HarnessNetwork): void {
  const t = network.world.tables;
  const row = {
    id: COMMENT_PDF_VERSION,
    asset_id: COMMENT_PDF_ASSET,
    kind: 'file',
    mime_type: 'application/pdf',
    size_bytes: 2_400_000,
    width: null,
    height: null,
    duration_ms: null,
    page_count: FIXTURE_PDF_PAGES,
    external_url: null,
    r2_key: `${WORKSPACE_ID}/${COMMENT_PDF_ASSET}/v1.pdf`,
    version_number: 1,
  };
  (t.asset_versions ??= []).push({
    ...row,
    assets: { display_name: null, filename: COMMENT_PDF_NAME },
  });
  (t.comments ??= []).push(
    threadComment(
      '0190f300-0000-7000-8000-0000000000f1',
      PEER,
      'The deck for the launch is attached.',
      NOW - 30 * 60_000,
      { attachment_asset_ids: [COMMENT_PDF_VERSION] },
    ),
  );
}

/** The post screen's checks after the shot: pinned bar, comment bars, and the comment "+" tray. */
async function postScreenChecks(page: Page): Promise<void> {
  const name = test.info().title.replace(/ @.*$/, '');
  await assertPinnedBarOnScroll(page, name);
  await assertCommentBars(page, name);
  await assertCommentTray(page, name);
}

/** The seven platforms, each with a format it offers (FORMATS_BY_PLATFORM). */
const PREVIEW_PLATFORMS = [
  { platform: 'instagram', slug: 'instagram', format: 'carousel' },
  { platform: 'facebook', slug: 'facebook', format: 'single_image' },
  { platform: 'linkedin', slug: 'linkedin', format: 'carousel' },
  { platform: 'x', slug: 'x', format: 'single_image' },
  { platform: 'threads', slug: 'threads', format: 'carousel' },
  { platform: 'tiktok', slug: 'tiktok', format: 'video' },
  { platform: 'youtube_shorts', slug: 'youtube-shorts', format: 'short' },
] as const;

/** The workspace and Monday carousel on one platform and format (one workspace, one platform). */
function onPlatform(network: HarnessNetwork, platform: string, format: string): void {
  for (const workspace of network.world.tables.workspaces ?? []) workspace.platform = platform;
  for (const post of network.world.tables.posts ?? []) {
    post.platform = platform;
    if (post.id === POST) post.format = format;
  }
}

/** The Preview pill opens the preview: full screen on a phone, the side panel on a laptop. */
async function openPostPreview(page: Page): Promise<void> {
  await postDetailReady(page);
  await tap([page.locator('[data-post-pills] button').first()], 'Preview pill');
  const panel = await firstVisible([page.locator('[data-preview-panel]')], 'preview');
  await waitFor([panel.locator('img'), panel.locator('[data-preview-cut]')], 'preview media');
}

SCREENS.push(
  {
    // An approved post: the lock line under the title, no decision row.
    name: 'post-detail-approved',
    seed: creator,
    url: `/posts/${AUDIT_POST_IDS.approved}`,
    steps: async (page) => {
      await waitFor(
        [page.getByRole('heading', { name: 'Customer quote tile', level: 1 })],
        'approved post',
      );
      await waitFor([page.getByText('To make changes, move it to Parked.')], 'approved lock');
    },
    after: async (page) => assertPinnedBarOnScroll(page, 'post-detail-approved'),
  },
  {
    // Checkpoints and a thread folded: open point on top, the resolved ones
    // one line each at the bottom; the replies show only the latest.
    name: 'post-thread-folded',
    seed: creator,
    extra: seedFoldedThread,
    url: `/posts/${POST}`,
    steps: async (page) => {
      await postDetailReady(page);
      await waitFor([page.locator('[data-checkpoint-progress-row]')], 'progress row');
      await waitFor([page.locator('[data-point-fold]')], 'resolved point folded');
      const more = await firstVisible([page.locator('[data-replies-more]')], 'earlier replies');
      await expect(more).toHaveText('View 2 earlier replies');
      await more.scrollIntoViewIfNeeded();
    },
    after: async (page) => {
      await assertProgressRowUnderBar(page, 'post-thread-folded');
      await assertPinnedBarOnScroll(page, 'post-thread-folded');
    },
  },
  {
    // A PDF from a comment opens in the in-app file viewer: "<", its name,
    // "Page 1 of 3", Download; never a new tab.
    name: 'post-comment-file-viewer',
    seed: creator,
    extra: seedCommentPdf,
    url: `/posts/${POST}`,
    steps: async (page) => {
      await postDetailReady(page);
      const card = await firstVisible(
        [page.getByRole('button', { name: `Open ${COMMENT_PDF_NAME}`, exact: true })],
        'comment PDF card',
      );
      await card.scrollIntoViewIfNeeded();
      await card.click();
      const viewer = await firstVisible([page.locator('[data-file-viewer="pdf"]')], 'file viewer');
      await waitFor([viewer.locator('[data-pdf-page="1"] canvas')], 'PDF page 1');
      await waitFor([viewer.locator('[data-viewer-bar]')], 'viewer bar');
    },
  },
  ...PREVIEW_PLATFORMS.map(
    (p): Screen => ({
      name: `post-preview-${p.slug}`,
      seed: creator,
      extra: (network) => {
        onPlatform(network, p.platform, p.format);
        seedPostPhotos(network);
      },
      url: `/posts/${POST}`,
      steps: openPostPreview,
    }),
  ),
);

// ---------------------------------------------------------------------------
// One search, the top bar and the chip row (7 Nov 2026, decisions A to F). The
// top bar reads search | sort | "+" | avatar on every screen (layout-checks.ts
// check 8 runs on each); the six list screens' own shots are their base
// screens (pipeline, briefs, assets, plan-tab, notifications, chat-list),
// phone and laptop, light and dark (LAPTOP_DARK_SCREENS), and the slots hold
// one x across them (the top bar test below). Each screen's sort opens its
// menu (phone: the sheet; laptop: the popover); the Bank's sort is its Filter
// and sort sheet (plan-tab-bank-filter). Activity's primary is Mark all read
// (notifications), its slot empty at 0 unread (activity-all-read). A picker's
// search opens the palette in pick mode ("Chats only", ticks, "Send 1"); the
// pickers themselves are forward-picker, post-picker, plan-picker,
// asset-picker and plan-from-bank. The chip row's Select sits pinned at the
// row's end (each base screen) and pressed in select mode (*-select-on). Every
// upload shows ui/UploadRing or Retry, never a bar or a % (check 10:
// UPLOAD_SCREENS).

/** The top bar's slot (sort or primary). */
const topbarSlot = (page: Page, name: 'sort' | 'primary'): Locator =>
  page.locator(`header [data-topbar-slot="${name}"]`);

/** The top bar's sort opened: its options painted (the phone sheet or the laptop popover). */
async function openTopbarSort(page: Page): Promise<void> {
  await tap([topbarSlot(page, 'sort').locator('button')], 'top bar sort');
  await waitFor([page.locator('[role="menuitemradio"]')], 'sort options');
}

/** The chip row's Select tapped: select mode on, nothing ticked, Select pressed. */
async function chipRowSelectOn(page: Page): Promise<void> {
  await tap([page.locator('[data-chip-row-select] [data-section-select="off"]')], 'Select');
  await waitFor([page.locator('[data-chip-row-select] [data-section-select="on"]')], 'Select on');
}

const planTabReady = async (page: Page): Promise<void> =>
  waitFor([page.locator('[data-plan-tab-list]'), page.getByText('Autumn launch')], 'plan');

const activityReady = async (page: Page): Promise<void> =>
  waitFor([page.getByText('Priya Raman mentioned you')], 'activity');

/** Every Activity row read: nothing to mark, so the primary slot is empty (its width kept). */
function seedActivityAllRead(network: HarnessNetwork): void {
  for (const row of network.world.tables.inbox_entries ?? []) {
    row.read_at ??= new Date(NOW - 5 * 60_000).toISOString();
  }
}

/** The DM's Plan tile, New plan, then Add concept with a title typed. */
async function openAddConcept(page: Page): Promise<Locator> {
  await openDm(page);
  await pickTrayTile(page, 'plan');
  const plans = page.getByRole('dialog', { name: 'Plans' });
  await tap([plans.locator('[data-plan-pick-new]')], 'New plan');
  const compose = page.locator('[data-plan-page="compose"]');
  await tap([compose.locator('[data-plan-add-concept]')], 'Add concept');
  const sheet = page.getByRole('dialog', { name: 'Add concept' });
  await waitFor([sheet.locator('[data-plan-concept-title]')], 'Add concept sheet');
  await sheet.locator('[data-plan-concept-title]').fill('Opening reel');
  return sheet;
}

/** A fresh file picked in the Add concept sheet (its upload starts at once). */
async function pickConceptFile(sheet: Locator): Promise<void> {
  await sheet.locator('[data-plan-concept-upload-input]').setInputFiles({
    name: 'storyboard.png',
    mimeType: 'image/png',
    buffer: solidPng(64, 48, [200, 120, 80]),
  });
}

/** The asset-upload Worker refuses every original (a thumbnail still answers). */
async function refuseUploads(page: Page): Promise<void> {
  await page.route(
    (url) => url.hostname === 'asset-upload.harness.test',
    async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (request.method() !== 'POST' || path === '/thumbnail') {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 400,
        headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' },
        body: JSON.stringify({ error: 'upload_refused' }),
      });
    },
  );
}

SCREENS.push(
  // Briefs for the creator (no sort; the blocked "+": aria-disabled, the
  // disabled look). briefs-approver is the approver's (the live "+", no sort).
  { name: 'briefs', seed: creator, url: '/briefs', steps: briefsReady },
  // The blocked "+" (9 Nov 2026): a tap keeps it blocked and says who creates.
  {
    name: 'briefs-plus-blocked',
    seed: creator,
    url: '/briefs',
    steps: async (page) => {
      await briefsReady(page);
      // aria-disabled (not disabled): taps still fire, but Playwright's
      // actionability check counts it as not enabled, so force the click.
      const blocked = await firstVisible(
        [page.locator('[data-topbar-plus][aria-disabled="true"][aria-label="New brief"]')],
        'blocked New brief',
      );
      await blocked.click({ force: true });
      await waitFor([page.getByText('Briefs come from approvers.', { exact: true })], 'toast');
    },
  },
  {
    name: 'pipeline-plus-blocked',
    seed: approver,
    url: '/pipeline',
    steps: async (page) => {
      await pipelineReady(page);
      // aria-disabled (not disabled): taps still fire, but Playwright's
      // actionability check counts it as not enabled, so force the click.
      const blocked = await firstVisible(
        [page.locator('[data-topbar-plus][aria-disabled="true"][aria-label="New post"]')],
        'blocked New post',
      );
      await blocked.click({ force: true });
      await waitFor([page.getByText('Posts come from creators.', { exact: true })], 'toast');
    },
  },
  // Each screen's sort, open.
  {
    name: 'pipeline-sort',
    seed: creator,
    url: '/pipeline',
    steps: async (page) => {
      await pipelineReady(page);
      await openTopbarSort(page);
    },
  },
  {
    name: 'assets-sort',
    seed: creator,
    url: '/assets',
    steps: async (page) => {
      await assetsReady(page);
      await openTopbarSort(page);
    },
  },
  {
    name: 'plan-tab-sort',
    seed: creator,
    extra: seedTab,
    url: '/plan',
    steps: async (page) => {
      await planTabReady(page);
      await openTopbarSort(page);
    },
  },
  {
    name: 'chat-list-sort',
    seed: creator,
    url: '/chat',
    steps: async (page) => {
      await chatListAllRows(page);
      await openTopbarSort(page);
    },
  },
  {
    // Nothing unread: no Mark all read, the primary slot empty at its 44 width.
    name: 'activity-all-read',
    seed: creator,
    extra: seedActivityAllRead,
    url: '/activity',
    steps: async (page) => {
      await activityReady(page);
      await waitFor([topbarSlot(page, 'primary')], 'primary slot');
      await expect(page.locator('[data-activity-mark-all]')).toHaveCount(0);
    },
  },
  {
    // Forward's search: the palette in pick mode over the picker ("Chats
    // only"), "crew" typed, Launch crew ticked, the footer "Send 1".
    name: 'palette-pick',
    seed: creator,
    url: '/chat',
    steps: async (page) => {
      await openDmMessageMenu(page);
      await tap([page.locator('[data-menu-item="forward"]')], 'Forward');
      await tap([page.getByRole('button', { name: 'Forward', exact: true }).last()], 'Forward bar');
      await tap([page.getByRole('dialog').locator('[data-palette-pick-open]')], 'picker search');
      const palette = page.locator('[data-palette-overlay][data-palette-mode="pick"]');
      await waitFor([palette.locator('[data-palette-pick-pill]')], 'pick pill');
      await expect(palette.locator('[data-palette-pick-pill]')).toHaveText('Chats only');
      await palette.getByRole('combobox').fill('crew');
      const row = palette.locator('[data-palette-pick]', { hasText: GROUP_NAME }).first();
      await tap([row], `${GROUP_NAME} row`);
      await expect(row).toHaveAttribute('data-palette-pick', 'on');
      await expect(palette.locator('[data-palette-pick-footer] button')).toHaveText('Send 1');
    },
  },
  // The chip row's Select tapped: select mode with nothing ticked, Select pressed.
  {
    name: 'pipeline-select-on',
    seed: creator,
    url: '/pipeline',
    steps: async (page) => {
      await pipelineReady(page);
      await chipRowSelectOn(page);
    },
  },
  {
    name: 'assets-select-on',
    seed: creator,
    url: '/assets',
    steps: async (page) => {
      await assetsReady(page);
      await chipRowSelectOn(page);
    },
  },
  {
    name: 'plan-tab-bank-select-on',
    seed: creator,
    extra: seedBank,
    url: '/plan?week=bank',
    steps: async (page) => {
      await bankReady(page);
      await chipRowSelectOn(page);
    },
  },
  {
    name: 'chat-list-select-on',
    seed: creator,
    url: '/chat',
    steps: async (page) => {
      await chatListAllRows(page);
      await chipRowSelectOn(page);
    },
  },
  // Uploads (decision F): the ring with its X, or Retry, in the same spot.
  {
    // Assets: Upload files, one file going up (held): the ring on the row's
    // thumb, its X named Stop upload; the size line, no bar.
    name: 'assets-upload-uploading',
    seed: creator,
    extra: (network) => {
      network.holdUploads();
    },
    url: '/assets',
    steps: async (page) => {
      await assetsReady(page);
      await tap([page.locator('[data-topbar-plus][aria-label="New file"]')], 'New file');
      await tap([page.getByRole('menuitem', { name: 'Upload files' })], 'Upload files');
      const sheet = page.getByRole('dialog', { name: 'Upload files' });
      await waitFor([sheet], 'upload sheet');
      await sheet.locator('input[type="file"]').setInputFiles({
        name: 'launch-poster.png',
        mimeType: 'image/png',
        buffer: solidPng(64, 48, [176, 112, 72]),
      });
      await tap([sheet.getByRole('button', { name: 'Upload 1', exact: true })], 'Upload 1');
      const ring = await firstVisible(
        [sheet.locator('[data-upload-thumb="uploading"] [data-upload-ring]')],
        'row ring',
      );
      await expect(ring).toHaveAccessibleName('Stop upload');
      await attributeStill(ring, 'data-upload-progress');
    },
  },
  {
    // New post: a photo going up (held): the tile under the ring, its X named Cancel upload.
    // Tiles are the framed sheet's (a format with a media frame): on Instagram the
    // untouched sheet opens on Single image. LinkedIn's Text default has no frame,
    // so its pick is a ui/PendingChip (ring + X on the thumb) instead of a tile.
    name: 'post-tile-uploading',
    seed: creator,
    extra: (network) => {
      onPlatform(network, 'instagram', 'single_image');
      network.holdUploads();
    },
    url: '/pipeline',
    steps: async (page) => {
      await pipelineReady(page);
      await tap([page.locator('[data-topbar-plus][aria-label="New post"]')], 'New post');
      const sheet = await firstVisible([page.getByRole('dialog')], 'create post sheet');
      await sheet.locator('input[type="file"][aria-label="Add a photo or video"]').setInputFiles({
        name: 'cover.png',
        mimeType: 'image/png',
        buffer: solidPng(640, 640, [72, 120, 160]),
      });
      const ring = await firstVisible(
        [sheet.locator('[data-pending-tile]:not([data-failed]) [data-upload-ring]')],
        'tile ring',
      );
      await expect(ring).toHaveAccessibleName('Cancel upload');
      await attributeStill(ring, 'data-upload-progress');
    },
  },
  {
    // Add concept: the fresh file's chip uploading (ring + X on its thumb, the size line).
    name: 'concept-chip-uploading',
    seed: creator,
    extra: (network) => {
      network.holdUploads();
    },
    url: '/chat',
    steps: async (page) => {
      const sheet = await openAddConcept(page);
      await pickConceptFile(sheet);
      const chip = sheet.locator('[data-plan-concept-chips] [data-pending-chip="uploading"]');
      await waitFor([chip.locator('[data-upload-ring]')], 'uploading chip');
      await expect(chip.locator('[data-upload-ring]')).toHaveAccessibleName('Cancel upload');
    },
  },
  {
    // The upload done: the chip ready ("PNG · size", the trailing X removes).
    name: 'concept-chip-ready',
    seed: creator,
    url: '/chat',
    steps: async (page) => {
      const sheet = await openAddConcept(page);
      await pickConceptFile(sheet);
      await waitFor(
        [sheet.locator('[data-plan-concept-chips] [data-pending-chip="ready"]')],
        'ready chip',
      );
      await expect(sheet.locator('[data-pending-chip="uploading"]')).toHaveCount(0);
    },
  },
  {
    // The upload refused: the chip failed ("Couldn't upload", Retry, the trailing X).
    name: 'concept-chip-failed',
    seed: creator,
    prepare: (_network, page) => refuseUploads(page),
    url: '/chat',
    steps: async (page) => {
      const sheet = await openAddConcept(page);
      await pickConceptFile(sheet);
      const chip = sheet.locator('[data-plan-concept-chips] [data-pending-chip="failed"]');
      await waitFor([chip], 'failed chip');
      await expect(chip.locator('[data-pending-chip-meta]')).toHaveText("Couldn't upload");
    },
  },
);

/**
 * The upload screens: check 10 (no visible bar, no % figure) runs on each.
 * The chat sends are chat-upload-progress (photo), chat-send-uploading-* and
 * chat-send-queued-photo; the voice note is chat-voice-uploading; the
 * onboarding photo is onboarding-first-post-uploading (onboarding-steps.ts).
 */
const UPLOAD_SCREENS = new Set([
  'chat-upload-progress',
  'chat-send-queued-photo',
  'chat-send-uploading-album',
  'chat-send-uploading-video',
  'chat-send-uploading-file',
  'chat-voice-uploading',
  'assets-upload-uploading',
  'post-tile-uploading',
  'concept-chip-uploading',
  'concept-chip-ready',
  'concept-chip-failed',
  'onboarding-first-post-uploading',
]);

// ---------------------------------------------------------------------------
// The writing box (ui/WritingBox, Slack style, 8 Nov 2026): one box for chat,
// comments, sheet fields and the post caption. Chat: the phone's idle pill
// (+, "Message", mic), the card focused (empty and typing), the Aa row, the @
// list, the + drawer from the card, the emoji sheet and the Add link sheet, the
// expanded editor (phone: full screen; laptop: the box grown in place), and
// bubbles that render a numbered list, a quote with a bullet list, and a
// [text](url) link. Then a comment box on the post screen, the New brief
// Objective field focused with its row, and the New post caption box (emoji
// and "@" only, no Aa). Phone light/dark and laptop light come from the
// projects; LAPTOP_DARK_SCREENS adds laptop dark for the row and the bubbles.

const chatBox = (page: Page): Locator =>
  page.locator('[data-writing-box][data-mode="chat"]').first();

const chatField = (page: Page): Locator => chatBox(page).locator('textarea').first();

/** A writing box key by its aria-label ("Aa", "Emoji", "Mention", "Expand", ...). */
const boxKey = (box: Locator, name: string): Locator =>
  box.getByRole('button', { name, exact: true });

/**
 * The chat's writing box focused (phone: the pill turns into the card; laptop:
 * the card always), with `text` typed when given. `open` lands on the chat.
 */
async function focusChatBox(
  page: Page,
  text = '',
  open: (page: Page) => Promise<void> = openDm,
): Promise<Locator> {
  await open(page);
  const field = chatField(page);
  await field.click();
  await expect(field).toBeFocused();
  await waitFor(
    [page.locator('[data-writing-box][data-mode="chat"][data-shape="card"]')],
    'chat card',
  );
  if (text !== '') {
    await field.fill(text);
    await expect(chatBox(page).locator('[data-row-send]')).toBeEnabled();
  }
  return field;
}

/** Puts the caret in a textarea at `start` (to `end`), as a finger or a drag would. */
async function selectIn(field: Locator, start: number, end = start): Promise<void> {
  await field.evaluate(
    (el: HTMLTextAreaElement, at: { start: number; end: number }) => {
      el.focus();
      el.setSelectionRange(at.start, at.end);
      el.dispatchEvent(new Event('select', { bubbles: true }));
      document.dispatchEvent(new Event('selectionchange'));
    },
    { start, end },
  );
}

/** The emoji sheet's recents, held on the device before the page loads. */
async function seedEmojiRecents(_network: HarnessNetwork, page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem(
        'srtd.chat.emoji-recents',
        JSON.stringify(['🔥', '👍', '❤️', '😂', '🎉', '🙏']),
      );
    } catch {
      // Blocked storage: the sheet opens without its recents row.
    }
  });
}

/** The three DM bubbles that carry Slack blocks: a list, a quote with bullets, a link. */
const BLOCK_MESSAGES = {
  list: MEDIA_MESSAGE(0x40),
  quote: MEDIA_MESSAGE(0x41),
  link: MEDIA_MESSAGE(0x42),
} as const;

function seedBlockBubbles(network: HarnessNetwork): void {
  const at = (minutesAgo: number): string => new Date(NOW - minutesAgo * 60_000).toISOString();
  pushDmRow(network, BLOCK_MESSAGES.list, {
    sender: PEER,
    body: 'Shot list for Friday:\n1. Hamper unboxing\n2. Lamp close-up\n3. Team toast',
    created_at: at(3),
  });
  pushDmRow(network, BLOCK_MESSAGES.quote, {
    body: '> Can the hook land in 2 seconds?\nYes, cutting to:\n- Lid lift\n- *Logo* last',
    created_at: at(2),
  });
  pushDmRow(network, BLOCK_MESSAGES.link, {
    sender: PEER,
    body: `The reel brief is [here](${TEXT_URL}), notes inside.`,
    created_at: at(1),
  });
}

/** The New brief sheet open (the approver's "New brief"). */
async function openNewBrief(page: Page): Promise<Locator> {
  await briefsReady(page);
  await tap([page.getByRole('button', { name: 'New brief', exact: true })], 'New brief');
  return firstVisible([page.getByRole('dialog')], 'create brief sheet');
}

/** The New post sheet open (Pipeline's "New post"). */
async function openNewPost(page: Page): Promise<Locator> {
  await pipelineReady(page);
  await tap([page.getByRole('button', { name: 'New post', exact: true })], 'New post');
  return firstVisible([page.getByRole('dialog')], 'create post sheet');
}

SCREENS.push(
  {
    // Phone at rest: the pill (+, "Message", the mic), no rows.
    name: 'chat-box-idle',
    seed: creator,
    only: 'phone',
    url: '/chat',
    steps: async (page) => {
      await openDm(page);
      const pill = page.locator('[data-writing-box][data-mode="chat"][data-shape="pill"]');
      await waitFor([pill], 'idle pill');
      await waitFor([boxKey(pill, 'Record voice note')], 'pill mic');
      await expect(pill.locator('[data-writing-row]')).toHaveCount(0);
    },
  },
  {
    // Focused, nothing typed: the card (text on top; + Aa emoji @ ... send,
    // grey; laptop: the mic in the send slot while empty).
    name: 'chat-box-focused',
    seed: creator,
    hold: true,
    url: '/chat',
    steps: async (page) => {
      await focusChatBox(page);
      await waitFor([chatBox(page).locator('[data-action-row]')], 'action row');
      await page.mouse.move(0, 0);
    },
  },
  {
    // Typing: the send solid ink, the quiet Expand top right.
    name: 'chat-box-typing',
    seed: creator,
    hold: true,
    url: '/chat',
    steps: async (page) => {
      await focusChatBox(page, 'Cover is locked, sending the cut tonight');
      await waitFor([boxKey(chatBox(page), 'Expand')], 'Expand');
      await page.mouse.move(0, 0);
    },
  },
  {
    // The format row in place of the action row, Bold on (flat finish, 8 Nov
    // 2026). Phone: X close (a filled circle like send), Bold, Italic,
    // Underline, Strike, Link, Numbered list, Bullet list, send; no mic, no
    // Quote. Laptop: Aa on (which closes it) ... Quote. An on key is the glyph
    // in ink only.
    name: 'chat-box-format-row',
    seed: creator,
    hold: true,
    url: '/chat',
    steps: async (page) => {
      await focusChatBox(page, 'Three hooks for Friday');
      await tap([boxKey(chatBox(page), 'Aa')], 'Aa');
      const row = chatBox(page).getByRole('toolbar', { name: 'Format' });
      await waitFor([row], 'format row');
      const lead = isLaptop(page)
        ? '[data-row-key="aa"][aria-pressed="true"]'
        : '[data-row-key="close"]';
      await waitFor([row.locator(lead)], isLaptop(page) ? 'Aa on' : 'Close formatting');
      await tap([row.locator('[data-row-key="bold"]')], 'Bold');
      await waitFor([row.locator('[data-row-key="bold"][aria-pressed="true"]')], 'Bold on');
      await expect(chatBox(page).locator('[data-action-row]')).toHaveCount(0);
      await page.mouse.move(0, 0);
    },
  },
  {
    // @ (the row's Mention key types "@"): the group's people above the box.
    name: 'chat-box-mention',
    seed: creator,
    hold: true,
    url: '/chat',
    steps: async (page) => {
      await focusChatBox(page, '', (p) => openChat(p, GROUP_NAME));
      await tap([boxKey(chatBox(page), 'Mention')], 'Mention');
      await expect(chatField(page)).toHaveValue('@');
      await waitFor([page.locator('[data-mention-option]')], 'mention list');
      await page.mouse.move(0, 0);
    },
  },
  {
    // The + drawer opened from the card with a draft typed (the pill's +
    // drawer is composer-tray).
    name: 'chat-box-tray',
    seed: creator,
    hold: true,
    url: '/chat',
    steps: async (page) => {
      await focusChatBox(page, 'Files for the cut');
      await tap([boxKey(chatBox(page), 'Add attachment')], '+');
      await waitFor([page.locator('[data-tray]')], 'composer tray');
      await page.mouse.move(0, 0);
    },
  },
  {
    // The emoji sheet (ui/EmojiSheet): the search pill, Frequently used (held
    // on the device), the groups and the category bar.
    name: 'emoji-sheet',
    seed: creator,
    prepare: seedEmojiRecents,
    url: '/chat',
    steps: async (page) => {
      await focusChatBox(page);
      await tap([boxKey(chatBox(page), 'Emoji')], 'Emoji');
      const sheet = page.locator('[data-emoji-sheet]');
      await waitFor([sheet], 'emoji sheet');
      await waitFor([sheet.getByPlaceholder('Search emoji')], 'emoji search');
      await waitFor([sheet.getByText('Frequently used', { exact: true })], 'recents');
    },
  },
  {
    // Aa, Link with a word selected: the Add link sheet (Text prefilled, Link
    // empty; Cancel and Save).
    name: 'add-link-sheet',
    seed: creator,
    url: '/chat',
    steps: async (page) => {
      const text = 'The reel brief is here';
      const field = await focusChatBox(page, text);
      await tap([boxKey(chatBox(page), 'Aa')], 'Aa');
      await selectIn(field, text.length - 4, text.length);
      await tap([boxKey(chatBox(page), 'Link')], 'Link');
      const sheet = page.getByRole('dialog', { name: 'Add link' });
      await waitFor([sheet], 'Add link sheet');
      await expect(sheet.getByLabel('Text', { exact: true })).toHaveValue('here');
      await waitFor([sheet.getByRole('button', { name: 'Save', exact: true })], 'Save');
    },
  },
  {
    // Phone: Expand turns the same box into the full-screen editor (Collapse
    // and the chat's name in its bar, the rows at the bottom).
    name: 'chat-box-expanded',
    seed: creator,
    only: 'phone',
    hold: true,
    url: '/chat',
    steps: async (page) => {
      await focusChatBox(page, 'Plan for the week:\n1. Hamper reel\n2. Lamp stills\n3. Toast');
      await tap([boxKey(chatBox(page), 'Expand')], 'Expand');
      await waitFor([page.locator('[data-writing-box][data-expanded="phone"]')], 'editor');
      await waitFor([page.locator('[data-expanded-bar]')], 'editor bar');
      await page.mouse.move(0, 0);
    },
  },
  {
    // Laptop: Expand grows the box in place over the thread; Collapse top right.
    name: 'chat-box-expanded-laptop',
    seed: creator,
    only: 'laptop',
    hold: true,
    url: '/chat',
    steps: async (page) => {
      await focusChatBox(page, 'Plan for the week:\n1. Hamper reel\n2. Lamp stills\n3. Toast');
      await tap([boxKey(chatBox(page), 'Expand')], 'Expand');
      await waitFor([page.locator('[data-writing-box][data-expanded="laptop"]')], 'grown box');
      await waitFor([boxKey(chatBox(page), 'Collapse')], 'Collapse');
      await page.mouse.move(0, 0);
    },
  },
  {
    // Saved text renders its blocks: a numbered list (a peer), a quote over a
    // bullet list (own), and a [text](url) link showing its text (a peer).
    name: 'chat-bubble-blocks',
    seed: creator,
    extra: seedBlockBubbles,
    prepare: async (_network, page) => {
      await installLinkPreviewStub(page);
    },
    url: '/chat',
    steps: async (page) => {
      const link = await openDmOn(page, BLOCK_MESSAGES.link);
      const list = page.locator(`[data-msg-id="${BLOCK_MESSAGES.list}"] [data-msg-body]`);
      const quote = page.locator(`[data-msg-id="${BLOCK_MESSAGES.quote}"] [data-msg-body]`);
      await expect(list.locator('ol > li')).toHaveCount(3);
      await expect(quote.locator('.fmt-quote')).toHaveCount(1);
      await expect(quote.locator('ul > li')).toHaveCount(2);
      await expect(link.locator('[data-msg-body] [data-msg-link]')).toHaveText('here');
      await expect(link.locator('[data-msg-body]')).not.toContainText('](');
      await threadStill(page);
      await list.scrollIntoViewIfNeeded();
    },
  },
  {
    // The post screen's comment box focused with a line typed: the card with
    // its row (+ Aa emoji @ ... send).
    name: 'post-comment-box',
    seed: creator,
    hold: true,
    url: `/posts/${POST}`,
    steps: async (page) => {
      await postDetailReady(page);
      const box = page.locator('[data-writing-box][data-mode="comment"]').first();
      await box.scrollIntoViewIfNeeded();
      const field = box.locator('[contenteditable="true"], textarea').first();
      await field.click();
      await page.keyboard.type('Can the hook land sooner?');
      await waitFor([box.locator('[data-writing-row]')], 'comment row');
      await waitFor([boxKey(box, 'Aa')], 'comment Aa');
      await page.mouse.move(0, 0);
    },
  },
  {
    // ME's own edited comment (flat finish, 8 Nov 2026): the action bar rides
    // the row's top hairline, the name keeps one line, " (edited)" ends the body.
    name: 'post-comment-edited',
    seed: creator,
    extra: seedOwnEditedComment,
    url: `/posts/${POST}`,
    steps: async (page) => {
      await postDetailReady(page);
      const row = page.locator(`#comment-${ME_COMMENT_ID} [data-comment-row="root"]`);
      await waitFor([row.locator('[data-comment-edited]')], '(edited)');
      await expect(row.locator('[data-comment-bar]')).toHaveCSS('position', 'absolute');
      await row.scrollIntoViewIfNeeded();
    },
  },
  {
    // The same comment in its inline editor: Save and Cancel sit in view,
    // above the post screen's bottom bar on phone.
    name: 'post-comment-editing',
    seed: creator,
    extra: seedOwnEditedComment,
    hold: true,
    url: `/posts/${POST}`,
    steps: async (page) => {
      await postDetailReady(page);
      const comment = page.locator(`#comment-${ME_COMMENT_ID}`);
      const row = comment.locator('[data-comment-row="root"]');
      await row.scrollIntoViewIfNeeded();
      await tap([row.locator('[data-comment-bar] [data-bar-action="edit"]')], 'Edit');
      const save = comment.locator('[data-comment-editor]').getByRole('button', { name: 'Save' });
      await waitFor([save], 'Save');
      await expect(save).toBeInViewport({ ratio: 1 });
      await page.mouse.move(0, 0);
    },
  },
  {
    // New brief, Objective focused: a plain field at rest; focused, the format
    // keys and emoji sit inside its bottom edge (no +, no send).
    name: 'brief-field-row',
    seed: approver,
    hold: true,
    url: '/briefs',
    steps: async (page) => {
      const sheet = await openNewBrief(page);
      const field = sheet.locator('#brief-objective');
      await field.click();
      await page.keyboard.type('Three posts that sell the gift boxes.');
      // The inner locator is queried inside each box: root it at the page, not the sheet.
      const box = sheet.locator('[data-writing-box][data-mode="field"]', {
        has: page.locator('#brief-objective'),
      });
      await waitFor([box.locator('[data-writing-row]')], 'field row');
      await waitFor([boxKey(box, 'Bullet list')], 'Bullet list');
      await expect(boxKey(box, 'Add attachment')).toHaveCount(0);
      await page.mouse.move(0, 0);
    },
  },
  {
    // New post, Caption focused: emoji and "@" only (captions never format).
    name: 'post-caption-box',
    seed: creator,
    hold: true,
    url: '/pipeline',
    steps: async (page) => {
      const sheet = await openNewPost(page);
      const field = sheet.locator('#post-caption');
      await field.click();
      await page.keyboard.type('Festive hampers are here ');
      const box = sheet.locator('[data-writing-box][data-mode="caption"]');
      await waitFor([boxKey(box, 'Emoji')], 'caption emoji');
      await waitFor([boxKey(box, 'Mention')], 'caption @');
      await expect(boxKey(box, 'Aa')).toHaveCount(0);
      await expect(box.getByRole('toolbar', { name: 'Format' })).toHaveCount(0);
      await page.mouse.move(0, 0);
    },
  },
);

/** Catch-up screens with the reply at rest under comments: checkCatchUpComposer runs on each. */
const CATCH_UP_REST_SCREENS = new Set(['catch-up-rest']);

/** The writing box screens: check 11 (the row's keys and the send) runs on each. */
const WRITING_BOX_SCREENS = new Set([
  'chat-box-focused',
  'chat-box-typing',
  'chat-box-format-row',
  'chat-box-mention',
  'chat-box-expanded',
  'chat-box-expanded-laptop',
  'post-comment-box',
  'brief-field-row',
  'post-caption-box',
  'catch-up-tray-comment',
  'catch-up-tray-chat',
]);

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
  // Layout checks (layout-checks.ts) on the state as it is shot. A list
  // screen must show its ui/ListCards, so the list-card rule (equal heights,
  // the 40 picture at 16,10 in the bled row and 12 to the text) runs on it.
  if (LIST_CARD_SCREENS.has(screen.name)) await assertListCards(page, screen.name);
  // An upload screen shows the ring or Retry only: no visible bar, no % figure.
  if (UPLOAD_SCREENS.has(screen.name)) await assertNoUploadBar(page, screen.name);
  // A writing box screen: the row's keys are 44 tall, the send ends inside the box.
  if (WRITING_BOX_SCREENS.has(screen.name)) await assertWritingBox(page, screen.name);
  await checkLayout(page, screen.name);
  // Alignment (CLAUDE.md, 9 Nov 2026): one text column, one right edge, hung
  // photos, text off hairlines; measured on the screens that carry them.
  const align = ALIGN_SCREENS[screen.name];
  if (align !== undefined) await assertAlignment(page, screen.name, align);
  // A catch-up screen: 44 hits (bar keys 48), checkpoint circles on their
  // first line, no overlapping rows, the card on its own surface (check 13).
  if (screen.name.startsWith('catch-up-')) await assertCatchUpLayout(page, screen.name);
  // The reply at rest: the pill's field centred, its left on the photo column.
  if (CATCH_UP_REST_SCREENS.has(screen.name)) await checkCatchUpComposer(page, screen.name);
  await expect(page).toHaveScreenshot(`${screen.name}.png`, {
    maxDiffPixelRatio: 0.002,
    animations: 'disabled',
    caret: 'hide',
    ...(screen.mask !== undefined ? { mask: screen.mask(page) } : {}),
  });
  await screen.after?.(page);
  expect(network.blocked, 'blocked non-fixture requests').toEqual([]);
}

// Check 14 (alignment rules 1, 2, 3, 5): the screens and the family each measures.
const ALIGN_SCREENS: Readonly<Record<string, AlignScope>> = {
  'chat-thread-screen': 'chat-thread',
  'chat-thread-view-divider': 'chat-thread',
  'chat-thread-replies': 'chat-thread',
  'catch-up-thread-full': 'catch-up-thread',
  'catch-up-thread-empty': 'catch-up-thread',
  'catch-up-thread-replies': 'catch-up-thread',
  'chat-replies-row': 'chat-replies-row',
  'chat-replies-row-today': 'chat-replies-row',
  'chat-replies-row-older': 'chat-replies-row',
};

// The screens that list ui/ListCards (Pipeline, Briefs, Assets, the Chat
// list, Activity, the Plan tab and its Bank): checkLayout's list-card rule
// (every row the density height, 72 Cozy / 60 Compact / 80 Calm, the picture
// at 16 and the density inset in the bled row, 12 to the text)
// runs on every screen; these must show cards. The chip screens above may land
// on a chip's zero line, so they are checked whenever cards show.
const LIST_CARD_SCREENS = new Set([
  'chat-list-notes-photo',
  'pipeline',
  'pipeline-approver',
  'briefs',
  'briefs-approver',
  'assets',
  'assets-approver',
  'assets-select',
  'chat-list',
  'chat-list-select',
  'notifications',
  'activity-bank',
  'activity-sections',
  'activity-rows',
  'activity-rows-compact',
  'activity-rows-calm',
  'plan-tab',
  'plan-tab-live',
  'plan-tab-ended',
  'plan-tab-bank',
  'plan-tab-bank-select',
  'pipeline-select-1',
  'pipeline-select-2',
  'pipeline-overdue',
  'pipeline-select-on',
  'assets-select-on',
  'plan-tab-bank-select-on',
  'chat-list-select-on',
  'pipeline-compact',
  'pipeline-calm',
  'chat-list-compact',
  'chat-list-calm',
]);

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
  // Moment states: phone and laptop, light and dark.
  'chat-composer-recording',
  'chat-voice-sending',
  'asset-rename-saving',
  'chat-tasks-saving',
  'chat-upload-progress',
  'chat-message-pending',
  'chat-message-not-sent',
  'chat-select-mode',
  'post-approve-busy',
  // Delete for me: phone and laptop, light and dark.
  'chat-delete-sheet-everyone',
  'chat-delete-sheet-me',
  'chat-tombstone',
  'chat-tombstone-menu',
  'chat-home-chip-select',
  'chat-viewer-bar',
  'chat-viewer-delete-sheet',
  'chat-voice-uploading',
  'chat-list-notes-photo',
  // Chat media sweep: phone and laptop, light and dark.
  'chat-photo-single-portrait',
  'chat-photo-single-landscape',
  'chat-photo-single-square',
  'chat-album-2',
  'chat-album-3',
  'chat-album-4',
  'chat-send-queued-photo',
  'chat-send-uploading-album',
  'chat-send-uploading-video',
  'chat-send-uploading-file',
  'chat-send-failed-photo',
  'chat-send-failed-file',
  'chat-link-youtube',
  'chat-link-no-picture',
  'plan-dates-sheet',
  'sheet-header-back',
  // Post screen redo: phone and laptop, light and dark.
  'post-detail-approver',
  'post-detail-approved',
  'post-thread-folded',
  'post-comment-file-viewer',
  'post-preview-instagram',
  'post-preview-facebook',
  'post-preview-linkedin',
  'post-preview-x',
  'post-preview-threads',
  'post-preview-tiktok',
  'post-preview-youtube-shorts',
  // The six ListCard lists, every chip: phone and laptop, light and dark.
  'chat-list',
  'notifications',
  'plan-tab-bank',
  'pipeline-chip-all',
  'pipeline-chip-draft',
  'pipeline-chip-approved',
  'pipeline-chip-parked',
  'pipeline-chip-rejected',
  'assets-tab-media',
  'assets-tab-docs',
  'assets-tab-links',
  'assets-select',
  'pipeline-select-1',
  'pipeline-select-2',
  'pipeline-overdue',
  'chat-list-select',
  'plan-tab-bank-select',
  'plan-tab-live',
  'plan-tab-ended',
  'activity-chip-unread',
  'activity-chip-mentions',
  'plan-tab-chip-past',
  // Catch up and the thread view redo: phone and laptop, light and dark.
  'catch-up-thread-mention',
  'catch-up-thread-started',
  'catch-up-comment',
  'catch-up-swipe-read',
  'catch-up-swipe-keep',
  'catch-up-typing',
  'catch-up-end',
  // Catch up rebuild (9 Nov 2026: one card per item): phone and laptop, light and dark.
  'catch-up-rest',
  'catch-up-carousel',
  'catch-up-lightbox',
  'catch-up-menu',
  'catch-up-tray-comment',
  'catch-up-tray-chat',
  'catch-up-recording',
  'catch-up-voice-chip',
  'catch-up-thread-full',
  'catch-up-chat-main',
  'catch-up-long-name',
  'catch-up-long-title',
  'catch-up-long-caption',
  'catch-up-emoji',
  'catch-up-long-link',
  'catch-up-blank-lines',
  'catch-up-many-comments',
  'catch-up-video',
  'catch-up-text-only',
  'catch-up-caption-open',
  'catch-up-plan-item',
  'catch-up-bank-idea',
  'catch-up-brief-no-due',
  'catch-up-feedback',
  'catch-up-not-sent',
  'catch-up-error',
  'chat-thread-view-divider',
  // Alignment and one thread strip (9 Nov 2026): phone and laptop, light and dark.
  // Activity twins Plan in each density (10 Nov 2026): phone and laptop, light and dark.
  'activity-sections',
  'activity-rows',
  'activity-rows-compact',
  'activity-rows-calm',
  'boxes-activity',
  'chat-thread-replies',
  'catch-up-thread-empty',
  'catch-up-thread-replies',
  // Thread times and the replies row (9 Nov 2026): phone and laptop, light and dark.
  'chat-replies-row-today',
  'chat-replies-row-older',
  // One search, the top bar and the chip row (decisions A to F): phone and
  // laptop, light and dark. The top bar of the six list screens is shot on
  // their base screens above (pipeline, briefs-approver, assets, plan-tab,
  // notifications, chat-list) plus briefs for the creator and the blocked "+".
  'briefs',
  'briefs-plus-blocked',
  'pipeline-plus-blocked',
  'pipeline-sort',
  'assets-sort',
  'plan-tab-sort',
  'plan-tab-bank-filter',
  'chat-list-sort',
  'activity-all-read',
  'palette-pick',
  'forward-picker',
  'plan-picker',
  'asset-picker',
  'plan-from-bank',
  'pipeline-select-on',
  'assets-select-on',
  'plan-tab-bank-select-on',
  'chat-list-select-on',
  'assets-upload-uploading',
  'post-tile-uploading',
  'concept-chip-uploading',
  'concept-chip-ready',
  'concept-chip-failed',
  'onboarding-first-post-uploading',
  // The writing box (8 Nov 2026): phone and laptop, light and dark.
  'chat-box-typing',
  'chat-box-format-row',
  'chat-bubble-blocks',
  'post-comment-box',
]);

for (const screen of SCREENS) {
  const tag = LAPTOP_DARK_SCREENS.has(screen.name) ? ' @laptop-dark' : '';
  test(`${screen.name}${tag}`, async ({ page }) => capture(screen, page));
}

// The top bar across the six list screens (decision A): the sort and "+"
// slots sit at one x on Pipeline, Briefs, Assets, Plan, Activity and the Chat
// list (layout-checks.ts check 8b). One page walks them in turn on the
// fixture world; no screenshot (each screen's shot is its base screen).
const TOPBAR_LIST_SCREENS: ReadonlyArray<{ url: string; ready: (page: Page) => Promise<void> }> = [
  { url: '/pipeline', ready: pipelineReady },
  { url: '/briefs', ready: briefsReady },
  { url: '/assets', ready: assetsReady },
  { url: '/plan', ready: planTabReady },
  { url: '/activity', ready: activityReady },
  { url: '/chat', ready: chatListReady },
];

test('top bar: sort and "+" hold one x on the six list screens', async ({ page }) => {
  await page.clock.setFixedTime(NOW);
  await page.routeWebSocket(
    (url) => url.protocol === 'ws:' && url.hostname === 'localhost',
    () => undefined,
  );
  const network = await installHarnessNetwork(page);
  Object.assign(network.world, buildWorld(NOW));
  seedAudit(network, creator, NOW);
  seedTab(network);
  await installDeletedRoutes(page, network);
  const rows: Array<Awaited<ReturnType<typeof readTopbarSlots>>> = [];
  for (const screen of TOPBAR_LIST_SCREENS) {
    await page.goto(screen.url);
    await screen.ready(page);
    await waitFor([page.locator('header [data-topbar-slot="primary"]')], `${screen.url} top bar`);
    rows.push(await readTopbarSlots(page, screen.url));
  }
  assertTopbarSlotsStill('top bar across the six list screens', rows);
  expect(network.blocked, 'blocked non-fixture requests').toEqual([]);
});

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

// Check 15 (10 Nov 2026, Activity twins Plan): in each density, Activity's
// rows, sections and headings are measured against the Plan tab's on the same
// page (row height, picture x, title x, time right edge, chips to the first
// heading, heading to rows, a section's last row to the next heading, the
// heading's computed style); the "N new" chip (height by density, 8 after
// the name, the primary Button's ink); none of the retired hooks; and the
// loading boxes' first heading and first row land on the same pixel (0 delta).
// No screenshot (the shots are activity-rows*).
for (const density of ['compact', 'cozy', 'calm'] as const) {
  test(`activity twins plan (${density})`, async ({ page }) => {
    await page.clock.setFixedTime(NOW);
    await page.routeWebSocket(
      (url) => url.protocol === 'ws:' && url.hostname === 'localhost',
      () => undefined,
    );
    const network = await installHarnessNetwork(page);
    Object.assign(network.world, buildWorld(NOW));
    seedAudit(network, creator, NOW);
    seedTab(network);
    seedActivityRows(network);
    await withDensity(density)(network, page);
    await installDeletedRoutes(page, network);
    // Activity's read is held from the start, so no prefetch lands before its boxes paint.
    const hold = network.holdTable('inbox_entries');
    await page.goto('/plan');
    await planTabReady(page);
    await expectDensity(page, density);
    const plan = await readListTwin(page, 'plan');
    await page.goto('/activity');
    await waitFor([page.locator('[data-activity-boxes]')], 'activity boxes');
    const boxes = await readActivityBoxes(page);
    hold.release();
    await activitySectionsReady(page);
    const activity = await readListTwin(page, 'activity');
    assertActivityTwinsPlan(`activity twins plan (${density})`, plan, activity, boxes);
    expect(network.blocked, 'blocked non-fixture requests').toEqual([]);
  });
}
