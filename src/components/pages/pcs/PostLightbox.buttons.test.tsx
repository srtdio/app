import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { lightboxView, type LightboxViewProps } from '@/components/pages/pcs/PostLightbox';
import type { GalleryItem } from '@srtdio/posts';

// Button system: every lightbox control is the shared IconButton / Button
// (44px, 8px radius) wearing the dark overlay tokens.

vi.mock('@/components/ui/FileViewer', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, FileViewer: () => null };
});

function item(n: number): GalleryItem {
  return {
    assetAttachmentId: `aa-${n}`,
    assetVersionId: `ver-${n}`,
    assetId: `as-${n}`,
    position: n,
    filename: `image-${n}.png`,
    mimeType: 'image/png',
    kind: 'image',
    width: 1080,
    height: 1350,
    durationMs: null,
    pageCount: null,
    r2Key: `r2/${n}`,
    externalUrl: null,
  };
}

function props(overrides: Partial<LightboxViewProps> = {}): LightboxViewProps {
  return {
    items: [item(0), item(1), item(2)],
    index: 1,
    presignEnabled: true,
    chrome: true,
    busy: false,
    zoom: { scale: 1, x: 0, y: 0 },
    srcFor: (it) => `https://signed/${it.assetVersionId}`,
    failedFor: () => false,
    dimsFor: (it) =>
      it.width !== null && it.height !== null ? { width: it.width, height: it.height } : null,
    onClose: () => {},
    onPrev: () => {},
    onNext: () => {},
    onDownload: () => {},
    onTrackScroll: () => {},
    onImageLoad: () => {},
    stageGestures: {
      onPointerDown: () => {},
      onPointerMove: () => {},
      onPointerUp: () => {},
      onPointerCancel: () => {},
      onClick: () => {},
    },
    ...overrides,
  };
}

function tagFor(html: string, needle: string): string {
  const tag = (html.match(/<button[^>]*>/g) ?? []).find((t) => t.includes(needle));
  if (tag === undefined) throw new Error(`no button ${needle}`);
  return tag;
}

function classOf(tag: string): string[] {
  return (/class="([^"]*)"/.exec(tag)?.[1] ?? '').split(/\s+/);
}

function expectShared(tag: string): void {
  const cls = classOf(tag);
  expect(cls).toContain('h-11');
  expect(cls).toContain('rounded-lg');
  for (const old of ['h-9', 'h-12', 'rounded-md', 'rounded-xl', 'font-semibold', 'text-sm']) {
    expect(cls).not.toContain(old);
  }
}

describe('PostLightbox buttons', () => {
  it('"<" Back, prev, next and the manage bar are 44px buttons on overlay tokens; no X', () => {
    const html = renderToStaticMarkup(lightboxView(props({ manage: { onAddAfter: vi.fn() } })));
    expect(html).not.toContain('aria-label="Close viewer"');
    for (const label of ['Back', 'Previous image', 'Next image']) {
      const tag = tagFor(html, `aria-label="${label}"`);
      expectShared(tag);
      expect(classOf(tag)).toContain('w-11');
      expect(classOf(tag)).toContain('bg-overlay-surface');
      expect(classOf(tag)).toContain('text-overlay-fg');
    }
    for (const label of ['Download', 'Add image']) {
      const tag = tagFor(html, `aria-label="${label}"`);
      expectShared(tag);
      expect(classOf(tag)).toContain('text-overlay-fg');
    }
    // The duplicate Delete image is cut (Remove image stays, behind the Undo strip).
    expect(html).not.toContain('aria-label="Delete image"');
  });
});
