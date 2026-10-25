import { expect, type Locator, type Page } from '@playwright/test';
import { solidPng, type HarnessNetwork } from '../fixtures/harness-routes';
import type { Row } from '../fixtures/postgrest';
import {
  COLLEAGUE_A,
  GROUP_ID,
  ME,
  PEER,
  MAYA,
  POST_IDS,
  WORKSPACE_ID,
} from '../fixtures/chat-data';
import { startInduction } from '../fixtures/induction-rpc';
import { INDUCTION_KEYS, expectGuideId, selectCaptionWords, tapControl } from '../helpers/guide';
import { ROUTE_SCRIPTS } from '../../src/lib/induction-routes';
import { CHECK_EMAIL_COPY, WELCOME_COPY } from '../../src/lib/induction-copy';
import type { Step } from '../../src/lib/induction-model';

// The onboarding screens' walkers, shared by the visual lock (screens.spec.ts)
// and the PR C before/after capture (e2e/audit/capture-pr-c-onboarding.spec.ts),
// so the capture run proves every walker reaches its screen. Each screen is a
// fresh page: `prepare` edits the fixture world (and may add routes) after the
// harness network is installed, then `steps` walks from `url` to the state.
//
// Covered: sign up, sign in, the invite link's Join card (signed out); the
// pre-app screens of OnboardingFlow (the invitee's welcome; the self sign-up's
// side, name, the photo's positioning sheet, role; the approver's brand and
// waiting screens); the creator's setup in the shell (the workspace slot, the
// brand name form, the confirm, the filled first post, the approver invite, the
// closing card); and the approver tour's intro card and first three steps.
// There is no workspace photo anywhere in onboarding: the create form asks a
// brand name and a platform only (WorkspaceSwitcher), so the closest state is
// the confirm step (onboarding-workspace-confirm). The harness has no sample
// week (induction_sample_seed answers seeded: false), so the tour runs over the
// fixture workspace as onboarding-approver.spec.ts does.
//
// The guide's hand and ripple loop forever in CSS; the screenshots run with
// animations disabled, which cancels them to their first frame. The guide
// shows its pieces only once the control holds still, so every walker waits
// for the pieces and then for three equal reads of their rects.

/** The fixed instant both specs pin the page clock to (a Wednesday morning, UTC). */
export const ONBOARDING_NOW = Date.parse('2026-10-21T10:30:00Z');

const READY_MS = 20_000;
const TOKEN_KEY = 'sb-harness-auth-token';
const SUPABASE = 'https://harness.supabase.test';
const iso = (ms: number): string => new Date(ms).toISOString();

export interface OnboardingScreen {
  name: string;
  url: string;
  /** No session: the guest routes and the invite link's public Join card. */
  signedOut?: boolean;
  /** World edits after the world is built; may add page routes. */
  prepare?: (network: HarnessNetwork, page: Page, now: number) => Promise<void> | void;
  /** Waits for the page, then walks to the state to capture. */
  steps: (page: Page) => Promise<void>;
  /** Regions the visual lock masks: a product race no walker can settle. */
  mask?: (page: Page) => Locator[];
}

// ---------------------------------------------------------------------------
// Helpers

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

/** Drops the harness session before the app boots (runs after installHarnessNetwork's script). */
export async function signOut(page: Page): Promise<void> {
  await page.addInitScript((key) => window.localStorage.removeItem(key), TOKEN_KEY);
}

/**
 * The guide's pieces (`required`, plus the bar and card when shown) are up and
 * their rects read the same three times in a row: nothing is sliding in.
 */
async function guideSteady(page: Page, required: string[], what: string): Promise<void> {
  const pieces = [
    ...required,
    '[data-induction-box]',
    '[data-induction-hand]',
    '[data-induction-label]',
    '[data-induction-bar]',
    '[data-induction-card]',
  ];
  const until = Date.now() + READY_MS;
  let last = '';
  let same = 0;
  while (Date.now() < until) {
    const read = await page.evaluate(
      ({ all, need }) => {
        const rects = all.map((selector) => {
          const el = document.querySelector(selector);
          if (el === null) return null;
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0
            ? `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)},${Math.round(r.height)}`
            : null;
        });
        if (rects.slice(0, need).some((r) => r === null)) return null;
        return rects.map((r) => r ?? '-').join('|');
      },
      { all: pieces, need: required.length },
    );
    if (read !== null && read === last) {
      same += 1;
      if (same >= 2) return;
    } else {
      same = 0;
      last = read ?? '';
    }
    await page.waitForTimeout(200);
  }
  throw new Error(`guide never held still: ${what}`);
}

