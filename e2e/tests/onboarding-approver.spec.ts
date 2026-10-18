import { expect, test } from '@playwright/test';
import { installHarnessNetwork, type HarnessNetwork } from '../fixtures/harness-routes';
import { COLLEAGUE_A, GROUP_CHANNEL, GROUP_ID, ME, POST_IDS } from '../fixtures/chat-data';
import { inductionDone, startInduction } from '../fixtures/induction-rpc';
import { ROUTE_SCRIPTS } from '../../src/lib/induction-routes';
import { fillCopy } from '../../src/lib/induction-copy';
import type { Step } from '../../src/lib/induction-model';
import {
  collectErrors,
  copyContext,
  expectCard,
  expectGuideId,
  INDUCTION_KEYS,
  inductionSelector,
  selectCaptionWords,
  expectStep,
  guideId,
  tapControl,
} from '../helpers/guide';

// The approver route of onboarding v13 (an invited client): the intro card,
// then Review (open the post, comment on a line, approve, confirm), Ask (a
// brief), Talk (the group, the transcript step skipped by the 4 s rule because the
// harness offers no Transcribe link, Activity), then the closing card. Every step is
// walked with the real tap and checked against the guide spec (helpers/guide.ts).
// Seed: the fixture workspace with one post in review made by a teammate, the
// default group with an untranscribed voice note.
// Runs on the iPhone 13 viewport (dark) and on the 1280x800 laptop (@desktop).
// Linux WebKit approximates iOS WebKit, it is not iOS.

const script = ROUTE_SCRIPTS.approver;
const NOISE = [/chat store: initial load failed.*read cancelled/];
const REVIEW_TITLE = 'Monday carousel';
const CREATOR = 'Leo Martins';

/** The guide's qualifiers: the default group's row, the review post's row. */
const NARROW = {
  [INDUCTION_KEYS.chatDefaultGroupRow]: `[data-induction-channel="${GROUP_CHANNEL}"]`,
  [INDUCTION_KEYS.pipelinePostRow]: `[data-induction-post="${POST_IDS[0]}"]`,
};

function step(id: string): Step {
  const found = script.steps.find((s) => s.id === id);
  if (found === undefined) throw new Error(`no step ${id}`);
  return found;
}

