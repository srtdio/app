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
  for (const old of ['h-9', 'h-12', 'rounded-md', 'rounded-xl', 'font-semibold', 'text-xs']) {
    expect(cls).not.toContain(old);
  }
}

describe('PostLightbox buttons', () => {
  it('close, prev, next and the manage bar are 44px IconButtons on overlay tokens', () => {
    const html = renderToStaticMarkup(
      lightboxView(props({ manage: { onAddAfter: vi.fn(), onRemove: vi.fn() } })),
    );
    for (const label of ['Close viewer', 'Previous image', 'Next image']) {
      const tag = tagFor(html, `aria-label="${label}"`);
      expectShared(tag);
      expect(classOf(tag)).toContain('w-11');
      expect(classOf(tag)).toContain('bg-overlay-surface');
      expect(classOf(tag)).toContain('text-overlay-fg');
    }
    for (const label of ['Download', 'Add image', 'Delete image']) {
      const tag = tagFor(html, `aria-label="${label}"`);
      expectShared(tag);
      expect(classOf(tag)).toContain('text-overlay-fg');
    }
  });

  it('the remove confirm row: Cancel ghost, Remove secondary with bad ink', () => {
    const html = renderToStaticMarkup(
      lightboxView(
        props({
          manage: { onAddAfter: vi.fn(), onRemove: vi.fn() },
          removeConfirming: true,
          onCancelRemove: vi.fn(),
          onConfirmRemove: vi.fn(),
        }),
      ),
    );
    const buttons = html.match(/<button[^>]*>[^<]*<\/button>/g) ?? [];
    const cancel = buttons.find((b) => b.includes('>Cancel<'));
    const remove = buttons.find((b) => b.includes('>Remove<'));
    if (cancel === undefined || remove === undefined) throw new Error('no confirm row');
    expectShared(cancel);
    expectShared(remove);
    expect(classOf(remove)).toContain('text-bad');
    expect(classOf(remove)).toContain('border-border');
    expect(classOf(remove)).not.toContain('bg-bad-solid');
  });
});
