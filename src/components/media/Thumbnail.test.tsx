import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Thumbnail, type ThumbnailFallback } from '@/components/media';
import type { PresignCache } from '@/lib/asset-presign';

// Rendered to static markup (node SSR, no DOM): useState initializers run (so a
// warm cache.peek hit shows the image) while effects do not, which is exactly the
// lazy/off-screen state. The presign gate is asserted via the spy counts on the
// injected cache (peek is the synchronous initializer path).

function makeCache(peekUrl: string | null) {
  const peek = vi.fn(() =>
    peekUrl !== null ? { url: peekUrl, expiresAt: Date.now() + 3_600_000 } : null,
  );
  const resolve = vi.fn(async () => ({ url: 'resolved', expiresAt: Date.now() + 3_600_000 }));
  return { cache: { peek, resolve } as unknown as PresignCache, peek, resolve };
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
  it('(a) renders an <img object-cover> when a version is present and presign is enabled', () => {
    const { cache, peek } = makeCache('https://cdn.example/thumb.jpg');
    const out = render({
      assetVersionId: 'av1',
      cache,
      presignEnabled: true,
      fallback: { kind: 'glyph' },
    });
    expect(out).toContain('<img');
    expect(out).toContain('https://cdn.example/thumb.jpg');
    expect(out).toContain('object-cover');
    expect(peek).toHaveBeenCalledWith('av1');
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
});
