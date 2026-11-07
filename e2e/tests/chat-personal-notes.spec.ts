import { expect, test, type Page, type Request } from '@playwright/test';
import { installHarnessNetwork } from '../fixtures/harness-routes';
import { PEER_NAME } from '../fixtures/chat-data';
import {
  NOTES_TITLE,
  NOTE_PHOTO_TILE,
  OWN_PHOTO_URL,
  seedNotes,
  setOwnAvatar,
} from '../fixtures/notes-data';
import { checkStep } from '../fixtures/thread-checks';

// Personal notes: the notes card from the first paint, sorted into the one
// list by its last note once the list is in, the notes thread (one composer,
// the "Saved from" line), Save to notes
// from a DM's long-press menu with its tappable toast, and the Photos chip.
// Linux WebKit approximates iOS WebKit; it is not iOS.

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function rpcCalls(page: Page, name: string): Array<Record<string, unknown>> {
  const calls: Array<Record<string, unknown>> = [];
  page.on('request', (request: Request) => {
    if (!request.url().includes(`/rest/v1/rpc/${name}`)) return;
    calls.push((request.postDataJSON() ?? {}) as Record<string, unknown>);
  });
  return calls;
}

/** Hold a bubble like a finger: pointerdown, 700ms still, pointerup. */
async function holdBubble(page: Page, text: string): Promise<void> {
  const bubble = page.locator('[data-bubble]', { hasText: text }).last();
  await bubble.scrollIntoViewIfNeeded();
  const box = await bubble.boundingBox();
  if (box === null) throw new Error('bubble has no box');
  const at = { clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 };
  await bubble.dispatchEvent('pointerdown', { ...at, pointerType: 'touch', isPrimary: true });
  await page.waitForTimeout(700);
  await bubble.dispatchEvent('pointerup', { ...at, pointerType: 'touch', isPrimary: true });
}

/** Once the list is in, the notes card is one of its cards (sorted by its last note). */
async function tileInList(page: Page): Promise<void> {
  const list = page.locator('[data-chat-list]');
  await list.waitFor({ state: 'visible' });
  await expect(list.locator('[data-notes-tile]')).toHaveCount(1);
  await expect(page.locator('[data-section-label]')).toHaveCount(0);
}

/**
 * Record whether the notes tile is already in the DOM the moment the list
 * first shows anything (its skeleton or its sections): first paint is final.
 */
async function watchFirstPaint(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __tileAtFirstList?: boolean };
    const observer = new MutationObserver(() => {
      if (w.__tileAtFirstList !== undefined) return;
      const list = document.querySelector('[aria-label="Loading conversations"], [data-chat-home]');
      if (list === null) return;
      w.__tileAtFirstList = document.querySelector('[data-notes-tile]') !== null;
      observer.disconnect();
    });
    observer.observe(document, { childList: true, subtree: true });
  });
}

async function firstPaintTile(page: Page): Promise<void> {
  await watchFirstPaint(page);
  await page.goto('/chat');
  const tile = page.locator('[data-notes-tile]');
  await tile.waitFor({ state: 'visible', timeout: 30_000 });
  await expect(tile).toContainText(NOTES_TITLE);
  // The tagline until the previews read lands, then the last note (W8): which
  // one the first look catches depends on how fast that read answers.
  await expect(tile).toContainText(/Only you can see this|Moodboard for the spring shoot/);
  const atFirst = await page.evaluate(
    () => (window as unknown as { __tileAtFirstList?: boolean }).__tileAtFirstList,
  );
  expect(atFirst, 'tile present when the list first painted').toBe(true);
  await tileInList(page);
}

