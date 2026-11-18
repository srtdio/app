import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  PostGallery,
  galleryToolsRow,
  galleryView,
  type GalleryToolsModel,
} from '@/components/pages/pcs/PostGallery';
import {
  ARRANGE_HELPER,
  arrangeChanged,
  arrangeIndexAt,
  arrangeSlotOrigin,
} from '@/components/pages/pcs/ArrangeSheet';
import {
  dropIndex,
  galleryWriteErrorCopy,
  moveTo,
  replaceAt,
} from '@/components/pages/pcs/gallery-transforms';
import { Button } from '@/components/ui/Button';
import { LEADING_PULL, TRAILING_PULL } from '@/components/ui/layout';
import type { PresignCache, PresignDeps } from '@/lib/asset-presign';
import type { GalleryItem } from '@srtdio/posts';

// The gallery tools row under the strip (Add, Arrange, v{n}; 18 Nov 2026),
// Replace and Arrange each landing as ONE gallery_set, and no edit tools on an
// approved post. node environment, no DOM: hookless trees are
// walked, PostGallery is rendered to static markup, and the page wiring that
// lives inside hooks is pinned against the source.

function read(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}
const PAGE = read('../PostDetailPage.tsx');
const GALLERY = read('./PostGallery.tsx');
const ARRANGE = read('./ArrangeSheet.tsx');

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
    (el) =>
      (el.props as Record<string, unknown>)[attr] !== undefined &&
      (el.type === 'button' || el.type === Button),
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
    onArrange: vi.fn(),
    onVersions: vi.fn(),
    ...over,
  };
}

