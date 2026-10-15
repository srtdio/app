import { expect, test } from '@playwright/test';
import { installHarnessNetwork, solidPng, type HarnessNetwork } from '../fixtures/harness-routes';
import { ME } from '../fixtures/chat-data';
import { startInduction } from '../fixtures/induction-rpc';

// The pre-app screens: a person with an unfinished profile gets one question
// per screen before the shell. A Creator who signs up picks a side, names
// themselves with a required photo, picks a role and an age, then lands in the
// real shell to make the workspace. An invitee sets a password first. Runs on
// the iPhone 13 viewport; tagged @theme so it also runs in light.

function newPerson(network: HarnessNetwork, opts: { workspace: boolean }): void {
  const me = network.world.tables.users?.find((u) => u.id === ME);
  if (me !== undefined) me.profile_completed_at = null;
  startInduction(network.world.tables);
  if (!opts.workspace) {
    network.world.tables.workspaces = [];
    network.world.tables.workspace_members = [];
  }
}

test('a Creator walks side, name with photo, role and age, then makes the workspace in the shell @theme', async ({
  page,
}) => {
  const network = await installHarnessNetwork(page);
  newPerson(network, { workspace: false });
  await page.goto('/chat');

  await expect(page.getByRole('heading', { name: 'Who are you here as?' })).toBeVisible({
    timeout: 15_000,
  });
  const cont = page.getByRole('button', { name: 'Continue', exact: true });
  await expect(cont).toBeDisabled();
  await page.getByRole('radio', { name: /Creator/ }).click();
  await cont.click();

  await expect(page.getByRole('heading', { name: 'What should we call you?' })).toBeVisible();
  await page.getByLabel('Full name').fill('Meera Shah');
  await expect(page.getByLabel('Username')).toHaveValue('meera.shah');
  await expect(page.getByText('@meera.shah is yours.')).toBeVisible();
  // The photo is required.
  await expect(cont).toBeDisabled();
  await page.locator('input[type="file"]').setInputFiles({
    name: 'me.png',
    mimeType: 'image/png',
    buffer: solidPng(64, 64, [200, 120, 80]),
  });
  await expect(cont).toBeEnabled();
  await cont.click();

  await expect(page.getByRole('heading', { name: 'What do you do?' })).toBeVisible();
  await expect(page.getByText('How did you hear')).toHaveCount(0);
  await page.getByRole('button', { name: 'Your role' }).click();
  await page.getByRole('option', { name: 'Something else' }).click();
  await page.getByLabel('Tell us your role').fill('Community lead');
  await page.getByRole('radio', { name: '25-34' }).click();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();

  await expect(page.getByRole('button', { name: 'Create your workspace' })).toBeVisible({
    timeout: 15_000,
  });
  const save = network.rpcCalls.find((c) => c.name === 'user_onboarding_save');
  expect((save?.args.p_payload as Record<string, unknown>).designation).toBe('Community lead');
  expect(network.blocked, 'blocked non-fixture requests').toEqual([]);
});

test('invitee is asked to set a password for their workspace', async ({ page }) => {
  const network = await installHarnessNetwork(page);
  newPerson(network, { workspace: true });
  await page.goto('/chat');

  await expect(page.getByText('Step 1 of 3')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('heading', { name: /^Join / })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Who are you here as?' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeDisabled();
  expect(network.blocked, 'blocked non-fixture requests').toEqual([]);
});