test('personal notes: phone', async ({ page }) => {
  const network = await installHarnessNetwork(page);
  seedNotes(network.world);
  const ensures = rpcCalls(page, 'notes_channel_ensure');
  const searches = rpcCalls(page, 'chat_message_search');

  await firstPaintTile(page);
  // Ensured once on Chat home load, with a uuid_v7 trace.
  await expect.poll(() => ensures.length).toBe(1);
  expect(String(ensures[0]?.p_trace_id)).toMatch(UUID_V7);

  // Open notes: C1 list > 200px, C2 centre on a message or skeleton, C3 one composer.
  await page.locator('[data-notes-tile]').click();
  const report = await checkStep(page, 'notes-phone-2-open', {
    allowSkeleton: true,
    requireComposer: true,
  });
  expect(report.failures, report.failures.join('; ')).toEqual([]);
  await expect(page.locator('[data-notes-avatar]').first()).toBeVisible();
  await expect(page.locator('[data-header-line]')).toHaveText('Only you can see this');
  await expect(page.locator('[data-contact-open]')).toHaveCount(0);
  await expect(page.locator('[data-loops-strip]')).toHaveCount(0);
  const savedLine = page.locator('[data-saved-from="source"]').first();
  await expect(savedLine).toContainText(`Saved from ${PEER_NAME} · Priya`);

  // The tray offers Photos, File, Post and no Schedule.
  await page.locator('[data-plus]').click();
  await expect(page.locator('#composer-tray')).toBeVisible();
  await expect(page.locator('#composer-tray').getByText('Schedule')).toHaveCount(0);
  await expect(page.locator('#composer-tray').getByText('Photos')).toBeVisible();
  await page.keyboard.press('Escape');

  // Back home, open the DM, long-press a peer message: Save to notes.
  await page.getByRole('button', { name: 'Back to conversations' }).click();
  await page.getByText(PEER_NAME, { exact: true }).first().click();
  const peerLine = 'Can we tighten the hook on slide one?';
  await page.locator('[data-bubble]', { hasText: peerLine }).last().waitFor({ state: 'visible' });
  await holdBubble(page, peerLine);
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  const menuKeys = (): Promise<(string | null)[]> =>
    menu
      .locator('[data-menu-item]')
      .evaluateAll((els) => els.map((el) => el.getAttribute('data-menu-item')));
  // One level: Copy, Select, then Save to notes after Forward.
  const keys = await menuKeys();
  expect(keys).toContain('copy');
  expect(keys).not.toContain('more');
  const selectAt = keys.indexOf('select-text');
  const saveAt = keys.indexOf('save-notes');
  expect(selectAt).toBeGreaterThan(keys.indexOf('copy'));
  expect(saveAt).toBeGreaterThan(selectAt);
  const sends = rpcCalls(page, 'chat_message_send');
  await menu.locator('[data-menu-item="save-notes"]').click();
  const toast = page.getByRole('button', { name: /Saved to Personal notes/ });
  await expect(toast).toBeVisible();
  await expect.poll(() => sends.length).toBeGreaterThan(0);
  const send = sends[sends.length - 1] ?? {};
  expect(String(send.p_channel_id)).toMatch(/^notes__/);
  expect(typeof send.p_forwarded_from_message_id).toBe('string');
  expect(send.p_mentions).toBeUndefined();
  expect(String(send.p_trace_id)).toMatch(UUID_V7);

  // The toast opens notes; the saved copy carries its "Saved from" line.
  await toast.click();
  await expect(page.locator('[data-notes-avatar]').first()).toBeVisible();
  await expect(page.locator('[data-saved-from="source"]')).toHaveCount(2);
  await expect(page.locator('[data-bubble]', { hasText: peerLine }).last()).toBeVisible();

  // Back returns where notes were opened from: the DM, then the list.
  await page.getByRole('button', { name: 'Back to conversations' }).click();
  await expect(page.locator('[data-contact-open]', { hasText: PEER_NAME })).toBeVisible();
  await page.getByRole('button', { name: 'Back to conversations' }).click();
  // The Photos chip alone lists the photos themselves (empty query, p_kind
  // photo): the note's photo is a grid tile, notes included.
  await page.locator('[data-search-chip="photo"]').click();
  await expect(page.locator('[data-search-chip="photo"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator(`[data-media-tile="${NOTE_PHOTO_TILE}"]`)).toBeVisible();
  const chipCall = searches[searches.length - 1] ?? {};
  expect(chipCall.p_kind).toBe('photo');
  expect(chipCall.p_query).toBe('');
  // Tap again: the chip clears and the list is back.
  await page.locator('[data-search-chip="photo"]').click();
  await expect(page.locator('[data-media-results]')).toHaveCount(0);

  expect(network.blocked, 'blocked non-fixture requests').toEqual([]);
});

test.describe('laptop', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false });

  test('personal notes: laptop', async ({ page }) => {
    const network = await installHarnessNetwork(page);
    seedNotes(network.world);
    await firstPaintTile(page);
    // No search field on the chat home (search is the top bar's palette);
    // New chat is the top bar's "+".
    await expect(page.getByRole('searchbox')).toHaveCount(0);
    await expect(page.locator('[data-topbar-plus][aria-label="New chat"]')).toBeVisible();

    await page.locator('[data-notes-tile]').click();
    const report = await checkStep(page, 'notes-laptop-2-open', {
      allowSkeleton: true,
      requireComposer: true,
    });
    expect(report.failures, report.failures.join('; ')).toEqual([]);
    await expect(page.locator('[data-saved-from="source"]').first()).toBeVisible();
    expect(network.blocked, 'blocked non-fixture requests').toEqual([]);
  });
});