const SPOTLIGHT = ['[data-induction-box]', '[data-induction-hand]', '[data-induction-label]'];

async function onGuideStep(page: Page, id: string): Promise<void> {
  await expectGuideId(page, id, READY_MS);
  await guideSteady(page, SPOTLIGHT, id);
}

async function onGuideCard(page: Page, id: string, kind: 'intro' | 'closing'): Promise<void> {
  await expectGuideId(page, id, READY_MS);
  await guideSteady(page, [`[data-induction-card="${kind}"]`], id);
}

/** The pre-app screen's hand (EntryHand) on one Continue, settled. */
async function entryHandOn(page: Page, entry: string): Promise<void> {
  // The layer itself has no box (its pieces are absolute): wait on the pieces.
  const layer = `[data-induction-entry="${entry}"]`;
  await guideSteady(
    page,
    [`${layer} [data-induction-box]`, `${layer} [data-induction-hand]`],
    `${entry} hand`,
  );
}

function routeStep(route: 'creator' | 'approver', id: string): Step {
  const found = ROUTE_SCRIPTS[route].steps.find((s) => s.id === id);
  if (found === undefined) throw new Error(`no step ${id}`);
  return found;
}

function member(id: string, userId: string, role: string, active: boolean, now: number): Row {
  return {
    id,
    workspace_id: WORKSPACE_ID,
    user_id: userId,
    role,
    active,
    invited_by: active ? null : ME,
    invited_at: iso(now),
    accepted_at: active ? iso(now) : null,
    removed_at: null,
    rejoined_at: null,
  };
}

// ---------------------------------------------------------------------------
// Seeds

/** A self sign-up with an unfinished profile and no workspace (onboarding.spec.ts). */
function seedNewPerson(network: HarnessNetwork): void {
  const t = network.world.tables;
  const me = t.users?.find((u) => u.id === ME);
  if (me !== undefined) me.profile_completed_at = null;
  startInduction(t);
  t.workspaces = [];
  t.workspace_members = [];
}

/** An invited creator with an unfinished profile (onboarding-invited.spec.ts). */
function seedInvitee(network: HarnessNetwork): void {
  const t = network.world.tables;
  startInduction(t);
  const me = t.users?.find((u) => u.id === ME);
  if (me !== undefined) me.profile_completed_at = null;
  const mine = t.workspace_members?.find((m) => m.user_id === ME);
  if (mine !== undefined) {
    mine.role = 'agency';
    mine.invited_by = COLLEAGUE_A;
  }
}

/** An approver who signed up alone, on the brand or the waiting screen. */
function seedLoneApprover(network: HarnessNetwork, step: string, now: number): void {
  const t = network.world.tables;
  startInduction(t, step);
  t.workspaces = [];
  t.workspace_members = [];
  if (step === 'approver_waiting') {
    t.brand_agency_requests = [
      {
        id: '0190f200-0000-7000-8000-0000000000a1',
        requested_by: ME,
        agency_email: 'studio@kitebrand.in',
        brand_name: 'Kite',
        created_at: iso(now - 3_600_000),
      },
    ];
  }
}

/**
 * A new Creator in the shell: no workspace, no posts (onboarding-creator.spec.ts).
 * workspace_create hands back the fixture workspace.
 */
async function seedCreator(network: HarnessNetwork, page: Page, now: number): Promise<void> {
  const t = network.world.tables;
  startInduction(t);
  const group = t.groups?.find((g) => g.id === GROUP_ID);
  if (group !== undefined) group.is_default = true;
  const stash = t.workspaces?.[0];
  t.workspaces = [];
  t.workspace_members = [];
  t.posts = [];
  t.inbox_entries = [];
  await page.route(`${SUPABASE}/rest/v1/rpc/workspace_create`, async (route) => {
    const args = route.request().postDataJSON() as { p_payload: Record<string, string> };
    t.workspaces?.push({ ...stash, name: args.p_payload.name, platform: args.p_payload.platform });
    t.workspace_members?.push(
      member('0190f000-0000-7000-8000-0000000000f1', ME, 'owner', true, now),
    );
    await route.fulfill({ json: WORKSPACE_ID });
  });
}

