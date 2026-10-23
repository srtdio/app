import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  PostGallery,
  galleryToolsRow,
  reorderView,
  type GalleryToolsModel,
  type ReorderModel,
} from '@/components/pages/pcs/PostGallery';
import {
  dropIndex,
  galleryWriteErrorCopy,
  moveTo,
  replaceAt,
} from '@/components/pages/pcs/gallery-transforms';
import type { PresignCache, PresignDeps } from '@/lib/asset-presign';
import type { GalleryItem } from '@srtdio/posts';

// #26 regression: the gallery tools row under the picture (Add, Replace,
// Reorder, v{n}), Replace and Reorder each landing as ONE gallery_set, and no
// edit tools on an approved post. node environment, no DOM: hookless trees are
// walked, PostGallery is rendered to static markup, and the page wiring that
// lives inside hooks is pinned against the source.

function read(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}
const PAGE = read('../PostDetailPage.tsx');
const GALLERY = read('./PostGallery.tsx');

function flatten(node: ReactNode, out: ReactElement[]): void {
  if (Array.isArray(node)) {
    node.forEach((child) => flatten(child, out));
    return;
  }
  if (node === null || typeof node !== 'object' || !('props' in node)) return;
  const el = node as ReactElement;
  out.push(el);
  flatten((el.props as { children?: ReactNode }).children, out);
}
function elements(tree: ReactNode): ReactElement[] {
  const out: ReactElement[] = [];
  flatten(tree, out);
  return out;
}
function byData(tree: ReactNode, attr: string): ReactElement | undefined {
  return elements(tree).find(
    (el) => (el.props as Record<string, unknown>)[attr] !== undefined && el.type === 'button',
  );
}
function click(el: ReactElement | undefined): void {
  (el?.props as { onClick: () => void }).onClick();
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

function toolsModel(over: Partial<GalleryToolsModel> = {}): GalleryToolsModel {
  return {
    canEdit: true,
    itemCount: 3,
    versionNumber: 4,
    saving: false,
    error: null,
    onAdd: vi.fn(),
    onReplace: vi.fn(),
    onReorder: vi.fn(),
    onVersions: vi.fn(),
    ...over,
  };
}

describe('#26 gallery tools row', () => {
  it('creators get Add, Replace, Reorder, then the v{n} button pushed right, all 44px', () => {
    const html = renderToStaticMarkup(galleryToolsRow(toolsModel()));
    const order = ['>Add<', '>Replace<', '>Reorder<', '>v4<'].map((t) => html.indexOf(t));
    expect(order.every((at) => at > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain('ml-auto');
    expect(html.match(/min-h-\[44px\]/g)?.length).toBe(4);
  });

  it('approvers and approved posts get only the v{n} button', () => {
    const tree = galleryToolsRow(toolsModel({ canEdit: false }));
    expect(byData(tree, 'data-gallery-add')).toBeUndefined();
    expect(byData(tree, 'data-gallery-replace')).toBeUndefined();
    expect(byData(tree, 'data-gallery-reorder')).toBeUndefined();
    const onVersions = vi.fn();
    click(
      byData(galleryToolsRow(toolsModel({ canEdit: false, onVersions })), 'data-gallery-versions'),
    );
    expect(onVersions).toHaveBeenCalledTimes(1);
  });

  it('PostGallery renders no edit tools, no slide ⋯ on an approved post', () => {
    const tools = {
      canEdit: false,
      versionNumber: 2,
      error: null,
      onVersions: vi.fn(),
      onAdd: vi.fn(),
      onReplace: vi.fn(),
      onSaveOrder: vi.fn(async () => true),
    };
    const locked = renderToStaticMarkup(
      <PostGallery
        items={[item(0), item(1)]}
        cache={cache}
        deps={{} as PresignDeps}
        presignEnabled={false}
        onSlideActions={vi.fn()}
        tools={tools}
      />,
    );
    expect(locked).not.toContain('data-gallery-add');
    expect(locked).not.toContain('data-gallery-reorder');
    expect(locked).not.toContain('Slide 1 actions');
    expect(locked).toContain('>v2<');

    const open = renderToStaticMarkup(
      <PostGallery
        items={[item(0), item(1)]}
        cache={cache}
        deps={{} as PresignDeps}
        presignEnabled={false}
        onSlideActions={vi.fn()}
        tools={{ ...tools, canEdit: true }}
      />,
    );
    expect(open).toContain('data-gallery-add');
    expect(open).toContain('data-gallery-replace');
    expect(open).toContain('data-gallery-reorder');
    expect(open).toContain('Slide 1 actions');
  });

  it('the page computes canEdit from the stage (never on approved)', () => {
    expect(PAGE).toContain("canEdit: agencySide && !readOnly && currentStage !== 'approved',");
  });

  it('shows the error once, inline, with the approved-lock copy', () => {
    const copy = galleryWriteErrorCopy({ code: 'unknown', message: 'post_approved_locked' });
    expect(copy).toBe("Approved posts can't be edited.");
    expect(galleryWriteErrorCopy({ code: 'unknown', message: 'boom' })).toBe(
      "Couldn't do that. Try again.",
    );
    const html = renderToStaticMarkup(galleryToolsRow(toolsModel({ error: copy })));
    expect(html.split('Approved posts can&#x27;t be edited.')).toHaveLength(2);
    // The page drops the toast so the line never shows twice.
    expect(PAGE).not.toContain("push('Could not update the gallery. Please try again.')");
    expect(PAGE).toContain('setGalleryError(galleryWriteErrorCopy(result.error));');
  });
});

describe('#26 Replace is one save', () => {
  it('swaps only the current slide, keeping order and length', () => {
    expect(replaceAt(['a', 'b', 'c'], 1, 'n')).toEqual(['a', 'n', 'c']);
    expect(replaceAt(['a'], 5, 'n')).toEqual(['a']);
  });

  it('the page replaces the slide in one gallery_set commit after upload', () => {
    expect(PAGE).toContain("onReplace: (index) => openAdd({ mode: 'replace', index }),");
    const uploaded = PAGE.slice(PAGE.indexOf('async function handleUploaded'));
    const body = uploaded.slice(0, uploaded.indexOf('\n  }\n'));
    expect(body).toContain('ids = replaceAt(ids, target.index, first);');
    expect(body.split('commitGallery(')).toHaveLength(2);
  });
});

describe('#26 Reorder saves one version', () => {
  function reorderModel(over: Partial<ReorderModel> = {}): ReorderModel {
    return {
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
      ...over,
    };
  }

  it('moves only rearrange the draft; one Save order calls save exactly once', () => {
    const model = reorderModel();
    const tree = reorderView(model);
    click(byData(tree, 'data-reorder-left'));
    click(byData(tree, 'data-reorder-right'));
    expect(model.onMove).toHaveBeenCalledTimes(2);
    expect(model.onSave).not.toHaveBeenCalled();
    click(byData(tree, 'data-reorder-save'));
    expect(model.onSave).toHaveBeenCalledTimes(1);
    expect(renderToStaticMarkup(tree)).toContain('>Save order<');
    expect(renderToStaticMarkup(tree)).toContain('>Cancel<');
  });

  it('arrow keys move the focused tile (keyboard reorder)', () => {
    const model = reorderModel();
    const tile = elements(reorderView(model)).filter(
      (el) => (el.props as Record<string, unknown>)['data-reorder-tile'] !== undefined,
    )[2];
    const onKeyDown = (tile?.props as { onKeyDown: (e: unknown) => void }).onKeyDown;
    onKeyDown({ key: 'ArrowLeft', preventDefault: () => {} });
    expect(model.onMove).toHaveBeenCalledWith('aa-2', -1);
  });

  it('the dragged tile moves along the row only: translateX, no rotate or scale', () => {
    const tree = reorderView(reorderModel({ drag: { id: 'aa-0', dx: 42 } }));
    const html = renderToStaticMarkup(tree);
    expect(html).toContain('transform:translateX(42px)');
    expect(html).not.toMatch(/rotate|scale\(/);
    expect(html).toContain('touch-none');
    // Nothing animates movement, so reduced motion is respected.
    expect(GALLERY).not.toMatch(/transition-transform|transition-all/);
  });

  it('Save order is disabled until the order changes', () => {
    const tree = reorderView(reorderModel({ changed: false }));
    expect((byData(tree, 'data-reorder-save')?.props as { disabled?: boolean }).disabled).toBe(
      true,
    );
  });

  it('drag math lands the tile by whole steps, clamped', () => {
    expect(dropIndex(0, 130, 100, 3)).toBe(1);
    expect(dropIndex(0, 900, 100, 3)).toBe(2);
    expect(dropIndex(2, -260, 100, 3)).toBe(0);
    expect(moveTo(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a']);
  });

  it('the wrapper sends the whole draft once through onSaveOrder, wired to the one gallery_set commit', () => {
    expect(GALLERY.split('tools.onSaveOrder(')).toHaveLength(2);
    expect(PAGE).toContain('onSaveOrder: commitGallery,');
    const commit = PAGE.slice(PAGE.indexOf('const commitGallery = useCallback('));
    expect(commit.slice(0, commit.indexOf('\n  );\n')).split('gallerySet(')).toHaveLength(2);
  });
});
