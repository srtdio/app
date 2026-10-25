import { expect, test } from '@playwright/test';
import { installHarnessNetwork, type HarnessNetwork } from '../fixtures/harness-routes';
import { POST_IDS } from '../fixtures/chat-data';
import { undoStrip } from '../helpers/undo-strip';

// PR B delete rule: a post goes to Recently deleted, so Delete post asks
// nothing. The post deletes behind the Undo strip (UNDO_MS); Undo keeps it and
// sends nothing, even after the window would have ended. The harness viewer
// (ME) is the workspace owner. iPhone viewport, dark (the default project).

const POST = POST_IDS[0] ?? '';

const deleteCalls = (network: HarnessNetwork) =>
  network.rpcCalls.filter((call) => call.name === 'post_soft_delete');

test('Post detail: Delete post shows the Undo strip, no dialog; Undo restores the post', async ({
  page,
}) => {
  const network = await installHarnessNetwork(page);
  await page.goto(`/posts/${POST}`);
  const title = page.getByRole('heading', { name: 'Monday carousel', level: 1 });
  await expect(title).toBeVisible({ timeout: 15_000 });

  await page.getByRole('button', { name: 'More actions', exact: true }).first().click();
  const menu = page.getByRole('dialog', { name: 'Post actions', exact: true });
  await expect(menu).toBeVisible();
  // Delete is the last row, in the danger tone.
  const rows = menu.getByRole('menuitem');
  await expect(rows.last()).toHaveText(/Delete post/);
  await rows.last().click();

  // No confirm: the strip is the only thing that shows.
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: /Delete/ })).toHaveCount(0);
  const strip = undoStrip(page, 'Post deleted');
  await expect(strip).toBeVisible();
  await strip.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(strip).toHaveCount(0);

  // The post is still here, and nothing is sent once the window has passed.
  await expect(title).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/posts/${POST}`));
  await page.waitForTimeout(5_000);
  expect(deleteCalls(network)).toEqual([]);
  await expect(title).toBeVisible();
  expect(network.blocked).toEqual([]);
});

test('Post detail on phone: the Undo strip sits above the decision bar, never over it', async ({
  page,
}) => {
  await installHarnessNetwork(page);
  await page.goto(`/posts/${POST}`);
  await expect(page.getByRole('heading', { name: 'Monday carousel', level: 1 })).toBeVisible({
    timeout: 15_000,
  });
  const bar = page.locator('[data-decision-bar]');
  await expect(bar).toBeVisible();

  await page.getByRole('button', { name: 'More actions', exact: true }).first().click();
  const menu = page.getByRole('dialog', { name: 'Post actions', exact: true });
  await menu.getByRole('menuitem').last().click();

  const strip = undoStrip(page, 'Post deleted');
  await expect(strip).toBeVisible();
  // Let the strip finish its slide in before measuring.
  await page.waitForTimeout(600);
  const stripBox = await strip.boundingBox();
  const barBox = await bar.boundingBox();
  expect(stripBox).not.toBeNull();
  expect(barBox).not.toBeNull();
  // No overlap: the strip's bottom edge is at or above the bar's top edge.
  expect(stripBox!.y + stripBox!.height).toBeLessThanOrEqual(barBox!.y);
  await strip.getByRole('button', { name: 'Undo', exact: true }).click();
});
