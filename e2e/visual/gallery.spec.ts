import { expect, test, type Page } from '@playwright/test';
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
//
// Measured shape (11 Nov 2026), phone and laptop: the page is never wider
// than the viewport; nothing in a cell reaches past the cell's edges by more
// than the 16 phone gutter (a ListCard row's -mx-4 bleed and a trailing key's
// 12 pull live there by design); and no button's label spills out of its box.
// Content clipped inside a part (a cut label) counts as the part's own box.
// A screenshot alone is not proof.

const GUTTER_ROOM = 16;

/** What breaks its cell, as "<cell>: <tag> <width> wide in <cell width>". */
async function overflowOf(page: Page): Promise<{ viewport: number; page: number; over: string[] }> {
  return page.evaluate((room) => {
    const over: string[] = [];
    for (const cell of Array.from(document.querySelectorAll<HTMLElement>('[data-gallery-cell]'))) {
      const id = cell.dataset['galleryCell'] ?? '?';
      const box = cell.getBoundingClientRect();
      const walk = (el: Element): void => {
        for (const child of Array.from(el.children)) {
          const r = child.getBoundingClientRect();
          const tag = child.tagName.toLowerCase();
          if (r.width > 0 && (r.right > box.right + room + 1 || r.left < box.left - room - 1)) {
            over.push(`${id}: ${tag} ${Math.round(r.width)} wide in ${Math.round(box.width)}`);
          }
          if (tag === 'button' && child.scrollHeight > child.clientHeight + 1) {
            over.push(`${id}: button label ${child.scrollHeight} tall in ${child.clientHeight}`);
          }
          if (getComputedStyle(child).overflowX === 'visible') walk(child);
        }
      };
      walk(cell);
    }
    return { viewport: window.innerWidth, page: document.documentElement.scrollWidth, over };
  }, GUTTER_ROOM);
}

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
    const shape = await overflowOf(page);
    expect.soft(shape.page, 'page wider than the viewport').toBeLessThanOrEqual(shape.viewport);
    expect.soft(shape.over, 'cell content wider than its cell').toEqual([]);
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
