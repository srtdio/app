import { expect, test, type Locator, type Page } from '@playwright/test';
import { installHarnessNetwork, type HarnessNetwork } from '../fixtures/harness-routes';
import {
  COLLEAGUE_A,
  DATED_PLAN_ID,
  DATED_PLAN_ITEMS,
  DM_CHANNEL,
  ME,
  PEER_NAME,
  POST_IDS,
  seedDatedPlan,
} from '../fixtures/chat-data';
import { seedAudit } from '../fixtures/audit-pr-b';
import { installLinkPreviewStub, TEXT_URL } from '../fixtures/link-previews';

// The writing box (ui/WritingBox, Slack style, 8 Nov 2026): one box for chat,
// comments, sheet fields and the post caption. Stories:
//   S1 phone: tap the box, Aa, Numbered list, three lines, send: the bubble is
//      an <ol> of three; the chat list preview starts "1. ".
//   S2 phone: a quote, a [text](url) link through Add link, a bullet list: the
//      bubble shows .fmt-quote, the <ul> and the link's text.
//   S3 laptop: Cmd/Ctrl+B, Cmd/Ctrl+Shift+8, Cmd/Ctrl+K (Add link), the emoji
//      search "fire", Enter sends.
//   S4 edit a sent list: the box shows the raw prefixes, Save edit, a list again.
//   S5 New brief: the Objective bulleted through the field's row; the brief
//      screen shows the <ul>.
//   S6 a plan item comment: a mention chip inside a bullet.
//   S7 the mic: in the phone's idle pill; in the laptop card while empty.
//   S8 the + drawer from the card still opens its pickers.
//   S9 phone: expand, ten lines, collapse keeps the text, expand, send closes it.
//   S10 the caption: emoji and "@brandname" through the @ key, no Aa; the saved
//      caption is exact.
// Projects: iphone-webkit runs every test (laptop ones skip by width);
// desktop-webkit runs the @desktop ones. Linux WebKit approximates iOS WebKit
// (it never shows a keyboard); it is not iOS.

const isPhone = (page: Page): boolean => (page.viewportSize()?.width ?? 0) < 768;

/** Long enough for the message menu's long-press on touch. */
const HOLD_MS = 900;

const chatBox = (page: Page): Locator =>
  page.locator('[data-writing-box][data-mode="chat"]').first();
const chatField = (page: Page): Locator => chatBox(page).locator('textarea').first();

/** A writing box key by its aria-label ("Aa", "Bold", "Emoji", "Mention", ...). */
const key = (box: Locator, name: string): Locator =>
  box.getByRole('button', { name, exact: true }).first();

async function openChat(page: Page, name: string): Promise<void> {
  await page.goto('/chat');
  const row = page.getByText(name, { exact: true }).first();
  await row.waitFor({ state: 'visible' });
  await row.click();
  await page.locator('[data-msg-id]').first().waitFor({ state: 'visible', timeout: 8000 });
  await page.waitForTimeout(300);
}

function expectClean(network: HarnessNetwork): void {
  expect(network.blocked, 'blocked non-fixture requests').toEqual([]);
}

/** The body the page sent with its last call to `rpc`, or undefined. */
function lastArgs(network: HarnessNetwork, rpc: string): Record<string, unknown> | undefined {
  return network.rpcCalls.filter((c) => c.name === rpc).at(-1)?.args;
}

/** The caret at the end of a textarea, focused (as a tap at the end would leave it). */
async function caretToEnd(field: Locator): Promise<void> {
  await field.evaluate((el: HTMLTextAreaElement) => {
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
    el.dispatchEvent(new Event('select', { bubbles: true }));
    document.dispatchEvent(new Event('selectionchange'));
  });
}

/** Sends what the chat box holds and returns the new own bubble. */
async function sendFromBox(page: Page): Promise<Locator> {
  const before = await page.locator('[data-msg-id]').count();
  await chatBox(page).locator('[data-row-send]').click();
  await expect.poll(() => page.locator('[data-msg-id]').count()).toBe(before + 1);
  return page.locator('[data-msg-id]').last();
}