/**
 * A Creator part way through setup on the fixture workspace (ME owner), resumed
 * at a stored step. `ownPost` makes Monday carousel theirs and in review (the
 * first post sent); `client` keeps the fixture's approvers (the approver invited).
 */
function seedCreatorAt(
  network: HarnessNetwork,
  opts: { step: string; ownPost: boolean; client: boolean },
): void {
  const t = network.world.tables;
  startInduction(t, opts.step);
  const group = t.groups?.find((g) => g.id === GROUP_ID);
  if (group !== undefined) group.is_default = true;
  (t.posts ?? []).forEach((post, k) => {
    const mine = opts.ownPost && k === 0;
    post.created_by = mine ? ME : COLLEAGUE_A;
    if (mine) post.stage = 'review';
  });
  if (!opts.client) {
    for (const m of t.workspace_members ?? []) {
      if (m.user_id === PEER || m.user_id === MAYA) m.role = 'agency';
    }
  }
}

/** The approver's tour: one post in review by a teammate (onboarding-approver.spec.ts). */
function seedApprover(network: HarnessNetwork): void {
  const t = network.world.tables;
  startInduction(t);
  const group = t.groups?.find((g) => g.id === GROUP_ID);
  if (group !== undefined) group.is_default = true;
  const me = t.workspace_members?.find((m) => m.user_id === ME);
  if (me !== undefined) me.role = 'client';
  (t.posts ?? []).forEach((post, k) => {
    post.stage = k === 0 ? 'review' : 'approved';
    post.created_by = COLLEAGUE_A;
    post.caption = 'Launch day is here. The new range lands Monday.';
    post.post_versions = [
      {
        id: `0190e000-0000-7000-8000-00000000e00${k + 1}`,
        post_id: post.id,
        workspace_id: post.workspace_id,
        version_number: 1,
        snapshot: {},
        created_by: COLLEAGUE_A,
        legacy_author_name: null,
        created_at: post.created_at,
      },
    ];
  });
}

// ---------------------------------------------------------------------------
// Walkers

/** The side screen with Creator picked (a late shell read can drop a pick: pick again). */
async function sidePicked(page: Page): Promise<void> {
  await waitFor([page.getByRole('heading', { name: "How you'll use Sorted" })], 'side screen');
  await page.waitForLoadState('networkidle');
  const cont = page.getByRole('button', { name: 'Continue', exact: true });
  await expect(async () => {
    await page.getByRole('radio', { name: /Creator/ }).click();
    await expect(cont).toBeEnabled({ timeout: 1_000 });
    await expect(page.locator('[data-induction-entry="onboarding-side-continue"]')).toHaveCount(1, {
      timeout: 1_000,
    });
  }).toPass({ timeout: READY_MS });
}

async function sideScreen(page: Page): Promise<void> {
  await sidePicked(page);
  await entryHandOn(page, 'onboarding-side-continue');
}

/** The name screen, filled: Full name and the suggested username, checked free. */
async function nameFilled(page: Page): Promise<void> {
  await sidePicked(page);
  const cont = page.getByRole('button', { name: 'Continue', exact: true });
  await expect(async () => {
    await cont.click({ timeout: 1_000 });
    await expect(page.getByRole('heading', { name: 'Your name' })).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: READY_MS });
  await page.getByLabel('Full name').fill('Meera Shah');
  await waitFor([page.getByText('@meera.shah is yours.')], 'username checked');
}

async function nameScreen(page: Page): Promise<void> {
  await nameFilled(page);
  await entryHandOn(page, 'onboarding-name-continue');
}

/** The photo's positioning sheet over the name screen, a photo loaded. */
async function photoCropScreen(page: Page): Promise<void> {
  await nameFilled(page);
  await page.getByLabel('Choose a photo').setInputFiles({
    name: 'me.png',
    mimeType: 'image/png',
    buffer: solidPng(64, 64, [200, 120, 80]),
  });
  const use = page.getByRole('button', { name: 'Use this photo' });
  await waitFor([use], 'positioning sheet');
  await expect(use).toBeEnabled({ timeout: READY_MS });
  await page.waitForTimeout(400);
}

/** The role screen with a job title picked. */
async function roleScreen(page: Page): Promise<void> {
  await nameFilled(page);
  await entryHandOn(page, 'onboarding-name-continue');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await waitFor([page.getByRole('heading', { name: 'Your title' })], 'role screen');
  await page.getByRole('button', { name: 'Job title' }).click();
  await page.getByRole('option', { name: 'Copywriter' }).click();
  await entryHandOn(page, 'onboarding-role-continue');
}

