import { expect, test, type Locator, type Page } from '@playwright/test';
import { installHarnessNetwork, type HarnessNetwork } from '../fixtures/harness-routes';
import {
  COLLEAGUE_A,
  ME,
  PEER,
  POST_IDS,
  setHarnessPlatform,
  WORKSPACE_ID,
} from '../fixtures/chat-data';
import { expectMinTouchTarget } from '../helpers/touch-target';
import { expectButtonsMeetSystem } from '../helpers/button-system';

// Agency acts on behalf of client. The harness viewer (ME) is the workspace
// owner, an agency-side role: on a post in review the post's ⋯ sheet offers
// "Approve on their behalf" (flow B 31: creators never get a primary Approve) with
// the two-step confirm plus the on-behalf line, and Activity names who
// approved with "on behalf of client". The real app tree runs against fixture
// data in both colour schemes; Linux WebKit approximates iOS WebKit, it is not iOS.

const KEY = 'hs';

function expectNoBlocked(network: HarnessNetwork): void {
  expect(network.blocked, 'blocked non-fixture requests').toEqual([]);
}

/** Give the fixture workspace a key, so a regression would print KEY-N (spec-local world edit). */
function withKey(network: HarnessNetwork): void {
  const ws = network.world.tables.workspaces?.[0];
  if (ws !== undefined) ws.key = KEY;
}

