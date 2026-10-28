import { expect, test, type Page } from '@playwright/test';
import { installHarnessNetwork, type HarnessNetwork } from '../fixtures/harness-routes';
import { delaySupabaseReads } from '../fixtures/read-delays';

// Blink B3: opening the Activity tab with warm data (page one read earlier in
// the session) paints the kept rows on the first frame. Every animation frame
// and DOM change from the tap until settled is sampled: once the Activity page
// is mounted (its chip row is in the DOM), no sample may show the loading line
// ("Loading activity") or a blank list (no card, no zero state). Reads are
// delayed like a phone network (250 to 400 ms), so a page that waits on its
// read would show the loading line for that long. Runs in dark and light
// (@theme). Linux WebKit approximates iOS WebKit, it is not iOS.

declare global {
  interface Window {
    __activityFrames?: string[];
  }
}

function expectClean(network: HarnessNetwork): void {
  expect(network.blocked, 'blocked non-fixture requests').toEqual([]);
  expect([...new Set(network.unmatched)], 'unrecognised fixture requests').toEqual([]);
}

/** Start sampling the Activity list on every frame and DOM change. */
async function startSampling(page: Page): Promise<void> {
  await page.evaluate(() => {
    const frames: string[] = [];
    window.__activityFrames = frames;
    const read = (): string => {
      if (document.querySelector('[data-activity-chips]') === null) return 'absent';
      if ((document.body.textContent ?? '').includes('Loading activity')) return 'loading';
      if (document.querySelector('[data-activity-event]') !== null) return 'rows';
      return 'blank';
    };
    const sample = (): void => {
      const state = read();
      if (frames[frames.length - 1] !== state) frames.push(state);
    };
    new MutationObserver(sample).observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    const frame = (): void => {
      sample();
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
}

test(
  'Activity with warm data paints its kept rows on the first frame: no loading line, no blank list',
  { tag: '@theme' },
  async ({ page }) => {
    const network = await installHarnessNetwork(page);

    // A first visit reads page one (the session keeps it), then the person leaves.
    await page.goto('/notifications');
    await expect(page.locator('[data-activity-event]').first()).toBeVisible({ timeout: 15_000 });
    await page.locator('[data-tab-pill] a[href="/pipeline"]').click();
    await expect(page).toHaveURL(/\/pipeline$/);
    await expect(page.locator('[data-activity-chips]')).toHaveCount(0);

    // Phone-like reads from here on, then the tap back to Activity.
    const delays = await delaySupabaseReads(page);
    await startSampling(page);
    await page.locator('nav [data-activity-tab]').click();
    await expect(page).toHaveURL(/\/notifications$/);
    await expect(page.locator('[data-activity-event]').first()).toBeVisible();
    // Past the slowest delayed read, so the quiet refresh has landed too.
    await page.waitForTimeout(800);
    delays.setOn(false);

    const frames = await page.evaluate(() => window.__activityFrames ?? []);
    const mounted = frames.slice(Math.max(0, frames.indexOf('rows')));
    expect(frames, `samples: ${JSON.stringify(frames)}`).toContain('rows');
    expect(frames, `no loading line: ${JSON.stringify(frames)}`).not.toContain('loading');
    expect(frames, `no blank list: ${JSON.stringify(frames)}`).not.toContain('blank');
    // Once painted, the rows never drop back.
    expect(mounted.every((state) => state === 'rows')).toBe(true);
    expectClean(network);
  },
);