test('personal notes: a failed ensure shows the Retry state, not a skeleton', async ({ page }) => {
  const network = await installHarnessNetwork(page);
  // Registered after the harness routes, so it answers first: the proc refuses.
  await page.route('**/rest/v1/rpc/notes_channel_ensure', (route) =>
    route.fulfill({
      status: 400,
      headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'P0001', message: 'refused', details: null, hint: null }),
    }),
  );
  await page.goto('/chat');
  await page.locator('[data-notes-tile]').waitFor({ state: 'visible', timeout: 30_000 });
  await page.locator('[data-notes-tile]').click();
  await expect(page.getByText("Couldn't load messages")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
  expect(network.blocked, 'blocked non-fixture requests').toEqual([]);
});

/** The notes avatar outside the list card (the thread header). */
const HEADER_NOTES_AVATAR = '[data-notes-avatar]:not([data-notes-tile] [data-notes-avatar])';

for (const photo of [true, false]) {
  const name = photo ? 'with photo' : 'without photo';
  test(`notes avatar: ${name}`, async ({ page }) => {
    const network = await installHarnessNetwork(page);
    seedNotes(network.world);
    setOwnAvatar(network.world, photo ? OWN_PHOTO_URL : null);
    await page.goto('/chat');
    const tile = page.locator('[data-notes-tile]');
    await tile.waitFor({ state: 'visible', timeout: 30_000 });
    // The notes row is ui/ListCard's person slot at 40 (ui/Avatar 'card'):
    // the user's own photo, round; their initials (no image) without one.
    const picture = tile.locator('[data-notes-picture]');
    await expect(picture).toBeVisible();
    const box = await picture.boundingBox();
    expect(Math.round(box?.width ?? 0)).toBe(40);
    expect(Math.round(box?.height ?? 0)).toBe(40);
    const tileAvatar = tile.locator('[data-avatar-role="card"]');
    await expect(tileAvatar).toHaveClass(/rounded-full/);
    await expect(tile.locator('img')).toHaveCount(photo ? 1 : 0);

    await tile.click();
    const header = page.locator('[data-header-line]');
    await expect(header).toHaveText('Only you can see this');
    const headAvatar = page.locator(HEADER_NOTES_AVATAR).first();
    await expect(headAvatar).toHaveAttribute('data-notes-avatar', photo ? 'photo' : 'notebook');
    expect(Math.round((await headAvatar.boundingBox())?.width ?? 0)).toBe(32);
    await expect(page.locator('[data-contact-open]')).toHaveCount(0);
    expect(network.blocked, 'blocked non-fixture requests').toEqual([]);
  });
}

test('notes avatar: a photo that fails to load falls back (initials on the card, the notebook in the header)', async ({
  page,
}) => {
  const network = await installHarnessNetwork(page);
  setOwnAvatar(network.world, OWN_PHOTO_URL);
  await page.route(OWN_PHOTO_URL, (route) =>
    route.fulfill({ status: 404, headers: { 'access-control-allow-origin': '*' }, body: '' }),
  );
  await page.goto('/chat');
  const tile = page.locator('[data-notes-tile]');
  await tile.waitFor({ state: 'visible', timeout: 30_000 });
  await expect(tile.locator('[data-avatar-role="card"]')).toBeVisible();
  await expect(tile.locator('img')).toHaveCount(0);
  await tile.click();
  const headAvatar = page.locator(HEADER_NOTES_AVATAR).first();
  await expect(headAvatar).toHaveAttribute('data-notes-avatar', 'notebook');
  await expect(page.locator('[data-notes-badge]')).toHaveCount(0);
  expect(network.blocked, 'blocked non-fixture requests').toEqual([]);
});