/** Long-press (touch) or right-click (mouse) a bubble: its action menu. */
async function openMessageMenu(page: Page, bubble: Locator): Promise<void> {
  await bubble.scrollIntoViewIfNeeded();
  const menu = page.getByRole('menu').or(page.getByRole('dialog')).first();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (!isPhone(page)) {
      await bubble.click({ button: 'right' });
    } else {
      const box = await bubble.boundingBox();
      if (box === null) throw new Error('bubble has no box');
      const at = { clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 };
      await bubble.dispatchEvent('pointerdown', { ...at, pointerType: 'touch', isPrimary: true });
      await page.waitForTimeout(HOLD_MS);
      await bubble.dispatchEvent('pointerup', { ...at, pointerType: 'touch', isPrimary: true });
    }
    if (await menu.isVisible().catch(() => false)) return;
  }
  await expect(menu).toBeVisible();
}

const LIST_BODY = '1. Hamper unboxing\n2. Lamp close-up\n3. Team toast';

test('S1 phone: Aa, Numbered list, three lines, send: an <ol> of three, preview "1. "', async ({
  page,
}) => {
  test.skip(!isPhone(page), 'phone only');
  const network = await installHarnessNetwork(page);
  await openChat(page, PEER_NAME);
  const box = chatBox(page);
  const field = chatField(page);
  await expect(box).toHaveAttribute('data-shape', 'pill');

  await field.click();
  await expect(box).toHaveAttribute('data-shape', 'card');
  await key(box, 'Aa').click();
  await expect(box.getByRole('toolbar', { name: 'Format' })).toBeVisible();
  // The format row is wider than a phone: it scrolls inside the box, and the
  // page never grows sideways (the thread and the box stay on screen).
  const overflow = await page.evaluate(() => ({
    page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    box: (() => {
      const r = document
        .querySelector('[data-writing-box][data-mode="chat"]')
        ?.getBoundingClientRect();
      return r === undefined ? 0 : r.right - window.innerWidth;
    })(),
  }));
  expect(overflow.page).toBeLessThanOrEqual(0);
  expect(overflow.box).toBeLessThanOrEqual(0);
  await key(box, 'Numbered list').scrollIntoViewIfNeeded();
  await key(box, 'Numbered list').click();
  await expect(field).toHaveValue('1. ');
  await expect(key(box, 'Numbered list')).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.type('Hamper unboxing');
  // Return on a phone continues the list.
  await page.keyboard.press('Enter');
  await expect(field).toHaveValue('1. Hamper unboxing\n2. ');
  await page.keyboard.type('Lamp close-up');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Team toast');
  await expect(field).toHaveValue(LIST_BODY);

  const bubble = await sendFromBox(page);
  expect(lastArgs(network, 'chat_message_send')?.p_body).toBe(LIST_BODY);
  const items = bubble.locator('[data-msg-body] ol > li');
  await expect(items).toHaveText(['Hamper unboxing', 'Lamp close-up', 'Team toast']);
  await expect(bubble.locator('[data-msg-body]')).not.toContainText('1. ');
  // Send closes the format row and empties the box.
  await expect(box.getByRole('toolbar', { name: 'Format' })).toHaveCount(0);
  await expect(field).toHaveValue('');

  // The chat list's preview keeps the raw prefix (after the sender label).
  await page.goto('/chat');
  const row = page.locator('[data-chat-list] [data-list-card]', { hasText: PEER_NAME }).first();
  await expect(row.locator('[data-list-card-preview]')).toHaveText(/^(You: )?1\. Hamper unboxing/);
  expectClean(network);
});

