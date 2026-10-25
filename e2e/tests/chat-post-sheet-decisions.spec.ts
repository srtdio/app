import { expect, test, type Locator, type Page } from '@playwright/test';
import { installHarnessNetwork, type HarnessNetwork } from '../fixtures/harness-routes';
import { PEER_NAME, POST_IDS } from '../fixtures/chat-data';
import { seedAudit, type AuditRole } from '../fixtures/audit-pr-b';
import { undoStrip } from '../helpers/undo-strip';

// PR B decisions: the chat PostSheet carries Post detail's decisions. The DM
// with Priya ends on a shared card for Monday carousel (in review; the audit
// fixture). The approver rejects from the sheet's bottom bar; the creator parks
// from the sheet's ⋯ menu. Both open the same reason confirm as Post detail,
// show the Undo strip, and send stage_transition only when the window ends.
// iPhone viewport, dark (the default project).

const POST = POST_IDS[0] ?? '';

async function openPostSheet(
  page: Page,
  role: AuditRole,
): Promise<{ network: HarnessNetwork; sheet: Locator }> {
  const network = await installHarnessNetwork(page);
  seedAudit(network, { role });
  await page.goto('/chat');
  await page.getByText(PEER_NAME, { exact: true }).first().click();
  await expect(page.locator('[data-bubble]', { hasText: 'Ready for your look' })).toBeVisible({
    timeout: 15_000,
  });
  const card = page.getByRole('button', { name: 'Open post Monday carousel' }).last();
  await card.scrollIntoViewIfNeeded();
  await card.click();
  const sheet = page
    .getByRole('dialog')
    .filter({ has: page.locator(`[data-post-sheet="${POST}"]`) });
  await expect(sheet).toBeVisible();
  return { network, sheet };
}

const stageCalls = (network: HarnessNetwork) =>
  network.rpcCalls.filter((call) => call.name === 'stage_transition');

test('approver: Reject from the chat PostSheet bar asks for an optional reason, then rejects after Undo', async ({
  page,
}) => {
  const { network, sheet } = await openPostSheet(page, 'approver');

  // Phone: the decision row is the sheet's bottom bar, Reject and Approve.
  const bar = sheet.locator('[data-decision-bar]');
  await expect(bar.getByRole('button', { name: 'Approve', exact: true })).toBeVisible();
  await bar.getByRole('button', { name: 'Reject', exact: true }).click();

  const confirm = page.getByRole('dialog', { name: 'Reject this post?', exact: true });
  await expect(confirm).toBeVisible();
  await expect(confirm.getByLabel('Reason (optional)')).toBeVisible();
  // Cancel sits left of the primary, in the footer.
  await expect(confirm.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible();
  await confirm.locator('[data-stage-confirm]').click();
  await expect(confirm).toHaveCount(0);

  // The move waits for the Undo window.
  const strip = undoStrip(page, 'Post rejected');
  await expect(strip).toBeVisible();
  expect(stageCalls(network)).toEqual([]);
  // UNDO_MS (4 s) later the window ends and the move is sent once.
  await expect.poll(() => stageCalls(network).length, { timeout: 12_000 }).toBe(1);
  expect(stageCalls(network)[0]?.args).toMatchObject({ p_post_id: POST, p_to_stage: 'rejected' });
  expect(network.blocked).toEqual([]);
});

test('creator: Park from the chat PostSheet ⋯ menu, the same rows as Post detail', async ({
  page,
}) => {
  const { network, sheet } = await openPostSheet(page, 'creator');

  // Creator in review: the bar offers Send for review again; Approve on their
  // behalf, Reject and Park sit in the ⋯ menu.
  await expect(
    sheet.locator('[data-decision-bar]').getByRole('button', { name: 'Send for review again' }),
  ).toBeVisible();
  await sheet.getByRole('button', { name: 'More actions', exact: true }).click();
  const menu = page.getByRole('dialog', { name: 'Post actions', exact: true });
  await expect(menu).toBeVisible();
  const rows = await menu.getByRole('menuitem').allInnerTexts();
  const labels = rows.map((text) => text.split('\n')[0]?.trim() ?? '');
  expect(labels.slice(0, 2)).toEqual(['Open post', 'Copy link']);
  for (const name of ['Approve on their behalf', 'Reject', 'Park']) {
    expect(labels).toContain(name);
  }
  await menu.getByRole('menuitem', { name: /^Park/ }).click();

  const confirm = page.getByRole('dialog', { name: 'Park this post?', exact: true });
  await expect(confirm).toBeVisible();
  await confirm.locator('[data-stage-confirm]').click();
  await expect(confirm).toHaveCount(0);

  const strip = undoStrip(page, 'Post parked');
  await expect(strip).toBeVisible();
  expect(stageCalls(network)).toEqual([]);
  // UNDO_MS (4 s) later the window ends and the move is sent once.
  await expect.poll(() => stageCalls(network).length, { timeout: 12_000 }).toBe(1);
  expect(stageCalls(network)[0]?.args).toMatchObject({ p_post_id: POST, p_to_stage: 'parked' });
  expect(network.blocked).toEqual([]);
});
