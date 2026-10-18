import { expect, test, type Page, type Route } from '@playwright/test';
import { installHarnessNetwork } from '../fixtures/harness-routes';
import { DM_CHANNEL, ME, PEER, PEER_NAME, WORKSPACE_ID } from '../fixtures/chat-data';
import type { Row, Tables } from '../fixtures/postgrest';

// Message stars: long-press Star puts a star on the bubble, the header's
// Starred sheet lists it and a tap jumps to it, the chat home's Starred chip
// and the Contact sheet's Starred tab list it, and Unstar from Edit takes it
// out of all three. Linux WebKit approximates iOS WebKit; it is not iOS.

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PEER_LINE = 'Can we tighten the hook on slide one?';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET, POST, PATCH, DELETE, HEAD, OPTIONS',
};

/** The two star procs over the harness tables, as the migration defines them. */
function starProcs(tables: Tables): Record<string, (args: Record<string, unknown>) => unknown> {
  const stars = (tables.chat_message_stars ??= []);
  const messages = (): Row[] => tables.chat_messages ?? [];
  return {
    chat_message_star_set: (args) => {
      const ids = Array.isArray(args.p_message_ids) ? args.p_message_ids.map(String) : [];
      if (args.p_starred === true) {
        for (const m of messages()) {
          if (!ids.includes(String(m.id)) || m.channel_id !== args.p_channel_id) continue;
          if (stars.some((s) => s.message_id === m.id)) continue;
          stars.push({
            user_id: ME,
            message_id: m.id,
            message_created_at: m.created_at,
            channel_id: m.channel_id,
            workspace_id: WORKSPACE_ID,
            starred_at: new Date().toISOString(),
          });
        }
      } else {
        for (let i = stars.length - 1; i >= 0; i -= 1) {
          const s = stars[i];
          if (s && s.channel_id === args.p_channel_id && ids.includes(String(s.message_id)))
            stars.splice(i, 1);
        }
      }
      return null;
    },
    chat_message_starred_list: (args) => {
      const query = String(args.p_query ?? '').trim();
      const words = query.toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];
      const limit = Math.min(50, Math.max(1, Number(args.p_limit ?? 30)));
      const beforeAt =
        typeof args.p_before_created_at === 'string' ? args.p_before_created_at : null;
      const beforeId = typeof args.p_before_id === 'string' ? args.p_before_id : null;
      const starred = new Set(
        stars
          .filter((s) => args.p_channel_id == null || s.channel_id === args.p_channel_id)
          .map((s) => String(s.message_id)),
      );
      return messages()
        .filter((m) => starred.has(String(m.id)) && m.deleted_at === null)
        .filter((m) => {
          if (query === '') return true;
          if (query.length < 2 || query.length > 100) return false;
          const tokens =
            String(m.body ?? '')
              .toLowerCase()
              .match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];
          return words.every((w) => tokens.some((t) => t.startsWith(w)));
        })
        .sort(
          (a, b) =>
            String(b.created_at).localeCompare(String(a.created_at)) ||
            String(b.id).localeCompare(String(a.id)),
        )
        .filter((m) => {
          if (beforeAt === null) return true;
          const at = String(m.created_at);
          return at < beforeAt || (at === beforeAt && beforeId !== null && String(m.id) < beforeId);
        })
        .slice(0, limit);
    },
  };
}

async function installStars(
  page: Page,
  seed?: (tables: Tables) => void,
): Promise<Array<Record<string, unknown>>> {
  const { world } = await installHarnessNetwork(page);
  seed?.(world.tables);
  const procs = starProcs(world.tables);
  const calls: Array<Record<string, unknown>> = [];
  // Registered after the harness, so these answer first.
  await page.route(/\/rest\/v1\/rpc\/chat_message_star(_set|red_list)/, async (route: Route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: CORS });
      return;
    }
    const name = new URL(request.url()).pathname.split('/').pop() ?? '';
    const args = (request.postDataJSON() ?? {}) as Record<string, unknown>;
    calls.push({ name, ...args });
    const proc = procs[name];
    await route.fulfill({
      status: 200,
      headers: { ...CORS, 'content-type': 'application/json' },
      body: JSON.stringify(proc ? proc(args) : null),
    });
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

/** No iOS callout and no text selection on a long-press target. */
async function noCallout(page: Page, selector: string): Promise<void> {
  const touch = await page
    .locator(selector)
    .first()
    .evaluate((el) => {
      const style = getComputedStyle(el) as CSSStyleDeclaration & { webkitTouchCallout?: string };
      return { callout: style.webkitTouchCallout ?? 'none', select: style.webkitUserSelect };
    });
  expect(touch.callout).toBe('none');
  expect(touch.select).toBe('none');
}

async function openDm(page: Page): Promise<void> {
  await page.getByText(PEER_NAME, { exact: true }).first().click();
  await page.locator('[data-bubble]', { hasText: PEER_LINE }).last().waitFor({ state: 'visible' });
}

