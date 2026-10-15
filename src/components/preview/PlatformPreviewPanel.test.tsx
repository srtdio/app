import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { GalleryItem } from '@srtdio/posts';
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
      open
      onClose={() => undefined}
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

describe('PlatformPreviewPanel', () => {
  it('labels the chip by platform', () => {
    expect(previewChipLabel('instagram')).toBe('Instagram preview');
    expect(previewChipLabel('youtube_shorts')).toBe('YouTube Shorts preview');
  });
  it('classifies the first media', () => {
    expect(previewMediaKind(null)).toBe('none');
    expect(previewMediaKind(item({ kind: 'image' }))).toBe('image');
    expect(previewMediaKind(item({ mimeType: 'video/mp4' }))).toBe('video');
    expect(previewMediaKind(item({ mimeType: 'application/pdf' }))).toBe('document');
  });
  it('opens on the format default size and shows the workspace handle', () => {
    const html = body(
      'instagram',
      'single_image',
      item({ kind: 'image', width: 1080, height: 1350 }),
    );
    expect(html).toContain('aria-checked="true"');
    expect(html).toMatch(/aria-checked="true"[^>]*><span[^>]*>This post</);
    expect(html).toContain('1080 x 1350 · 4:5');
    expect(html).toContain('Test Workspace');
  });
  it('says Shorts are video only for an image, and still shows it in the 9:16 frame', () => {
    const html = body(
      'youtube_shorts',
      'short',
      item({ kind: 'image', width: 1920, height: 1080 }),
    );
    expect(html).toContain('Shorts are video only.');
    expect(html).toContain('This post');
    expect(html).toContain('1080 x 1920 · 9:16');
  });
  it('shows documents as-is', () => {
    expect(body('linkedin', 'carousel', item({ mimeType: 'application/pdf' }))).toContain(
      'no crop',
    );
  });
});

describe('the preview names and sizes the post platform', () => {
  it('LinkedIn: LinkedIn preview with LinkedIn sizes', () => {
    expect(previewChipLabel('linkedin')).toBe('LinkedIn preview');
    const html = body('linkedin', 'carousel', item({ kind: 'image', width: 1080, height: 1350 }));
    expect(html).toContain('1200 x 627 · 1.91:1');
    expect(html).not.toContain('1080 x 566');
  });
  it('Instagram: Instagram preview with Instagram sizes', () => {
    expect(previewChipLabel('instagram')).toBe('Instagram preview');
    const html = body('instagram', 'carousel', item({ kind: 'image', width: 1080, height: 1350 }));
    expect(html).toContain('1080 x 566 · 1.91:1');
    expect(html).not.toContain('1200 x 627');
  });
});
