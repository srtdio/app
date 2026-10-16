import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { frameFor, type Frame } from '@/lib/platform-specs';
import { frameMap, IDENTITY_MAP } from '@/components/pages/pcs/pin-annotations';
import {
  CHAT_CARD_FRAME_MAX_HEIGHT,
  COMPOSER_FRAME_MAX_HEIGHT,
  frameBandClass,
  frameBoxStyle,
  frameCutText,
  frameMediaClass,
  galleryItemMedia,
  PlatformFrame,
  PlatformFrameUpload,
} from '@/components/media/PlatformFrame';
import type { GalleryItem } from '@srtdio/posts';

/** The frame before any media size is known: the format's default size. */
const empty = (platform: string, format: string): Frame | null => frameFor(platform, format, null);

const COVER: Frame = { ratio: 0.8, source: 'default', fit: 'cover', bands: 'none' };

describe('platform frame rule (no media yet)', () => {
  it('Instagram Reel and Story are 9:16, cropped to fill', () => {
    for (const format of ['reel', 'story']) {
      const frame = empty('instagram', format);
      expect(frame?.ratio).toBeCloseTo(9 / 16);
      expect(frame?.fit).toBe('cover');
    }
  });

  it('Instagram single image defaults to the 4:5 portrait', () => {
    expect(empty('instagram', 'single_image')?.ratio).toBeCloseTo(1080 / 1350);
  });

  it('LinkedIn image defaults to its portrait size, and takes the photo ratio once known', () => {
    expect(empty('linkedin', 'single_image')?.ratio).toBeCloseTo(1080 / 1350);
    const wide = frameFor('linkedin', 'single_image', { kind: 'image', w: 1200, h: 627 });
    expect(wide?.ratio).toBeCloseTo(1200 / 627);
  });

  it('YouTube Shorts video is 9:16 with blurred bands, never cropped', () => {
    const frame = frameFor('youtube_shorts', 'short', { kind: 'video', w: 1920, h: 1080 });
    expect(frame).toEqual({ ratio: 9 / 16, source: 'fixed', fit: 'contain', bands: 'blur' });
  });

  it('text has no frame', () => {
    expect(empty('linkedin', 'text')).toBeNull();
    expect(empty('x', 'text')).toBeNull();
    expect(empty('linkedin', 'link')).toBeNull();
  });
});

describe('frame box size', () => {
  it('composer: full column width, height from the ratio, capped at 60vh', () => {
    expect(COMPOSER_FRAME_MAX_HEIGHT).toBe('60vh');
    // 9:16 bites the cap: at most 60vh x 0.5625 = 33.75vh wide, so 60vh tall.
    expect(frameBoxStyle(9 / 16, COMPOSER_FRAME_MAX_HEIGHT)).toEqual({
      width: 'min(100%, calc(60vh * 0.5625))',
      aspectRatio: '0.5625',
    });
    expect(frameBoxStyle(16 / 9, COMPOSER_FRAME_MAX_HEIGHT).aspectRatio).toBe(String(16 / 9));
  });

  it('chat card: 240px column, capped at 320px tall (a 9:16 card media is 180 x 320)', () => {
    expect(CHAT_CARD_FRAME_MAX_HEIGHT).toBe('320px');
    expect(frameBoxStyle(9 / 16, CHAT_CARD_FRAME_MAX_HEIGHT).width).toBe(
      'min(100%, calc(320px * 0.5625))',
    );
    // 4:5 under the cap: min(240px, 256px) = the full 240px, 300px tall.
    expect(frameBoxStyle(0.8, CHAT_CARD_FRAME_MAX_HEIGHT).width).toBe(
      'min(100%, calc(320px * 0.8))',
    );
  });
});

describe('frame paint', () => {
  it('bands are black, an unbanded frame a theme token', () => {
    expect(frameBandClass(COVER)).toBe('bg-panel-2');
    expect(frameBandClass({ ...COVER, bands: 'black' })).toBe('bg-black');
    expect(frameBandClass({ ...COVER, bands: 'blur' })).toBe('bg-black');
    expect(frameMediaClass(COVER)).toContain('object-cover');
    expect(frameMediaClass({ ...COVER, fit: 'contain' })).toContain('object-contain');
  });

  it('the empty frame is a dashed token surface; the blur backdrop only draws with media', () => {
    const blur: Frame = { ratio: 9 / 16, source: 'fixed', fit: 'contain', bands: 'blur' };
    const emptyHtml = renderToStaticMarkup(
      <PlatformFrame frame={blur} maxHeight="60vh" empty backdrop={<i data-backdrop="" />}>
        {null}
      </PlatformFrame>,
    );
    expect(emptyHtml).toContain('data-frame-empty');
    expect(emptyHtml).toContain('border-dashed border-border-strong bg-panel-2');
    expect(emptyHtml).not.toContain('bg-black');
    expect(emptyHtml).not.toContain('data-backdrop');
    const filled = renderToStaticMarkup(
      <PlatformFrame frame={blur} maxHeight="60vh" backdrop={<i data-backdrop="" />}>
        <img alt="" />
      </PlatformFrame>,
    );
    expect(filled).toContain('data-backdrop');
    expect(filled).toContain('border-border');
    expect(filled).toContain('bg-black');
  });

  it('the upload frame is one 44px+ button', () => {
    const html = renderToStaticMarkup(
      <PlatformFrameUpload
        frame={COVER}
        maxHeight="60vh"
        label="Add a photo or video"
        onPick={() => {}}
      />,
    );
    expect(html).toContain('min-h-[44px]');
    expect(html).toContain('h-11 w-11');
    expect(html.match(/<button/g)).toHaveLength(1);
  });
});

describe('frame helpers', () => {
  it('the cut text names the share of the photo outside the frame', () => {
    expect(frameCutText(IDENTITY_MAP, 'Instagram')).toBeNull();
    expect(frameCutText(frameMap({ w: 1080, h: 1920 }, 0.8, 'cover'), 'Facebook')).toBe(
      '30% outside the Facebook frame.',
    );
  });

  it('a gallery item reads as image, video or other for the frame rule', () => {
    const base: GalleryItem = {
      assetAttachmentId: 'a',
      assetVersionId: 'v',
      assetId: 'x',
      position: 0,
      filename: 'f',
      mimeType: null,
      kind: 'file',
      width: null,
      height: null,
      durationMs: null,
      pageCount: null,
      r2Key: null,
      externalUrl: null,
    };
    expect(galleryItemMedia({ ...base, kind: 'image' }, { w: 4, h: 5 })).toEqual({
      kind: 'image',
      w: 4,
      h: 5,
    });
    expect(galleryItemMedia({ ...base, mimeType: 'video/mp4' }, null).kind).toBe('video');
    expect(galleryItemMedia(base, null).kind).toBe('other');
  });
});
