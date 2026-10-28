import { expect, test, type Locator, type Page } from '@playwright/test';
import { installHarnessNetwork } from '../fixtures/harness-routes';
import { MAYA_NAME, PEER_NAME } from '../fixtures/chat-data';

// Decision 128: every Reply puts the cursor in the composer at once (long-press
// menu, swipe right, laptop chevron, right-click, a card hold or the sheet's
// Talk about, Reply in the thread view), so typing lands there with no extra
// tap. Decision 32 holds: opening a chat on touch focuses nothing.
// Linux WebKit approximates iOS WebKit (it never shows a keyboard); it is not iOS.

const PEER_LINE = 'Can we tighten the hook on slide one?';

const composer = (page: Page): Locator => page.locator('form textarea').first();
const bubble = (page: Page): Locator =>
  page.locator('[data-bubble]', { hasText: PEER_LINE }).last();

async function openDm(page: Page): Promise<void> {
  await installHarnessNetwork(page);
  await page.goto('/chat');
  await page.getByText(PEER_NAME, { exact: true }).first().click();
  await bubble(page).waitFor({ state: 'visible' });
  await page.waitForTimeout(300);
}

/** Wait until the list stops scrolling: a scroll closes the action menu. */
async function settle(page: Page, target: Locator = bubble(page)): Promise<void> {
  await target.scrollIntoViewIfNeeded();
  let last = -1;
  await expect
    .poll(
      async () => {
        const top = await page.evaluate(
          () => document.querySelector('[data-msg-id]')?.closest('ul')?.scrollTop ?? 0,
        );
        const still = top === last;
        last = top;
        return still;
      },
      { intervals: [250] },
    )
    .toBe(true);
}

async function centre(target: Locator): Promise<{ clientX: number; clientY: number }> {
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (box === null) throw new Error('no box');
  return { clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 };
}

/** Hold a bubble like a finger: pointerdown, 700ms still, pointerup. */
async function holdBubble(page: Page): Promise<void> {
  const at = await centre(bubble(page));
  const touch = { ...at, pointerType: 'touch', isPrimary: true, pointerId: 7 };
  await bubble(page).dispatchEvent('pointerdown', touch);
  await page.waitForTimeout(700);
  await bubble(page).dispatchEvent('pointerup', touch);
}

/** Swipe a bubble right past the trigger, then lift. */
async function swipeBubble(page: Page): Promise<void> {
  const target = bubble(page);
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (box === null) throw new Error('no box');
  const y = box.y + box.height / 2;
  const x0 = Math.max(box.x + 24, 40);
  const ev = (x: number) => ({
    clientX: x,
    clientY: y,
    pointerType: 'touch',
    isPrimary: true,
    pointerId: 9,
  });
  await target.dispatchEvent('pointerdown', ev(x0));
  for (const dx of [10, 30, 50, 70, 90, 100]) {
    await target.dispatchEvent('pointermove', ev(x0 + dx));
    await page.waitForTimeout(16);
  }
  await target.dispatchEvent('pointerup', ev(x0 + 100));
}

/** Pick Reply in the open action menu. */
async function menuReply(page: Page): Promise<void> {
  const menu = page.getByRole('menu', { name: 'Message actions' });
  await expect(menu).toBeVisible();
  await menu.locator('[data-menu-item="reply"]').click();
  await expect(menu).toHaveCount(0);
}

/** Distance (px) from the list's bottom edge. */
async function fromBottom(page: Page): Promise<number> {
  return page.evaluate(() => {
    const list = document.querySelector('[data-msg-id]')?.closest('ul');
    if (!list) return 0;
    return list.scrollHeight - list.scrollTop - list.clientHeight;
  });
}

/** The composer owns focus, with the caret at the end of its text. */
async function expectFocusedAtEnd(page: Page): Promise<void> {
  const state = await composer(page).evaluate((el) => {
    const area = el as HTMLTextAreaElement;
    return {
      focused: document.activeElement === area,
      caret: area.selectionStart,
      end: area.selectionEnd,
      length: area.value.length,
    };
  });
  expect(state.focused, 'composer textarea is document.activeElement').toBe(true);
  expect(state.caret).toBe(state.length);
  expect(state.end).toBe(state.length);
}

