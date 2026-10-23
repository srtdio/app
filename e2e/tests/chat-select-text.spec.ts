import { expect, test, type Locator, type Page } from '@playwright/test';
import { expectMinTouchTarget } from '../helpers/touch-target';
import { installHarnessNetwork } from '../fixtures/harness-routes';
import { MENTION_PREVIEW, PEER_NAME } from '../fixtures/chat-data';

// The long-press menu's Select: one message's body text becomes selectable in
// place (iMessage style), the whole body selected at once; every other bubble
// stays unselectable. The menu always opens below the held bubble (WhatsApp
// style). Runs in both theme projects (dark and light) for parity. Linux
// WebKit approximates iOS WebKit; it is not iOS.

const PEER_LINE = 'Can we tighten the hook on slide one?';

const list = (page: Page): Locator => page.locator('ul:has([data-msg-id])').first();
const bubbleWith = (page: Page, text: string): Locator =>
  page.locator('[data-bubble]', { hasText: text }).last();
const menu = (page: Page): Locator => page.getByRole('menu', { name: 'Message actions' });

async function openDm(page: Page): Promise<void> {
  await installHarnessNetwork(page);
  await page.goto('/chat');
  await page.getByText(PEER_NAME, { exact: true }).first().click();
  await bubbleWith(page, PEER_LINE).waitFor({ state: 'visible' });
  await page.waitForTimeout(300);
}

/** Wait until the list stops scrolling: a scroll closes the action menu. */
async function settle(page: Page, target: Locator): Promise<void> {
  await target.scrollIntoViewIfNeeded();
  let last = -1;
  await expect
    .poll(
      async () => {
        const top = await list(page).evaluate((el) => el.scrollTop);
        const still = top === last;
        last = top;
        return still;
      },
      { intervals: [250] },
    )
    .toBe(true);
}

/** Hold a bubble like a finger: pointerdown, 700ms still, pointerup. */
async function hold(page: Page, target: Locator): Promise<void> {
  await settle(page, target);
  const box = await target.boundingBox();
  if (box === null) throw new Error('no box');
  const at = {
    clientX: box.x + box.width / 2,
    clientY: box.y + Math.min(box.height / 2, 20),
    pointerType: 'touch',
    isPrimary: true,
    pointerId: 7,
  };
  await target.dispatchEvent('pointerdown', at);
  await page.waitForTimeout(700);
  await target.dispatchEvent('pointerup', at);
  await expect(menu(page)).toBeVisible();
}

/** The body's displayed text: its text minus the invisible meta spacer. */
async function displayedBody(target: Locator): Promise<string> {
  return target.locator('[data-msg-body]').evaluate((el) => {
    const copy = el.cloneNode(true) as HTMLElement;
    copy.querySelector('[data-meta-spacer]')?.remove();
    return copy.textContent ?? '';
  });
}

async function selectionText(page: Page): Promise<string> {
  return page.evaluate(() => window.getSelection()?.toString() ?? '');
}

/** Computed user-select (WebKit reports it under the prefixed name). */
async function userSelect(target: Locator): Promise<string> {
  return target.evaluate((el) => {
    const style = getComputedStyle(el) as CSSStyleDeclaration & { webkitUserSelect?: string };
    return style.userSelect !== '' ? style.userSelect : (style.webkitUserSelect ?? '');
  });
}

/** Select sits under More. */
async function openMore(page: Page): Promise<void> {
  await menu(page).locator('[data-menu-item="more"]').click();
  await expect(menu(page).locator('[data-menu-item="back"]')).toBeVisible();
}

async function pickSelect(page: Page): Promise<void> {
  await openMore(page);
  await menu(page).locator('[data-menu-item="select-text"]').click();
  await expect(menu(page)).toHaveCount(0);
}

