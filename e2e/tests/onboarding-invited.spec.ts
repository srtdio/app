import { expect, test, type Page } from '@playwright/test';
import { installHarnessNetwork, solidPng, type HarnessNetwork } from '../fixtures/harness-routes';
import {
  COLLEAGUE_A,
  GROUP_CHANNEL,
  GROUP_ID,
  ME,
  WORKSPACE_ID,
  seedClientPlan,
} from '../fixtures/chat-data';
import { inductionDone, startInduction } from '../fixtures/induction-rpc';
import { ROUTE_SCRIPTS } from '../../src/lib/induction-routes';
import { FIRST_POST_SAMPLE, fillCopy, WELCOME_COPY } from '../../src/lib/induction-copy';
import type { Step } from '../../src/lib/induction-model';
import {
  INDUCTION_KEYS,
  collectErrors,
  copyContext,
  expectCard,
  expectGuideId,
  expectStep,
  selectCaptionWords,
  tapControl,
} from '../helpers/guide';

// The invited creator (an agency member who joined from an invite): the
// welcome, name with photo and role screens (Setup 1 of 2, Setup 2 of 2, no
// password, no age), then the guide: the Approved chip, the first post (open
// the sheet, then a tap each fills the caption, picks Single image and attaches
// the sample photo, then send for review), the intro
// card, Ask (the brief, the plan card in the group), Review (comment on a line
// of their own post), Talk (the group, the transcript step skipped by the 4 s rule because the
// harness offers no Transcribe link, Activity) and the closing card. Every
// guide step is walked with the real tap and checked against the guide spec
// (helpers/guide.ts). Seed: the fixture workspace, one open brief, a client
// plan card in the default group, posts by a teammate only. iPhone 13, dark.
// Linux WebKit approximates iOS WebKit, it is not iOS.

const script = ROUTE_SCRIPTS.invited;
const NOISE = [/chat store: initial load failed.*read cancelled/];
const BRIEF_AT = '2026-10-10T09:00:00Z';

function step(id: string): Step {
  const found = script.steps.find((s) => s.id === id);
  if (found === undefined) throw new Error(`no step ${id}`);
  return found;
}

function seedInvited(network: HarnessNetwork): void {
  const { world } = network;
  const t = world.tables;
  startInduction(t);
  const me = t.users?.find((u) => u.id === ME);
  if (me !== undefined) me.profile_completed_at = null;
  const member = t.workspace_members?.find((m) => m.user_id === ME);
  if (member !== undefined) {
    member.role = 'agency';
    member.invited_by = COLLEAGUE_A;
  }
  const group = t.groups?.find((g) => g.id === GROUP_ID);
  if (group !== undefined) group.is_default = true;
  // Posts by a teammate only: the invited creator has sent none yet.
  for (const post of t.posts ?? []) post.created_by = COLLEAGUE_A;
  (t.briefs ??= []).push({
    id: '0190e600-0000-7000-8000-0000000000b1',
    workspace_id: WORKSPACE_ID,
    number: 3,
    title: 'Festive week',
    objective: 'Sell the gift boxes before Diwali.',
    brand_requirements: null,
    format_requested: null,
    reference_links: null,
    mentions: null,
    status: 'open',
    target_date: null,
    created_via: 'app',
    created_by: COLLEAGUE_A,
    closed_at: null,
    closed_by: null,
    legacy_author_name: null,
    row_version: 1,
    created_at: BRIEF_AT,
    updated_at: BRIEF_AT,
    deleted_at: null,
  });
  seedClientPlan(world, {
    channelId: GROUP_CHANNEL,
    sender: COLLEAGUE_A,
    fileVersionId: '0190e600-0000-7000-8000-0000000000f1',
  });
}

/** The invited entry: welcome (no count), name with photo (Setup 1 of 2), role (Setup 2 of 2). */
async function walkEntry(page: Page): Promise<void> {
  await expect(
    page.getByRole('heading', { name: fillCopy(WELCOME_COPY.heading, copyContext()) }),
  ).toBeVisible({ timeout: 15_000 });
  await page.waitForLoadState('networkidle');
  await expect(page.getByText(/(Step|Setup) \d of \d/)).toHaveCount(0);
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  await page.getByRole('button', { name: WELCOME_COPY.continue, exact: true }).click();

  await expect(page.getByText('Setup 1 of 2')).toBeVisible();
  await page.getByLabel('Full name').fill('Meera Shah');
  await page.getByLabel('Choose a photo').setInputFiles({
    name: 'me.png',
    mimeType: 'image/png',
    buffer: solidPng(64, 64, [200, 120, 80]),
  });
  await page.getByRole('button', { name: 'Use this photo' }).click();
  const cont = page.getByRole('button', { name: 'Continue', exact: true });
  await expect(cont).toBeEnabled();
  await cont.click();

  await expect(page.getByText('Setup 2 of 2')).toBeVisible();
  await page.getByRole('button', { name: 'Job title' }).click();
  await page.getByRole('option', { name: 'Copywriter' }).click();
  // No age range any more (v13 dropped it).
  await expect(page.getByText(/age range/i)).toHaveCount(0);
  await expect(page.getByRole('radio', { name: /^\d{2}-\d{2}$|^55\+$/ })).toHaveCount(0);
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  await cont.click();
}