/** Type with the keyboard only (no click): the text must land in the composer. */
async function typeLands(page: Page, before: string): Promise<void> {
  await page.keyboard.type('hi');
  await expect(composer(page)).toHaveValue(`${before}hi`);
  await expect(composer(page)).toHaveAttribute('placeholder', /^Reply/);
}

/** Leave a draft in the composer, then move focus away from it. */
async function leaveDraft(page: Page, draft: string): Promise<void> {
  await composer(page).fill(draft);
  await composer(page).evaluate((el) => (el as HTMLTextAreaElement).blur());
  await expect(composer(page)).not.toBeFocused();
}

test.describe('iPhone', () => {
  test('long-press Reply focuses the composer, draft kept, caret at end', async ({ page }) => {
    await openDm(page);
    // Decision 32: opening a chat on touch never focuses the composer.
    await expect(composer(page)).not.toBeFocused();
    await leaveDraft(page, 'draft ');
    await settle(page);
    const pinnedBefore = (await fromBottom(page)) <= 48;
    await holdBubble(page);
    await menuReply(page);
    await expectFocusedAtEnd(page);
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(page.locator('[data-selection-bar]')).toHaveCount(0);
    if (pinnedBefore) expect(await fromBottom(page)).toBeLessThanOrEqual(48);
    await typeLands(page, 'draft ');
  });

  test('swipe right focuses the composer and typing lands there', async ({ page }) => {
    await openDm(page);
    await expect(composer(page)).not.toBeFocused();
    await settle(page);
    await swipeBubble(page);
    await expect(composer(page)).toHaveAttribute('placeholder', /^Reply/);
    await expectFocusedAtEnd(page);
    await expect(page.getByRole('menu')).toHaveCount(0);
    await typeLands(page, '');
  });
});

async function openMaya(page: Page): Promise<void> {
  await installHarnessNetwork(page);
  await page.goto('/chat');
  await page.getByText(MAYA_NAME, { exact: true }).first().click();
  await page.locator('[data-msg-id]').first().waitFor({ state: 'visible', timeout: 8000 });
  await page.waitForTimeout(300);
}

/** A real mouse click whose pointer drifts dx px (3 to 6) between down and up. */
async function driftClick(page: Page, target: Locator, dx: number): Promise<void> {
  const { clientX, clientY } = await centre(target);
  await page.mouse.move(clientX, clientY);
  await page.mouse.down();
  await page.mouse.move(clientX + dx, clientY + 1, { steps: 3 });
  await page.mouse.up();
}

/** Pick Reply in the open menu with a drifting mouse. */
async function driftMenuReply(page: Page, dx: number): Promise<void> {
  const menu = page.getByRole('menu', { name: 'Message actions' });
  await expect(menu).toBeVisible();
  await driftClick(page, menu.locator('[data-menu-item="reply"]'), dx);
  await expect(menu).toHaveCount(0);
}

