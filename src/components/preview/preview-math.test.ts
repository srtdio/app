import { describe, expect, it } from 'vitest';
import { POST_PLATFORMS } from '@srtdio/posts';
import { PLATFORM_SPECS, type PlatformSize } from '@/lib/platform-specs';
import {
  cropFor,
  cropLine,
  defaultSizeFor,
  formatDefaultSize,
  formatFrameRatio,
  postSize,
  ratioLabel,
  sizeMeta,
  sizesFor,
  specFor,
} from '@/components/preview/preview-math';

const size = (w: number, h: number, layout: PlatformSize['layout'] = 'feed'): PlatformSize => ({
  label: 'x',
  w,
  h,
  layout,
});

describe('spec lookup', () => {
  it('has a spec for every platform key', () => {
    for (const p of POST_PLATFORMS) expect(specFor(p)).toBe(PLATFORM_SPECS[p]);
  });
  it('returns null / empty for an unknown key', () => {
    expect(specFor('twitter')).toBeNull();
    expect(sizesFor('twitter', 'image')).toEqual([]);
  });
  it('each non-empty list has exactly one default', () => {
    for (const p of POST_PLATFORMS) {
      for (const media of ['image', 'video'] as const) {
        const list = PLATFORM_SPECS[p][media];
        if (list.length > 0) expect(list.filter((s) => s.isDefault).length).toBe(1);
      }
    }
  });
  it('YouTube Shorts takes no image', () => {
    expect(sizesFor('youtube_shorts', 'image')).toEqual([]);
    expect(specFor('youtube_shorts')?.imageUnsupported).toBe('Shorts are video only.');
  });
  it('reads the verified values', () => {
    expect(sizesFor('instagram', 'image')[0]).toMatchObject({ w: 1080, h: 1350 });
    expect(sizesFor('x', 'image')[0]).toMatchObject({ label: 'Landscape', w: 1600, h: 900 });
    expect(sizesFor('linkedin', 'image')[0]).toMatchObject({ w: 1200, h: 627 });
  });
});

describe('format default size', () => {
  it('reel / story / short / tiktok video are 9:16', () => {
    expect(formatFrameRatio('instagram', 'reel')).toBeCloseTo(9 / 16);
    expect(formatFrameRatio('instagram', 'story')).toBeCloseTo(9 / 16);
    expect(formatFrameRatio('facebook', 'reel')).toBeCloseTo(9 / 16);
    expect(formatFrameRatio('youtube_shorts', 'short')).toBeCloseTo(9 / 16);
    expect(formatFrameRatio('tiktok', 'video')).toBeCloseTo(9 / 16);
  });
  it('single image / carousel use the platform default image size', () => {
    expect(formatDefaultSize('instagram', 'single_image')?.size).toMatchObject({
      w: 1080,
      h: 1350,
    });
    expect(formatDefaultSize('x', 'single_image')?.size).toMatchObject({ w: 1600, h: 900 });
    expect(formatDefaultSize('linkedin', 'carousel')?.size).toMatchObject({ w: 1080, h: 1350 });
    expect(formatDefaultSize('threads', 'carousel')?.size).toMatchObject({ w: 1080, h: 1350 });
  });
  it('text and link have no frame', () => {
    expect(formatFrameRatio('x', 'text')).toBeNull();
    expect(formatFrameRatio('linkedin', 'link')).toBeNull();
    expect(formatFrameRatio('x', 'nope')).toBeNull();
  });
  it('the panel falls back to the media list default when the format is the other kind', () => {
    expect(defaultSizeFor('instagram', 'reel', 'image')?.label).toBe('Tall');
    expect(defaultSizeFor('instagram', 'story', 'video')?.label).toBe('Story');
    expect(defaultSizeFor('instagram', 'carousel', 'video')?.label).toBe('Feed');
  });
});

describe('panel default follows the post frame', () => {
  it('opens on the size nearest the frame the post page shows', () => {
    expect(defaultSizeFor('instagram', 'carousel', 'image', { w: 1080, h: 1080 })?.label).toBe(
      'Square',
    );
    expect(defaultSizeFor('instagram', 'single_image', 'image', { w: 1920, h: 1080 })?.label).toBe(
      'Landscape',
    );
    expect(defaultSizeFor('linkedin', 'carousel', 'image', { w: 1920, h: 1080 })?.label).toBe(
      'Landscape',
    );
    expect(defaultSizeFor('linkedin', 'carousel', 'image', { w: 1080, h: 1920 })?.label).toBe(
      'Portrait',
    );
    expect(defaultSizeFor('instagram', 'story', 'video', { w: 1920, h: 1080 })?.label).toBe(
      'Story',
    );
  });
});

describe('ratio labels', () => {
  it('names published ratios', () => {
    expect(ratioLabel(1080, 1350)).toBe('4:5');
    expect(ratioLabel(1080, 1920)).toBe('9:16');
    expect(ratioLabel(1080, 566)).toBe('1.91:1');
    expect(ratioLabel(1200, 630)).toBe('1.91:1');
    expect(ratioLabel(1200, 627)).toBe('1.91:1');
    expect(sizeMeta(size(1080, 1440))).toBe('1080 x 1440 · 3:4');
  });
});

