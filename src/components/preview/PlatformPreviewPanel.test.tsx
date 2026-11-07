import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { GalleryItem } from '@srtdio/posts';
import { POST_PLATFORMS } from '@srtdio/posts';
import { PresignCache } from '@/lib/asset-presign';
import { fetchWithTrace } from '@/lib/fetch';
import {
  PreviewBody,
  previewChipLabel,
  previewMediaKind,
} from '@/components/preview/PlatformPreviewPanel';

const cache = new PresignCache({
  endpoint: null,
  getAccessToken: async () => null,
  fetcher: fetchWithTrace,
});

function item(over: Partial<GalleryItem>): GalleryItem {
  return {
    assetAttachmentId: 'aa',
    assetVersionId: 'v1',
    assetId: 'a1',
    position: 0,
    filename: 'file',
    mimeType: null,
    kind: 'file',
    width: null,
    height: null,
    durationMs: null,
    pageCount: null,
    r2Key: null,
    externalUrl: null,
    ...over,
  };
}

function body(platform: string, format: string, media: GalleryItem | null): string {
  return renderToStaticMarkup(
    <PreviewBody
      platform={platform}
      format={format}
      caption="Hello there"
      handle="Test Workspace"
      firstMedia={media}
      cache={cache}
      presignEnabled={false}
    />,
  );
}

const portrait = item({ kind: 'image', width: 1080, height: 1350 });
const tallVideo = item({ kind: 'video', mimeType: 'video/mp4', width: 1080, height: 1920 });

describe('PlatformPreviewPanel', () => {
  it('labels the chip by platform', () => {
    expect(previewChipLabel('instagram')).toBe('Instagram preview');
    expect(previewChipLabel('youtube_shorts')).toBe('YouTube Shorts preview');
    expect(previewChipLabel('linkedin')).toBe('LinkedIn preview');
  });
  it('classifies the first media', () => {
    expect(previewMediaKind(null)).toBe('none');
    expect(previewMediaKind(item({ kind: 'image' }))).toBe('image');
    expect(previewMediaKind(item({ mimeType: 'video/mp4' }))).toBe('video');
    expect(previewMediaKind(item({ mimeType: 'application/pdf' }))).toBe('document');
  });
  it('has no size picker and no separate Crop section', () => {
    for (const html of [
      body('instagram', 'single_image', portrait),
      body('linkedin', 'carousel', portrait),
      body('tiktok', 'video', tallVideo),
    ]) {
      expect(html).not.toContain('role="radiogroup"');
      expect(html).not.toContain('role="radio"');
      expect(html).not.toContain('aria-label="Crop"');
      expect(html).not.toContain('This post');
      expect(html).not.toContain('Original ·');
      expect(html).not.toContain('Shown<');
    }
  });
  it('says Shorts are video only for an image, and still shows it in the 9:16 frame', () => {
    const html = body(
      'youtube_shorts',
      'short',
      item({ kind: 'image', width: 1920, height: 1080 }),
    );
    expect(html).toContain('Shorts are video only.');
    expect(html).toContain('Full-screen preview');
    expect(html).toContain('Shown with bands');
  });
  it('shows documents as-is', () => {
    expect(body('linkedin', 'carousel', item({ mimeType: 'application/pdf' }))).toContain(
      'no crop',
    );
  });
});

