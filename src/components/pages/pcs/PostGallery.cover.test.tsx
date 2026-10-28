// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PresignCache, PresignDeps, PresignedUrl } from '@/lib/asset-presign';
import type { GalleryItem } from '@srtdio/posts';

// Blink B1: opening a post from the Pipeline painted an empty media frame
// until the full image had downloaded. The ribbon now paints the small copy the
// Pipeline card already showed (the shared presign cache's thumbnail URL) on
// the first frame, in the same box and fit, and swaps to the full image only
// once that image has loaded AND decoded. No cover known: exactly as before.

const h = vi.hoisted(() => ({ marks: [] as string[] }));
vi.mock('@/lib/perf-marks', () => ({
  mark: (name: string) => {
    h.marks.push(name);
  },
}));

import { PostGallery } from '@/components/pages/pcs/PostGallery';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: () => void };
function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {};
  let reject: () => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = () => rej(new Error('x'));
  });
  return { promise, resolve, reject };
}

const coverOf = (versionId: string): string => `https://files.test/thumb/${versionId}`;
const fullOf = (versionId: string): string => `https://files.test/full/${versionId}`;
const later = (): number => Date.now() + 3_600_000;

let fullReads = new Map<string, Deferred<PresignedUrl>>();
let decodes: Deferred<void>[] = [];

function makeCache(covers: readonly string[]): PresignCache {
  return {
    peek: () => null,
    peekThumbnail: (versionId: string) =>
      covers.includes(versionId) ? { url: coverOf(versionId), expiresAt: later() } : null,
    resolve: (versionId: string) => {
      const d = deferred<PresignedUrl>();
      fullReads.set(versionId, d);
      return d.promise;
    },
  } as unknown as PresignCache;
}

const deps = { endpoint: null, getAccessToken: async () => null } as unknown as PresignDeps;