/** Menu style in the current theme: radius 18, 1px border-border, icons in the row ink. */
async function expectMenuStyle(page: Page): Promise<void> {
  // Let the entrance scale finish so sizes read at 1.
  await page.waitForTimeout(400);
  const style = await menu(page).evaluate((panel) => {
    const probe = document.createElement('div');
    probe.className = 'border border-border text-fg';
    document.body.appendChild(probe);
    const ref = getComputedStyle(probe);
    const panelStyle = getComputedStyle(panel);
    const rows = Array.from(panel.querySelectorAll<HTMLElement>('[data-menu-item]'))
      .filter((row) => row.getAttribute('data-menu-item') !== 'delete')
      .filter((row) => !row.getAttribute('data-menu-item')?.startsWith('react'));
    const icons = rows.map((row) => {
      const svg = row.querySelector('[data-menu-icon] svg');
      return {
        row: getComputedStyle(row).color,
        icon: svg !== null ? getComputedStyle(svg).color : '',
        width: svg?.getAttribute('width') ?? '',
        height: row.getBoundingClientRect().height,
      };
    });
    const cells = Array.from(
      panel.querySelectorAll<HTMLElement>('[data-menu-reactions] button'),
    ).map((b) => b.getBoundingClientRect());
    const out = {
      radius: panelStyle.borderTopLeftRadius,
      borderWidth: panelStyle.borderTopWidth,
      borderColor: panelStyle.borderTopColor,
      refBorder: ref.borderTopColor,
      fg: ref.color,
      icons,
      cells: cells.map((r) => ({ width: r.width, height: r.height })),
    };
    probe.remove();
    return out;
  });
  expect(style.radius).toBe('18px');
  expect(style.borderWidth).toBe('1px');
  expect(style.borderColor).toBe(style.refBorder);
  expect(style.icons.length).toBeGreaterThan(3);
  for (const icon of style.icons) {
    expect(icon.icon).toBe(icon.row);
    expect(icon.row).toBe(style.fg);
    expect(icon.width).toBe('22');
    expectMinTouchTarget({ height: icon.height }, { dimension: 'height' });
  }
  expect(style.cells).toHaveLength(6);
  for (const cell of style.cells) expectMinTouchTarget(cell);
}

