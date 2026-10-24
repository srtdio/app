import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Thumbnail, type ThumbnailFallback } from '@/components/media';
import type { PresignCache } from '@/lib/asset-presign';

// Rendered to static markup (node SSR, no DOM): useState initializers run (so a
// warm cache.peek hit shows the image) while effects do not, which is exactly the
// lazy/off-screen state. The presign gate is asserted via the spy counts on the
// injected cache (peek is the synchronous initializer path).

function makeCache(peekUrl: string | null, smallUrl: string | null = null) {
  const peek = vi.fn(() =>
    peekUrl !== null ? { url: peekUrl, expiresAt: Date.now() + 3_600_000 } : null,
  );
  const resolve = vi.fn(async () => ({ url: 'resolved', expiresAt: Date.now() + 3_600_000 }));
  const peekThumbnail = vi.fn(() =>
    smallUrl !== null ? { url: smallUrl, expiresAt: Date.now() + 3_600_000 } : null,
  );
  const thumbnail = vi.fn(async () => null);
  return {
    cache: { peek, resolve, peekThumbnail, thumbnail } as unknown as PresignCache,
    peek,
    resolve,
    peekThumbnail,
  };
}

function render(props: {
  assetVersionId: string | null;
  cache: PresignCache;
  presignEnabled: boolean;
  fallback: ThumbnailFallback;
  aspect?: 'square' | '4/3';
}): string {
  return renderToStaticMarkup(<Thumbnail alt="alt text" {...props} />);
}