function item(versionId: string, n = 0): GalleryItem {
  return {
    assetAttachmentId: `aa-${versionId}`,
    assetVersionId: versionId,
    assetId: `as-${versionId}`,
    position: n,
    filename: `image-${versionId}.png`,
    mimeType: 'image/png',
    kind: 'image',
    width: 800,
    height: 1000,
    durationMs: null,
    pageCount: null,
    r2Key: null,
    externalUrl: null,
  } as GalleryItem;
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function renderGallery(items: GalleryItem[], cache: PresignCache): void {
  act(() => {
    root?.render(<PostGallery items={items} cache={cache} deps={deps} presignEnabled />);
  });
}

function tile(): Element {
  const el = document.querySelector('[data-ribbon-tile]');
  if (el === null) throw new Error('no ribbon tile');
  return el;
}
const coverImg = (): HTMLImageElement | null =>
  tile().querySelector<HTMLImageElement>('img[data-gallery-cover]');
const fullImg = (): HTMLImageElement | null =>
  tile().querySelector<HTMLImageElement>('img[data-gallery-full]');

/** The frame shows a picture: some img with a src that is not hidden. */
function frameHasPicture(): boolean {
  return Array.from(tile().querySelectorAll('img')).some(
    (img) => (img.getAttribute('src') ?? '') !== '' && !img.classList.contains('opacity-0'),
  );
}

async function fire(img: HTMLImageElement | null, type: 'load' | 'error'): Promise<void> {
  if (img === null) throw new Error(`no img to ${type}`);
  await act(async () => {
    img.dispatchEvent(new Event(type));
    await Promise.resolve();
  });
}

beforeEach(() => {
  h.marks = [];
  fullReads = new Map();
  decodes = [];
  Object.defineProperty(HTMLImageElement.prototype, 'decode', {
    configurable: true,
    value: () => {
      const d = deferred<void>();
      decodes.push(d);
      return d.promise;
    },
  });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('post ribbon: known cover first, full image after decode', () => {
  it('paints the known cover on the first render, before any presign answers', () => {
    renderGallery([item('v-first')], makeCache(['v-first']));
    // First commit: the cover is there, with the card's exact URL.
    expect(coverImg()?.getAttribute('src')).toBe(coverOf('v-first'));
    expect(frameHasPicture()).toBe(true);
    // Same box and fit as the full image: absolute, full size, contain (the
    // ribbon tile already carries the picture's own ratio, so nothing shifts).
    const cls = coverImg()?.className ?? '';
    for (const c of ['absolute', 'inset-0', 'h-full', 'w-full', 'object-contain']) {
      expect(cls.split(/\s+/)).toContain(c);
    }
    // The full image's presign is still pending: no full img yet, no glyph tile.
    expect(fullImg()).toBeNull();
    expect(tile().querySelector('svg')).toBeNull();
  });

  it('keeps the cover until the full image has loaded AND decoded, then swaps', async () => {
    renderGallery([item('v-swap')], makeCache(['v-swap']));
    fullReads.get('v-swap')?.resolve({ url: fullOf('v-swap'), expiresAt: later() });
    await flush();
    // The full image is mounted over the cover but hidden until decoded.
    expect(fullImg()?.getAttribute('src')).toBe(fullOf('v-swap'));
    expect(fullImg()?.classList.contains('opacity-0')).toBe(true);
    expect(coverImg()).not.toBeNull();
    expect(frameHasPicture()).toBe(true);

    // Bytes arrived, decode still pending: the cover stays.
    await fire(fullImg(), 'load');
    expect(decodes).toHaveLength(1);
    expect(coverImg()).not.toBeNull();
    expect(fullImg()?.classList.contains('opacity-0')).toBe(true);
    expect(h.marks).not.toContain('post:media:full-swap');

    // Decoded: the full image shows and the cover leaves, in one commit.
    await act(async () => {
      decodes[0]?.resolve();
      await Promise.resolve();
    });
    await flush();
    expect(coverImg()).toBeNull();
    expect(fullImg()?.classList.contains('opacity-0')).toBe(false);
    expect(frameHasPicture()).toBe(true);
    expect(h.marks).toContain('post:media:full-swap');
  });

  it('never shows an empty frame at any step of the open', async () => {
    const seen: boolean[] = [];
    renderGallery([item('v-steps')], makeCache(['v-steps']));
    seen.push(frameHasPicture());
    fullReads.get('v-steps')?.resolve({ url: fullOf('v-steps'), expiresAt: later() });
    await flush();
    seen.push(frameHasPicture());
    await fire(coverImg(), 'load');
    seen.push(frameHasPicture());
    await fire(fullImg(), 'load');
    seen.push(frameHasPicture());
    await act(async () => {
      decodes[0]?.resolve();
      await Promise.resolve();
    });
    await flush();
    seen.push(frameHasPicture());
    expect(seen).toEqual([true, true, true, true, true]);
  });

  it('drops the cover-paint mark when the cover paints (first slide only)', async () => {
    renderGallery([item('v-mark-1', 0), item('v-mark-2', 1)], makeCache(['v-mark-1', 'v-mark-2']));
    const covers = document.querySelectorAll<HTMLImageElement>('img[data-gallery-cover]');
    expect(covers).toHaveLength(2);
    // The slide on screen loads its cover eagerly; the next one lazily.
    expect(covers[0]?.getAttribute('loading')).toBe('eager');
    expect(covers[1]?.getAttribute('loading')).toBe('lazy');
    await fire(covers[1] ?? null, 'load');
    expect(h.marks).not.toContain('post:media:cover-paint');
    await fire(covers[0] ?? null, 'load');
    expect(h.marks).toEqual(['post:media:cover-paint']);
  });

  it('a failed full image keeps the cover (never the glyph tile)', async () => {
    renderGallery([item('v-full-fails')], makeCache(['v-full-fails']));
    fullReads.get('v-full-fails')?.resolve({ url: fullOf('v-full-fails'), expiresAt: later() });
    await flush();
    await fire(fullImg(), 'error');
    expect(coverImg()?.getAttribute('src')).toBe(coverOf('v-full-fails'));
    expect(frameHasPicture()).toBe(true);
  });

  it('a failed cover shows the full image as it loads, as before', async () => {
    renderGallery([item('v-cover-fails')], makeCache(['v-cover-fails']));
    fullReads.get('v-cover-fails')?.resolve({ url: fullOf('v-cover-fails'), expiresAt: later() });
    await flush();
    await fire(coverImg(), 'error');
    expect(coverImg()).toBeNull();
    expect(fullImg()?.classList.contains('opacity-0')).toBe(false);
  });

  it('no known cover: the full image renders exactly as before (no layer, no hiding)', async () => {
    renderGallery([item('v-no-cover')], makeCache([]));
    expect(coverImg()).toBeNull();
    fullReads.get('v-no-cover')?.resolve({ url: fullOf('v-no-cover'), expiresAt: later() });
    await flush();
    const full = fullImg();
    expect(full?.getAttribute('src')).toBe(fullOf('v-no-cover'));
    expect(full?.className).toBe('h-full w-full object-contain');
    expect(full?.parentElement?.tagName).not.toBe('SPAN');
  });

  it('a reopened post whose full image decoded this session paints it with no cover', async () => {
    const cache = makeCache(['v-reopen']);
    renderGallery([item('v-reopen')], cache);
    fullReads.get('v-reopen')?.resolve({ url: fullOf('v-reopen'), expiresAt: later() });
    await flush();
    await fire(fullImg(), 'load');
    await act(async () => {
      decodes[0]?.resolve();
      await Promise.resolve();
    });
    await flush();
    act(() => root?.render(<div />));
    renderGallery([item('v-reopen')], cache);
    expect(coverImg()).toBeNull();
  });
});
