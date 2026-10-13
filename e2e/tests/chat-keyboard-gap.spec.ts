import { expect, test, type Page } from '@playwright/test';
import { installHarnessNetwork } from '../fixtures/harness-routes';
import { PEER_NAME } from '../fixtures/chat-data';

// The iPhone keyboard gap: with the keyboard open the composer must sit right
// on the browser's bar above the keyboard, not float above an empty band.
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

async function composerBox(page: Page): Promise<{ top: number; bottom: number }> {
  return page.evaluate(() => {
    const form = [...document.querySelectorAll('form')].find(
      (f) => f.querySelector('textarea') !== null && f.getBoundingClientRect().height > 0,
    );
    const box = form?.getBoundingClientRect();
    return { top: box?.top ?? -1, bottom: box?.bottom ?? -1 };
  });
}

test('composer sits on the keyboard bar with no gap, and returns to the bottom after', async ({
  page,
}) => {
  await fakeVisualViewport(page);
  await installHarnessNetwork(page);
  await page.goto('/chat');
  await page.getByText(PEER_NAME, { exact: true }).first().click();
  const textarea = page.locator('form textarea').first();
  await textarea.waitFor({ state: 'visible' });
  const layoutHeight = await page.evaluate(() => window.innerHeight);

  const closed = await composerBox(page);
  expect(Math.abs(closed.bottom - layoutHeight)).toBeLessThanOrEqual(2);

  // iPhone 13 portrait: about 336px of keyboard plus bar, page panned by 90px.
  const visible = layoutHeight - 336;
  const pan = 90;
  await textarea.focus();
  await page.evaluate(([h, t]) => window.__keyboard(h, t), [visible, pan] as const);
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.keyboard))
    .toBe('open');

  const open = await composerBox(page);
  // Flush with the visible bottom: no band between composer and the keyboard bar.
  expect(Math.abs(open.bottom - (pan + visible))).toBeLessThanOrEqual(2);
  // The thread header stays at the visible top, and the thread keeps room.
  const headerTop = await page.evaluate(
    () => document.getElementById('root')?.getBoundingClientRect().top ?? -1,
  );
  expect(Math.abs(headerTop - pan)).toBeLessThanOrEqual(2);
  expect(open.top - pan).toBeGreaterThan(200);
  await expect(textarea).toBeFocused();

  await page.evaluate((h) => window.__keyboard(h, 0), layoutHeight);
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.keyboard ?? 'closed'))
    .toBe('closed');
  const after = await composerBox(page);
  expect(Math.abs(after.bottom - layoutHeight)).toBeLessThanOrEqual(2);
});