test('S2 phone: a quote, Add link and a bullet list render as blocks in the bubble', async ({
  page,
}) => {
  test.skip(!isPhone(page), 'phone only');
  const network = await installHarnessNetwork(page);
  await installLinkPreviewStub(page);
  await openChat(page, PEER_NAME);
  const box = chatBox(page);
  const field = chatField(page);

  await field.click();
  await key(box, 'Aa').click();
  await key(box, 'Quote').click();
  await expect(field).toHaveValue('> ');
  await page.keyboard.type('Can the hook land in 2 seconds?');
  // Return continues the quote; Return on the empty "> " line ends it.
  await page.keyboard.press('Enter');
  await expect(field).toHaveValue('> Can the hook land in 2 seconds?\n> ');
  await page.keyboard.press('Enter');
  await expect(field).toHaveValue('> Can the hook land in 2 seconds?\n');
  await page.keyboard.type('Brief is ');

  // Link with nothing selected: Add link opens with both fields empty.
  await key(box, 'Link').click();
  const sheet = page.getByRole('dialog', { name: 'Add link' });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByLabel('Text', { exact: true })).toHaveValue('');
  await sheet.getByLabel('Text', { exact: true }).fill('here');
  await sheet.getByLabel('Link', { exact: true }).fill(TEXT_URL);
  await sheet.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(sheet).toBeHidden();
  const withLink = `> Can the hook land in 2 seconds?\nBrief is [here](${TEXT_URL})`;
  await expect(field).toHaveValue(withLink);

  await caretToEnd(field);
  await page.keyboard.press('Enter');
  await key(box, 'Bullet list').click();
  await expect(field).toHaveValue(`${withLink}\n- `);
  await page.keyboard.type('Lid lift');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Logo');
  const body = `${withLink}\n- Lid lift\n- Logo`;
  await expect(field).toHaveValue(body);

  const bubble = await sendFromBox(page);
  expect(lastArgs(network, 'chat_message_send')?.p_body).toBe(body);
  const shown = bubble.locator('[data-msg-body]');
  await expect(shown.locator('.fmt-quote')).toHaveText('Can the hook land in 2 seconds?');
  await expect(shown.locator('ul > li')).toHaveText(['Lid lift', 'Logo']);
  await expect(shown.locator('[data-msg-link]')).toHaveText('here');
  await expect(shown).not.toContainText('](');
  expectClean(network);
});

test('S3 laptop: Cmd+B, Cmd+Shift+8, Cmd+K, emoji search "fire", Enter sends @desktop', async ({
  page,
}) => {
  test.skip(isPhone(page), 'laptop only');
  const network = await installHarnessNetwork(page);
  await openChat(page, PEER_NAME);
  const box = chatBox(page);
  const field = chatField(page);
  // The laptop box is the card always.
  await expect(box).toHaveAttribute('data-shape', 'card');

  await field.click();
  await field.fill('ship today');
  await field.evaluate((el: HTMLTextAreaElement) => {
    el.focus();
    el.setSelectionRange(5, 10);
  });
  await page.keyboard.press('ControlOrMeta+b');
  await expect(field).toHaveValue('ship *today*');

  await caretToEnd(field);
  // Shift+Return is the newline on a laptop (Return sends).
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.press('ControlOrMeta+Shift+Digit8');
  await expect(field).toHaveValue('ship *today*\n- ');
  await page.keyboard.type('Lid lift');

  // Cmd/Ctrl+K opens Add link; Cancel leaves the text as it was.
  await page.keyboard.press('ControlOrMeta+k');
  const linkSheet = page.getByRole('dialog', { name: 'Add link' });
  await expect(linkSheet).toBeVisible();
  await linkSheet.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(linkSheet).toBeHidden();
  await expect(field).toHaveValue('ship *today*\n- Lid lift');

  // Emoji: search "fire", pick it; on a laptop the sheet stays open.
  await caretToEnd(field);
  await key(box, 'Emoji').click();
  const emoji = page.locator('[data-emoji-sheet]');
  await expect(emoji).toBeVisible();
  await emoji.getByPlaceholder('Search emoji').fill('fire');
  await emoji.locator('[data-emoji-results] [data-emoji-cell="🔥"]').first().click();
  await expect(field).toHaveValue('ship *today*\n- Lid lift🔥');
  await page.keyboard.press('Escape');
  await expect(emoji).toBeHidden();
  await expect(field).toBeVisible();

  const before = await page.locator('[data-msg-id]').count();
  await caretToEnd(field);
  await page.keyboard.press('Enter');
  await expect.poll(() => page.locator('[data-msg-id]').count()).toBe(before + 1);
  expect(lastArgs(network, 'chat_message_send')?.p_body).toBe('ship *today*\n- Lid lift🔥');
  const bubble = page.locator('[data-msg-id]').last().locator('[data-msg-body]');
  await expect(bubble.locator('strong', { hasText: 'today' })).toBeVisible();
  await expect(bubble.locator('ul > li')).toHaveText(['Lid lift🔥']);
  await expect(field).toHaveValue('');
  expectClean(network);
});

