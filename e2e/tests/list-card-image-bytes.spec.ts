import { expect, test, type Page, type Request } from '@playwright/test';
import { installHarnessNetwork } from '../fixtures/harness-routes';

// Speed: a ListCard picture is 72 wide, so it loads ONLY the version's small
// stored copy (media/Thumbnail size="list"); it never presigns or fetches the
// full-size original, even when a version has no small copy (the card shows
// its fallback instead). Per phone list screen this records, after the list
// settles: presign calls by rendition, image bytes received and the first
// ?paintlog marks, logged as one JSON line per screen (read by the PR body)
// and attached to the report. The assert is the rule: zero originals.

const ASSET_READ_HOST = 'asset-read.harness.test';

const SCREENS = [
  { name: 'pipeline', path: '/pipeline?stage=all', ready: '[data-list-card]' },
  { name: 'assets', path: '/assets', ready: '[data-list-card]' },
  { name: 'briefs', path: '/briefs', ready: '[data-list-card]' },
  { name: 'plan-tab', path: '/plan', ready: '[data-plan-tab-list]' },
] as const;

interface Tally {
  presignThumbnail: number;
  presignOriginal: number;
  imageResponses: number;
  imageBytes: number;
}

function watch(page: Page): { tally: Tally; settle: () => Promise<void> } {
  const tally: Tally = {
    presignThumbnail: 0,
    presignOriginal: 0,
    imageResponses: 0,
    imageBytes: 0,
  };
  const pending: Array<Promise<void>> = [];
  page.on('request', (request: Request) => {
    const url = new URL(request.url());
    if (url.hostname !== ASSET_READ_HOST || request.method() !== 'POST') return;
    if (url.pathname.startsWith('/blob/')) return;
    let body: Record<string, unknown> = {};
    try {
      body = (request.postDataJSON() ?? {}) as Record<string, unknown>;
    } catch {
      body = {};
    }
    if (body.stream === true) return;
    if (body.rendition === 'thumbnail') tally.presignThumbnail += 1;
    else tally.presignOriginal += 1;
  });
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.hostname !== ASSET_READ_HOST || !url.pathname.startsWith('/blob/image/')) return;
    pending.push(
      response
        .body()
        .then((buf) => {
          tally.imageResponses += 1;
          tally.imageBytes += buf.byteLength;
        })
        .catch(() => undefined),
    );
  });
  return { tally, settle: async () => void (await Promise.all(pending)) };
}

for (const screen of SCREENS) {
  test(`${screen.name}: list pictures load only the small copy, never the original`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await installHarnessNetwork(page);
    const { tally, settle } = watch(page);
    await page.goto(`${screen.path}${screen.path.includes('?') ? '&' : '?'}paintlog=1`);
    await expect(page.locator(screen.ready).first()).toBeVisible({ timeout: 15_000 });
    // Let in-view pictures resolve (presign, then the image) before reading.
    await page.waitForLoadState('networkidle');
    await settle();
    const marks = await page.evaluate(() => {
      const seen = new Set<string>();
      return performance
        .getEntriesByType('mark')
        .filter((m) => (seen.has(m.name) ? false : (seen.add(m.name), true)))
        .map((m) => ({ name: m.name, ms: Math.round(m.startTime) }));
    });
    const line = JSON.stringify({ screen: screen.name, ...tally, marks });
    test.info().annotations.push({ type: 'list-card-image-bytes', description: line });
    process.stdout.write(`LIST_CARD_IMAGE_BYTES ${line}\n`);
    expect(tally.presignOriginal).toBe(0);
  });
}