describe('gallery tools row', () => {
  it('one row: Add and Arrange on the left, v{n} on the right, all 44px', () => {
    const tree = galleryToolsRow(toolsModel());
    expect(tree).not.toBeNull();
    const html = renderToStaticMarkup(tree!);
    const order = ['>Add<', '>Arrange<', '>v4<'].map((t) => html.indexOf(t));
    expect(order.every((at) => at > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html.match(/min-h-11/g)?.length).toBe(3);
    // Replace and Remove live on the opened picture, reordering in Arrange.
    expect(html).not.toContain('>Replace<');
    expect(html).not.toContain('>Reorder<');
    // One row: the left group never wraps; v{n} stays on the right.
    expect(html).toContain('min-w-0 flex-1 items-center');
    expect(html).not.toContain('flex-wrap');
    expect(html).not.toContain('ml-auto');
    expect(html).not.toContain('Add pin');
  });

  it('Add sits on the leading page edge and v{n} on the trailing one (the pulls)', () => {
    const tree = galleryToolsRow(toolsModel());
    const add = byData(tree, 'data-gallery-add');
    const versions = byData(tree, 'data-gallery-versions');
    const cls = (el: ReactElement | undefined) => (el?.props as { className?: string }).className;
    expect(cls(add)).toContain(LEADING_PULL);
    expect(cls(add)).toContain('px-3');
    // The trailing pull's margin; its phone ink slide is off here, since the
    // text (not the clock glyph) is what ends on the edge.
    expect(cls(versions)).toContain(TRAILING_PULL.split(' ')[0]);
    expect(cls(versions)).toContain('max-md:[&>svg]:translate-x-0');
    expect(cls(versions)).not.toContain('--ink-r');
    expect(cls(versions)).toContain('px-3');
    // Phone: the approved lock's ink sits on the page edge (no 44 box, no pull).
    const lockRow = renderToStaticMarkup(
      galleryToolsRow(toolsModel({ canEdit: false, locked: true }))!,
    );
    expect(lockRow).toMatch(/data-gallery-lock=""[^>]*class="[^"]*max-md:ml-0 max-md:w-auto/);
    expect(cls(byData(tree, 'data-gallery-arrange'))).not.toContain(LEADING_PULL);
  });

  it('no row without edit tools, a lock or v{n}', () => {
    expect(galleryToolsRow(toolsModel({ canEdit: false, versionNumber: null }))).toBeNull();
  });

  it('approved: one 16px lock in text-fg-3, no edit tools', () => {
    const tree = galleryToolsRow(toolsModel({ canEdit: false, locked: true }));
    expect(tree).not.toBeNull();
    const html = renderToStaticMarkup(tree!);
    expect(html.split('data-gallery-lock').length - 1).toBe(1);
    expect(html.match(/<svg/g)?.length).toBe(2); // the lock and the v{n} history icon
    expect(html).toContain('width="16"');
    expect(html).toContain('text-fg-3');
    expect(html).not.toContain('data-gallery-add');
  });

  it('no dots and no counter: the toolbar comes right after the strip', () => {
    const html = renderToStaticMarkup(
      galleryView({
        items: [item(0), item(1)],
        cache,
        presignEnabled: false,
        onOpen: () => {},
        toolbar: <div data-test-toolbar="" />,
      }),
    );
    const lastSlide = html.lastIndexOf('View image');
    const toolbar = html.indexOf('data-test-toolbar');
    expect(lastSlide).toBeGreaterThan(-1);
    expect(toolbar).toBeGreaterThan(lastSlide);
    expect(html).not.toContain('Go to slide');
    expect(html).not.toContain('>1/2<');
  });

  it('Add appends: new files land last (no insert-after path)', () => {
    expect(GALLERY).toContain('onAdd: tools.onAdd,');
    expect(GALLERY).not.toContain('onAddAfter');
    expect(PAGE).not.toContain('insertAfter');
  });

  it('approvers and approved posts get only the v{n} button', () => {
    const tree = galleryToolsRow(toolsModel({ canEdit: false }));
    expect(byData(tree, 'data-gallery-add')).toBeUndefined();
    expect(byData(tree, 'data-gallery-arrange')).toBeUndefined();
    const onVersions = vi.fn();
    click(
      byData(galleryToolsRow(toolsModel({ canEdit: false, onVersions })), 'data-gallery-versions'),
    );
    expect(onVersions).toHaveBeenCalledTimes(1);
  });

  it('PostGallery renders no edit tools on an approved post, and never a ⋮ circle on the picture', () => {
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
        tools={tools}
      />,
    );
    expect(locked).not.toContain('data-gallery-add');
    expect(locked).not.toContain('data-gallery-arrange');
    expect(locked).not.toContain('Slide 1 actions');
    expect(locked).toContain('>v2<');

    const open = renderToStaticMarkup(
      <PostGallery
        items={[item(0), item(1)]}
        cache={cache}
        deps={{} as PresignDeps}
        presignEnabled={false}
        tools={{ ...tools, canEdit: true }}
      />,
    );
    expect(open).toContain('data-gallery-add');
    expect(open).toContain('data-gallery-arrange');
    expect(open).not.toContain('data-gallery-replace');
    expect(open).not.toContain('Slide 1 actions');
    expect(open).not.toContain('rounded-full bg-overlay');
    expect(GALLERY).not.toContain('slideMenuButton');
    expect(GALLERY).not.toContain('IconMore');
  });

  it('the page computes canEdit from the stage (never on approved)', () => {
    expect(PAGE).toContain('const canEditContent = agencySide && !readOnly && !approvedLocked;');
    expect(PAGE).toContain('canEdit: canEditContent,');
  });

  it('shows the error once, inline, with the approved-lock copy', () => {
    const copy = galleryWriteErrorCopy({ code: 'unknown', message: 'post_approved_locked' });
    expect(copy).toBe("Couldn't update the gallery. Approved posts are locked.");
    expect(galleryWriteErrorCopy({ code: 'unknown', message: 'boom' })).toBe(
      "Couldn't update the gallery. Try again.",
    );
    const html = renderToStaticMarkup(galleryToolsRow(toolsModel({ error: copy })));
    expect(html.split('Approved posts are locked.')).toHaveLength(2);
    // The page drops the toast so the line never shows twice.
    expect(PAGE).not.toContain("push('Could not update the gallery. Please try again.')");
    expect(PAGE).toContain('setGalleryError(galleryWriteErrorCopy(result.error));');
  });
});