test.describe('iPhone', () => {
  test('menu opens below the bottom-most bubble, styled from tokens', async ({ page }) => {
    await openDm(page);
    const last = page.locator('[data-msg-id]:has([data-msg-body]) [data-bubble]').last();
    await hold(page, last);
    await page.waitForTimeout(400);
    const held = await page.locator('[data-menu-held]').boundingBox();
    const panel = await menu(page).boundingBox();
    if (held === null || panel === null) throw new Error('no box');
    expect(panel.y).toBeGreaterThanOrEqual(held.y + held.height);
    const viewport = page.viewportSize();
    if (viewport !== null) expect(panel.y + panel.height).toBeLessThanOrEqual(viewport.height);
    await expectMenuStyle(page);
    await openMore(page);
    await expect(menu(page).locator('[data-menu-item="select-text"]')).toBeVisible();
    await expect(menu(page).locator('[data-menu-item="select"]')).toHaveCount(0);
  });

  test('Select selects the displayed body; only that body is selectable; tap outside clears', async ({
    page,
  }) => {
    await openDm(page);
    const target = bubbleWith(page, MENTION_PREVIEW);
    await hold(page, target);
    await pickSelect(page);
    const displayed = await displayedBody(target);
    expect(displayed).toContain(MENTION_PREVIEW);
    expect(displayed).not.toContain('@[');
    expect((await selectionText(page)).trim()).toBe(displayed.trim());
    expect(await userSelect(target.locator('[data-msg-body]'))).toBe('text');
    // Every bubble and the list are user-select none. Every other body is not
    // made selectable: its computed value is none (Chromium) or auto (WebKit
    // does not inherit the value; per CSS, auto inside a none box acts as
    // none). Only the active body is text.
    const state = await page.evaluate(() => {
      const read = (el: Element): string => {
        const s = getComputedStyle(el) as CSSStyleDeclaration & { webkitUserSelect?: string };
        return s.userSelect !== '' ? s.userSelect : (s.webkitUserSelect ?? '');
      };
      const bubbles = Array.from(document.querySelectorAll('[data-bubble]'));
      const list = document.querySelector('[data-msg-id]')?.closest('ul');
      return {
        list: list != null ? read(list) : '',
        bubbles: bubbles.map(read),
        textBodies: bubbles
          .map((b) => b.querySelector('[data-msg-body]'))
          .filter((body): body is Element => body !== null && read(body) === 'text').length,
        otherBodies: bubbles
          .map((b) => b.querySelector('[data-msg-body]'))
          .filter((body) => body !== null && !body.hasAttribute('data-selecting-text'))
          .map((body) => (body !== null ? read(body) : '')),
      };
    });
    expect(state.list).toBe('none');
    expect(new Set(state.bubbles)).toEqual(new Set(['none']));
    expect(state.textBodies).toBe(1);
    expect(state.otherBodies.length).toBeGreaterThan(3);
    for (const value of state.otherBodies) expect(['none', 'auto']).toContain(value);
    // Tap outside: the selection and the selectable body go.
    const other = bubbleWith(page, PEER_LINE);
    const box = await other.boundingBox();
    if (box === null) throw new Error('no box');
    await page.mouse.click(box.x + 8, box.y + box.height / 2);
    await expect(page.locator('[data-selecting-text]')).toHaveCount(0);
    expect(await selectionText(page)).toBe('');
    expect(['none', 'auto']).toContain(await userSelect(target.locator('[data-msg-body]')));
    expect(await userSelect(target)).toBe('none');
  });

  test('selection stays while the user takes their time and drags the handles', async ({
    page,
  }) => {
    await openDm(page);
    const target = bubbleWith(page, MENTION_PREVIEW);
    await hold(page, target);
    await pickSelect(page);
    const displayed = (await displayedBody(target)).trim();
    expect((await selectionText(page)).trim()).toBe(displayed);
    // Taking their time: nothing ends it on its own.
    await page.waitForTimeout(2500);
    await expect(page.locator('[data-selecting-text]')).toHaveCount(1);
    expect((await selectionText(page)).trim()).toBe(displayed);
    const body = await target.locator('[data-msg-body]').boundingBox();
    if (body === null) throw new Error('no box');
    const touch = (x: number, y: number) => ({
      clientX: x,
      clientY: y,
      pointerType: 'touch',
      isPrimary: true,
      pointerId: 11,
      bubbles: true,
    });
    // Grab the end handle's knob just under the last line (outside the text)
    // and drag it up and back, slowly: a drag never ends Select.
    const knobX = body.x + body.width - 4;
    const knobY = body.y + body.height + 12;
    await target.dispatchEvent('pointerdown', touch(knobX, knobY));
    for (const dy of [-4, -10, -16, -10, -4]) {
      await target.dispatchEvent('pointermove', touch(knobX - 20, knobY + dy));
      await page.waitForTimeout(150);
    }
    await target.dispatchEvent('pointerup', touch(knobX - 20, knobY - 4));
    await expect(page.locator('[data-selecting-text]')).toHaveCount(1);
    // iOS cancels the page's press when its native handle drag takes over.
    await target.dispatchEvent('pointerdown', touch(knobX, knobY));
    await target.dispatchEvent('pointercancel', touch(knobX, knobY));
    // A tap on the handle itself (still, just outside the text) keeps it too.
    await target.dispatchEvent('pointerdown', touch(body.x - 10, body.y - 10));
    await target.dispatchEvent('pointerup', touch(body.x - 10, body.y - 10));
    await page.waitForTimeout(300);
    await expect(page.locator('[data-selecting-text]')).toHaveCount(1);
    expect((await selectionText(page)).trim()).toBe(displayed);
  });

  test('back leaves text selection and stays in the chat', async ({ page }) => {
    await openDm(page);
    const target = bubbleWith(page, PEER_LINE);
    await hold(page, target);
    await pickSelect(page);
    await expect(page.locator('[data-selecting-text]')).toHaveCount(1);
    await page.goBack();
    await expect(page.locator('[data-selecting-text]')).toHaveCount(0);
    expect(await selectionText(page)).toBe('');
    await expect(target).toBeVisible();
  });

  test('Forward still opens multi-select with the message ticked', async ({ page }) => {
    await openDm(page);
    const target = bubbleWith(page, PEER_LINE);
    await hold(page, target);
    await menu(page).locator('[data-menu-item="forward"]').click();
    await expect(page.locator('[data-selection-bar]')).toBeVisible();
    await expect(page.locator('[data-msg-id][data-checked]', { hasText: PEER_LINE })).toHaveCount(
      1,
    );
  });

  test('Delete on a text message goes behind Undo (no confirm), no multi-select', async ({
    page,
  }) => {
    await openDm(page);
    const line = 'Fresh line to delete';
    await page.locator('form textarea').first().fill(line);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    const row = page.locator('[data-msg-id][data-state="sent"]', { hasText: line });
    await expect(row).toBeVisible();
    await hold(page, bubbleWith(page, line));
    await menu(page).locator('[data-menu-item="delete"]').click();
    // X7 FT39: a text message deletes behind a 4s Undo instead of the confirm.
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeVisible();
    await expect(page.locator('[data-selection-bar]')).toHaveCount(0);
    await expect(page.locator('[data-msg-id][data-checked]')).toHaveCount(0);
  });
});

