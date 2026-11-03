import { expect, test, type Page } from '@playwright/test';
import { installHarnessNetwork } from '../fixtures/harness-routes';
import { PEER_NAME } from '../fixtures/chat-data';

// The app must not pin itself to the visual viewport while the iPhone keyboard
// is open: on iPhone Chrome the AutoFill bar sits inside that area and covered
// the composer. The browser pans to the focused field instead.
// Linux WebKit never shows a keyboard, so the keyboard is simulated the way
// iOS reports it: visualViewport shrinks (and pans) while innerHeight stays.

declare global {
  interface Window {
    __keyboard: (height: number, offsetTop: number) => void;
  }
}

async function fakeVisualViewport(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const vv = new EventTarget() as EventTarget & {
      height: number;
      width: number;
      offsetTop: number;
      offsetLeft: number;
      pageTop: number;
      pageLeft: number;
      scale: number;
    };
    Object.assign(vv, {
      height: window.innerHeight,
      width: window.innerWidth,
      offsetTop: 0,
      offsetLeft: 0,
      pageTop: 0,
      pageLeft: 0,
      scale: 1,
    });
    Object.defineProperty(window, 'visualViewport', { configurable: true, get: () => vv });
    window.__keyboard = (height, offsetTop) => {
      vv.height = height;
      vv.offsetTop = offsetTop;
      vv.dispatchEvent(new Event('resize'));
      vv.dispatchEvent(new Event('scroll'));
    };
  });
}

async function rootState(page: Page): Promise<{ keyboardAttr: boolean; position: string }> {
  return page.evaluate(() => ({
    keyboardAttr: document.documentElement.hasAttribute('data-keyboard'),
    position: getComputedStyle(document.getElementById('root') as HTMLElement).position,
  }));
}

test('keyboard opening does not pin #root to the visual viewport', async ({ page }) => {
  await fakeVisualViewport(page);
  await installHarnessNetwork(page);
  await page.goto('/chat');
  await page.getByText(PEER_NAME, { exact: true }).first().click();
  const textarea = page.locator('form textarea').first();
  await textarea.waitFor({ state: 'visible' });
  const layoutHeight = await page.evaluate(() => window.innerHeight);

  const before = await rootState(page);
  expect(before.keyboardAttr).toBe(false);
  expect(before.position).not.toBe('fixed');

  // iPhone 13 portrait: about 336px of keyboard plus bar, page panned by 90px.
  const visible = layoutHeight - 336;
  const pan = 90;
  await textarea.focus();
  await page.evaluate(([h, t]) => window.__keyboard(h, t), [visible, pan] as const);
  // Give any listener a couple of frames to react before asserting it did not.
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
  const during = await rootState(page);
  expect(during.keyboardAttr).toBe(false);
  expect(during.position).not.toBe('fixed');
  await expect(textarea).toBeFocused();

  await page.evaluate((h) => window.__keyboard(h, 0), layoutHeight);
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
  const after = await rootState(page);
  expect(after.keyboardAttr).toBe(false);
  expect(after.position).not.toBe('fixed');
  await expect(textarea).toBeFocused();
});

// The chat list scrolls the document on a phone (page mode), but a thread
// keeps the locked shell its keyboard handling is proven against: opening one
// from the list drops html.scroll-page in the same render, the document never
// scrolls, and the composer sits at the bottom of the screen.
test('a thread opened from the page-mode list is the locked shell', async ({ page }) => {
  await installHarnessNetwork(page);
  await page.goto('/chat');
  const pageModeOn = (): Promise<boolean> =>
    page.evaluate(() => document.documentElement.classList.contains('scroll-page'));
  const phone = (page.viewportSize()?.width ?? 0) < 768;
  await page.getByText(PEER_NAME, { exact: true }).first().waitFor({ state: 'visible' });
  if (phone) expect(await pageModeOn()).toBe(true);
  await page.getByText(PEER_NAME, { exact: true }).first().click();
  const textarea = page.locator('form textarea').first();
  await textarea.waitFor({ state: 'visible' });
  await expect.poll(pageModeOn).toBe(false);
  const state = await page.evaluate(() => {
    const doc = document.scrollingElement ?? document.documentElement;
    const form = document.querySelector('form:has(textarea)');
    return {
      docScrollable: doc.scrollHeight > doc.clientHeight + 1,
      scrollY: window.scrollY,
      formBottom: form === null ? Number.NaN : form.getBoundingClientRect().bottom,
      innerHeight: window.innerHeight,
    };
  });
  expect(state.docScrollable).toBe(false);
  expect(state.scrollY).toBe(0);
  // The composer's bottom edge is on screen, at the bottom of the thread.
  expect(state.formBottom).toBeLessThanOrEqual(state.innerHeight + 1);
  expect(state.formBottom).toBeGreaterThan(state.innerHeight - 200);
});