test('PCS: agency approves on their behalf through the on-behalf sheet', async ({ page }) => {
  const network = await installHarnessNetwork(page);
  withKey(network);
  await page.goto(`/posts/${POST_IDS[0]}`);

  const more = page.getByRole('button', { name: 'More actions', exact: true }).first();
  await more.waitFor({ state: 'visible', timeout: 15_000 });
  // Flow B 31: no primary Approve for the creator side.
  await expect(page.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
  await more.click();
  const sheet = page.getByRole('dialog', { name: 'Post actions', exact: true });
  // Approve on their behalf, Reject and Park sit in the ⋯ sheet (ActionMenu rows).
  await expect(sheet.getByRole('menuitem', { name: /Reject/ })).toBeVisible();
  await expect(sheet.getByRole('menuitem', { name: /Park/ })).toBeVisible();
  await sheet.getByRole('menuitem', { name: /Approve on their behalf/ }).click();

  // Spec D: the one on-behalf sheet, no post title and no code in it.
  const behalf = page.getByRole('dialog', { name: 'Approve on their behalf?', exact: true });
  await expect(behalf).toBeVisible();
  await expect(behalf.locator('[data-on-behalf-sheet]')).toContainText('Approving on behalf of');
  await expect(behalf.locator('[data-on-behalf-approve]')).toHaveText('Approve');
  await expect(page.getByText('HS-101', { exact: false })).toHaveCount(0);
  // Cancel sends nothing.
  await behalf.locator('[data-on-behalf-cancel]').click();
  await expect(page.locator('[data-on-behalf-sheet]')).toHaveCount(0);
  expectNoBlocked(network);
});

test('PCS: every button on the post page is 44 tall with an 8px radius or round', async ({
  page,
}) => {
  const network = await installHarnessNetwork(page);
  withKey(network);
  await page.goto(`/posts/${POST_IDS[0]}`);
  await page
    .getByRole('button', { name: 'More actions', exact: true })
    .first()
    .waitFor({ state: 'visible', timeout: 15_000 });
  await expectButtonsMeetSystem(page);
  expectNoBlocked(network);
});

test('Activity: "<Name> approved" under the title, no brand suffix, never KEY-N', async ({
  page,
}) => {
  const network = await installHarnessNetwork(page);
  withKey(network);
  const now = new Date().toISOString();
  network.world.tables.inbox_entries?.push(
    {
      id: '0190f100-0000-7000-8000-0000000000a1',
      user_id: ME,
      actor_user_id: COLLEAGUE_A,
      workspace_id: WORKSPACE_ID,
      event_type: 'stage_change',
      entity_type: 'post',
      entity_id: POST_IDS[0],
      scope: 'posts',
      scope_key: POST_IDS[0],
      tier: 'active',
      payload: { from: 'review', to: 'approved', actor_role: 'agency' },
      read_at: null,
      snoozed_until: null,
      email_sent_at: null,
      deleted_at: null,
      created_at: now,
    },
    {
      id: '0190f100-0000-7000-8000-0000000000a2',
      user_id: ME,
      actor_user_id: COLLEAGUE_A,
      workspace_id: WORKSPACE_ID,
      event_type: 'assets_deleted',
      entity_type: 'workspace',
      entity_id: WORKSPACE_ID,
      scope: 'everything',
      scope_key: WORKSPACE_ID,
      tier: 'active',
      payload: { count: 3, filenames: ['a.png', 'b.png', 'c.png'], actor_role: 'agency' },
      read_at: null,
      snoozed_until: null,
      email_sent_at: null,
      deleted_at: null,
      created_at: now,
    },
  );
  await page.goto('/notifications');

  // The title shows once, in the card header; the line keeps the stage change only.
  await expect(page.getByText('Leo Martins approved', { exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText(/on behalf of/)).toHaveCount(0);
  await expect(page.getByText('Monday carousel', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('HS-101', { exact: false })).toHaveCount(0);
  await expect(page.getByText('Leo Martins deleted 3 files', { exact: true })).toBeVisible();
  await expect(page.getByText('Moved to', { exact: false })).toHaveCount(0);
  expectNoBlocked(network);
});

// A post's platform always equals its workspace's. The PCS "{Platform} preview"
// chip and panel name the workspace platform and list that platform's sizes.
// Tagged @theme for light and dark.

function workspaceLabel(page: Page) {
  return (page.viewportSize()?.width ?? 0) >= 768
    ? page.locator('aside button').first()
    : page.getByRole('button', { name: 'Switch workspace' });
}

const CASES = [
  { platform: 'linkedin', label: 'LinkedIn', format: 'carousel', size: '1200 x 627 · 1.91:1' },
  { platform: 'instagram', label: 'Instagram', format: 'carousel', size: '1080 x 566 · 1.91:1' },
] as const;

for (const c of CASES) {
  test(`a post in a ${c.label} workspace shows the ${c.label} preview @theme`, async ({ page }) => {
    const network = await installHarnessNetwork(page);
    setHarnessPlatform(network.world, c.platform, c.format);
    // Post detail hides the Topbar on a phone, so the workspace label is read
    // on Pipeline first, then the post opens.
    await page.goto('/pipeline');
    await expect(workspaceLabel(page)).toContainText(`Harness Studio - ${c.label}`, {
      timeout: 15_000,
    });
    await page.goto(`/posts/${POST_IDS[0]}`);
    const chip = page.getByRole('button', { name: `${c.label} preview` });
    await expect(chip).toBeVisible();
    expectMinTouchTarget(await chip.boundingBox());
    await chip.click();

    const panel = page.getByRole('dialog', { name: `${c.label} preview` });
    await expect(panel).toBeVisible();
    // It opens on the frame the post page shows, then lists the platform's sizes.
    await expect(panel.getByRole('radio', { name: /This post/ })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await expect(panel.getByRole('radio', { name: /Portrait/ })).toBeVisible();
    await expect(panel).toContainText(c.size);
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
    expect(network.blocked, 'blocked non-fixture requests').toEqual([]);
  });
}

// Type roles on the post page (design rules, locked 24 Oct 2026): the page
// title is 28px/600, the caption is body text at 14px and the details line is
// meta at 12px. The post page has no section label on screen.

/** The computed type of one element: size, weight and case. */
function typeOf(locator: Locator) {
  return locator.evaluate((el) => {
    const s = getComputedStyle(el);
    return { size: s.fontSize, weight: s.fontWeight, transform: s.textTransform };
  });
}

test('PCS type roles: page title 28px, caption body 14px, details meta 12px @theme', async ({
  page,
}) => {
  const network = await installHarnessNetwork(page);
  withKey(network);
  await page.goto(`/posts/${POST_IDS[0]}`);
  const title = page.locator('h1', { hasText: 'Monday carousel' }).first();
  await title.waitFor({ state: 'visible', timeout: 15_000 });

  const titleType = await typeOf(title);
  expect(titleType.size).toBe('28px');
  expect(titleType.weight).toBe('600');

  const caption = page.locator('[data-caption-block]').getByText('Fixture caption').first();
  await expect(caption).toBeVisible();
  expect((await typeOf(caption)).size).toBe('14px');

  const meta = page.locator('[data-post-details]').first();
  await expect(meta).toBeVisible();
  expect((await typeOf(meta)).size).toBe('12px');
  expectNoBlocked(network);
});

// ---------------------------------------------------------------------------

// A client tagged in a comment on a draft post: the @-mention picker does not
// offer clients on a draft, so the tag is the @[uuid] token typed by hand (the
// body carries it as is). comment_create's mention rule (the fixture mirrors
// the live proc) raises invalid_mention with the client's id as DETAIL; the
// one toast explains, and the composer keeps the typed text. PEER is a client
// member and the harness viewer (ME) is the owner. iPhone viewport, dark and
// light (@theme).

const DRAFT_POST = POST_IDS[0] ?? '';
const TOAST = "Clients can't see drafts. Tag them once it's in Review.";

function expectCleanComments(network: HarnessNetwork): void {
  expect(network.blocked, 'blocked non-fixture requests').toEqual([]);
  expect(
    network.unmatched.filter((u) => u.includes('comment')),
    'unrecognised comment requests',
  ).toEqual([]);
}

/** Put the post in Draft before the page reads it. */
function makeDraft(network: HarnessNetwork): void {
  const post = (network.world.tables.posts ?? []).find((p) => p.id === DRAFT_POST);
  if (post === undefined) throw new Error('fixture post missing');
  post.stage = 'draft';
}

test('Draft post: tagging a client keeps the comment and shows the drafts toast @theme', async ({
  page,
}) => {
  const network = await installHarnessNetwork(page);
  makeDraft(network);
  await page.goto(`/posts/${DRAFT_POST}`);
  await expect(page.getByRole('heading', { name: 'Monday carousel', level: 1 })).toBeVisible({
    timeout: 15_000,
  });

  const section = page.locator('#post-comments');
  const box = section.getByRole('textbox', { name: 'Comment body', exact: true });
  await box.scrollIntoViewIfNeeded();
  await box.click();
  const text = `Over to @[${PEER}] for a look`;
  await page.keyboard.type(text);
  await expect(box).toHaveText(text);

  await section.getByRole('button', { name: 'Post', exact: true }).click();

  await expect(page.getByRole('status').getByText(TOAST, { exact: true })).toBeVisible();
  // The server refused it: nothing landed, and the draft is still in the box.
  const creates = network.rpcCalls.filter((c) => c.name === 'comment_create');
  expect(creates).toHaveLength(1);
  expect(String(creates[0]?.args.p_body)).toContain(`@[${PEER}]`);
  expect(network.world.tables.comments ?? []).toHaveLength(0);
  await expect(box).toHaveText(text);
  // The toast is the one explanation: no inline error under the composer.
  await expect(section.getByRole('alert')).toHaveCount(0);
  expectCleanComments(network);
});