test('S4 edit a sent list: the box shows the raw prefixes, Save edit renders a list', async ({
  page,
}) => {
  test.skip(!isPhone(page), 'phone only');
  const network = await installHarnessNetwork(page);
  await openChat(page, PEER_NAME);
  const box = chatBox(page);
  const field = chatField(page);

  await field.click();
  await field.fill('1. Alpha\n2. Beta');
  const bubble = await sendFromBox(page);
  await expect(bubble.locator('[data-msg-body] ol > li')).toHaveText(['Alpha', 'Beta']);

  await openMessageMenu(page, bubble.locator('[data-bubble]').first());
  await page.locator('[data-menu-item="edit"]').click();
  // Edit puts the stored text back: the raw prefixes, never the drawn list.
  await expect(field).toHaveValue('1. Alpha\n2. Beta');
  await expect(page.getByRole('button', { name: 'Cancel editing', exact: true })).toBeVisible();

  await caretToEnd(field);
  await page.keyboard.press('Enter');
  await expect(field).toHaveValue('1. Alpha\n2. Beta\n3. ');
  await page.keyboard.type('Gamma');
  await key(box, 'Save edit').click();
  await expect
    .poll(() => lastArgs(network, 'chat_message_edit')?.p_body)
    .toBe('1. Alpha\n2. Beta\n3. Gamma');
  await expect(bubble.locator('[data-msg-body] ol > li')).toHaveText(['Alpha', 'Beta', 'Gamma']);
  expectClean(network);
});

test('S5 New brief: the Objective bulleted from the field row; the brief shows the <ul>', async ({
  page,
}) => {
  test.skip(!isPhone(page), 'phone only');
  const network = await installHarnessNetwork(page);
  seedAudit(network, { role: 'approver' });
  await page.goto('/briefs');
  await page.getByRole('button', { name: 'New brief', exact: true }).first().click();
  const sheet = page.getByRole('dialog').first();
  await expect(sheet).toBeVisible();
  await sheet.locator('#brief-title').fill('Diwali week');

  const objective = sheet.locator('#brief-objective');
  // `has` is queried inside each box: root its locator at the page.
  const box = sheet.locator('[data-writing-box][data-mode="field"]', {
    has: page.locator('#brief-objective'),
  });
  // At rest a plain field: no row until it is focused.
  await expect(box.locator('[data-writing-row]')).toHaveCount(0);
  await objective.click();
  await expect(box.locator('[data-writing-row]')).toBeVisible();
  // Field mode: the format keys and emoji, never + or send.
  await expect(key(box, 'Add attachment')).toHaveCount(0);
  await expect(box.locator('[data-row-send]')).toHaveCount(0);
  await key(box, 'Bullet list').click();
  await expect(objective).toHaveValue('- ');
  await page.keyboard.type('Lift hamper sales');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Grow followers');
  const body = '- Lift hamper sales\n- Grow followers';
  await expect(objective).toHaveValue(body);

  await sheet.getByRole('button', { name: 'Create brief', exact: true }).click();
  await expect
    .poll(
      () =>
        (lastArgs(network, 'brief_create')?.p_payload as { objective?: string } | undefined)
          ?.objective,
    )
    .toBe(body);
  const created = (network.world.tables.briefs ?? []).find((b) => b.title === 'Diwali week');
  expect(created).toBeDefined();

  await page.goto(`/briefs/${String(created?.id)}`);
  await expect(page.getByRole('heading', { name: 'Diwali week', level: 1 })).toBeVisible();
  const section = page.locator('section', { hasText: 'Objective' }).first();
  await expect(section.locator('ul > li')).toHaveText(['Lift hamper sales', 'Grow followers']);
  expectClean(network);
});

