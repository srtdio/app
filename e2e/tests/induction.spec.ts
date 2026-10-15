import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { installHarnessNetwork, type HarnessNetwork } from '../fixtures/harness-routes';
import { GROUP_CHANNEL, GROUP_ID, ME, WORKSPACE_ID } from '../fixtures/chat-data';
import { inductionDone, startInduction } from '../fixtures/induction-rpc';
import type { Row } from '../fixtures/postgrest';

// The induction: the guided first run on the real screens. Each step asserts
// the accent box sits within 2px of its live control (7px out: 5px gap plus
// the 2px border) and that the card never overlaps the control. Tagged @theme
// and @desktop so it runs on the phone in dark and light and on the laptop.
// Linux WebKit approximates iOS WebKit, it is not iOS.

const SUPABASE = 'https://harness.supabase.test';
const OUTSET = 7;

interface R {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The first visible control for a key, read live in the page. */
async function controlRect(page: Page, key: string): Promise<R | null> {
  return page.evaluate((k) => {
    for (const el of Array.from(document.querySelectorAll(`[data-induction="${k}"]`))) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0)
        return { x: r.left, y: r.top, width: r.width, height: r.height };
    }
    return null;
  }, key);
}

async function selectorRect(page: Page, selector: string): Promise<R | null> {
  return page.evaluate((s) => {
    const el = document.querySelector(s);
    if (el === null) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  }, selector);
}

function overlaps(a: R, b: R): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

let shot = 0;

/** The box is on `key` (within 2px), the card clear of it, and a screenshot for review. */
async function expectBoxed(page: Page, info: TestInfo, key: string): Promise<void> {
  await expect(page.locator('[data-induction-box]')).toBeVisible({ timeout: 15_000 });
  await expect
    .poll(
      async () => {
        const control = await controlRect(page, key);
        const box = await selectorRect(page, '[data-induction-box]');
        if (control === null || box === null) return 99;
        return Math.max(
          Math.abs(box.x - (control.x - OUTSET)),
          Math.abs(box.y - (control.y - OUTSET)),
          Math.abs(box.width - (control.width + OUTSET * 2)),
          Math.abs(box.height - (control.height + OUTSET * 2)),
        );
      },
      { message: `box on ${key}`, timeout: 10_000 },
    )
    .toBeLessThanOrEqual(2);
  const control = await controlRect(page, key);
  const card = await selectorRect(page, '[data-induction-card]');
  if (control !== null && card !== null) {
    expect(overlaps(card, control), `card clear of ${key}`).toBe(false);
  }
  shot += 1;
  await page.screenshot({ path: info.outputPath(`${String(shot).padStart(2, '0')}-${key}.png`) });
}

function guide(page: Page) {
  return page.locator('[data-induction-card], [data-induction-strip]');
}

async function next(page: Page): Promise<void> {
  await guide(page).getByRole('button', { name: 'Next', exact: true }).click();
}

function expectNoBlocked(network: HarnessNetwork): void {
  expect(network.blocked, 'blocked non-fixture requests').toEqual([]);
}

/** The default group the workspace was made with. */
function markDefaultGroup(network: HarnessNetwork): void {
  const group = network.world.tables.groups?.find((g) => g.id === GROUP_ID);
  if (group !== undefined) group.is_default = true;
}

function welcomeEntry(name: string, platform: string): Row {
  return {
    id: '0190f100-0000-7000-8000-0000000000e1',
    user_id: ME,
    actor_user_id: null,
    workspace_id: WORKSPACE_ID,
    event_type: 'system',
    entity_type: 'workspace',
    entity_id: WORKSPACE_ID,
    scope: 'everything',
    scope_key: WORKSPACE_ID,
    tier: 'active',
    payload: { kind: 'welcome', workspace_name: name, platform },
    read_at: null,
    snoozed_until: null,
    email_sent_at: null,
    deleted_at: null,
    created_at: new Date().toISOString(),
  };
}

function setMyRole(network: HarnessNetwork, role: string): void {
  const me = network.world.tables.workspace_members?.find((m) => m.user_id === ME);
  if (me !== undefined) me.role = role;
}

test.beforeEach(() => {
  shot = 0;
});