function seedApprover(network: HarnessNetwork): void {
  const t = network.world.tables;
  startInduction(t);
  const group = t.groups?.find((g) => g.id === GROUP_ID);
  if (group !== undefined) group.is_default = true;
  const me = t.workspace_members?.find((m) => m.user_id === ME);
  if (me !== undefined) me.role = 'client';
  // One post in review, made by a teammate; the others already approved.
  (t.posts ?? []).forEach((post, k) => {
    post.stage = k === 0 ? 'review' : 'approved';
    post.created_by = COLLEAGUE_A;
    post.caption = 'Launch day is here. The new range lands Monday.';
    // A caption comment anchors to the current version (PostDetailPage).
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

test('approver: review, ask, talk with real taps, then Done @desktop', async ({ page }, info) => {
  test.setTimeout(120_000);
  const errors = collectErrors(page);
  const network = await installHarnessNetwork(page);
  seedApprover(network);
  const ctx = copyContext({ post: REVIEW_TITLE, creator: CREATOR });
  const narrow = NARROW;
  const check = async (id: string, back?: boolean, shot?: string) =>
    expectStep(page, info, {
      step: step(id),
      ctx,
      narrow,
      ...(back !== undefined ? { back } : {}),
      ...(shot !== undefined ? { shot } : {}),
    });

  await page.goto('/pipeline');

  // The intro card names the post and who sent it; no hairline under it.
  await expectCard(page, {
    id: script.intro.id,
    kind: 'intro',
    title: fillCopy(script.intro.title, ctx),
    button: script.intro.button,
  });
  await page.getByRole('button', { name: script.intro.button, exact: true }).click();

  // Review.
  await check('a_post_open', false, '01-first-step');
  // The tap where the hand presses (the thumbnail) opens the post.
  await tapControl(page, step('a_post_open'), narrow);
  await check('a_line_select');
  // The tap alone selects nothing; the Comment button (the next control)
  // shows once a line is selected, which finishes the step.
  await tapControl(page, step('a_line_select'));
  await selectCaptionWords(page);
  await expectGuideId(page, 'a_comment_button');
  await check('a_comment_button', true);

  // Back goes one step back and never undoes data; the walk carries on.
  await page.locator('[data-induction-back]').click();
  await expectGuideId(page, 'a_line_select');
  // The tap alone selects nothing; the Comment button (the next control)
  // shows once a line is selected, which finishes the step.
  await tapControl(page, step('a_line_select'));
  await selectCaptionWords(page);
  await expectGuideId(page, 'a_comment_button');
  await check('a_comment_button');
  await tapControl(page, step('a_comment_button'));

  await expect(page.getByRole('textbox', { name: 'Caption comment body' })).toBeFocused();
  await page.keyboard.type('Can the first line be shorter?');
  await check('a_comment_post', undefined, '02-mid-route');
  await tapControl(page, step('a_comment_post'));
  await check('a_approve');
  await tapControl(page, step('a_approve'));
  await check('a_approve_confirm');
  await tapControl(page, step('a_approve_confirm'));
  await expect.poll(() => network.world.tables.posts?.[0]?.stage).toBe('approved');
  // The data drops the Review steps once the post is approved; the intro card
  // never returns, the guide goes straight on to the brief.
  await page.waitForTimeout(1_000);
  expect(await guideId(page)).not.toBe(script.intro.id);

  // Ask: a brief, field by field.
  await check('a_brief_add');
  await tapControl(page, step('a_brief_add'));
  // Field steps: type, then tap the next field to finish the title.
  await check('a_brief_title');
  await tapControl(page, step('a_brief_title'));
  await page.keyboard.type('Diwali week');
  expect(await guideId(page)).toBe('a_brief_title');
  await tapControl(page, step('a_brief_objective'));
  await check('a_brief_objective');
  await page.keyboard.type('Three posts that sell the gift boxes.');
  // The keyboard's Done: a filled field losing focus finishes it.
  await page.locator(inductionSelector(INDUCTION_KEYS.briefSheetObjective)).blur();
  await check('a_brief_create');
  await tapControl(page, step('a_brief_create'));
  await expect.poll(() => network.world.tables.briefs?.length ?? 0).toBe(1);

  // Talk: the default group, the transcript step (skipped: no Transcribe link in the harness), then Activity.
  await check('a_group_open');
  await tapControl(page, step('a_group_open'), narrow);
  // The harness has no transcribe Worker, so the voice note offers no
  // Transcribe link: the step's control does not exist and the 4 s rule skips
  // it (bar only, no box), then Activity on the chat list.
  await expectGuideId(page, 'a_transcript');
  await expect(page.locator('[data-induction-box]')).toHaveCount(0);
  await expectGuideId(page, 'a_activity', 8_000);
  // Activity opens the chat list, where the tabs show.
  await check('a_activity');
  await tapControl(page, step('a_activity'));

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

  // induction_sample_files is a read: the sample week's file keys, so its
  // photos show from the site without a presign.
  const writes = network.rpcCalls
    .map((c) => c.name)
    .filter((n) => n.startsWith('induction_') && n !== 'induction_sample_files');
  expect(new Set(writes)).toEqual(
    new Set(['induction_state', 'induction_step_set', 'induction_sample_seed', 'induction_finish']),
  );
  expect(errors.filter((e) => !NOISE.some((n) => n.test(e)))).toEqual([]);
  expect(network.blocked).toEqual([]);
});

test('approver: an old stored step resolves by the data', async ({ page }, info) => {
  const errors = collectErrors(page);
  const network = await installHarnessNetwork(page);
  seedApprover(network);
  // An id from the old card guide: no crash, the route resumes from the data.
  startInduction(network.world.tables, 'approver_top_bar');
  const ctx = copyContext({ post: REVIEW_TITLE, creator: CREATOR });
  await page.goto('/pipeline');

  await expectCard(page, {
    id: script.intro.id,
    kind: 'intro',
    title: fillCopy(script.intro.title, ctx),
    button: script.intro.button,
  });
  await page.getByRole('button', { name: script.intro.button, exact: true }).click();
  await expectStep(page, info, { step: step('a_post_open'), ctx, back: false, narrow: NARROW });
  expect(network.rpcCalls.filter((c) => c.name === 'induction_finish')).toHaveLength(0);
  expect(errors.filter((e) => !NOISE.some((n) => n.test(e)))).toEqual([]);
});