test.describe('laptop', () => {
  test.use({
    viewport: { width: 1280, height: 800 },
    isMobile: false,
    hasTouch: false,
    deviceScaleFactor: 1,
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  });

  test('right-click Select; drag selects in the body; browser menu inside; Escape clears', async ({
    page,
  }) => {
    await openDm(page);
    const target = bubbleWith(page, PEER_LINE);
    await settle(page, target);
    await target.click({ button: 'right' });
    await expect(menu(page)).toBeVisible();
    await expectMenuStyle(page);
    await pickSelect(page);
    const displayed = await displayedBody(target);
    expect((await selectionText(page)).trim()).toBe(displayed.trim());

    // Mouse drag inside the body selects part of it.
    const body = await target.locator('[data-msg-body]').boundingBox();
    if (body === null) throw new Error('no box');
    const y = body.y + Math.min(body.height / 2, 10);
    await page.mouse.move(body.x + 2, y);
    await page.mouse.down();
    await page.mouse.move(body.x + body.width / 3, y, { steps: 5 });
    await page.mouse.up();
    const part = await selectionText(page);
    expect(part.length).toBeGreaterThan(0);
    expect(displayed).toContain(part);
    await expect(page.locator('[data-selecting-text]')).toHaveCount(1);

    // Right-click inside the active body: the browser's own menu, not ours.
    await page.evaluate(() => {
      (window as unknown as { __ctx: boolean[] }).__ctx = [];
      window.addEventListener('contextmenu', (e) =>
        (window as unknown as { __ctx: boolean[] }).__ctx.push(e.defaultPrevented),
      );
    });
    await target
      .locator('[data-msg-body]')
      .dispatchEvent('contextmenu', { button: 2, bubbles: true, cancelable: true });
    expect(await page.evaluate(() => (window as unknown as { __ctx: boolean[] }).__ctx)).toEqual([
      false,
    ]);
    await expect(menu(page)).toHaveCount(0);

    await page.keyboard.press('Escape');
    await expect(page.locator('[data-selecting-text]')).toHaveCount(0);
    expect(await selectionText(page)).toBe('');
  });

  test('hover chevron Select, then opening another menu ends it', async ({ page }) => {
    await openDm(page);
    const target = bubbleWith(page, PEER_LINE);
    await settle(page, target);
    await target.hover();
    await target.locator('[data-more]').click();
    await pickSelect(page);
    await expect(page.locator('[data-selecting-text]')).toHaveCount(1);
    const other = bubbleWith(page, MENTION_PREVIEW);
    await settle(page, other);
    await other.click({ button: 'right' });
    await expect(menu(page)).toBeVisible();
    await expect(page.locator('[data-selecting-text]')).toHaveCount(0);
  });
});
