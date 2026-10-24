import { expect, test, type Page } from '@playwright/test';
import { installHarnessNetwork, type HarnessNetwork } from '../fixtures/harness-routes';
import {
  DM_CHANNEL,
  GROUP_CHANNEL,
  GROUP_NAME,
  ME,
  PEER,
  WORKSPACE_ID,
} from '../fixtures/chat-data';

// The search screen (command palette): "Search anything", grouped results
// from workspace_search_grouped + workspace_search_counts, the RECENT list on
// an empty search, the overlay's scrim token, laptop keyboard navigation and
// the phone's full-screen sheet with Cancel. Linux WebKit approximates iOS.

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

async function openPalette(page: Page): Promise<void> {
  await page
    .getByRole('button', { name: /^Search( ⌘K)?$/ })
    .filter({ visible: true })
    .first()
    .click();
  const dialog = page.getByRole('dialog', { name: 'Command palette' });
  await expect(dialog).toBeVisible();
  // Measure only once the enter transition (scale + fade) has settled.
  await dialog.evaluate(
    (el) =>
      new Promise<void>((resolve) => {
        const settled = (): void => {
          if (el.className.includes('scale-100') && el.getAnimations().length === 0) resolve();
          else requestAnimationFrame(settled);
        };
        settled();
      }),
  );
}

test.describe('command palette', () => {
  test('phone: full screen, Cancel, scrim token, grouped results @theme', async ({ page }) => {
    const net = await installHarnessNetwork(page);
    await page.goto('/chat');
    await page.getByText(GROUP_NAME, { exact: true }).first().waitFor({ state: 'visible' });
    await openPalette(page);

    const input = page.getByPlaceholder('Search anything');
    await expect(input).toBeVisible();
    await expect(page.getByText('Go to', { exact: true })).toHaveCount(0);

    // Full screen on phones, with a 44px Cancel.
    const dialog = page.getByRole('dialog', { name: 'Command palette' });
    const box = await dialog.boundingBox();
    const viewport = page.viewportSize();
    expect(Math.round(box?.width ?? 0)).toBe(viewport?.width);
    const cancel = page.getByRole('button', { name: 'Cancel' });
    const cancelBox = await cancel.boundingBox();
    expect(cancelBox?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect(cancelBox?.width ?? 0).toBeGreaterThanOrEqual(44);

    // The overlay paints the scrim token for this theme, never a hardcoded black.
    const overlay = page.locator('[data-palette-overlay]');
    const dark = await page.evaluate(() => document.documentElement.classList.contains('dark'));
    const scrim = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--scrim').trim(),
    );
    expect(scrim).toBe(dark ? 'rgba(0, 0, 0, 0.6)' : 'rgba(20, 22, 30, 0.45)');
    await expect(overlay).toHaveCSS(
      'background-color',
      dark ? 'rgba(0, 0, 0, 0.6)' : 'rgba(20, 22, 30, 0.45)',
    );

    await input.fill('crew');
    const groups = page.locator('[data-palette-group="Groups"]');
    await expect(groups).toBeVisible();
    await expect(groups.getByText(GROUP_NAME, { exact: true })).toBeVisible();
    await expect(page.locator('[data-palette-group="Posts"]')).toHaveCount(0);

    // One round trip each, in parallel, named args and one uuid_v7 trace id.
    const grouped = net.rpcCalls.filter((c) => c.name === 'workspace_search_grouped');
    const counts = net.rpcCalls.filter((c) => c.name === 'workspace_search_counts');
    expect(grouped).toHaveLength(1);
    expect(counts).toHaveLength(1);
    expect(grouped[0]?.args).toMatchObject({
      p_workspace_id: WORKSPACE_ID,
      p_query: 'crew',
      p_per_kind: 5,
    });
    expect(String(grouped[0]?.args.p_trace_id)).toMatch(UUID_V7);
    expect(counts[0]?.args.p_trace_id).toBe(grouped[0]?.args.p_trace_id);
    expect(net.rpcCalls.some((c) => c.name === 'workspace_search')).toBe(false);

    await cancel.click();
    await expect(dialog).toHaveCount(0);
  });

  test('recents: an opened group shows under RECENT, scoped to this user', async ({ page }) => {
    await installHarnessNetwork(page);
    await page.goto(`/chat?channel=${encodeURIComponent(GROUP_CHANNEL)}`);
    await expect
      .poll(() =>
        page.evaluate(
          (key) => window.localStorage.getItem(key),
          `sorted:recent:${ME}:${WORKSPACE_ID}`,
        ),
      )
      .toContain('"type":"group"');
    // Only {type, id, openedAt} is stored: no titles.
    const stored = await page.evaluate(
      (key) => window.localStorage.getItem(key) ?? '',
      `sorted:recent:${ME}:${WORKSPACE_ID}`,
    );
    expect(stored).not.toContain(GROUP_NAME);

    await page.goto('/chat');
    await page.getByText(GROUP_NAME, { exact: true }).first().waitFor({ state: 'visible' });
    await openPalette(page);
    const recent = page.locator('[data-palette-group="Recent"]');
    await expect(recent).toBeVisible();
    await expect(recent.getByText('Recent', { exact: true })).toHaveCSS(
      'text-transform',
      'uppercase',
    );
    await expect(recent.getByText(GROUP_NAME, { exact: true })).toBeVisible();
    await expect(recent.getByText('Group', { exact: true })).toBeVisible();

    // Sign-out clears every list on this device.
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('sorted:signout')));
    const after = await page.evaluate(
      (key) => window.localStorage.getItem(key),
      `sorted:recent:${ME}:${WORKSPACE_ID}`,
    );
    expect(after).toBeNull();
  });
});