describe('Thumbnail', () => {
  it('(a) renders an <img object-cover> of the small copy when a version is present and presign is enabled', () => {
    const { cache, peekThumbnail } = makeCache(null, 'https://cdn.example/thumb.jpg');
    const out = render({
      assetVersionId: 'av1',
      cache,
      presignEnabled: true,
      fallback: { kind: 'glyph' },
    });
    expect(out).toContain('<img');
    expect(out).toContain('https://cdn.example/thumb.jpg');
    expect(out).toContain('object-cover');
    expect(peekThumbnail).toHaveBeenCalledWith('av1');
  });

  it('(a2) never loads the full-size original over a known small copy, even when its link is known', () => {
    const { cache, resolve } = makeCache(
      'https://srtd.io/f/av1/full?k=key',
      'https://srtd.io/f/av1/thumb?k=key',
    );
    const out = render({
      assetVersionId: 'av1',
      cache,
      presignEnabled: true,
      fallback: { kind: 'glyph' },
    });
    expect(out).toContain('https://srtd.io/f/av1/thumb?k=key');
    expect(out).not.toContain('https://srtd.io/f/av1/full');
    expect(resolve).not.toHaveBeenCalled();
  });

  it('(b) renders a link fallback with its domain label', () => {
    const { cache } = makeCache(null);
    const out = render({
      assetVersionId: null,
      cache,
      presignEnabled: true,
      fallback: { kind: 'link', label: 'example.com' },
    });
    expect(out).toContain('example.com');
    expect(out).toContain('<svg');
    expect(out).not.toContain('<img');
  });

  it('(c) renders a file fallback with its extension', () => {
    const { cache } = makeCache(null);
    const out = render({
      assetVersionId: null,
      cache,
      presignEnabled: true,
      fallback: { kind: 'file', extension: 'PDF' },
    });
    expect(out).toContain('PDF');
    expect(out).toContain('<svg');
    expect(out).not.toContain('<img');
  });

  it('(d) renders a text/caption fallback', () => {
    const { cache } = makeCache(null);
    const out = render({
      assetVersionId: null,
      cache,
      presignEnabled: true,
      fallback: { kind: 'text', caption: 'Launch day is here' },
    });
    expect(out).toContain('Launch day is here');
    expect(out).toContain('italic');
    expect(out).not.toContain('<img');
  });

  it('(e) renders a glyph fallback', () => {
    const { cache } = makeCache(null);
    const out = render({
      assetVersionId: null,
      cache,
      presignEnabled: true,
      fallback: { kind: 'glyph' },
    });
    expect(out).toContain('<svg');
    expect(out).not.toContain('<img');
  });

  it('(f) does not resolve or peek when presign is disabled or the id is null', () => {
    const disabled = makeCache('https://cdn.example/thumb.jpg');
    const offOut = render({
      assetVersionId: 'av1',
      cache: disabled.cache,
      presignEnabled: false,
      fallback: { kind: 'glyph' },
    });
    expect(disabled.peek).not.toHaveBeenCalled();
    expect(disabled.resolve).not.toHaveBeenCalled();
    expect(offOut).not.toContain('<img');

    const nullId = makeCache('https://cdn.example/thumb.jpg');
    const nullOut = render({
      assetVersionId: null,
      cache: nullId.cache,
      presignEnabled: true,
      fallback: { kind: 'glyph' },
    });
    expect(nullId.peek).not.toHaveBeenCalled();
    expect(nullId.resolve).not.toHaveBeenCalled();
    expect(nullOut).not.toContain('<img');
  });

  it('(g) defaults to a square frame and applies the 4:3 frame when asked', () => {
    const { cache } = makeCache(null);
    const square = render({
      assetVersionId: null,
      cache,
      presignEnabled: true,
      fallback: { kind: 'glyph' },
    });
    expect(square).toContain('aspect-square');
    expect(square).not.toContain('aspect-[4/3]');

    const wide = render({
      assetVersionId: null,
      cache,
      presignEnabled: true,
      aspect: '4/3',
      fallback: { kind: 'glyph' },
    });
    expect(wide).toContain('aspect-[4/3]');
    expect(wide).not.toContain('aspect-square');
  });

  it('(h) paints a known small copy on the first frame, never waiting for the original', () => {
    const { cache, peekThumbnail, resolve } = makeCache(null, 'https://cdn.example/small.jpg');
    const out = render({
      assetVersionId: 'av1',
      cache,
      presignEnabled: true,
      fallback: { kind: 'glyph' },
    });
    expect(out).toContain('https://cdn.example/small.jpg');
    expect(out).toContain('data-thumb-small');
    expect(out).not.toContain('animate-pulse');
    expect(peekThumbnail).toHaveBeenCalledWith('av1');
    expect(resolve).not.toHaveBeenCalled();
  });

  it('(i) never peeks a small copy when presign is off or there is no version', () => {
    const { cache, peekThumbnail } = makeCache(null, 'https://cdn.example/small.jpg');
    render({ assetVersionId: null, cache, presignEnabled: true, fallback: { kind: 'glyph' } });
    render({ assetVersionId: 'av1', cache, presignEnabled: false, fallback: { kind: 'glyph' } });
    expect(peekThumbnail).not.toHaveBeenCalled();
  });

  it('fix 1: bodyLines 3 clamps the post tile to 3 lines; the default class is unchanged', () => {
    const { cache } = makeCache(null);
    const fallback: ThumbnailFallback = {
      kind: 'post',
      glyph: 'text',
      label: 'Text',
      body: 'Launch day is here',
      layout: 'text',
    };
    const three = renderToStaticMarkup(
      <Thumbnail
        alt="alt text"
        assetVersionId={null}
        cache={cache}
        presignEnabled={false}
        fallback={fallback}
        bodyLines={3}
      />,
    );
    expect(three).toContain('class="mt-auto line-clamp-3 text-sm leading-snug text-fg-2"');
    expect(three).not.toContain('line-clamp-4');
    const pipeline = renderToStaticMarkup(
      <Thumbnail
        alt="alt text"
        assetVersionId={null}
        cache={cache}
        presignEnabled={false}
        fallback={fallback}
      />,
    );
    expect(pipeline).toContain(
      'class="mt-auto line-clamp-4 text-sm leading-snug text-fg-2"',
    );
    expect(pipeline).not.toContain('line-clamp-3');
  });

  it('fix 30: a caller-drawn fallbackTile replaces the fallback when there is no image', () => {
    const { cache } = makeCache(null);
    const out = renderToStaticMarkup(
      <Thumbnail
        alt="alt text"
        assetVersionId={null}
        cache={cache}
        presignEnabled={true}
        fallback={{ kind: 'glyph' }}
        fallbackTile={<span data-custom-tile="">deck.pdf</span>}
      />,
    );
    expect(out).toContain('data-custom-tile');
    expect(out).toContain('deck.pdf');
    expect(out).not.toContain('<img');
  });
});
