import { expect, test, type Page } from '@playwright/test';
import { installHarnessNetwork, type HarnessNetwork } from '../fixtures/harness-routes';
import { expectMinTouchTarget } from '../helpers/touch-target';

// One workspace = one client = one platform. Creating a workspace asks for the
// client name and a platform, confirms that the platform is final, and sends it
// to workspace_create; the shell then names the workspace "<Client> - <Platform>"
// and New post offers only that platform's formats. Tagged @theme (phone, light
// and dark) and @desktop (laptop). The viewer is the fixture owner, a maker
// role, so the create menu has no New brief. Fixture names are fictional.

function isLaptop(page: Page): boolean {
  return (page.viewportSize()?.width ?? 0) >= 768;
}

/** The shell's workspace label: the top bar on a phone, the sidebar on a laptop. */
function workspaceLabel(page: Page) {
  return isLaptop(page)
    ? page.locator('aside button').first()
    : page.getByRole('button', { name: 'Switch workspace' });
}

function expectClean(network: HarnessNetwork): void {
  expect(network.blocked, 'blocked non-fixture requests').toEqual([]);
  expect([...new Set(network.unmatched)], 'unrecognised fixture requests').toEqual([]);
}

test('create a workspace with a platform, then post in its formats @theme @desktop', async ({
  page,
}) => {
  const network = await installHarnessNetwork(page);
  await page.goto('/pipeline');

  const label = workspaceLabel(page);
  await expect(label).toContainText('Harness Studio - LinkedIn', { timeout: 15_000 });

  // A maker role: the create menu offers New post only.
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByText('New post', { exact: true })).toBeVisible();
  await expect(page.getByText('New brief', { exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.mouse.click(5, 300);

  await label.click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Create workspace' }).click();
  await expect(dialog).toHaveAttribute('aria-label', 'Create workspace');

  const tiles = dialog.getByRole('radio');
  await expect(tiles).toHaveCount(7);
  for (const tile of await tiles.all()) expectMinTouchTarget(await tile.boundingBox());

  const cont = dialog.getByRole('button', { name: 'Continue' });
  await expect(cont).toBeDisabled();
  await dialog.getByLabel('Client name').fill('Kite');
  await expect(cont).toBeDisabled();
  await dialog.getByRole('radio', { name: /Instagram/ }).click();
  await expect(dialog).toContainText(
    'Shown as Kite - Instagram. The chat group takes the same name.',
  );
  await cont.click();

  await expect(dialog).toHaveAttribute('aria-label', 'One platform per workspace');
  await expect(dialog).toContainText(
    'Kite - Instagram is final. Another platform means another workspace.',
  );
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();

  await expect(label).toContainText('Kite - Instagram', { timeout: 15_000 });
  const create = network.rpcCalls.find((c) => c.name === 'workspace_create');
  expect(create?.args.p_payload).toMatchObject({ name: 'Kite', platform: 'instagram' });

  // New post: no Platform field, and only Instagram's formats.
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.getByText('New post', { exact: true }).click();
  const format = page.getByRole('button', { name: 'Format' });
  await expect(format).toContainText('Reel');
  await expect(page.getByRole('button', { name: 'Platform' })).toHaveCount(0);
  await format.click();
  await expect(page.getByRole('option')).toHaveText(['Reel', 'Story', 'Carousel', 'Single image']);

  expectClean(network);
});
