import { describe, expect, it } from 'vitest';
import { FORMATS_BY_PLATFORM, POST_PLATFORMS } from '@srtdio/posts';
import { frameFor, formatDefaultSize, type FrameMedia } from '@/lib/platform-specs';

const V = 9 / 16;
const img = (w: number | null, h: number | null): FrameMedia => ({ kind: 'image', w, h });
const vid = (w: number | null, h: number | null): FrameMedia => ({ kind: 'video', w, h });

describe('frameFor: every platform and format', () => {
  it('text and link have no media box', () => {
    for (const p of POST_PLATFORMS) {
      for (const f of ['text', 'link']) expect(frameFor(p, f, img(1080, 1080))).toBeNull();
    }
  });
  it('reel / story / short and every TikTok or Shorts post are 9:16 whatever the media', () => {
    for (const p of POST_PLATFORMS) {
      for (const f of FORMATS_BY_PLATFORM[p]) {
        const fixed =
          ['reel', 'story', 'short'].includes(f) || p === 'tiktok' || p === 'youtube_shorts';
        if (!fixed || f === 'text' || f === 'link') continue;
        expect(frameFor(p, f, img(1920, 1080)), `${p}/${f}`).toEqual({ ratio: V, source: 'fixed' });
      }
    }
  });
  it('instagram feed formats clamp the first media ratio into 1.91:1 to 3:4', () => {
    expect(frameFor('instagram', 'single_image', img(1080, 1080))).toEqual({
      ratio: 1,
      source: 'media',
    });
    expect(frameFor('instagram', 'carousel', img(1080, 1920))?.ratio).toBeCloseTo(3 / 4);
    expect(frameFor('instagram', 'carousel', img(3000, 1000))?.ratio).toBeCloseTo(1.91);
    expect(frameFor('instagram', 'single_image', img(1080, 1350))?.ratio).toBeCloseTo(0.8);
  });
  it('linkedin video clamps into 1:2.4 to 2.4:1; linkedin images use the format default', () => {
    expect(frameFor('linkedin', 'video', vid(1920, 1080))?.ratio).toBeCloseTo(16 / 9);
    expect(frameFor('linkedin', 'video', vid(3000, 1000))?.ratio).toBeCloseTo(2.4);
    expect(frameFor('linkedin', 'video', vid(1000, 3000))?.ratio).toBeCloseTo(1 / 2.4);
    expect(frameFor('linkedin', 'single_image', img(1920, 1080))).toEqual({
      ratio: 1080 / 1350,
      source: 'default',
    });
  });
  it('platforms without range data use the format default size', () => {
    expect(frameFor('x', 'single_image', img(1080, 1920))?.ratio).toBeCloseTo(16 / 9);
    expect(frameFor('x', 'video', vid(1080, 1920))?.ratio).toBeCloseTo(16 / 9);
    expect(frameFor('facebook', 'carousel', img(1920, 1080))?.ratio).toBeCloseTo(0.8);
    expect(frameFor('facebook', 'video', vid(1920, 1080))?.ratio).toBeCloseTo(0.8);
    expect(frameFor('threads', 'carousel', img(1920, 1080))?.ratio).toBeCloseTo(0.8);
    expect(frameFor('threads', 'video', vid(1920, 1080))?.ratio).toBeCloseTo(V);
  });
  it('before the first media size is known, the format default stands in', () => {
    expect(frameFor('instagram', 'carousel', img(null, null))).toEqual({
      ratio: 0.8,
      source: 'default',
    });
    expect(frameFor('instagram', 'carousel', null)?.ratio).toBeCloseTo(0.8);
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
