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
  reaches,
  selectCaptionWords,
  expectStep,
  guideId,
  tapControl,
} from '../helpers/guide';

// The approver route of onboarding v13 (an invited client): the intro card,
// then Review (open the post, comment on a line, approve, confirm), Ask (a
// brief), Talk (the group, the transcript step skipped by the 4 s rule because the
// seed's voice note has no transcript, Activity), then the closing card. Every step is
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
  // Known product bug (soft): the hand presses the card's thumbnail, which
  // sits above the card's "Open post" button (PostCard.tsx), so the tap there
  // opens nothing and the step waits. The walk then taps the title row, which
  // reaches the button.
  await tapControl(page, step('a_post_open'), narrow);
  const opened = await reaches(page, 'a_line_select', 4_000);
  expect.soft(opened, 'a tap where the hand presses opens the post').toBe(true);
  if (!opened) {
    const title = await page.getByText(REVIEW_TITLE, { exact: true }).first().boundingBox();
    if (title === null) throw new Error('no post title');
    await page.mouse.click(title.x + 4, title.y + title.height / 2);
  }
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
  // Known product bug (soft): once the post is approved the data drops the
  // Review steps, the brief step becomes the first look-around step, and the
  // intro card shows again mid-route (resolveGuide in induction.ts). The walk
  // then taps Start, which lands on the brief step.
  // Wait past the facts re-read (the post left Review), then decide.
  await page.waitForTimeout(1_000);
  await expect
    .poll(() => guideId(page), { timeout: 10_000 })
    .toMatch(new RegExp(`^(${script.intro.id}|a_brief_add)$`));
  const noIntro = (await guideId(page)) !== script.intro.id;
  expect.soft(noIntro, 'no intro card again after the approval').toBe(true);
  if (!noIntro) await page.getByRole('button', { name: script.intro.button, exact: true }).click();

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

  // Talk: the default group, the transcript step (skipped), then Activity.
  await check('a_group_open');
  await tapControl(page, step('a_group_open'), narrow);
  // Known product bug (soft, seen on the laptop): the group row stays on
  // screen after its tap and the next control (the transcript link) is not
  // there, so the tap is never confirmed and the guide stays on the group.
  // The walk then resumes at the transcript step, as a reload would.
  const leftGroup = await reaches(page, 'a_transcript', 4_000, { box: false });
  expect.soft(leftGroup, 'the tap on the group row moves the guide on').toBe(true);
  if (!leftGroup) {
    startInduction(network.world.tables, 'a_transcript');
    await page.goto('/chat');
  }
  // The seed's voice note has no transcript yet, and the step's control is
  // the Show transcript link, so the 4 s rule skips it: bar only, then Activity.
  await expectGuideId(page, 'a_transcript');
  await expect(page.locator('[data-induction-box]')).toHaveCount(0);
  // Activity opens the chat list, where the tabs show.
  await expectGuideId(page, 'a_activity', 8_000);
  await check('a_activity');
  await tapControl(page, step('a_activity'));
  // Known product bug (soft): the last step has no next control, and the tab
  // stays on screen after its tap, so the tap is never confirmed and the guide
  // stays on Activity. The walk then resumes at the closing card, as a reload would.
  const closed = await reaches(page, script.closing.id, 4_000, { box: false });
  expect.soft(closed, 'the tap on the last step opens the closing card').toBe(true);
  if (!closed) {
    startInduction(network.world.tables, script.closing.id);
    await page.goto('/activity');
  }

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

  const writes = network.rpcCalls.map((c) => c.name).filter((n) => n.startsWith('induction_'));
  expect(new Set(writes)).toEqual(
    new Set(['induction_state', 'induction_step_set', 'induction_finish']),
  );
  expect(errors.filter((e) => !NOISE.some((n) => n.test(e)))).toEqual([]);
  expect(network.blocked).toEqual([]);
});

test('approver: an old stored step resolves by the data, then Skip finishes the tour', async ({
  page,
}, info) => {
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

  // Skip ends the tour at once: induction_finish, no guide, the screen stays.
  await page.locator('[data-induction-skip]').click();
  await expect(page.locator('[data-induction-layer]')).toHaveCount(0);
  await expect(page).toHaveURL(/\/pipeline/);
  await expect.poll(() => inductionDone(network.world.tables)).toBe(true);
  expect(network.rpcCalls.filter((c) => c.name === 'induction_finish')).toHaveLength(1);
  expect(errors.filter((e) => !NOISE.some((n) => n.test(e)))).toEqual([]);
});
