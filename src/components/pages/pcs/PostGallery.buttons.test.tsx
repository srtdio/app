import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  galleryFrame,
  galleryToolsRow,
  galleryView,
  reorderView,
  type ReorderModel,
} from '@/components/pages/pcs/PostGallery';
import type { PresignCache } from '@/lib/asset-presign';
import type { GalleryItem } from '@srtdio/posts';

// Button system: the gallery tools row and the reorder bar use the shared
// 44px / 8px-radius Button (the local TOOL_BUTTON recipe is gone).

function buttonTags(html: string): string[] {
  return html.match(/<button[^>]*>/g) ?? [];
}

function classOf(tag: string): string {
  return /class="([^"]*)"/.exec(tag)?.[1] ?? '';
}

/**
 * The shared Button's 44 / 8-radius face. `edgeTool`: a tools-row Tool takes
 * ClearButton's 12 padding (px-3) so the pulls put its glyph on the page edge.
 */
function expectShared(tag: string, edgeTool = false): void {
  const cls = classOf(tag).split(/\s+/);
  expect(cls).toContain('h-11');
  expect(cls).toContain('rounded-lg');
  expect(cls).toContain('text-base');
  expect(cls).toContain('font-medium');
  for (const old of [
    'h-9',
    'h-12',
    'rounded-md',
    'rounded-xl',
    'font-semibold',
    'text-sm',
    ...(edgeTool ? [] : ['px-3']),
  ]) {
    expect(cls).not.toContain(old);
  }
}

const cache = {
  peek: () => null,
  peekThumbnail: () => null,
  resolve: () => new Promise<never>(() => {}),
} as unknown as PresignCache;

function item(n: number): GalleryItem {
  return {
    assetAttachmentId: `aa-${n}`,
    assetVersionId: `ver-${n}`,
    assetId: `as-${n}`,
    position: n,
    filename: `image-${n}.png`,
    mimeType: 'image/png',
    kind: 'image',
    width: 800,
    height: 1000,
    durationMs: null,
    pageCount: null,
    r2Key: `r2/${n}`,
    externalUrl: null,
  };
}

describe('PostGallery buttons', () => {
  it('tools row: Add, Replace, Reorder and v{n} are shared buttons', () => {
    const tree = galleryToolsRow({
      canEdit: true,
      itemCount: 3,
      versionNumber: 4,
      saving: false,
      error: null,
      onAdd: vi.fn(),
      onReplace: vi.fn(),
      onReorder: vi.fn(),
      onVersions: vi.fn(),
    });
    if (tree === null) throw new Error('no tools row');
    const tags = buttonTags(renderToStaticMarkup(tree));
    expect(tags).toHaveLength(4);
    for (const tag of tags) {
      expectShared(tag, true);
      // A row of 3+ actions is the Tool level: no fill, no border, no lighting.
      expect(classOf(tag)).toContain('lit-hover');
      expect(classOf(tag)).not.toContain('bg-fg/10');
      expect(classOf(tag)).not.toContain('lit-btn-');
    }
  });

  it('cut line: "See preview" is a shared 44px link button that opens the preview', () => {
    const onSeePreview = vi.fn();
    const items = [{ ...item(0), width: 1080, height: 1920 }];
    const html = renderToStaticMarkup(
      galleryView({
        items,
        cache,
        presignEnabled: false,
        onOpen: vi.fn(),
        frame: galleryFrame('linkedin', 'single_image', items, {}),
        platformLabel: 'LinkedIn',
        onSeePreview,
      }),
    );
    expect(html).toMatch(/LinkedIn cuts \d+% of this\./);
    const tag = buttonTags(html).find((t) => t.includes('data-see-preview'));
    expect(tag).toBeDefined();
    expectShared(tag!);
    expect(classOf(tag!)).toContain('text-fg');
    expect(html).not.toContain('Tap to see full image');
  });

  it('reorder: no button bar, only the photo tiles (hold and drag, saved on drop)', () => {
    const model: ReorderModel = {
      items: [item(0), item(1), item(2)],
      cache,
      presignEnabled: false,
      ratio: 4 / 5,
      drag: null,
      saving: false,
      error: null,
      onMove: vi.fn(),
      onTilePointerDown: vi.fn(),
      onTilePointerMove: vi.fn(),
      onTilePointerUp: vi.fn(),
      onTilePointerCancel: vi.fn(),
    };
    const tags = buttonTags(renderToStaticMarkup(reorderView(model)));
    expect(tags).toHaveLength(3);
    expect(tags.every((tag) => tag.includes('data-reorder-tile'))).toBe(true);
  });
});
