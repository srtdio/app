import { test, type Page } from '@playwright/test';
import { fileOfRequest, writeFragment } from '../../scripts/ci/visual-map';

// Capture helpers shared by screens.spec.ts and gallery.spec.ts, moved here
// unchanged from screens.spec.ts so both specs settle and record the same way.

/**
 * No hover, no focus ring, no transition mid-flight. The pointer parks at the
 * page corner (a step's last click leaves it on whatever renders there next:
 * plan-item's "Remove from plan" took its hover fill on some runs), the active
 * element blurs, then every finite animation and transition must end. Infinite
 * ones (the guide hand's press loop) never end; animations: 'disabled' holds
 * those still in the shot.
 */
export async function stabilise(page: Page, hold = false): Promise<void> {
  if (!hold) {
    await page.mouse.move(0, 0);
    await page.evaluate(() => {
      const active = document.activeElement;
      if (active instanceof HTMLElement) active.blur();
    });
  }
  await page.waitForFunction(
    () =>
      document
        .getAnimations()
        .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
        .every((a) => !a.pending && a.playState !== 'running'),
    undefined,
    { timeout: 5_000 },
  );
}

/** Fonts loaded, images decoded, two frames painted. */
export async function settle(page: Page): Promise<void> {
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await page.evaluate(() =>
    Promise.all(
      Array.from(document.images)
        .filter((img) => !img.complete)
        .map(
          (img) =>
            new Promise<void>((resolve) => {
              img.addEventListener('load', () => resolve(), { once: true });
              img.addEventListener('error', () => resolve(), { once: true });
            }),
        ),
    ).then(() => undefined),
  );
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

/**
 * The screen-to-files map (scripts/ci/visual-map.ts): every src/ and
 * packages/ module the dev server serves while this screen renders. A
 * listener only (no wait, nothing routed); write() is one small sync file.
 */
export function recordScreenFiles(page: Page): { write: (screen: string) => void } {
  const files = new Set<string>();
  page.on('request', (r) => {
    const f = fileOfRequest(r.url());
    if (f !== null) files.add(f);
  });
  return {
    write: (screen) =>
      writeFragment({ screen, project: test.info().project.name, files: [...files] }),
  };
}
