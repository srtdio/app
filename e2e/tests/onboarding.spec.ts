import { expect, test, type Page } from '@playwright/test';
import { installHarnessNetwork, solidPng, type HarnessNetwork } from '../fixtures/harness-routes';
import { ME } from '../fixtures/chat-data';
import { startInduction } from '../fixtures/induction-rpc';

// The pre-app screens: a person with an unfinished profile gets one question
// per screen before the shell. A Creator who signs up picks a side, names
// themselves with a required photo and picks a role (no age range since v13),
// then lands in the real shell to make the workspace. The guide's hand shows
// up on the name screen's Continue the moment it is enabled (never on the side
// screen, never before), stays on the role screen's Continue, and the shell's
// guide carries it on to the workspace step. The invitee's welcome,
// name and role screens (no password) are walked in onboarding-invited.spec.ts.
// Runs on the iPhone 13 viewport; tagged @theme so it also runs in light.

const NAME_CONTINUE = '[data-induction-entry="onboarding-name-continue"]';
const ROLE_CONTINUE = '[data-induction-entry="onboarding-role-continue"]';
const SIDE_CONTINUE = '[data-induction-entry="onboarding-side-continue"]';

/** The hand's fingertip sits on the control (HAND_TIP in GuideParts.tsx, 8px slack). */
async function expectHandOn(page: Page, control: string): Promise<void> {
  await expect(page.locator('[data-induction-hand]')).toHaveCount(1);
  const hand = await page.locator('[data-induction-hand]').boundingBox();
  const box = await page.locator(control).boundingBox();
  expect(hand).not.toBeNull();
  expect(box).not.toBeNull();
  const tip = { x: (hand?.x ?? 0) + 17, y: (hand?.y ?? 0) + 1 };
  expect(tip.x).toBeGreaterThanOrEqual((box?.x ?? 0) - 8);
  expect(tip.x).toBeLessThanOrEqual((box?.x ?? 0) + (box?.width ?? 0) + 8);
  expect(tip.y).toBeGreaterThanOrEqual((box?.y ?? 0) - 8);
  expect(tip.y).toBeLessThanOrEqual((box?.y ?? 0) + (box?.height ?? 0) + 8);
}

function newPerson(network: HarnessNetwork, opts: { workspace: boolean }): void {
  const me = network.world.tables.users?.find((u) => u.id === ME);
  if (me !== undefined) me.profile_completed_at = null;
  startInduction(network.world.tables);
  if (!opts.workspace) {
    network.world.tables.workspaces = [];
    network.world.tables.workspace_members = [];
  }
}

