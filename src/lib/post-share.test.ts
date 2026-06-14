import { describe, expect, it } from 'vitest';
import {
  buildPostLink,
  canDownloadAll,
  isDownloadableImage,
  toDownloadDescriptors,
  type GalleryImageLike,
  type ResolvedDownload,
} from '@/lib/post-share';

function item(over: Partial<GalleryImageLike>): GalleryImageLike {
  return { kind: 'image', mimeType: 'image/png', ...over };
}

describe('buildPostLink', () => {
  it('joins an origin and a leading-slash path', () => {
    expect(buildPostLink('https://app.example', '/posts/p1')).toBe('https://app.example/posts/p1');
  });

  it('strips a trailing slash on the origin', () => {
    expect(buildPostLink('https://app.example/', '/posts/p1')).toBe('https://app.example/posts/p1');
  });

  it('strips multiple trailing slashes on the origin', () => {
    expect(buildPostLink('https://app.example///', '/posts/p1')).toBe(
      'https://app.example/posts/p1',
    );
  });

  it('adds a missing leading slash on the path', () => {
    expect(buildPostLink('https://app.example', 'posts/p1')).toBe('https://app.example/posts/p1');
  });

  it('preserves an origin that carries a port', () => {
    expect(buildPostLink('http://localhost:5173', '/posts/abc')).toBe(
      'http://localhost:5173/posts/abc',
    );
  });

  it('does not invent or assume any domain', () => {
    expect(buildPostLink('https://staging.internal', '/posts/x')).toBe(
      'https://staging.internal/posts/x',
    );
  });
});

describe('isDownloadableImage', () => {
  it('accepts the image kind', () => {
    expect(isDownloadableImage(item({ kind: 'image', mimeType: null }))).toBe(true);
  });

  it('accepts an image/* mime even when kind disagrees', () => {
    expect(isDownloadableImage(item({ kind: 'file', mimeType: 'image/jpeg' }))).toBe(true);
  });

  it('rejects a video', () => {
    expect(isDownloadableImage(item({ kind: 'video', mimeType: 'video/mp4' }))).toBe(false);
  });

  it('rejects a non-image file with no image mime', () => {
    expect(isDownloadableImage(item({ kind: 'file', mimeType: 'application/pdf' }))).toBe(false);
  });
});

describe('canDownloadAll', () => {
  it('is false for an empty gallery', () => {
    expect(canDownloadAll([])).toBe(false);
  });

  it('is false when no image is present', () => {
    expect(
      canDownloadAll([
        item({ kind: 'video', mimeType: 'video/mp4' }),
        item({ kind: 'file', mimeType: 'application/pdf' }),
      ]),
    ).toBe(false);
  });

  it('is true with a single image', () => {
    expect(canDownloadAll([item({})])).toBe(true);
  });

  it('is true when at least one image sits among other kinds', () => {
    expect(
      canDownloadAll([item({ kind: 'video', mimeType: 'video/mp4' }), item({ kind: 'image' })]),
    ).toBe(true);
  });
});

describe('toDownloadDescriptors', () => {
  it('returns nothing for an empty input', () => {
    expect(toDownloadDescriptors([])).toEqual([]);
  });

  it('maps a single resolved image', () => {
    const resolved: ResolvedDownload[] = [{ url: 'https://cdn/x?sig=1', filename: 'one.png' }];
    expect(toDownloadDescriptors(resolved)).toEqual([
      { url: 'https://cdn/x?sig=1', filename: 'one.png' },
    ]);
  });

  it('preserves order across many images', () => {
    const resolved: ResolvedDownload[] = [
      { url: 'u1', filename: 'a.png' },
      { url: 'u2', filename: 'b.png' },
      { url: 'u3', filename: 'c.png' },
    ];
    expect(toDownloadDescriptors(resolved).map((d) => d.filename)).toEqual([
      'a.png',
      'b.png',
      'c.png',
    ]);
  });

  it('drops items whose URL failed to resolve, keeping order', () => {
    const resolved: ResolvedDownload[] = [
      { url: 'u1', filename: 'a.png' },
      { url: null, filename: 'b.png' },
      { url: '', filename: 'c.png' },
      { url: 'u4', filename: 'd.png' },
    ];
    expect(toDownloadDescriptors(resolved)).toEqual([
      { url: 'u1', filename: 'a.png' },
      { url: 'u4', filename: 'd.png' },
    ]);
  });
});