test('chat stars: star, list everywhere, jump, unstar from Edit', async ({ page }) => {
  const calls = await installStars(page);
  await page.goto('/chat');
  await openDm(page);

  // Long-press: Copy, Forward, Star, then More (Select and Save to notes under it).
  await holdBubble(page, PEER_LINE);
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  const menuKeys = (): Promise<(string | null)[]> =>
    menu
      .locator('[data-menu-item]')
      .evaluateAll((els) => els.map((el) => el.getAttribute('data-menu-item')));
  const keys = await menuKeys();
  expect(keys.indexOf('forward')).toBe(keys.indexOf('copy') + 1);
  expect(keys.indexOf('star')).toBe(keys.indexOf('forward') + 1);
  expect(keys.indexOf('more')).toBe(keys.indexOf('star') + 1);
  await menu.locator('[data-menu-item="more"]').click();
  const more = await menuKeys();
  expect(more[0]).toBe('back');
  expect(more.indexOf('save-notes')).toBe(more.indexOf('select-text') + 1);
  await menu.locator('[data-menu-item="back"]').click();
  await expect(menu.locator('[data-menu-item="star"]')).toHaveText(/Star/);
  await noCallout(page, '[data-bubble]');
  await menu.locator('[data-menu-item="star"]').click();

  // The bubble carries the star at once; one write with a uuid_v7 trace.
  const bubble = page.locator('[data-bubble]', { hasText: PEER_LINE }).last();
  await expect(bubble.locator('[data-meta-star]')).toBeVisible();
  await expect.poll(() => calls.filter((c) => c.name === 'chat_message_star_set').length).toBe(1);
  const set = calls.find((c) => c.name === 'chat_message_star_set') ?? {};
  expect(set.p_starred).toBe(true);
  expect(String(set.p_trace_id)).toMatch(UUID_V7);
  for (const key of Object.keys(set)) if (key !== 'name') expect(key.startsWith('p_')).toBe(true);

  // The menu now offers Unstar.
  await holdBubble(page, PEER_LINE);
  await expect(page.getByRole('menu').locator('[data-menu-item="star"]')).toHaveText(/Unstar/);
  await page.keyboard.press('Escape');

  // Header star: the sheet lists it; a tap closes the sheet and jumps to it.
  await page.getByRole('button', { name: 'Starred messages' }).click();
  const sheet = page.locator('[data-starred-sheet]');
  await expect(sheet).toBeVisible();
  await expect(sheet.locator('[data-starred-chat-name]')).toHaveText(PEER_NAME);
  const sheetRow = sheet.locator('[data-starred-row]', { hasText: PEER_LINE });
  await expect(sheetRow).toBeVisible();
  await noCallout(page, '[data-starred-row]');
  await sheetRow.click();
  await expect(sheet).toHaveCount(0);
  await expect(page.locator('[data-msg-id][data-jump-glow]', { hasText: PEER_LINE })).toBeVisible();

  // Contact sheet: the Starred tab lists it.
  await page.locator('[data-contact-open]').click();
  await page.getByRole('button', { name: 'Starred', exact: true }).click();
  const tab = page.locator('[data-starred-tab]');
  await expect(tab.locator('[data-starred-row]', { hasText: PEER_LINE })).toBeVisible();
  await page.getByRole('button', { name: 'Close contact info' }).click();

  // Chat home: the Starred chip is first and lists it in place of the chats.
  await page.getByRole('button', { name: 'Back to conversations' }).click();
  const chips = await page
    .locator('[data-search-chip]')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-search-chip')));
  expect(chips).toEqual(['starred', 'photo', 'link', 'file', 'voice']);
  await page.locator('[data-search-chip="starred"]').click();
  const home = page.locator('[data-starred-home]');
  await expect(home.locator('[data-starred-row]', { hasText: PEER_LINE })).toBeVisible();
  await expect(page.locator('[data-notes-tile]')).toHaveCount(0);

  // Edit, select it, Unstar (1): gone from the home list.
  await home.locator('[data-starred-edit="edit"]').click();
  await home.locator('[data-starred-row]', { hasText: PEER_LINE }).click();
  await page.locator('[data-starred-unstar]').click();
  await expect(home.locator('[data-starred-row]')).toHaveCount(0);
  await expect(home.locator('[data-starred-empty]')).toBeVisible();
  const unset = calls.filter((c) => c.name === 'chat_message_star_set').pop() ?? {};
  expect(unset.p_starred).toBe(false);

  // ...and from the bubble, the header sheet and the Contact tab.
  await page.locator('[data-search-chip="starred"]').click();
  await openDm(page);
  await expect(
    page.locator('[data-bubble]', { hasText: PEER_LINE }).last().locator('[data-meta-star]'),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Starred messages' }).click();
  await expect(page.locator('[data-starred-sheet] [data-starred-empty]')).toBeVisible();
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await page.locator('[data-contact-open]').click();
  await page.getByRole('button', { name: 'Starred', exact: true }).click();
  await expect(page.locator('[data-starred-tab] [data-starred-empty]')).toBeVisible();
});

// One long starred message: 9 lines, a line break, a long unbroken URL.
const LONG_ID = '0190b000-0000-7000-8000-00000000f001';
const LONG_URL = `https://cdn.example.com/briefs/diwali/${'storyboard-final-v'.repeat(6)}7.pdf`;
const LONG_LAST = 'Thanksgivingwrapup';
const LONG_BODY = [
  'Brief notes for the Diwali shoot, please read before Monday.',
  'One: the hook on slide one needs a tighter first line and a clearer promise.',
  'Two: the cover shot should use the warm light from the second take, not the first.',
  'Three: captions stay under 120 characters and lead with the offer.',
  '',
  `Reference deck: ${LONG_URL}`,
  'Four: the reel cuts at 0:12 and 0:24, keep the logo off the first frame.',
  'Five: alt text on every image, written for screen readers, plain words only.',
  `Six: send the final set to the client by Friday 5pm, then we close the brief ${LONG_LAST}`,
].join('\n');

test(
  'chat home Starred chip: the card shows the whole message',
  { tag: '@theme' },
  async ({ page }) => {
    await installStars(page, (tables) => {
      const created = new Date(Date.now() - 60_000).toISOString();
      (tables.chat_messages ??= []).push({
        id: LONG_ID,
        channel_id: DM_CHANNEL,
        workspace_id: WORKSPACE_ID,
        sender_user_id: PEER,
        body: LONG_BODY,
        mentions: null,
        attachment_asset_ids: null,
        shared_post_ids: null,
        shared_brief_ids: null,
        reply_to_message_id: null,
        forwarded_from_message_id: null,
        attachment_meta: null,
        agora_event_id: null,
        created_at: created,
        edited_at: null,
        deleted_at: null,
        thread_root_message_id: null,
      });
      (tables.chat_message_stars ??= []).push({
        user_id: ME,
        message_id: LONG_ID,
        message_created_at: created,
        channel_id: DM_CHANNEL,
        workspace_id: WORKSPACE_ID,
        starred_at: created,
      });
    });
    await page.goto('/chat');
    await page.locator('[data-search-chip="starred"]').click();
    const home = page.locator('[data-starred-home]');
    const row = home.locator(`[data-starred-row="${LONG_ID}"]`);
    const bubble = row.locator('[data-starred-bubble]');
    await expect(bubble).toBeVisible();

    // Every line is there, line breaks kept, nothing hidden inside the bubble.
    const text = await bubble.evaluate((el) => (el as HTMLElement).innerText);
    expect(text).toBe(LONG_BODY);
    const box = await bubble.evaluate((el) => {
      const style = getComputedStyle(el);
      return {
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
        clamp: style.getPropertyValue('-webkit-line-clamp'),
        maxHeight: style.maxHeight,
        whiteSpace: style.whiteSpace,
        lineHeight: parseFloat(style.lineHeight),
      };
    });
    expect(box.scrollHeight).toBe(box.clientHeight);
    expect(box.scrollWidth).toBeLessThanOrEqual(box.clientWidth);
    expect(['', 'none']).toContain(box.clamp);
    expect(box.maxHeight).toBe('none');
    expect(box.whiteSpace).toBe('pre-wrap');
    // 9 source lines (one blank) wrap to at least 9 rendered lines.
    expect(box.clientHeight).toBeGreaterThanOrEqual(9 * box.lineHeight);

    // No horizontal overflow anywhere on the page.
    const pageOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(pageOverflow).toBeLessThanOrEqual(0);

    // The card's last word is on screen once the list scrolls to the end (the
    // list scrolls as a whole; the bubble never scrolls on its own).
    const lastWord = await bubble.evaluate((el, word) => {
      let list: HTMLElement | null = el.parentElement;
      while (list !== null && !/(auto|scroll)/.test(getComputedStyle(list).overflowY)) {
        list = list.parentElement;
      }
      if (list === null) return null;
      list.scrollTop = list.scrollHeight;
      const node = [...el.childNodes].find((n) => n.textContent?.includes(word));
      if (node === undefined) return null;
      const range = document.createRange();
      const at = (node.textContent ?? '').lastIndexOf(word);
      range.setStart(node, at);
      range.setEnd(node, at + word.length);
      const r = range.getBoundingClientRect();
      const view = list.getBoundingClientRect();
      return {
        inList: r.top >= view.top && r.bottom <= view.bottom,
        inScreen: r.top >= 0 && r.bottom <= window.innerHeight && r.right <= window.innerWidth,
        bubbleScrolls: el.scrollTop !== 0,
      };
    }, LONG_LAST);
    expect(lastWord).toEqual({ inList: true, inScreen: true, bubbleScrolls: false });

    // A tap still opens the chat at that message.
    await row.click();
    await expect(home).toHaveCount(0);
    await expect(
      page.locator('[data-msg-id][data-jump-glow]', { hasText: LONG_LAST }),
    ).toBeVisible();
  },
);