test('creator: workspace, first post and approver invite gates, through to finish @theme @desktop', async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  const network = await installHarnessNetwork(page);
  const t = network.world.tables;
  startInduction(t);
  markDefaultGroup(network);
  // A new Creator: no workspace, no posts, nobody else yet.
  const stash = t.workspaces?.[0];
  t.workspaces = [];
  t.workspace_members = [];
  t.posts = [];
  t.inbox_entries = [];

  // workspace_create hands back the fixture workspace (its chat group and
  // channel already exist) and writes the welcome entry, as the proc does.
  await page.route(`${SUPABASE}/rest/v1/rpc/workspace_create`, async (route) => {
    const args = route.request().postDataJSON() as { p_payload: Record<string, string> };
    t.workspaces?.push({ ...stash, name: args.p_payload.name, platform: args.p_payload.platform });
    t.workspace_members?.push({
      id: '0190f000-0000-7000-8000-0000000000f1',
      workspace_id: WORKSPACE_ID,
      user_id: ME,
      role: 'owner',
      active: true,
      invited_by: null,
      invited_at: null,
      accepted_at: new Date().toISOString(),
      removed_at: null,
      rejoined_at: null,
    });
    t.inbox_entries?.push(welcomeEntry(args.p_payload.name ?? '', args.p_payload.platform ?? ''));
    await route.fulfill({ json: WORKSPACE_ID });
  });
  // invite-send adds the pending approver, as member_invite does.
  await page.route(`${SUPABASE}/functions/v1/invite-send`, async (route) => {
    const body = route.request().postDataJSON() as { role: string };
    t.workspace_members?.push({
      id: '0190f000-0000-7000-8000-0000000000f2',
      workspace_id: WORKSPACE_ID,
      user_id: '0190a000-0000-7000-8000-0000000000f9',
      role: body.role,
      active: false,
      invited_by: ME,
      invited_at: new Date().toISOString(),
      accepted_at: null,
      removed_at: null,
      rejoined_at: null,
    });
    await route.fulfill({ json: { invite_id: '0190f000-0000-7000-8000-0000000000f3' } });
  });

  await page.goto('/pipeline');

  // 1. The real shell, an empty main, and the slot.
  await expectBoxed(page, info, 'topbar-workspace-slot');
  await expect(guide(page)).toContainText('Step 1 of 8');
  await expect(guide(page).getByRole('button')).toHaveCount(0);
  await page.getByRole('button', { name: 'Create your workspace' }).click();
  await expect(page.locator('[data-induction-strip]')).toContainText('Create your workspace');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.getByLabel('Brand name').fill('Kite');
  await page.getByRole('radio', { name: 'LinkedIn' }).click();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Create', exact: true }).click();

  // 2. The stage row.
  await expectBoxed(page, info, 'pipeline-stage-row');
  await expect(guide(page)).toContainText('Step 2 of 8');
  await expect(guide(page)).toContainText('Review is where your approver looks.');
  await next(page);

  // 3. Hard gate: the first post. No Next, no Later.
  await expectBoxed(page, info, 'pipeline-create');
  await expect(guide(page).getByRole('button')).toHaveCount(0);
  await page.locator('[data-induction="pipeline-create"]').click();
  const strip = page.locator('[data-induction-strip]');
  await expect(strip).toContainText('Send your first post for review');
  await expect(strip.getByRole('button')).toHaveCount(0);
  await expect(page.getByRole('dialog').getByLabel('Owner')).toHaveCount(0);
  await page.locator('#post-caption').fill('Launch day\nThe new range is here.');
  await expect(page.getByRole('switch', { name: /Share in the .* chat/ })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expectBoxed(page, info, 'post-sheet-primary');
  await page.getByRole('button', { name: 'Send for review', exact: true }).click();

  // 4. Hard gate: the approver invite. Leaving brings the person back.
  await expect(page).toHaveURL(/\/settings\?panel=members/, { timeout: 15_000 });
  await expectBoxed(page, info, 'members-invite');
  await expect(guide(page).getByRole('button')).toHaveCount(0);
  await page.locator('[data-induction="chat-tab"]').filter({ visible: true }).first().click();
  await expect(page).toHaveURL(/\/settings\?panel=members/);
  await page.locator('#invite-email').fill('riya@kitebrand.in');
  await page.getByRole('button', { name: 'Send invite', exact: true }).click();

  // 4b. Optional: other creators.
  await expect(guide(page)).toContainText('Add other creators', { timeout: 15_000 });
  await guide(page).getByRole('button', { name: "It's just me for now" }).click();

  // 5. The post view: comments, then Approve (pointed at, never pressed).
  await expect(page).toHaveURL(/\/posts\//, { timeout: 15_000 });
  await expectBoxed(page, info, 'post-comment-composer');
  await next(page);
  await expectBoxed(page, info, 'post-approve');
  await expect(guide(page)).toContainText('This one is for your approver.');
  await next(page);

  // 6. Assets.
  await expect(page).toHaveURL(/\/assets/);
  await expectBoxed(page, info, 'assets-add');
  await next(page);

  // 7. Activity, with the welcome entry.
  await expect(page).toHaveURL(/\/activity/);
  await expectBoxed(page, info, 'activity-list');
  await expect(page.getByText('Kite - LinkedIn is ready.')).toBeVisible();
  await next(page);

  // 8. The real default group: #, + (the tray opens), tasks (the sheet opens), mic.
  await expect(page).toHaveURL(new RegExp(`channel=${encodeURIComponent(GROUP_CHANNEL)}`));
  await expectBoxed(page, info, 'chat-hash');
  await next(page);
  await expectBoxed(page, info, 'chat-plus');
  await page.locator('[data-induction="chat-plus"]').filter({ visible: true }).first().click();
  await expectBoxed(page, info, 'chat-attach-tray');
  await next(page);
  await expectBoxed(page, info, 'chat-tasks');
  await page.locator('[data-induction="chat-tasks"]').filter({ visible: true }).first().click();
  await expect(page.locator('[data-induction-strip]')).toContainText('tasks');
  await next(page);
  await page.getByRole('dialog', { name: 'Tasks' }).getByRole('button', { name: 'Close' }).click();
  await expectBoxed(page, info, 'chat-mic');
  await next(page);

  await expect(page.locator('[data-induction-layer]')).toHaveCount(0);
  expect(inductionDone(t)).toBe(true);
  expect(network.rpcCalls.map((c) => c.name)).toEqual(
    expect.arrayContaining([
      'post_create',
      'stage_transition',
      'chat_message_send',
      'induction_finish',
    ]),
  );
  expectNoBlocked(network);
});

test('approver: top bar, review, post, assets, briefs, activity, the group @theme @desktop', async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  const network = await installHarnessNetwork(page);
  const t = network.world.tables;
  startInduction(t);
  markDefaultGroup(network);
  setMyRole(network, 'client');
  t.inbox_entries?.push(welcomeEntry('Harness Studio', 'linkedin'));
  await page.goto('/pipeline');

  await expectBoxed(page, info, 'topbar-workspace-slot');
  await expect(guide(page)).toContainText('Harness Studio - LinkedIn');
  await expect(guide(page)).toContainText('Posts waiting for your approval live here.');
  await next(page);
  await expectBoxed(page, info, 'pipeline-stage-row');
  await next(page);

  await expect(page).toHaveURL(/\/posts\//, { timeout: 15_000 });
  await expectBoxed(page, info, 'post-comment-composer');
  await next(page);
  await expectBoxed(page, info, 'post-approve');
  await next(page);

  await expectBoxed(page, info, 'assets-add');
  await next(page);
  await expectBoxed(page, info, 'briefs-new');
  await expect(guide(page).getByRole('button', { name: 'Later' })).toBeVisible();
  await guide(page).getByRole('button', { name: 'Later' }).click();
  await expectBoxed(page, info, 'activity-list');
  await next(page);

  await expect(page).toHaveURL(new RegExp(`channel=${encodeURIComponent(GROUP_CHANNEL)}`));
  await expectBoxed(page, info, 'chat-post-card');
  await expect(guide(page)).toContainText('Waiting on you');
  await next(page);
  await expectBoxed(page, info, 'chat-hash');
  await next(page);
  await expectBoxed(page, info, 'chat-tasks');
  await next(page);

  await expect(page.locator('[data-induction-layer]')).toHaveCount(0);
  expect(inductionDone(t)).toBe(true);
  expectNoBlocked(network);
});

test('teammate: drafts, an optional post, assets, activity, the group @theme @desktop', async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  const network = await installHarnessNetwork(page);
  const t = network.world.tables;
  startInduction(t);
  markDefaultGroup(network);
  setMyRole(network, 'agency');
  t.inbox_entries?.push(welcomeEntry('Harness Studio', 'linkedin'));
  await page.goto('/pipeline');

  await expectBoxed(page, info, 'pipeline-draft-chip');
  await expect(guide(page)).toContainText('Drafts are yours until you send them.');
  await next(page);

  await expectBoxed(page, info, 'pipeline-create');
  await page.locator('[data-induction="pipeline-create"]').click();
  await expect(page.getByRole('button', { name: 'Save as draft', exact: true })).toBeVisible();
  await expectBoxed(page, info, 'post-sheet-primary');
  await page.locator('[data-induction-strip]').getByRole('button', { name: 'Later' }).click();
  await page.keyboard.press('Escape');

  await expect(page).toHaveURL(/\/assets/);
  await expectBoxed(page, info, 'assets-add');
  await guide(page).getByRole('button', { name: 'Later' }).click();
  await expectBoxed(page, info, 'activity-list');
  await next(page);

  await expectBoxed(page, info, 'chat-hash');
  await next(page);
  await expectBoxed(page, info, 'chat-plus');
  await next(page);

  await expect(page.locator('[data-induction-layer]')).toHaveCount(0);
  expect(inductionDone(t)).toBe(true);
  expectNoBlocked(network);
});
