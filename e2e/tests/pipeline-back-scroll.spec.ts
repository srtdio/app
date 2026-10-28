import { expect, test, type Page } from '@playwright/test';
import { installHarnessNetwork } from '../fixtures/harness-routes';

// B4 (28 Oct phone recording): Back from a post painted Pipeline at the top,
// then ~0.4 s later jumped to the kept scroll position in one frame. With warm
// data, every frame after Back that shows the board must already sit at the
// kept position: zero frames at the top, zero jump. Short viewport so the
// harness board scrolls. Tagged @theme for light and dark.

/** Sample the shell scroller every frame for `ms`: [scrollTop, cards on screen]. */
async function sampleFrames(page: Page, ms: number): Promise<void> {
  await page.evaluate((duration) => {
    const w = window as unknown as { __frames: Array<[number, boolean]> };
    w.__frames = [];
    const start = performance.now();
    const tick = (): void => {
      const main = document.querySelector('main');
      const cards = document.querySelector('[data-post-card-thumb], [data-post-card-body]');
      w.__frames.push([main?.scrollTop ?? -1, cards !== null]);
      if (performance.now() - start < duration) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, ms);
}

test('Back to Pipeline paints at the kept scroll position on the first frame @theme', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 480 });
  const network = await installHarnessNetwork(page);
  await page.goto('/pipeline?stage=all');
  const card = page.getByRole('button', { name: 'Open post Monday carousel' });
  await expect(card).toBeVisible({ timeout: 15_000 });

  const kept = await page.evaluate(() => {
    const main = document.querySelector('main');
    if (main === null) return 0;
    main.scrollTop = main.scrollHeight;
    main.dispatchEvent(new Event('scroll'));
    return main.scrollTop;
  });
  expect(kept).toBeGreaterThan(0);
  // The save listener runs on the scroll event; let it land.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));

  // A DOM click: no scroll-into-view moves the board before it is left.
  await page.evaluate(() => {
    const opens = [
      ...document.querySelectorAll<HTMLButtonElement>('button[aria-label^="Open post "]'),
    ];
    opens[opens.length - 1]?.click();
  });
  await expect(page.getByRole('button', { name: 'Back', exact: true }).first()).toBeVisible({
    timeout: 15_000,
  });

  await sampleFrames(page, 1_500);
  await page.getByRole('button', { name: 'Back', exact: true }).first().click();
  await page.waitForTimeout(1_600);

  const frames = await page.evaluate(
    () => (window as unknown as { __frames: Array<[number, boolean]> }).__frames,
  );
  const boardFrames = frames.filter(([, cards]) => cards);
  expect(boardFrames.length).toBeGreaterThan(0);
  const off = boardFrames.filter(([top]) => Math.abs(top - kept) > 1);
  expect(off).toEqual([]);
  expect(network.blocked).toEqual([]);
});