describe('Replace is one save', () => {
  it('swaps only the current slide, keeping order and length', () => {
    expect(replaceAt(['a', 'b', 'c'], 1, 'n')).toEqual(['a', 'n', 'c']);
    expect(replaceAt(['a'], 5, 'n')).toEqual(['a']);
  });

  it('the page replaces the slide in one gallery_set commit after upload', () => {
    expect(PAGE).toContain("onReplace: (index) => openAdd({ mode: 'replace', index }),");
    const apply = PAGE.slice(PAGE.indexOf('async function applyNewVersions'));
    const body = apply.slice(0, apply.indexOf('\n  }\n'));
    expect(body).toContain('ids = replaceAt(ids, target.index, first);');
    expect(body.split('commitGallery(')).toHaveLength(2);
  });
});

describe('Arrange: one sheet, one save on Done', () => {
  const grid = { columns: 3, cellWidth: 100, cellHeight: 125, gap: 8, count: 5 };

  it('one helper line that teaches both jobs', () => {
    expect(ARRANGE_HELPER).toBe('Drag to change the order. Drop on Remove to delete.');
    expect(ARRANGE.split('{ARRANGE_HELPER}')).toHaveLength(2);
  });

  it('the slot under the pointer, clamped to the pictures there are', () => {
    expect(arrangeIndexAt(10, 10, grid)).toBe(0);
    expect(arrangeIndexAt(230, 10, grid)).toBe(2);
    expect(arrangeIndexAt(120, 140, grid)).toBe(4);
    // Past the last picture, and off the grid's edges.
    expect(arrangeIndexAt(300, 300, grid)).toBe(4);
    expect(arrangeIndexAt(-40, -40, grid)).toBe(0);
    expect(arrangeIndexAt(5, 5, { ...grid, count: 0 })).toBe(0);
  });

  it('a slot sits one cell plus one gap from its neighbour', () => {
    expect(arrangeSlotOrigin(0, grid)).toEqual({ x: 0, y: 0 });
    expect(arrangeSlotOrigin(2, grid)).toEqual({ x: 216, y: 0 });
    expect(arrangeSlotOrigin(4, grid)).toEqual({ x: 108, y: 133 });
  });

  it('changed means moved or removed, never an untouched list', () => {
    expect(arrangeChanged(['a', 'b'], ['a', 'b'])).toBe(false);
    expect(arrangeChanged(['a', 'b'], ['b', 'a'])).toBe(true);
    expect(arrangeChanged(['a', 'b'], ['a'])).toBe(true);
  });

  it('the lifted picture follows the pointer only: no rotation, no scale, no transition', () => {
    expect(ARRANGE).toContain('transform: `translate(');
    expect(ARRANGE).not.toMatch(/rotate|scale\(|transition-transform|transition-all/);
    expect(GALLERY).not.toMatch(/transition-transform|transition-all/);
  });

  it('drag math still moves a picture to its new place', () => {
    expect(dropIndex(0, 130, 100, 3)).toBe(1);
    expect(moveTo(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a']);
  });

  it('nothing is saved until Done: one onSave, wired to the one gallery commit', () => {
    expect(ARRANGE.split('void onSave(')).toHaveLength(2);
    expect(ARRANGE).toContain('dirty={changed}');
    expect(GALLERY).toContain('onSave={tools.onSaveOrder}');
    expect(GALLERY).not.toContain('reorderView');
    expect(PAGE).toContain('onSaveOrder: commitGallery,');
    const commit = PAGE.slice(PAGE.indexOf('const commitGallery = useCallback('));
    expect(commit.slice(0, commit.indexOf('\n  );\n')).split('gallerySet(')).toHaveLength(2);
  });

  it('holding a picture or right-clicking it opens Arrange (no slide actions sheet)', () => {
    expect(GALLERY).toContain('if (canArrange) setArrangeOpen(true);');
    expect(GALLERY).not.toContain('onSlideActions');
    expect(PAGE).not.toContain('SlideActionsSheet');
  });
});