test('S6 a plan item comment: a mention chip inside a bullet', async ({ page }) => {
  test.skip(!isPhone(page), 'phone only');
  test.setTimeout(90_000);
  const network = await installHarnessNetwork(page);
  seedDatedPlan(network.world, { channelId: DM_CHANNEL, sender: ME });
  await openChat(page, PEER_NAME);
  const card = page.locator(`[data-plan-card="${DATED_PLAN_ID}"]`);
  await card.scrollIntoViewIfNeeded();
  await card.locator('[data-plan-open]').click();
  const plan = page.locator('[data-plan-page="plan"]');
  await expect(plan.locator('[data-plan-row]').first()).toBeVisible();
  const target = DATED_PLAN_ITEMS.find((it) => it.title === 'Recipe carousel');
  if (target === undefined) throw new Error('fixture');
  await plan.locator(`[data-plan-row="${target.id}"]`).click();
  const item = page.locator('[data-plan-page="item"]');
  await expect(item).toBeVisible();

  const comment = item.getByRole('textbox', { name: 'Comment' });
  await comment.scrollIntoViewIfNeeded();
  await comment.click();
  // `has` is queried inside each box: a page-rooted locator for the field.
  const box = item.locator('[data-writing-box]', {
    has: page.getByRole('textbox', { name: 'Comment' }),
  });
  await key(box, 'Bullet list').click();
  await expect(comment).toHaveValue('- ');
  await page.keyboard.type('@Le');
  const option = page.locator(`[data-mention-option="${COLLEAGUE_A}"]`);
  await expect(option).toBeVisible();
  await option.click();
  await page.keyboard.type('can you check the hook?');
  await item.getByRole('button', { name: 'Send comment', exact: true }).click();

  await expect
    .poll(() => String(lastArgs(network, 'plan_item_comment_create')?.p_body ?? ''))
    .toMatch(/^- /);
  const posted = item.locator('[data-plan-comment-bubble]', { hasText: 'can you check the hook?' });
  await expect(posted.locator(`ul > li [data-plan-mention="${COLLEAGUE_A}"]`)).toBeVisible();
  await expect(posted).not.toContainText('- ');
  expectClean(network);
});

test('S7 phone: the idle pill shows the mic', async ({ page }) => {
  test.skip(!isPhone(page), 'phone only');
  const network = await installHarnessNetwork(page);
  await openChat(page, PEER_NAME);
  const box = chatBox(page);
  await expect(box).toHaveAttribute('data-shape', 'pill');
  await expect(key(box, 'Record voice note')).toBeVisible();
  await expect(key(box, 'Add attachment')).toBeVisible();
  await expect(box.locator('[data-writing-row]')).toHaveCount(0);
  expectClean(network);
});

test('S7 laptop: the card shows the mic while empty, Send once typed @desktop', async ({
  page,
}) => {
  test.skip(isPhone(page), 'laptop only');
  const network = await installHarnessNetwork(page);
  await openChat(page, PEER_NAME);
  const box = chatBox(page);
  const field = chatField(page);
  await expect(box).toHaveAttribute('data-shape', 'card');
  await expect(key(box, 'Record voice note')).toBeVisible();
  await expect(box.locator('[data-row-send]')).toHaveCount(0);
  await field.click();
  await field.fill('On it');
  await expect(box.locator('[data-row-send]')).toBeEnabled();
  await expect(key(box, 'Record voice note')).toHaveCount(0);
  await field.fill('');
  await expect(key(box, 'Record voice note')).toBeVisible();
  expectClean(network);
});

