import { expect, test } from '@playwright/test';
import { installHarnessNetwork, type HarnessNetwork } from '../fixtures/harness-routes';
import { GROUP_CHANNEL, GROUP_ID, ME, WORKSPACE_ID } from '../fixtures/chat-data';
import { inductionDone, startInduction } from '../fixtures/induction-rpc';
import type { Row } from '../fixtures/postgrest';
import { ROUTE_SCRIPTS } from '../../src/lib/induction-routes';
import { FIRST_POST_SAMPLE, fillCopy } from '../../src/lib/induction-copy';
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

// The creator route of onboarding v13 (the owner who signed up; the pre-app
// screens are onboarding.spec.ts): Step 1 the workspace (the top bar slot, the
// form's Continue, then Create), Step 2 the Approved chip, Step 3 the first post (open the sheet, then
// a tap each fills the caption, picks Single image and attaches the sample
// photo, then send for review), Step 4 the approver
// invite (a gate) and the optional team invite ("It's just me for now"), the
// intro card, then the look-around on their own workspace: no brief and no
// plan yet (both steps dropped by the data), Review (comment on a line of
// their post), Talk (the group, the transcript step skipped by the 4 s rule because the
// harness offers no Transcribe link, Activity), and the closing card. Every step is
// walked with the real tap and checked against the guide spec
// (helpers/guide.ts). Seed: no workspace yet. iPhone 13, dark.
// Linux WebKit approximates iOS WebKit, it is not iOS.

const SUPABASE = 'https://harness.supabase.test';
const script = ROUTE_SCRIPTS.creator;
const NOISE = [/chat store: initial load failed.*read cancelled/];
const POST_TITLE = 'Launch day';

function step(id: string): Step {
  const found = script.steps.find((s) => s.id === id);
  if (found === undefined) throw new Error(`no step ${id}`);
  return found;
}

function member(id: string, userId: string, role: string, active: boolean): Row {
  const now = new Date().toISOString();
  return {
    id,
    workspace_id: WORKSPACE_ID,
    user_id: userId,
    role,
    active,
    invited_by: active ? null : ME,
    invited_at: now,
    accepted_at: active ? now : null,
    removed_at: null,
    rejoined_at: null,
  };
}

/**
 * A new Creator: no workspace, no posts, nobody else. workspace_create hands
 * back the fixture workspace (its default group and chat channel already
 * exist), invite-send adds the pending approver as member_invite does.
 */
async function seedCreator(network: HarnessNetwork, page: import('@playwright/test').Page) {
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
    t.workspace_members?.push(member('0190f000-0000-7000-8000-0000000000f1', ME, 'owner', true));
    await route.fulfill({ json: WORKSPACE_ID });
  });
  await page.route(`${SUPABASE}/functions/v1/invite-send`, async (route) => {
    const body = route.request().postDataJSON() as { role: string };
    t.workspace_members?.push(
      member(
        '0190f000-0000-7000-8000-0000000000f2',
        '0190a000-0000-7000-8000-0000000000f9',
        body.role,
        false,
      ),
    );
    await route.fulfill({ json: { invite_id: '0190f000-0000-7000-8000-0000000000f3' } });
  });
}