describe('crop math', () => {
  it('fits exactly', () => {
    const r = cropFor({ w: 2160, h: 2700 }, size(1080, 1350));
    expect(r.kind).toBe('fits');
    expect(cropLine(r)).toBe('Fits exactly');
  });
  it('cuts the sides of a wider original', () => {
    const r = cropFor({ w: 1920, h: 1080 }, size(1080, 1080));
    expect(r).toMatchObject({ kind: 'cut', pct: 44, from: 'sides' });
    expect(cropLine(r)).toBe('44% cut from sides');
    expect(r.window.w).toBeCloseTo(0.5625);
    expect(r.window.x).toBeCloseTo(0.21875);
  });
  it('cuts top and bottom of a taller original', () => {
    const r = cropFor({ w: 1080, h: 1920 }, size(1080, 1350));
    expect(r).toMatchObject({ kind: 'cut', pct: 30, from: 'top and bottom' });
    expect(cropLine(r)).toBe('30% cut from top and bottom');
    expect(r.window.h).toBeCloseTo(0.703125);
  });
  it('shows bands / letterbox without a crop', () => {
    const bands = cropFor({ w: 1920, h: 1080 }, size(1080, 1920, 'bands'));
    expect(bands.kind).toBe('bands');
    expect(cropLine(bands)).toBe('Shown with bands');
    expect(bands.window).toEqual({ x: 0, y: 0, w: 1, h: 1 });
    expect(cropFor({ w: 1080, h: 1080 }, size(1080, 1080, 'letterbox')).kind).toBe('bands');
    expect(cropFor({ w: 720, h: 1280 }, size(1080, 1920, 'bands')).kind).toBe('fits');
  });
  it('treats a sub-0.5% cut as a fit and a zero dimension as a fit', () => {
    expect(cropFor({ w: 1081, h: 1350 }, size(1080, 1350)).kind).toBe('fits');
    expect(cropFor({ w: 0, h: 10 }, size(1080, 1350)).kind).toBe('fits');
  });
});

// The verified table: label WxH, * = default.
const T: Record<string, [string, string]> = {
  instagram: [
    'Portrait 1080x1350*,Tall 1080x1440,Square 1080x1080,Landscape 1080x566',
    'Reel 1080x1920*,Story 1080x1920,Feed 1080x1350',
  ],
  facebook: [
    'Portrait 1080x1350*,Square 1080x1080,Landscape 1200x630',
    'Feed 1080x1350*,Feed square 1080x1080,Reel 1080x1920,Story 1080x1920',
  ],
  linkedin: [
    'Landscape 1200x627,Square 1080x1080,Portrait 1080x1350*',
    'Landscape 1920x1080*,Square 1080x1080,Portrait 1080x1350,Vertical 1080x1920',
  ],
  x: [
    'Landscape 1600x900*,Square 1080x1080,Portrait 1080x1350',
    'Landscape 1920x1080*,Vertical 1080x1920,Square 1080x1080',
  ],
  youtube_shorts: ['', 'Short 1080x1920*'],
  tiktok: ['Vertical 1080x1920*', 'Vertical 1080x1920*,Landscape 1920x1080,Square 1080x1080'],
  threads: [
    'Portrait 1080x1350*,Square 1080x1080',
    'Vertical 1080x1920*,Portrait 1080x1350,Square 1080x1080',
  ],
};
it('matches the verified 16 Oct 2026 table exactly', () => {
  for (const [p, [img, vid]] of Object.entries(T)) {
    const s = PLATFORM_SPECS[p as keyof typeof PLATFORM_SPECS];
    const f = (l: typeof s.image) =>
      l.map((z) => `${z.label} ${z.w}x${z.h}${z.isDefault ? '*' : ''}`).join(',');
    expect(f(s.image), p).toBe(img);
    expect(f(s.video), p).toBe(vid);
  }
  expect(PLATFORM_SPECS.youtube_shorts.video[0]?.layout).toBe('bands');
  expect(PLATFORM_SPECS.tiktok.video.slice(1).map((z) => z.layout)).toEqual([
    'letterbox',
    'letterbox',
  ]);
});

describe('postSize: the panel opens on the frame the post page shows', () => {
  it('matches frameFor for crop and bands', () => {
    expect(postSize('instagram', 'carousel', 'image', { w: 1920, h: 1080 })).toMatchObject({
      label: 'This post',
      w: 1920,
      h: 1080,
      layout: 'feed',
    });
    expect(postSize('facebook', 'single_image', 'image', { w: 1080, h: 1920 })).toMatchObject({
      w: 1080,
      h: 1350,
      layout: 'feed',
    });
    const tiktok = postSize('tiktok', 'video', 'image', { w: 1920, h: 1080 });
    expect(tiktok?.layout).toBe('letterbox');
    expect(tiktok?.feedCard).toBeUndefined();
    expect(postSize('youtube_shorts', 'short', 'image', { w: 1920, h: 1080 })?.layout).toBe(
      'bands',
    );
    const threads = postSize('threads', 'carousel', 'image', { w: 3000, h: 1000 });
    expect(threads).toMatchObject({ layout: 'letterbox', feedCard: true });
  });
  it('crop line agrees with the page: bands never cut', () => {
    const tiktok = postSize('tiktok', 'video', 'image', { w: 1920, h: 1080 });
    if (tiktok === null) throw new Error('size');
    expect(cropLine(cropFor({ w: 1920, h: 1080 }, tiktok))).toBe('Shown with bands');
    expect(cropLine(cropFor({ w: 1080, h: 1920 }, tiktok))).toBe('Fits exactly');
    const ig = postSize('instagram', 'carousel', 'image', { w: 1080, h: 1920 });
    if (ig === null) throw new Error('size');
    expect(cropLine(cropFor({ w: 1080, h: 1920 }, ig))).toBe('25% cut from top and bottom');
  });
});