test('S8 the + drawer from the card still opens its pickers', async ({ page }) => {
  test.skip(!isPhone(page), 'phone only');
  const network = await installHarnessNetwork(page);
  await openChat(page, PEER_NAME);
  const box = chatBox(page);
  const field = chatField(page);
  await field.click();
  await field.fill('Files for the cut');
  await expect(box).toHaveAttribute('data-shape', 'card');

  const pickers: Array<[tile: string, dialog: string]> = [
    ['post', 'Share a post'],
    ['brief', 'Share a brief'],
    ['assets', 'Add from Assets'],
  ];
  for (const [tile, dialog] of pickers) {
    const plus = key(box, 'Add attachment');
    test.skip((await plus.count()) === 0, 'no upload endpoint in this env: the plus tray is off');
    await plus.click();
    await expect(page.locator('[data-tray]')).toBeVisible();
    await page.locator(`[data-tray-tile="${tile}"]`).click();
    const sheet = page.getByRole('dialog', { name: dialog });
    await expect(sheet).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
  }
  // The draft rode through every picker.
  await expect(field).toHaveValue('Files for the cut');
  expectClean(network);
});

test('S9 phone: expand, ten lines, collapse keeps the text, expand, send closes it', async ({
  page,
}) => {
  test.skip(!isPhone(page), 'phone only');
  const network = await installHarnessNetwork(page);
  await openChat(page, PEER_NAME);
  const root = page.locator('[data-writing-box][data-mode="chat"]');
  const box = chatBox(page);
  const field = chatField(page);
  await field.click();
  await page.keyboard.type('Line 1');
  await key(box, 'Expand').click();
  await expect(root).toHaveAttribute('data-expanded', 'phone');
  await expect(page.locator('[data-expanded-bar]')).toBeVisible();
  // The editor covers the whole screen width from the top, nothing cut: it
  // lives on <body> while expanded, out of any clipping or moving ancestor.
  const editor = await page.evaluate(() => {
    const el = document.querySelector('[data-writing-box][data-expanded="phone"]');
    const r = el?.getBoundingClientRect();
    return {
      onBody: el?.closest('[data-writing-host]')?.parentElement === document.body,
      left: r?.left ?? -1,
      top: r?.top ?? -1,
      right: r?.right ?? 0,
      height: r?.height ?? 0,
      width: window.innerWidth,
      viewH: window.visualViewport?.height ?? window.innerHeight,
    };
  });
  expect(editor.onBody).toBe(true);
  expect(editor.left).toBe(0);
  expect(editor.top).toBe(0);
  expect(Math.round(editor.right)).toBe(editor.width);
  expect(editor.height).toBeGreaterThan(editor.viewH * 0.5);
  // The same field: the text and the caret stayed.
  await expect(field).toHaveValue('Line 1');
  await expect(field).toBeFocused();

  for (let n = 2; n <= 10; n += 1) {
    await page.keyboard.press('Enter');
    await page.keyboard.type(`Line ${n}`);
  }
  const ten = Array.from({ length: 10 }, (_, i) => `Line ${i + 1}`).join('\n');
  await expect(field).toHaveValue(ten);

  await key(page.locator('[data-expanded-bar]'), 'Collapse').click();
  await expect(root).not.toHaveAttribute('data-expanded', /.+/);
  await expect(field).toHaveValue(ten);

  await key(box, 'Expand').click();
  await expect(root).toHaveAttribute('data-expanded', 'phone');
  const bubble = await sendFromBox(page);
  await expect(root).not.toHaveAttribute('data-expanded', /.+/);
  await expect(bubble.locator('[data-msg-body]')).toContainText('Line 10');
  expect(lastArgs(network, 'chat_message_send')?.p_body).toBe(ten);
  await expect(field).toHaveValue('');
  expectClean(network);
});

