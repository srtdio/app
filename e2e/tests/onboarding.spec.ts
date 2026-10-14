import { expect, test } from '@playwright/test';
import { installHarnessNetwork, type HarnessNetwork } from '../fixtures/harness-routes';
import { ME } from '../fixtures/chat-data';

// Onboarding: a person with an unfinished profile and no workspace gets the
// one-question-per-screen flow instead of an empty screen (the Inside Edge dead
// end of 14 Oct 2026). Walks name, role, quick questions and workspace on the
// iPhone 13 viewport; tagged @theme so it also runs in light.

function newPerson(network: HarnessNetwork, opts: { workspace: boolean }): void {
  const me = network.world.tables.users?.find((u) => u.id === ME);
  if (me !== undefined) me.profile_completed_at = null;
  if (!opts.workspace) {
    network.world.tables.workspaces = [];
    network.world.tables.workspace_members = [];
  }
}

test('new sign-up walks from name to a created workspace @theme', async ({ page }) => {
  const network = await installHarnessNetwork(page);
  newPerson(network, { workspace: false });
  await page.goto('/chat');

  await expect(page.getByRole('heading', { name: 'What should we call you?' })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText('Step 1 of 6')).toBeVisible();
  const cont = page.getByRole('button', { name: 'Continue', exact: true });
  await page.getByLabel('Full name').fill('');
  await expect(cont).toBeDisabled();

  await page.getByLabel('Full name').fill('Meera Shah');
  await expect(page.getByLabel('Username')).toHaveValue('meera.shah');
  await expect(page.getByText('@meera.shah is yours.')).toBeVisible();
  await cont.click();

  await expect(page.getByRole('heading', { name: 'What do you do?' })).toBeVisible();
  await page.getByRole('radio', { name: 'Account manager' }).click();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();

  await expect(page.getByRole('heading', { name: 'Two quick ones' })).toBeVisible();
  await page.getByRole('radio', { name: '25-34' }).click();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();

  await expect(
    page.getByRole('heading', { name: 'Which brand are you starting with?' }),
  ).toBeVisible();
  await page.getByLabel('Workspace name').fill('Kite & Co');
  await expect(page.getByText('Kite and Co', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Create workspace' }).click();

  await expect(page.getByRole('heading', { name: 'What needs approval first?' })).toBeVisible();
  expect(network.rpcCalls.map((c) => c.name)).toEqual(
    expect.arrayContaining(['user_onboarding_save', 'workspace_create']),
  );
  expect(network.blocked, 'blocked non-fixture requests').toEqual([]);
});

test('invitee is asked to set a password for their workspace', async ({ page }) => {
  const network = await installHarnessNetwork(page);
  newPerson(network, { workspace: true });
  await page.goto('/chat');

  await expect(page.getByText('Step 1 of 3')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('heading', { name: /^Join / })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeDisabled();
  expect(network.blocked, 'blocked non-fixture requests').toEqual([]);
});
