import { describe, expect, it } from 'vitest';
import { FORMATS_BY_PLATFORM, POST_PLATFORMS } from '@srtdio/posts';
import { frameFor, formatDefaultSize, type FrameMedia } from '@/lib/platform-specs';
import { cutPercent, frameMap } from '@/components/pages/pcs/pin-annotations';

const img = (w: number | null, h: number | null): FrameMedia => ({ kind: 'image', w, h });
const vid = (w: number | null, h: number | null): FrameMedia => ({ kind: 'video', w, h });

const WIDE = { w: 1920, h: 1080 }; // 16:9
const PORTRAIT = { w: 1080, h: 1350 }; // 4:5
const TALL = { w: 1080, h: 1920 }; // 9:16

/** The frame, crop % and bands a fixture gets on a platform's feed format. */
function outcome(platform: string, format: string, media: { w: number; h: number }) {
  const frame = frameFor(platform, format, img(media.w, media.h));
  if (frame === null) throw new Error('no frame');
  const map = frameMap(media, frame.ratio, frame.fit);
  const bands = map.box.w < 0.995 || map.box.h < 0.995;
  return { ratio: frame.ratio, cut: cutPercent(map), bands, fit: frame.fit };
}

// platform -> its feed format used for the table, and the expected outcome per
// fixture: [ratio, cut %, bands].
const TABLE: Array<
  [string, string, Record<'wide' | 'portrait' | 'tall', [number, number, boolean]>]
> = [
  [
    'instagram',
    'carousel',
    { wide: [16 / 9, 0, false], portrait: [4 / 5, 0, false], tall: [3 / 4, 25, false] },
  ],
  [
    'facebook',
    'single_image',
    { wide: [16 / 9, 0, false], portrait: [4 / 5, 0, false], tall: [4 / 5, 30, false] },
  ],
  [
    'linkedin',
    'carousel',
    { wide: [16 / 9, 0, false], portrait: [4 / 5, 0, false], tall: [4 / 5, 30, false] },
  ],
  [
    'x',
    'single_image',
    { wide: [16 / 9, 0, false], portrait: [4 / 5, 0, false], tall: [4 / 5, 30, false] },
  ],
  [
    'threads',
    'carousel',
    { wide: [16 / 9, 0, false], portrait: [4 / 5, 0, false], tall: [9 / 16, 0, false] },
  ],
  [
    'tiktok',
    'video',
    { wide: [9 / 16, 0, true], portrait: [9 / 16, 0, true], tall: [9 / 16, 0, false] },
  ],
  [
    'youtube_shorts',
    'short',
    { wide: [9 / 16, 0, true], portrait: [9 / 16, 0, true], tall: [9 / 16, 0, false] },
  ],
];

describe('frameFor: every platform with a 16:9, a 4:5 and a 9:16 image', () => {
  for (const [platform, format, want] of TABLE) {
    for (const [name, media] of [
      ['wide', WIDE],
      ['portrait', PORTRAIT],
      ['tall', TALL],
    ] as const) {
      it(`${platform} ${name}`, () => {
        const got = outcome(platform, format, media);
        const [ratio, cut, bands] = want[name];
        expect(got.ratio).toBeCloseTo(ratio, 6);
        expect(got.cut).toBe(cut);
        expect(got.bands).toBe(bands);
      });
    }
  }
});

describe('frameFor: platform behaviour', () => {
  it('regression: Facebook and LinkedIn never force a 16:9 image into 4:5', () => {
    for (const p of ['facebook', 'linkedin']) {
      const f = frameFor(p, p === 'facebook' ? 'single_image' : 'carousel', img(1920, 1080));
      expect(f?.ratio).not.toBeCloseTo(0.8);
      expect(f?.ratio).toBeCloseTo(16 / 9);
    }
  });
  it('Facebook / LinkedIn / Instagram cap wide media at 1.91:1 with a centre crop', () => {
    for (const [p, f] of [
      ['facebook', 'single_image'],
      ['linkedin', 'single_image'],
      ['instagram', 'single_image'],
    ] as const) {
      const got = outcome(p, f, { w: 3000, h: 1000 });
      expect(got.ratio).toBeCloseTo(1.91);
      expect(got.fit).toBe('cover');
      expect(got.cut).toBe(36);
    }
  });
  it('X caps wide media at 16:9', () => {
    expect(outcome('x', 'single_image', { w: 3000, h: 1000 }).ratio).toBeCloseTo(16 / 9);
  });
  it('Threads never cuts: outside 1.91:1 to 9:16 it fits with bands', () => {
    const wide = outcome('threads', 'carousel', { w: 3000, h: 1000 });
    expect(wide).toMatchObject({ cut: 0, bands: true, fit: 'contain' });
    expect(wide.ratio).toBeCloseTo(1.91);
    const tall = outcome('threads', 'carousel', { w: 1000, h: 3000 });
    expect(tall).toMatchObject({ cut: 0, bands: true, fit: 'contain' });
    expect(tall.ratio).toBeCloseTo(9 / 16);
  });
  it('TikTok bands are black, YouTube Shorts bands blurred; both always 9:16', () => {
    expect(frameFor('tiktok', 'video', img(1920, 1080))).toMatchObject({
      fit: 'contain',
      bands: 'black',
    });
    expect(frameFor('youtube_shorts', 'short', img(1920, 1080))).toMatchObject({
      fit: 'contain',
      bands: 'blur',
    });
    expect(frameFor('tiktok', 'video', null)?.ratio).toBeCloseTo(9 / 16);
    expect(frameFor('youtube_shorts', 'short', vid(1920, 1080))?.ratio).toBeCloseTo(9 / 16);
  });
  it('Instagram / Facebook reels and stories are 9:16, cropped to fill', () => {
    for (const [p, f] of [
      ['instagram', 'reel'],
      ['instagram', 'story'],
      ['facebook', 'reel'],
      ['facebook', 'story'],
    ] as const) {
      expect(frameFor(p, f, img(1920, 1080))).toMatchObject({ fit: 'cover', source: 'fixed' });
      expect(frameFor(p, f, img(1920, 1080))?.ratio).toBeCloseTo(9 / 16);
    }
  });
  it('LinkedIn video keeps its 1:2.4 to 2.4:1 range', () => {
    expect(frameFor('linkedin', 'video', vid(3000, 1000))?.ratio).toBeCloseTo(2.4);
    expect(frameFor('linkedin', 'video', vid(1000, 3000))?.ratio).toBeCloseTo(1 / 2.4);
  });
  it('text and link have no media box', () => {
    for (const p of POST_PLATFORMS) {
      for (const f of ['text', 'link']) expect(frameFor(p, f, img(1080, 1080))).toBeNull();
    }
  });
  it('before the first media size is known, the format default stands in (Threads still fits)', () => {
    expect(frameFor('instagram', 'carousel', null)).toMatchObject({
      source: 'default',
      fit: 'cover',
    });
    expect(frameFor('threads', 'carousel', img(null, null))).toMatchObject({ fit: 'contain' });
  });
  it('every offered media format resolves to a frame', () => {
    for (const p of POST_PLATFORMS) {
      for (const f of FORMATS_BY_PLATFORM[p]) {
        if (f === 'text' || f === 'link') continue;
        expect(frameFor(p, f, null), `${p}/${f}`).not.toBeNull();
        expect(formatDefaultSize(p, f), `${p}/${f}`).not.toBeNull();
      }
    }
  });
  it('unknown keys have no frame', () => {
    expect(frameFor('twitter', 'single_image', null)).toBeNull();
    expect(frameFor('x', 'image', null)).toBeNull();
  });
});