test.describe('command palette on a laptop @desktop', () => {
  test.skip(({ isMobile }) => isMobile, 'desktop only');

  test('centred box, Esc chip, arrows move, Enter opens, Esc closes', async ({ page }) => {
    await installHarnessNetwork(page);
    await page.goto('/chat');
    await page.getByText(GROUP_NAME, { exact: true }).first().waitFor({ state: 'visible' });
    await openPalette(page);
    const dialog = page.getByRole('dialog', { name: 'Command palette' });
    await expect(dialog.getByText('Esc', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cancel' })).toBeHidden();
    const box = await dialog.boundingBox();
    const viewport = page.viewportSize();
    const centre = (box?.x ?? 0) + (box?.width ?? 0) / 2;
    expect(Math.abs(centre - (viewport?.width ?? 0) / 2)).toBeLessThanOrEqual(1);

    const input = page.getByPlaceholder('Search anything');
    await input.fill('crew');
    const rows = page.locator('[data-palette-group="Groups"] [role="option"]');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toHaveAttribute('aria-selected', 'true');
    await input.press('ArrowDown');
    await expect(rows.nth(1)).toHaveAttribute('aria-selected', 'true');
    await input.press('ArrowUp');
    await expect(rows.nth(0)).toHaveAttribute('aria-selected', 'true');
    // Newest first: Thread crew, then Launch crew.
    await input.press('ArrowDown');
    await expect(rows.nth(1)).toContainText(GROUP_NAME);
    await input.press('Enter');
    await expect(dialog).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`channel=${encodeURIComponent(GROUP_CHANNEL)}`));

    await openPalette(page);
    await page.getByPlaceholder('Search anything').press('Escape');
    await expect(dialog).toHaveCount(0);
  });
});

// Search result jump: a palette result lands on the exact item it matched,
// carrying the searched words (q=) through the one jump helper. The target is
// centred and tinted for 2s (no animation under reduced motion); the word stays
// marked until the screen is left. A gone target opens its parent, no error.

const JUMP_NOT_LOADED_TOAST = 'Message is older than loaded history';

async function search(page: Page, query: string): Promise<void> {
  await page.goto('/chat');
  await page.getByText(GROUP_NAME, { exact: true }).first().waitFor({ state: 'visible' });
  await openPalette(page);
  await page.getByPlaceholder('Search anything').fill(query);
}

function chatRow(id: string, body: string, minutesAgo: number) {
  return {
    id,
    channel_id: DM_CHANNEL,
    workspace_id: WORKSPACE_ID,
    sender_user_id: PEER,
    body,
    mentions: null,
    attachment_asset_ids: null,
    shared_post_ids: null,
    shared_brief_ids: null,
    reply_to_message_id: null,
    forwarded_from_message_id: null,
    attachment_meta: null,
    agora_event_id: null,
    created_at: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    edited_at: null,
    deleted_at: null,
    thread_root_message_id: null,
  };
}