test.describe('laptop', () => {
  test.use({
    viewport: { width: 1280, height: 800 },
    isMobile: false,
    hasTouch: false,
    deviceScaleFactor: 1,
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  });

  test('hover chevron Reply focuses the composer', async ({ page }) => {
    await openDm(page);
    await leaveDraft(page, 'draft ');
    await settle(page);
    await bubble(page).hover();
    await bubble(page).locator('[data-more]').click();
    await menuReply(page);
    await expectFocusedAtEnd(page);
    await typeLands(page, 'draft ');
  });

  test('right-click Reply focuses the composer', async ({ page }) => {
    await openDm(page);
    await leaveDraft(page, '');
    await settle(page);
    await bubble(page).click({ button: 'right' });
    await menuReply(page);
    await expectFocusedAtEnd(page);
    await typeLands(page, '');
  });

  test('hover chevron Reply with a drifting mouse focuses the composer', async ({ page }) => {
    await openDm(page);
    await leaveDraft(page, 'draft ');
    await settle(page);
    await bubble(page).hover();
    await driftClick(page, bubble(page).locator('[data-more]'), 3);
    await driftMenuReply(page, 5);
    await expectFocusedAtEnd(page);
    await typeLands(page, 'draft ');
  });

  test('right-click Reply with a drifting mouse focuses the composer', async ({ page }) => {
    await openDm(page);
    await leaveDraft(page, '');
    await settle(page);
    await bubble(page).click({ button: 'right' });
    await driftMenuReply(page, 6);
    await expectFocusedAtEnd(page);
    await typeLands(page, '');
  });

  test('card hold released on the card: focus, and its click never opens the sheet', async ({
    page,
  }) => {
    await openMaya(page);
    await leaveDraft(page, '');
    const card = page.locator('[role="button"][aria-label^="Open post"]').last();
    await settle(page, card);
    const { clientX, clientY } = await centre(card);
    await page.mouse.move(clientX, clientY);
    await page.mouse.down();
    await page.mouse.move(clientX + 3, clientY + 1, { steps: 2 });
    await page.waitForTimeout(700);
    await page.mouse.up();
    await page.waitForTimeout(300);
    await expect(page.getByRole('button', { name: /^Talk about/ })).toHaveCount(0);
    await expectFocusedAtEnd(page);
  });

  test('card hold with the mouse moved off the card still focuses the composer', async ({
    page,
  }) => {
    await openMaya(page);
    await leaveDraft(page, 'about ');
    const card = page.locator('[role="button"][aria-label^="Open post"]').last();
    await settle(page, card);
    const { clientX, clientY } = await centre(card);
    await page.mouse.move(clientX, clientY);
    await page.mouse.down();
    await page.mouse.move(clientX + 4, clientY + 2, { steps: 2 });
    await page.waitForTimeout(700);
    const box = await card.boundingBox();
    if (box === null) throw new Error('no box');
    await page.mouse.move(box.x + box.width + 40, box.y - 40, { steps: 4 });
    await page.mouse.up();
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(page.locator('[role="dialog"]')).toHaveCount(0);
    await expectFocusedAtEnd(page);
    await expect(composer(page)).toHaveValue('about ');
    // The next plain click on that card still opens its sheet.
    await card.click();
    await expect(page.getByRole('button', { name: /^Talk about/ })).toBeVisible();
  });
});

test.describe('iPhone, cards and threads', () => {
  /**
   * Hold like a finger: pointerdown, 700ms still, pointerup on the same target.
   * The caller settled the target in view; no second scroll here, since any
   * scroll during the hold cancels it (a post card is a tall fixed box, so a
   * re-scroll would land inside the hold).
   */
  async function hold(page: Page, target: Locator): Promise<void> {
    const box = await target.boundingBox();
    if (box === null) throw new Error('no box');
    const at = { clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 };
    const touch = { ...at, pointerType: 'touch', isPrimary: true, pointerId: 11 };
    await target.dispatchEvent('pointerdown', touch);
    await page.waitForTimeout(700);
    await target.dispatchEvent('pointerup', touch);
  }

  test('card hold Talk about focuses the composer on release', async ({ page }) => {
    await openMaya(page);
    await expect(composer(page)).not.toBeFocused();
    const card = page.locator('[role="button"][aria-label^="Open post"]').last();
    await settle(page, card);
    await hold(page, card);
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expectFocusedAtEnd(page);
  });

  test('sheet Talk about focuses the composer', async ({ page }) => {
    await openMaya(page);
    const card = page.locator('[role="button"][aria-label^="Open post"]').last();
    await settle(page, card);
    await card.click();
    const talk = page.getByRole('button', { name: /^Talk about/ });
    await expect(talk).toBeVisible();
    await talk.click();
    await expect(talk).toHaveCount(0);
    await expectFocusedAtEnd(page);
  });

  test('Reply inside the thread view focuses the view composer', async ({ page }) => {
    await openMaya(page);
    await page.locator('[data-thread-open="replies"]', { hasText: '4 replies' }).click();
    const view = page.locator('[data-thread-view]');
    await expect(view).toHaveCSS('opacity', '1');
    const input = view.getByPlaceholder('Reply in thread');
    await input.evaluate((el) => (el as HTMLTextAreaElement).blur());
    const member = view.locator('li[data-msg-id] [data-bubble]').last();
    await settle(page, member);
    await hold(page, member);
    await menuReply(page);
    const focused = await view
      .locator('form textarea')
      .evaluate((el) => document.activeElement === el);
    expect(focused, 'thread view composer is document.activeElement').toBe(true);
    await page.keyboard.type('hi');
    await expect(view.locator('form textarea')).toHaveValue('hi');
  });
});