test('S10 the caption: emoji and "@brandname" through the @ key, no Aa, saved exact', async ({
  page,
}) => {
  test.skip(!isPhone(page), 'phone only');
  const network = await installHarnessNetwork(page);
  await page.goto('/pipeline');
  await page.getByRole('button', { name: 'New post', exact: true }).first().click();
  const sheet = page.getByRole('dialog').first();
  await expect(sheet).toBeVisible();
  await sheet.locator('#post-title').fill('Hamper week');

  const caption = sheet.locator('#post-caption');
  const box = sheet.locator('[data-writing-box][data-mode="caption"]');
  await caption.click();
  await expect(key(box, 'Emoji')).toBeVisible();
  await expect(key(box, 'Mention')).toBeVisible();
  // Captions never format: no Aa, no format row, no shortcut.
  await expect(box.getByRole('button', { name: 'Aa', exact: true })).toHaveCount(0);
  await expect(box.getByRole('toolbar', { name: 'Format' })).toHaveCount(0);
  await page.keyboard.type('Hamper week ');

  await key(box, 'Emoji').click();
  const emoji = page.locator('[data-emoji-sheet]');
  await expect(emoji).toBeVisible();
  await emoji.getByPlaceholder('Search emoji').fill('fire');
  await emoji.locator('[data-emoji-results] [data-emoji-cell="🔥"]').first().click();
  // A phone closes the sheet on a pick.
  await expect(emoji).toBeHidden();
  await expect(caption).toHaveValue('Hamper week 🔥');

  await caretToEnd(caption);
  await page.keyboard.type(' ');
  await key(box, 'Mention').click();
  await expect(caption).toHaveValue('Hamper week 🔥 @');
  await page.keyboard.type('brandname');
  const text = 'Hamper week 🔥 @brandname';
  await expect(caption).toHaveValue(text);
  await page.keyboard.press('ControlOrMeta+b');
  await expect(caption).toHaveValue(text);

  await sheet.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect
    .poll(
      () =>
        (lastArgs(network, 'post_create')?.p_payload as { caption?: string } | undefined)?.caption,
    )
    .toBe(text);
  expectClean(network);
});

test('S11 phone: the post comment box stays on screen and its @ list opens above it', async ({
  page,
}) => {
  test.skip(!isPhone(page), 'phone only');
  await installHarnessNetwork(page);
  await page.goto(`/posts/${POST_IDS[0] ?? ''}`);
  const composer = page.locator('[data-comments-composer]');
  const editor = composer.getByRole('textbox', { name: 'Comment body' });
  await editor.scrollIntoViewIfNeeded();
  await editor.click();
  const box = composer.locator('[data-writing-box]').first();
  await expect(box).toHaveAttribute('data-shape', 'card');
  await page.keyboard.type('@');

  // The page never grows sideways and the box sits inside the screen.
  const geometry = await page.evaluate(() => {
    const boxEl = document.querySelector('[data-comments-composer] [data-writing-box]');
    const list = document.querySelector('[data-comments-composer] [data-mention-list]');
    const field = document.querySelector('[data-comments-composer] [contenteditable="true"]');
    const r = (el: Element | null): DOMRect | null => el?.getBoundingClientRect() ?? null;
    return {
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      width: window.innerWidth,
      box: r(boxEl),
      list: r(list),
      field: r(field),
    };
  });
  expect(geometry.overflow).toBeLessThanOrEqual(0);
  expect(geometry.box?.left ?? -1).toBeGreaterThanOrEqual(0);
  expect(geometry.box?.right ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(geometry.width);
  // The list (when members match) opens above the field, never under the box.
  if (geometry.list !== null && geometry.field !== null) {
    expect(geometry.list.bottom).toBeLessThanOrEqual(geometry.field.top);
    expect(geometry.list.top).toBeGreaterThanOrEqual(0);
  }
});
