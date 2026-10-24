import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  galleryToolsRow,
  pinButton,
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

function expectShared(tag: string): void {
  const cls = classOf(tag).split(/\s+/);
  expect(cls).toContain('h-11');
  expect(cls).toContain('rounded-lg');
  expect(cls).toContain('text-sm');
  expect(cls).toContain('font-medium');
  for (const old of [
    'h-9',
    'h-12',
    'rounded-md',
    'rounded-xl',
    'font-semibold',
    'text-xs',
    'px-3',
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
  it('tools row: Add, Replace, Reorder, Add pin and v{n} are shared buttons', () => {
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
      pin: pinButton(0, null, vi.fn(), vi.fn()),
    });
    if (tree === null) throw new Error('no tools row');
    const tags = buttonTags(renderToStaticMarkup(tree));
    expect(tags).toHaveLength(5);
    for (const tag of tags) {
      expectShared(tag);
      expect(classOf(tag)).toContain('border-border');
    }
  });

  it('armed pin: Cancel is a shared secondary button', () => {
    const cancel = pinButton(0, 0, vi.fn(), vi.fn());
    if (cancel === null) throw new Error('no cancel');
    const tags = buttonTags(renderToStaticMarkup(cancel));
    expect(tags).toHaveLength(1);
    expectShared(tags[0]!);
  });

  it('reorder bar: Move left, Move right, Cancel secondary; Save order primary', () => {
    const model: ReorderModel = {
      items: [item(0), item(1), item(2)],
      cache,
      presignEnabled: false,
      ratio: 4 / 5,
      drag: null,
      selectedId: 'aa-1',
      changed: true,
      saving: false,
      error: null,
      onSelect: vi.fn(),
      onMove: vi.fn(),
      onTilePointerDown: vi.fn(),
      onTilePointerMove: vi.fn(),
      onTilePointerUp: vi.fn(),
      onSave: vi.fn(),
      onCancel: vi.fn(),
    };
    const tags = buttonTags(renderToStaticMarkup(reorderView(model))).filter(
      (tag) => !tag.includes('data-reorder-tile'),
    );
    expect(tags).toHaveLength(4);
    for (const tag of tags) expectShared(tag);
    const save = tags.find((tag) => tag.includes('data-reorder-save'));
    expect(classOf(save ?? '')).toContain('bg-accent');
  });
});