/** One old DM message behind more than a page (50) of newer ones. */
const OLD_ID = '0190b000-0000-7000-8900-00000000f0aa';
const OLD_WORD = 'zanzibar';
function seedOlderMessage(net: HarnessNetwork): void {
  const rows = (net.world.tables.chat_messages ??= []);
  // The fixture DM spans the last 30 hours with 40 rows: 15 more just before
  // it, then the target, so the first page (50) stops short of it.
  for (let i = 0; i < 15; i += 1) {
    const id = `0190b000-0000-7000-8900-0000000f${String(i).padStart(4, '0')}`;
    rows.push(chatRow(id, `Filler note ${i}`, 31 * 60 + i * 10));
  }
  rows.push(chatRow(OLD_ID, `Shoot moves to ${OLD_WORD} next week`, 100 * 60));
}

test.describe('search result jump', () => {
  test('a chat message hit: centred, tinted 2s then cleared, word stays marked @theme', async ({
    page,
  }) => {
    await installHarnessNetwork(page);
    await search(page, 'approvals');
    const hit = page.locator('[data-palette-group="Chat"] [role="option"]').first();
    await expect(hit.locator('mark[data-search-mark]').first()).toHaveText(/^approvals$/i);
    await hit.click();

    const target = page.locator('[data-msg-id][data-jump-glow]');
    await expect(target).toHaveCount(1);
    await expect(target).toBeInViewport();
    await expect(target.locator('mark[data-search-mark]').first()).toHaveText(/^approvals$/i);
    // No in-chat search bar, and the jump params are gone from the url.
    await expect(page.locator('[data-chat-search-bar]')).toHaveCount(0);
    expect(new URL(page.url()).searchParams.has('q')).toBe(false);

    // The tint clears after 2s (plus its fade); the word stays marked on this screen.
    await expect(target).toHaveCount(0, { timeout: 4_000 });
    await expect(page.locator('[data-msg-id] mark[data-search-mark]').first()).toBeVisible();
  });

  test('a message not loaded yet: its older page loads and the message is centred', async ({
    page,
  }) => {
    const net = await installHarnessNetwork(page);
    seedOlderMessage(net);
    await search(page, OLD_WORD);
    const hit = page.locator('[data-palette-group="Chat"] [role="option"]').first();
    await expect(hit).toBeVisible();
    await hit.click();
    const target = page.locator(`[data-msg-id="${OLD_ID}"]`);
    await expect(target).toBeInViewport();
    await expect(target).toHaveAttribute('data-jump-glow', '');
    await expect(target.locator('mark[data-search-mark]')).toHaveText(OLD_WORD);
  });

  test('a target gone since the search opens its chat with no error', async ({ page }) => {
    const net = await installHarnessNetwork(page);
    seedOlderMessage(net);
    await search(page, OLD_WORD);
    const hit = page.locator('[data-palette-group="Chat"] [role="option"]').first();
    await expect(hit).toBeVisible();
    const rows = net.world.tables.chat_messages ?? [];
    rows.splice(
      rows.findIndex((r) => r.id === OLD_ID),
      1,
    );
    await hit.click();
    await expect(page.locator('[data-msg-id]').first()).toBeVisible();
    await page.waitForTimeout(1_500);
    await expect(page.getByText(JUMP_NOT_LOADED_TOAST)).toHaveCount(0);
    await expect(page.locator('[data-msg-id][data-jump-glow]')).toHaveCount(0);
  });

  test('reduced motion: the tint shows with no transition and clears at 2s', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await installHarnessNetwork(page);
    await search(page, 'approvals');
    await page.locator('[data-palette-group="Chat"] [role="option"]').first().click();
    const target = page.locator('[data-msg-id][data-jump-glow]');
    await expect(target).toHaveCount(1);
    expect(await target.evaluate((el) => (el as HTMLElement).style.transition)).toBe('none');
    await expect(target).toHaveCount(0, { timeout: 3_000 });
  });

  test('a group hit opens the chat with the word marked in its name', async ({ page }) => {
    await installHarnessNetwork(page);
    await search(page, 'crew');
    await page
      .locator('[data-palette-group="Groups"] [role="option"]', { hasText: GROUP_NAME })
      .click();
    await expect(
      page.locator('mark[data-search-mark]', { hasText: /^crew$/i }).first(),
    ).toBeVisible();
  });

  test('a post hit opens the post with the word marked in its title', async ({ page }) => {
    await installHarnessNetwork(page);
    await search(page, 'carousel');
    await page
      .locator('[data-palette-group="Posts"] [role="option"]', { hasText: 'Monday carousel' })
      .click();
    await expect(
      page
        .getByRole('heading', { name: /Monday carousel/ })
        .locator('mark[data-search-mark]', { hasText: /^carousel$/i })
        .first(),
    ).toBeVisible();
  });
});