test('creator: workspace, first post, approver invite, then the look-around', async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  const errors = collectErrors(page);
  const network = await installHarnessNetwork(page);
  await seedCreator(network, page);
  const ctx = copyContext({ brand: 'Kite', post: POST_TITLE });
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

  // Step 1: the workspace. The slot opens the sheet straight on the form
  // (there is no workspace to list); Continue is boxed once the form can
  // continue, then Create, which only the data finishes.
  await check('c_workspace', false, '01-first-step');
  await expect(page.locator('[data-induction-bar]')).toContainText('Step 1');
  await tapControl(page, step('c_workspace'));
  // Nothing dims until the form can continue; then Continue is boxed.
  await expectGuideId(page, 'c_workspace_continue');
  await expect(page.locator('[data-induction-box]')).toHaveCount(0);
  await expect(page.locator('[data-induction-bar]')).toContainText('Step 1');
  await page.getByLabel('Brand name').fill('Kite');
  await page.getByRole('radio', { name: 'LinkedIn' }).click();
  await check('c_workspace_continue');
  await tapControl(page, step('c_workspace_continue'));
  // The next step shows at once: no green tick on the finished one.
  await expect(page.locator('[data-induction-result]')).toHaveCount(0);
  await check('c_workspace_create');
  await tapControl(page, step('c_workspace_create'));

  // Step 2: the stage chips. Back never undoes data: both workspace steps are
  // finished by the workspace, so Back hides here.
  await check('c_approved_chip', false);
  await expect(page.locator('[data-induction-bar]')).toContainText('Step 2');
  await tapControl(page, step('c_approved_chip'));

  // Step 3: the first post.
  await check('c_post_create');
  await tapControl(page, step('c_post_create'));
  // The person never types: each tap fills its field and the guide moves on.
  // The caption tap fills the sample caption.
  await check('c_post_caption');
  await tapControl(page, step('c_post_caption'));
  await expect(page.locator('#post-caption')).toHaveValue(FIRST_POST_SAMPLE.caption);
  // The Format tap picks Single image (no menu) and passes the Single image step.
  await check('c_post_format');
  await tapControl(page, step('c_post_format'));
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Format', exact: true })).toHaveText(
    'Single image',
  );
  // The photo tap attaches the bundled sample and starts its upload at once.
  await check('c_post_media');
  await tapControl(page, step('c_post_media'));
  await expect(page.locator('img[src^="blob:"]').first()).toBeVisible();
  await expect.poll(() => network.uploads).toEqual([FIRST_POST_SAMPLE.photoName]);
  await check('c_post_send', undefined, '02-mid-route');
  await tapControl(page, step('c_post_send'));
  // Send creates the post with the filled values (the photo uploaded once), no target date.
  await expect.poll(() => network.uploads).toEqual([FIRST_POST_SAMPLE.photoName]);
  await expect.poll(() => network.rpcCalls.some((c) => c.name === 'post_create')).toBe(true);
  const created = network.rpcCalls.find((c) => c.name === 'post_create');
  expect(created?.args.p_payload).toMatchObject({
    title: POST_TITLE,
    caption: FIRST_POST_SAMPLE.caption,
    format: 'single_image',
  });
  expect('target_date' in (created?.args.p_payload as Record<string, unknown>)).toBe(false);

  // Step 4: the approver invite (a gate: leaving brings the person back), then
  // the optional team invite.
  await expect(page).toHaveURL(/\/settings\?panel=members/, { timeout: 15_000 });
  // No address yet: Send invite cannot be used, so the email field is boxed.
  await expectGuideId(page, 'c_approver_invite');
  await expect(page.locator('[data-induction-box]')).toHaveCount(1);
  await expect(page.locator('[data-induction-label]')).toHaveText("Type your approver's email");
  // A gate offers no way round it: no secondary chip, and no Skip.
  const later = step('c_team_invite').laterLabel ?? '';
  const bar = page.locator('[data-induction-bar]');
  await expect(bar.getByRole('button', { name: later, exact: true })).toHaveCount(0);
  // Leaving a gate's screen brings the person back to it.
  await page.goto('/chat');
  await expect(page).toHaveURL(/\/settings\?panel=members/, { timeout: 10_000 });
  await expectGuideId(page, 'c_approver_invite');
  // Once an address is in, the gate boxes Send invite.
  const email = page.locator('#invite-email');
  await email.click();
  expect(await email.evaluate((el) => el === document.activeElement)).toBe(true);
  await page.keyboard.type('riya@kitebrand.in');
  await check('c_approver_invite');
  await page.getByRole('button', { name: 'Send invite', exact: true }).click();
  // The team invite: the form is empty again, so nothing dims until an address is in.
  await expectGuideId(page, 'c_team_invite');
  await expect(page.locator('[data-induction-box]')).toHaveCount(0);
  // "It's just me for now" waits until they have scrolled the page by hand.
  await expect(bar.getByRole('button', { name: later, exact: true })).toHaveCount(0);
  await page.evaluate(() => window.dispatchEvent(new WheelEvent('wheel', { deltaY: 120 })));
  await bar.getByRole('button', { name: later, exact: true }).click();

  // The look-around: no brief, no plan, so Review comes first.
  await expectCard(page, {
    id: script.intro.id,
    kind: 'intro',
    title: fillCopy(script.intro.title, ctx),
    button: script.intro.button,
  });
  await page.getByRole('button', { name: script.intro.button, exact: true }).click();
  await check('c_line_select');
  // The tap alone selects nothing; the Comment button (the next control)
  // shows once a line is selected, which finishes the step.
  await tapControl(page, step('c_line_select'));
  await selectCaptionWords(page);
  await expectGuideId(page, 'c_comment_button');
  await check('c_comment_button');
  await tapControl(page, step('c_comment_button'));
  await page.keyboard.type('Ready for Riya.');
  await check('c_comment_post');
  await tapControl(page, step('c_comment_post'));

  // The comment stays in view: the guide waits on the post for Next.
  await expectGuideId(page, 'c_group_open');
  await expect(page).toHaveURL(/\/posts\//);
  await expect(page.locator('[data-induction-bar]')).toContainText('Your comment is on the post.');
  await page.locator('[data-induction-next]').click();
  await check('c_group_open');
  await tapControl(page, step('c_group_open'), narrow);
  // The harness has no transcribe Worker, so the voice note offers no
  // Transcribe link: the step's control does not exist and the 4 s rule skips
  // it (bar only, no box), then Activity on the chat list.
  await expectGuideId(page, 'c_transcript');
  await expect(page.locator('[data-induction-box]')).toHaveCount(0);
  await expectGuideId(page, 'c_activity', 8_000);
  // Activity opens the chat list, where the tabs show.
  await check('c_activity');
  await tapControl(page, step('c_activity'));

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
