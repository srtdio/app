import { expect, test } from '@playwright/test';
import { ONBOARDING_NOW } from './onboarding-steps';
import { recordScreenFiles, settle, stabilise } from './shared';

// Parts gallery (e2e/gallery): one full-page shot per registered ui part at
// /gallery/<Part>, every state and awkward case in one page (the register is
// e2e/gallery/register.ts). Runs in iphone-light, iphone-dark, laptop-light,
// laptop-dark (@laptop-dark) and chrome-phone (@gallery, Chromium Pixel 7);
// never in the ipad-* projects. Same fixed clock, settle and screen-to-files
// fragment as screens.spec.ts. One line per screen: a changed line selects
// that screen only (scripts/ci/visual-select.ts). The list matches PARTS in
// the register (guard: src/__tests__/gallery-register.test.ts).

interface GalleryScreen {
  name: string;
  url: string;
}

const GALLERY: GalleryScreen[] = [
  { name: 'gallery-Text', url: '/gallery/Text' },
  { name: 'gallery-Button', url: '/gallery/Button' },
  { name: 'gallery-IconButton', url: '/gallery/IconButton' },
  { name: 'gallery-Chip', url: '/gallery/Chip' },
  { name: 'gallery-Tag', url: '/gallery/Tag' },
  { name: 'gallery-CountBadge', url: '/gallery/CountBadge' },
  { name: 'gallery-Avatar', url: '/gallery/Avatar' },
  { name: 'gallery-ListCard', url: '/gallery/ListCard' },
  { name: 'gallery-HeaderBar', url: '/gallery/HeaderBar' },
  { name: 'gallery-Toolbar', url: '/gallery/Toolbar' },
  { name: 'gallery-LoadMore', url: '/gallery/LoadMore' },
  { name: 'gallery-Input', url: '/gallery/Input' },
];

for (const screen of GALLERY) {
  test(`${screen.name} @gallery @laptop-dark`, async ({ page }) => {
    const map = recordScreenFiles(page);
    await page.clock.setFixedTime(ONBOARDING_NOW);
    // Vite's HMR socket answers nothing (no reload mid-capture).
    await page.routeWebSocket(
      (url) => url.protocol === 'ws:' && url.hostname === 'localhost',
      () => undefined,
    );
    // No network: anything off the harness host is refused and fails the test.
    const blocked: string[] = [];
    await page.route(
      (url) => url.hostname !== 'localhost',
      (route) => {
        blocked.push(route.request().url());
        return route.abort();
      },
    );
    await page.goto(screen.url);
    await expect(page.locator('main[data-gallery]')).toBeVisible({ timeout: 20_000 });
    await stabilise(page);
    await settle(page);
    await page.evaluate(() => {
      for (const a of document.getAnimations()) {
        if (a.effect?.getComputedTiming().iterations === Infinity) a.cancel();
        else a.finish();
      }
    });
    await expect.soft(page).toHaveScreenshot(`${screen.name}.png`, {
      fullPage: true,
      maxDiffPixelRatio: 0.002,
      animations: 'disabled',
      caret: 'hide',
    });
    map.write(screen.name);
    expect(blocked, 'blocked non-fixture requests').toEqual([]);
  });
}
