import { expect, test, type Page } from '@playwright/test';
import { installHarnessNetwork, type HarnessNetwork } from '../fixtures/harness-routes';
import { ME, WORKSPACE_ID, seedPlanTab } from '../fixtures/chat-data';
import { seedRecentlyDeleted } from '../fixtures/assets-recently-deleted';

// S8 measurement: the phone list screens that use ui/ListCard (Pipeline,
// Briefs, Assets, the Chat list, Activity, the Plan tab). Per screen this
// records, after the list settles: when the first card painted, when the first
// list picture painted, the first ?paintlog marks, and the image requests and
// bytes the pictures cost; logged as one JSON line per screen
// (LIST_CARD_IMAGE_BYTES, read by the PR body) and attached as an annotation.
//
// It asserts only that the list rendered and that the existing Thumbnail rule
// holds: a version whose small copy was served never also asks for its
// original, and a picture showing the small copy draws no other image. (A
// version with no small copy may load its original; that is measured, not
// failed.)

const ASSET_READ_HOST = 'asset-read.harness.test';
const CARD = '[data-list-card]';

/** Open briefs, so the Briefs list has cards (the harness world has none). */
function seedBriefs(network: HarnessNetwork, count: number): void {
  const t = network.world.tables;
  const now = Date.now();
  for (let i = 0; i < count; i += 1) {
    const at = new Date(now - (i + 1) * 3_600_000).toISOString();
    (t.briefs ??= []).push({
      id: `0190da00-0000-7000-8b00-${String(i + 1).padStart(12, '0')}`,
      number: 700 + i,
      workspace_id: WORKSPACE_ID,
      title: `Measured brief ${i + 1}`,
      objective: 'Fixture objective',
      format_requested: null,
      brand_requirements: null,
      target_date: null,
      reference_links: null,
      status: 'open',
      closed_at: null,
      closed_by: null,
      created_by: ME,
      legacy_author_name: null,
      created_via: 'app',
      row_version: 1,
      updated_at: at,
      created_at: at,
      deleted_at: null,
    });
  }
}

const SCREENS: ReadonlyArray<{
  name: string;
  path: string;
  seed?: (network: HarnessNetwork) => void;
}> = [
  { name: 'pipeline', path: '/pipeline?stage=all' },
  { name: 'briefs', path: '/briefs', seed: (n) => seedBriefs(n, 3) },
  { name: 'assets', path: '/assets', seed: (n) => seedRecentlyDeleted(n) },
  { name: 'chat-list', path: '/chat' },
  { name: 'activity', path: '/notifications' },
  { name: 'plan-tab', path: '/plan', seed: (n) => seedPlanTab(n.world, { sender: ME }) },
];

interface Tally {
  presignSmall: number;
  presignOriginal: number;
  imageRequests: number;
  imageBytes: number;
}

/**
 * Counts asset-read traffic: presigns by rendition (stream reads skipped), the
 * versions whose small copy was served (200) and those whose original was
 * asked for, and the image bytes received.
 */
function watch(page: Page) {
  const tally: Tally = { presignSmall: 0, presignOriginal: 0, imageRequests: 0, imageBytes: 0 };
  const smallServed = new Set<string>();
  const originalAsked = new Set<string>();
  const pending: Array<Promise<void>> = [];
  const bodyOf = (raw: () => unknown): Record<string, unknown> => {
    try {
      return (raw() ?? {}) as Record<string, unknown>;
    } catch {
      return {};
    }
  };
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.hostname !== ASSET_READ_HOST) return;
    if (url.pathname.startsWith('/blob/image/')) {
      tally.imageRequests += 1;
      return;
    }
    if (request.method() !== 'POST' || url.pathname.startsWith('/blob/')) return;
    const body = bodyOf(() => request.postDataJSON());
    if (body.stream === true) return;
    const id = String(body.asset_version_id ?? body.id ?? '');
    if (body.rendition === 'thumbnail') tally.presignSmall += 1;
    else {
      tally.presignOriginal += 1;
      originalAsked.add(id);
    }
  });
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.hostname !== ASSET_READ_HOST) return;
    if (url.pathname.startsWith('/blob/image/')) {
      pending.push(
        response
          .body()
          .then((buf) => {
            tally.imageBytes += buf.byteLength;
          })
          .catch(() => undefined),
      );
      return;
    }
    const request = response.request();
    if (request.method() !== 'POST' || url.pathname.startsWith('/blob/')) return;
    const body = bodyOf(() => request.postDataJSON());
    if (body.rendition === 'thumbnail' && response.status() === 200) {
      smallServed.add(String(body.asset_version_id ?? body.id ?? ''));
    }
  });
  return {
    tally,
    smallServed,
    originalAsked,
    settle: async () => void (await Promise.all(pending)),
  };
}

for (const screen of SCREENS) {
  test(`${screen.name}: list paint marks and picture bytes`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    // First card and first list picture, timed in the page (performance.now)
    // without touching the app: a frame loop for the card, a capturing load
    // listener for the picture.
    await page.addInitScript((card: string) => {
      const w = window as unknown as { __firstCard?: number; __firstThumb?: number };
      const tick = (): void => {
        if (w.__firstCard === undefined && document.querySelector(card) !== null) {
          w.__firstCard = performance.now();
        }
        if (w.__firstCard === undefined) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      document.addEventListener(
        'load',
        (event) => {
          const target = event.target;
          if (
            w.__firstThumb === undefined &&
            target instanceof HTMLImageElement &&
            target.closest(card) !== null
          ) {
            w.__firstThumb = performance.now();
          }
        },
        true,
      );
    }, CARD);
    const network = await installHarnessNetwork(page);
    screen.seed?.(network);
    const { tally, smallServed, originalAsked, settle } = watch(page);
    await page.goto(`${screen.path}${screen.path.includes('?') ? '&' : '?'}paintlog=1`);

    // The list rendered.
    await expect(page.locator(CARD).first()).toBeVisible({ timeout: 15_000 });
    // Let in-view pictures resolve (presign, then the image) before reading.
    await page.waitForLoadState('networkidle');
    await settle();

    const measured = await page.evaluate(() => {
      const w = window as unknown as { __firstCard?: number; __firstThumb?: number };
      const seen = new Set<string>();
      const marks = performance
        .getEntriesByType('mark')
        .filter((m) => (seen.has(m.name) ? false : (seen.add(m.name), true)))
        .map((m) => ({ name: m.name, ms: Math.round(m.startTime) }));
      const round = (v: number | undefined): number | null =>
        v === undefined ? null : Math.round(v);
      return {
        firstCardPainted: round(w.__firstCard),
        firstThumbPainted: round(w.__firstThumb),
        marks,
      };
    });
    const line = JSON.stringify({
      screen: screen.name,
      firstCardPainted: measured.firstCardPainted,
      firstThumbPainted: measured.firstThumbPainted,
      ...tally,
      marks: measured.marks,
    });
    test.info().annotations.push({ type: 'list-card-image-bytes', description: line });
    process.stdout.write(`LIST_CARD_IMAGE_BYTES ${line}\n`);

    // A version whose small copy was served never also asks for its original.
    expect([...originalAsked].filter((id) => smallServed.has(id))).toEqual([]);
    // A list picture showing the small copy draws no other image beside it.
    const mixed = await page
      .locator(`${CARD} [data-list-card-picture]`)
      .evaluateAll(
        (slots) =>
          slots.filter(
            (slot) =>
              slot.querySelector('img[data-thumb-small]') !== null &&
              slot.querySelector('img:not([data-thumb-small])') !== null,
          ).length,
      );
    expect(mixed).toBe(0);
  });
}
