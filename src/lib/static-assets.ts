// Asset versions whose bytes ship with the app (the onboarding sample week under
// public/induction-sample/). They need no presign round trip: the page shows
// them from the site's own static path at once, and their small thumbnails are
// fetched ahead so photos are on screen before anyone points at them.

const SAMPLE_PREFIX = 'induction-sample/';

interface StaticAsset {
  /** The file itself, e.g. /induction-sample/kr-ruffle.jpg. */
  full: string;
  /** Its small copy (a PDF's cover image), e.g. /induction-sample/thumb/kr-ruffle.jpg. */
  thumb: string;
}

const known = new Map<string, StaticAsset>();

/** The static paths for a sample r2_key, or null for any other key. */
function staticPathsFor(r2Key: string | null): StaticAsset | null {
  if (r2Key === null || !r2Key.startsWith(SAMPLE_PREFIX)) return null;
  const name = r2Key.slice(r2Key.lastIndexOf('/') + 1).replace(/\.pdf$/i, '.jpg');
  return { full: `/${r2Key}`, thumb: `/${SAMPLE_PREFIX}thumb/${name}` };
}

/** Remembers these versions as static; returns how many were new. */
export function registerStaticAssets(
  rows: ReadonlyArray<{ id: string; r2_key: string | null }>,
): number {
  let added = 0;
  for (const row of rows) {
    const paths = staticPathsFor(row.r2_key);
    if (paths === null || known.has(row.id)) continue;
    known.set(row.id, paths);
    added += 1;
  }
  return added;
}

/** The static paths of a version, or undefined when it needs a presign. */
export function staticAsset(assetVersionId: string): StaticAsset | undefined {
  return known.get(assetVersionId);
}

const warmed = new Set<string>();

/** Fetches these URLs into the browser cache now, so they paint at once later. */
export function warmImages(urls: readonly string[]): void {
  if (typeof Image === 'undefined') return;
  for (const url of urls) {
    if (warmed.has(url)) continue;
    warmed.add(url);
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
  }
}

/** Every registered version's thumbnail, for warming. */
export function staticThumbs(): string[] {
  return Array.from(known.values(), (paths) => paths.thumb);
}