test.describe('search basics', () => {
  test('one tap: the field has the cursor inside the tap itself (iOS keyboard)', async ({
    page,
  }) => {
    await installHarnessNetwork(page);
    await page.goto('/chat');
    await page.getByText(GROUP_NAME, { exact: true }).first().waitFor({ state: 'visible' });
    // Record what is focused when the tap's click finishes dispatching: iOS raises
    // the keyboard only for a focus() that ran inside that handler.
    await page.evaluate(() => {
      window.addEventListener('click', () => {
        const el = document.activeElement;
        (window as unknown as { focusAtTap: string | null }).focusAtTap =
          el?.getAttribute('aria-label') ?? null;
      });
    });
    await page
      .getByRole('button', { name: /^Search( ⌘K)?$/ })
      .filter({ visible: true })
      .first()
      .tap();
    const input = page.getByPlaceholder('Search anything');
    await expect(input).toBeFocused();
    expect(
      await page.evaluate(() => (window as unknown as { focusAtTap: string | null }).focusAtTap),
    ).toBe('Search this workspace');
  });

  test('Clear search empties the field and keeps the cursor there', async ({ page }) => {
    await installHarnessNetwork(page);
    await page.goto('/chat');
    await page.getByText(GROUP_NAME, { exact: true }).first().waitFor({ state: 'visible' });
    await openPalette(page);
    const input = page.getByPlaceholder('Search anything');
    const clear = page.getByRole('button', { name: 'Clear search' });
    await expect(clear).toHaveCount(0);
    await input.fill('crew');
    await expect(clear).toBeVisible();
    const box = await clear.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    await expect(clear).toHaveText('');
    await clear.tap();
    await expect(input).toHaveValue('');
    await expect(input).toBeFocused();
    await expect(clear).toHaveCount(0);
  });
});

test.describe('search basics on a laptop @desktop', () => {
  test.skip(({ isMobile }) => isMobile, 'desktop only');

  test('Ctrl/Cmd+K opens with the cursor ready, is ignored in other fields; Esc returns focus; Enter opens the first result', async ({
    page,
  }) => {
    await installHarnessNetwork(page);
    await page.goto('/chat');
    await page.getByText(GROUP_NAME, { exact: true }).first().waitFor({ state: 'visible' });
    const mod = await page.evaluate(() =>
      /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent) ? 'Meta' : 'Control',
    );
    const dialog = page.getByRole('dialog', { name: 'Command palette' });

    // Typing in another text field: the shortcut does nothing.
    const other = page.getByRole('searchbox', { name: 'Search conversations' });
    await other.focus();
    await page.keyboard.press(`${mod}+k`);
    await expect(dialog).toHaveCount(0);
    await expect(other).toBeFocused();

    // From anywhere else it opens, the field ready to type in.
    const from = page.getByRole('button', { name: 'Account menu' });
    await from.focus();
    await page.keyboard.press(`${mod}+k`);
    await expect(dialog).toBeVisible();
    const input = page.getByPlaceholder('Search anything');
    await expect(input).toBeFocused();
    await page.keyboard.type('crew');

    // Esc closes and puts focus back where it was.
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(from).toBeFocused();

    // Enter opens the first (default selected) result.
    await page.keyboard.press(`${mod}+k`);
    await page.keyboard.type('crew');
    const first = page.locator('[role="option"]').first();
    await expect(first).toHaveAttribute('aria-selected', 'true');
    const text = (await first.textContent()) ?? '';
    await page.keyboard.press('Enter');
    await expect(dialog).toHaveCount(0);
    await expect(page).toHaveURL(/channel=/);
    expect(text).toMatch(/crew/i);
  });
});