test('a Creator walks side, name with photo and role, then makes the workspace in the shell @theme', async ({
  page,
}) => {
  const network = await installHarnessNetwork(page);
  newPerson(network, { workspace: false });
  await page.goto('/chat');

  await expect(page.getByRole('heading', { name: 'Your role' })).toBeVisible({
    timeout: 15_000,
  });
  // The shell's first reads can still be landing when the screen paints; a late
  // one re-mounts the flow and drops a side picked in between. Let them finish.
  await page.waitForLoadState('networkidle');
  const cont = page.getByRole('button', { name: 'Continue', exact: true });
  await expect(cont).toBeDisabled();
  // No hand on the side screen until a side is picked.
  await expect(page.locator('[data-induction-hand]')).toHaveCount(0);
  // A read landing later still can re-mount the flow and drop the pick: pick
  // again until Continue holds (a pre-existing shell behaviour, seen on WebKit).
  await expect(async () => {
    await page.getByRole('radio', { name: /Creator/ }).click();
    await expect(cont).toBeEnabled({ timeout: 1_000 });
    // Picked: the hand comes onto Continue.
    await expect(page.locator(SIDE_CONTINUE)).toHaveCount(1, { timeout: 1_000 });
    await cont.click({ timeout: 1_000 });
    await expect(page.getByRole('heading', { name: 'Your name' })).toBeVisible({
      timeout: 1_000,
    });
  }).toPass({ timeout: 15_000 });

  await expect(page.getByRole('heading', { name: 'Your name' })).toBeVisible();
  await page.getByLabel('Full name').fill('Meera Shah');
  await expect(page.getByLabel('Username')).toHaveValue('meera.shah');
  await expect(page.getByText('@meera.shah is yours.')).toBeVisible();
  // The photo is required. No hand while Continue is disabled.
  await expect(cont).toBeDisabled();
  await page.waitForTimeout(300);
  await expect(page.locator('[data-induction-hand]')).toHaveCount(0);
  // The username stays on screen with the photo row (no scrolling to reach it).
  const usernameBox = await page.getByLabel('Username').boundingBox();
  expect((usernameBox?.y ?? 9999) + (usernameBox?.height ?? 0)).toBeLessThan(
    page.viewportSize()?.height ?? 0,
  );
  await page.getByLabel('Choose a photo').setInputFiles({
    name: 'me.png',
    mimeType: 'image/png',
    buffer: solidPng(64, 64, [200, 120, 80]),
  });
  await page.getByRole('button', { name: 'Use this photo' }).click();
  await expect(cont).toBeEnabled();
  // Photo, name and username filled: the hand shows on Continue.
  await expect(page.locator(NAME_CONTINUE)).toHaveCount(1);
  await expectHandOn(page, '[data-induction="onboarding-name-continue"]');
  await cont.click();

  await expect(page.getByRole('heading', { name: 'Your title' })).toBeVisible();
  // Nothing dimmed and no hand until a job title is picked.
  await expect(page.locator('[data-induction-hand]')).toHaveCount(0);
  await expect(page.getByText('How did you hear')).toHaveCount(0);
  await page.getByRole('button', { name: 'Job title' }).click();
  await page.getByRole('option', { name: 'Something else' }).click();
  await page.getByLabel('Tell us your job title').fill('Community lead');
  // Picked: the hand comes onto Continue.
  await expect(page.locator(ROLE_CONTINUE)).toHaveCount(1);
  await expectHandOn(page, '[data-induction="onboarding-role-continue"]');
  await expect(page.getByText(/age range/i)).toHaveCount(0);
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  // Watch the hand from the tap until the shell's guide holds the workspace step.
  await page.evaluate(() => {
    const w = window as unknown as { handGap: number; handWatch: boolean };
    w.handGap = 0;
    w.handWatch = true;
    let since = -1;
    const frame = (now: number): void => {
      const hand = document.querySelector('[data-induction-hand]') !== null;
      if (hand) since = -1;
      else if (since < 0) since = now;
      else w.handGap = Math.max(w.handGap, now - since);
      if (w.handWatch) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
  await page.getByRole('button', { name: 'Continue', exact: true }).click();

  await expect(page.getByRole('button', { name: 'Create your workspace' })).toBeVisible({
    timeout: 15_000,
  });
  // On to the workspace step: the shell's guide puts the hand on the top bar slot.
  await expect(page.locator('[data-induction-step="c_workspace"]')).toHaveCount(1, {
    timeout: 15_000,
  });
  await expectHandOn(page, '[data-induction="topbar-workspace-slot"]');
  const gap = await page.evaluate(() => {
    const w = window as unknown as { handGap: number; handWatch: boolean };
    w.handWatch = false;
    return w.handGap;
  });
  // No gap: at most the guide's settle beat while the shell paints (not a missing hand).
  expect(gap, 'longest stretch with no hand, ms').toBeLessThan(1_000);
  const save = network.rpcCalls.find((c) => c.name === 'user_onboarding_save');
  const payload = save?.args.p_payload as Record<string, unknown>;
  expect(payload.designation).toBe('Community lead');
  expect('age_range' in payload).toBe(false);
  expect(network.blocked, 'blocked non-fixture requests').toEqual([]);
});