/** The invitee's welcome, its subline read (the inviter's name). */
async function welcomeScreen(page: Page): Promise<void> {
  await waitFor([page.getByRole('heading', { name: 'Welcome to Harness Studio' })], 'welcome');
  await waitFor(
    [page.getByText('Leo Martins invited you to create posts with the team.')],
    'welcome subline',
  );
  await waitFor([page.getByRole('button', { name: WELCOME_COPY.continue, exact: true })], 'go');
}

/** The creator's first guide step: the top bar slot, no workspace yet. */
async function workspaceSlot(page: Page): Promise<void> {
  await onGuideStep(page, 'c_workspace');
}

/** The create form filled (Kite, LinkedIn): Continue is boxed. */
async function workspaceNameFilled(page: Page): Promise<void> {
  await workspaceSlot(page);
  await tapControl(page, routeStep('creator', 'c_workspace'));
  await expectGuideId(page, 'c_workspace_continue', READY_MS);
  await page.getByLabel('Brand name').fill('Kite');
  await page.getByRole('radio', { name: 'LinkedIn' }).click();
  await onGuideStep(page, 'c_workspace_continue');
}

/** The confirm step: the name can't be changed later; Create is boxed. */
async function workspaceConfirm(page: Page): Promise<void> {
  await workspaceNameFilled(page);
  await tapControl(page, routeStep('creator', 'c_workspace_continue'));
  await onGuideStep(page, 'c_workspace_create');
}

/** The first post's sheet filled by the guide's taps (caption, Single image, photo): Send is boxed. */
async function firstPostFilled(page: Page): Promise<void> {
  const step = (id: string): Step => routeStep('creator', id);
  await onGuideStep(page, 'c_post_create');
  await tapControl(page, step('c_post_create'));
  await onGuideStep(page, 'c_post_caption');
  await tapControl(page, step('c_post_caption'));
  await onGuideStep(page, 'c_post_format');
  await tapControl(page, step('c_post_format'));
  await onGuideStep(page, 'c_post_media');
  await tapControl(page, step('c_post_media'));
  await waitFor([page.locator('img[src^="blob:"]')], 'first post photo');
  await onGuideStep(page, 'c_post_send');
}

/** The approver invite gate on Members: the email field is boxed. */
async function approverInvite(page: Page): Promise<void> {
  await onGuideStep(page, 'c_approver_invite');
}

async function creatorClosing(page: Page): Promise<void> {
  await onGuideCard(page, ROUTE_SCRIPTS.creator.closing.id, 'closing');
}

const APPROVER_NARROW = `[data-induction-post="${POST_IDS[0]}"]`;

async function tourIntro(page: Page): Promise<void> {
  await onGuideCard(page, ROUTE_SCRIPTS.approver.intro.id, 'intro');
}

async function tourPostOpen(page: Page): Promise<void> {
  await tourIntro(page);
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await onGuideStep(page, 'a_post_open');
}

async function tourLineSelect(page: Page): Promise<void> {
  await tourPostOpen(page);
  await tapControl(page, routeStep('approver', 'a_post_open'), {
    [INDUCTION_KEYS.pipelinePostRow]: APPROVER_NARROW,
  });
  await onGuideStep(page, 'a_line_select');
}

async function tourCommentButton(page: Page): Promise<void> {
  await tourLineSelect(page);
  await tapControl(page, routeStep('approver', 'a_line_select'));
  await selectCaptionWords(page);
  await onGuideStep(page, 'a_comment_button');
}

// ---------------------------------------------------------------------------
// Screens

const INVITE_ID = '0190f000-0000-7000-8000-0000000000e1';