test('invited creator: welcome, name, role, then the first post and the look-around', async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  const errors = collectErrors(page);
  const network = await installHarnessNetwork(page);
  seedInvited(network);
  const ctx = copyContext();
  const narrow = {
    [INDUCTION_KEYS.chatDefaultGroupRow]: `[data-induction-channel="${GROUP_CHANNEL}"]`,
  };
  const check = async (id: string, back?: boolean, shot?: string) =>
    expectStep(page, info, {
      step: step(id),
      ctx,
      narrow,
      ...(back !== undefined ? { back } : {}),
      ...(shot !== undefined ? { shot } : {}),
    });
  await page.goto('/pipeline');
  await walkEntry(page);
  // The invited entry saves name, photo and role only: no password, no age.
  await expect
    .poll(() => network.rpcCalls.some((c) => c.name === 'user_onboarding_save'))
    .toBe(true);
  const save = network.rpcCalls.find((c) => c.name === 'user_onboarding_save');
  const payload = save?.args.p_payload as Record<string, unknown>;
  expect(payload.designation).toBe('Copywriter');
  expect('age_range' in payload).toBe(false);

  // First post: the Approved chip, then the post sheet field by field.
  await check('i_approved_chip', false, '01-first-step');
  await tapControl(page, step('i_approved_chip'));
  await check('i_post_create');
  await tapControl(page, step('i_post_create'));
  // The person never types: each tap fills its field and the guide moves on.
  // The caption tap fills the sample caption.
  await check('i_post_caption');
  await tapControl(page, step('i_post_caption'));
  await expect(page.locator('#post-caption')).toHaveValue(FIRST_POST_SAMPLE.caption);
  // The Format tap picks Single image (no menu) and passes the Single image step.
  await check('i_post_format');
  await tapControl(page, step('i_post_format'));
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Format', exact: true })).toHaveText(
    'Single image',
  );
  // The photo tap attaches the bundled sample and starts its upload at once.
  await check('i_post_media');
  await tapControl(page, step('i_post_media'));
  await expect(page.locator('img[src^="blob:"]').first()).toBeVisible();
  await expect.poll(() => network.uploads).toEqual([FIRST_POST_SAMPLE.photoName]);
  await check('i_post_send');
  await tapControl(page, step('i_post_send'));

  // The gate opens on the data: the post is in review, then the intro card.
  await expectCard(page, {
    id: script.intro.id,
    kind: 'intro',
    title: fillCopy(script.intro.title, ctx),
    button: script.intro.button,
  });
  const sent = network.world.tables.posts?.find((p) => p.created_by === ME);
  expect(sent?.stage).toBe('review');
  await page.getByRole('button', { name: script.intro.button, exact: true }).click();

  // Ask: the brief, then the plan card in the default group.
  await check('i_brief_open', undefined, '02-mid-route');
  await tapControl(page, step('i_brief_open'));
  // The card opens the brief; the guide then opens the group with the plan card.
  await check('i_plan_open');
  await tapControl(page, step('i_plan_open'));

  // Review: comment on one line of their own post.
  await check('i_line_select');
  // The tap alone selects nothing; the Comment button (the next control)
  // shows once a line is selected, which finishes the step.
  await tapControl(page, step('i_line_select'));
  await selectCaptionWords(page);
  await expectGuideId(page, 'i_comment_button');
  await check('i_comment_button');
  await tapControl(page, step('i_comment_button'));
  await page.keyboard.type('First line could be punchier.');
  await check('i_comment_post');
  await tapControl(page, step('i_comment_post'));
  await expect.poll(() => network.world.tables.comments?.length ?? 0).toBe(1);

  // Talk: the default group, the transcript step (skipped: no Transcribe link in the harness), then Activity.
  // The comment stays in view: the guide waits on the post for Next.
  await expectGuideId(page, 'i_group_open');
  await page.locator('[data-induction-next]').click();
  await check('i_group_open');
  await tapControl(page, step('i_group_open'), narrow);
  // The harness has no transcribe Worker, so the voice note offers no
  // Transcribe link: the step's control does not exist and the 4 s rule skips
  // it (bar only, no box), then Activity on the chat list.
  await expectGuideId(page, 'i_transcript');
  await expect(page.locator('[data-induction-box]')).toHaveCount(0);
  await expectGuideId(page, 'i_activity', 8_000);
  // Activity opens the chat list, where the tabs show.
  await check('i_activity');
  await tapControl(page, step('i_activity'));

  await expectCard(page, {
    id: script.closing.id,
    kind: 'closing',
    title: fillCopy(script.closing.title, ctx),
    button: script.closing.button,
  });
  await page.screenshot({ path: info.outputPath('03-closing.png') });
  await page.getByRole('button', { name: script.closing.button, exact: true }).click();
  await expect(page.locator('[data-induction-layer]')).toHaveCount(0);
  await expect.poll(() => inductionDone(network.world.tables)).toBe(true);
  expect(errors.filter((e) => !NOISE.some((n) => n.test(e)))).toEqual([]);
  expect(network.blocked).toEqual([]);
});