describe('every platform renders its own chrome', () => {
  const FEED: readonly string[] = ['instagram', 'facebook', 'linkedin', 'x', 'threads'];
  for (const platform of POST_PLATFORMS) {
    it(`${platform}: header, caption, media and the static action glyphs`, () => {
      const full = !FEED.includes(platform);
      const html = full
        ? body(platform, platform === 'youtube_shorts' ? 'short' : 'video', tallVideo)
        : body(platform, 'single_image', portrait);
      expect(html).toContain(`data-preview-platform="${platform}"`);
      expect(html).toContain(
        full ? 'data-preview-chrome="full"' : `data-preview-chrome="feed-${platform}"`,
      );
      // The workspace name heads the post (never a hardcoded account).
      expect(html).toContain('Test Workspace');
      expect(html).toContain('Hello there');
      // The action row / rail: glyphs only, hidden from assistive tech, no controls.
      expect(html).toMatch(/<span aria-hidden="true" data-preview-actions=""[^>]*>(<svg)/);
      const actions = html.slice(html.indexOf('data-preview-actions'));
      expect(actions.slice(0, actions.indexOf('</span>'))).not.toContain('<button');
      // Platform colours are named pv-* tokens; never a raw hex in the markup.
      expect(html).toContain(full ? 'bg-pv-screen' : 'bg-pv-card');
      expect(html).not.toMatch(/#[0-9a-fA-F]{6}\b/);
    });
  }

  it('feed captions clamp at 3 lines, full-screen captions at 2', () => {
    expect(body('instagram', 'single_image', portrait)).toContain('-webkit-line-clamp:3');
    expect(body('instagram', 'reel', tallVideo)).toContain('-webkit-line-clamp:2');
  });

  it('Facebook and LinkedIn sit the card on their own page colour', () => {
    expect(body('facebook', 'single_image', portrait)).toContain('bg-pv-fb-page');
    expect(body('linkedin', 'single_image', portrait)).toContain('bg-pv-li-page');
  });
});

describe('placement from the post format', () => {
  it('reel and short are full screen, story is the story frame', () => {
    expect(body('instagram', 'reel', tallVideo)).toContain('Full-screen preview');
    expect(body('facebook', 'reel', tallVideo)).toContain('Full-screen preview');
    expect(body('youtube_shorts', 'short', tallVideo)).toContain('Full-screen preview');
    expect(body('instagram', 'story', tallVideo)).toContain('Story preview');
  });
  it('single image, carousel and text are feed posts', () => {
    expect(body('instagram', 'single_image', portrait)).toContain('Feed preview');
    expect(body('linkedin', 'carousel', portrait)).toContain('Feed preview');
    const text = body('x', 'text', null);
    expect(text).toContain('Feed preview');
    expect(text).toContain('Hello there');
    expect(text).not.toContain('data-preview-media');
    expect(text).not.toContain('data-preview-cut');
  });
  it('offers Reel / Story / Feed chips only for a plain video on Instagram or Facebook', () => {
    for (const platform of POST_PLATFORMS) {
      for (const format of ['video', 'reel', 'story', 'single_image', 'carousel', 'text']) {
        const media = format === 'text' ? null : format.includes('image') ? portrait : tallVideo;
        const html = body(platform, format, media);
        const open = format === 'video' && (platform === 'instagram' || platform === 'facebook');
        expect(html.includes('aria-label="Placement"'), `${platform} ${format}`).toBe(open);
      }
    }
    const html = body('instagram', 'video', tallVideo);
    for (const label of ['Reel', 'Story', 'Feed']) expect(html).toContain(`>${label}<`);
    // Opens on Feed: the only pressed chip is Feed, and the card is the feed card.
    expect(html.match(/aria-pressed="true"/g)?.length).toBe(1);
    expect(html).toMatch(/aria-pressed="true"[^>]*>(?:<[^>]+>)*Feed</);
    expect(html).toContain('Feed preview');
  });
  it('a plain video on Instagram with no size yet still opens in the feed card', () => {
    expect(body('instagram', 'video', item({ kind: 'video', mimeType: 'video/mp4' }))).toContain(
      'Feed preview',
    );
  });
});

describe('the one line under the post', () => {
  it('names the platform, the share cut and the side, with Show cut', () => {
    const html = body(
      'instagram',
      'single_image',
      item({ kind: 'image', width: 1080, height: 1920 }),
    );
    expect(html).toContain('Instagram cuts 25% from top and bottom');
    expect(html).toContain('Show cut');
    expect(html).toMatch(/aria-pressed="false"[^>]*>(?:<[^>]+>)*Show cut</);
    expect(html).not.toContain('data-cut-strip');
  });
  it('a fit reads Fits exactly, with no Show cut', () => {
    const html = body('instagram', 'single_image', portrait);
    expect(html).toContain('Fits exactly');
    expect(html).not.toContain('Show cut');
  });
  it('a banded frame reads Shown with bands', () => {
    const html = body('tiktok', 'video', item({ kind: 'video', width: 1920, height: 1080 }));
    expect(html).toContain('Shown with bands');
    expect(html).not.toContain('Show cut');
  });
  it('LinkedIn cuts from the sides of a wide photo', () => {
    const html = body(
      'linkedin',
      'single_image',
      item({ kind: 'image', width: 3000, height: 1000 }),
    );
    expect(html).toMatch(/LinkedIn cuts \d+% from sides/);
  });
});

describe('PreviewBody on a composer draft', () => {
  it('draws the unsaved caption and the local file, never presigning', () => {
    const html = renderToStaticMarkup(
      <PreviewBody
        platform="instagram"
        format="single_image"
        caption="Draft caption"
        handle="Kite"
        firstMedia={item({ kind: 'image', mimeType: 'image/png' })}
        localUrl="blob:local-photo"
      />,
    );
    expect(html).toContain('Draft caption');
    expect(html).toContain('src="blob:local-photo"');
    expect(html).toContain('Feed preview');
  });

  it('a draft Reel with no media yet opens on the 9:16 full-screen frame', () => {
    const html = renderToStaticMarkup(
      <PreviewBody
        platform="instagram"
        format="reel"
        caption="Soon"
        handle="Kite"
        firstMedia={null}
        localUrl={null}
      />,
    );
    expect(html).toContain('Full-screen preview');
    expect(html).toContain('Photos and videos show up here.');
    expect(html).toContain('Soon');
  });

  it('a draft carousel swipes every slide, with the "1 / n" pill', () => {
    const slides = ['a', 'b', 'c'].map((id) => ({
      item: item({ assetAttachmentId: id, kind: 'image', mimeType: 'image/png' }),
      localUrl: `blob:${id}`,
    }));
    const html = renderToStaticMarkup(
      <PreviewBody
        platform="instagram"
        format="carousel"
        caption="Three"
        handle="Kite"
        firstMedia={slides[0]?.item ?? null}
        localUrl="blob:a"
        slides={slides}
      />,
    );
    expect(html).toContain('aria-roledescription="carousel"');
    for (const id of ['a', 'b', 'c']) expect(html).toContain(`src="blob:${id}"`);
    expect(html).toMatch(/data-preview-pill=""[^>]*>1 \/ 3</);
  });
});