export const ONBOARDING_SCREENS: OnboardingScreen[] = [
  {
    name: 'onboarding-sign-up',
    url: '/signup',
    signedOut: true,
    steps: async (page) =>
      waitFor(
        [page.getByRole('button', { name: CHECK_EMAIL_COPY.createAccount, exact: true })],
        'sign up',
      ),
  },
  {
    name: 'onboarding-sign-in',
    url: '/signin',
    signedOut: true,
    steps: async (page) =>
      waitFor([page.getByRole('button', { name: 'Email me a sign-in link' })], 'sign in'),
  },
  {
    // The invite email's tap-to-join link (?th=), opened signed out: the Join card.
    name: 'onboarding-invite-accept',
    url: `/invite/accept/${INVITE_ID}?th=harness-token&ws=Harness%20Studio&by=Priya%20Raman`,
    signedOut: true,
    steps: async (page) =>
      waitFor([page.getByRole('button', { name: 'Join Harness Studio' })], 'invite join card'),
  },
  {
    name: 'onboarding-welcome',
    url: '/pipeline',
    prepare: (network) => seedInvitee(network),
    steps: welcomeScreen,
  },
  {
    name: 'onboarding-side',
    url: '/chat',
    prepare: (network) => seedNewPerson(network),
    steps: sideScreen,
  },
  {
    name: 'onboarding-name',
    url: '/chat',
    prepare: (network) => seedNewPerson(network),
    steps: nameScreen,
  },
  {
    name: 'onboarding-photo-crop',
    url: '/chat',
    prepare: (network) => seedNewPerson(network),
    steps: photoCropScreen,
  },
  {
    name: 'onboarding-role',
    url: '/chat',
    prepare: (network) => seedNewPerson(network),
    steps: roleScreen,
  },
  {
    name: 'onboarding-brand',
    url: '/pipeline',
    prepare: (network, _page, now) => seedLoneApprover(network, 'approver_brand', now),
    steps: async (page) =>
      waitFor([page.getByRole('heading', { name: 'Who makes your posts?' })], 'brand screen'),
  },
  {
    name: 'onboarding-waiting',
    url: '/pipeline',
    prepare: (network, _page, now) => seedLoneApprover(network, 'approver_waiting', now),
    steps: async (page) => {
      await waitFor([page.getByRole('heading', { name: 'Your team is on its way' })], 'waiting');
      await waitFor([page.getByText('We asked studio@kitebrand.in.')], 'waiting request');
    },
  },
  {
    name: 'onboarding-workspace-slot',
    url: '/pipeline',
    prepare: (network, page, now) => seedCreator(network, page, now),
    steps: workspaceSlot,
  },
  {
    name: 'onboarding-workspace-name',
    url: '/pipeline',
    prepare: (network, page, now) => seedCreator(network, page, now),
    steps: workspaceNameFilled,
  },
  {
    // No workspace photo exists in onboarding: the confirm is the step after the name.
    name: 'onboarding-workspace-confirm',
    url: '/pipeline',
    prepare: (network, page, now) => seedCreator(network, page, now),
    steps: workspaceConfirm,
  },
  {
    name: 'onboarding-first-post',
    url: '/pipeline',
    prepare: async (network, page) => {
      seedCreatorAt(network, { step: 'c_post_create', ownPost: false, client: true });
      // The laptop composer preview races the photo's measure against the upload
      // finishing (PlatformPreviewPanel resets the measure when the version id
      // lands): it ends on "Measuring the original." or on the crop, run to run,
      // and its height moves the sheet around it, so a mask cannot hold. The
      // shot leaves the preview out (laptop only; phone never shows it).
      await page.addInitScript(() => {
        document.addEventListener('DOMContentLoaded', () => {
          const style = document.createElement('style');
          style.textContent = '[data-composer-preview] { display: none !important; }';
          document.head.appendChild(style);
        });
      });
    },
    steps: firstPostFilled,
  },
  {
    name: 'onboarding-invite-approver',
    url: '/settings?panel=members',
    prepare: (network) =>
      seedCreatorAt(network, { step: 'c_approver_invite', ownPost: true, client: false }),
    steps: approverInvite,
  },
  {
    name: 'onboarding-done',
    url: '/pipeline',
    prepare: (network) =>
      seedCreatorAt(network, {
        step: ROUTE_SCRIPTS.creator.closing.id,
        ownPost: true,
        client: true,
      }),
    steps: creatorClosing,
  },
  {
    name: 'onboarding-tour-intro',
    url: '/pipeline',
    prepare: (network) => seedApprover(network),
    steps: tourIntro,
  },
  {
    name: 'onboarding-tour-1',
    url: '/pipeline',
    prepare: (network) => seedApprover(network),
    steps: tourPostOpen,
  },
  {
    name: 'onboarding-tour-2',
    url: '/pipeline',
    prepare: (network) => seedApprover(network),
    steps: tourLineSelect,
  },
  {
    name: 'onboarding-tour-3',
    url: '/pipeline',
    prepare: (network) => seedApprover(network),
    steps: tourCommentButton,
  },
];
