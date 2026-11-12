import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  PostGallery,
  galleryToolsRow,
  galleryView,
  reorderView,
  REORDER_HELPER,
  type GalleryToolsModel,
  type ReorderModel,
} from '@/components/pages/pcs/PostGallery';
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
    onReplace: vi.fn(),
    onReorder: vi.fn(),
    onVersions: vi.fn(),
    ...over,
  };
}

describe('#26 gallery tools row', () => {
  it('one row: Add, Replace, Reorder on the left, v{n} on the right, all 44px', () => {
    const tree = galleryToolsRow(toolsModel());
    expect(tree).not.toBeNull();
    const html = renderToStaticMarkup(tree!);
    const order = ['>Add<', '>Replace<', '>Reorder<', '>v4<'].map((t) => html.indexOf(t));
    expect(order.every((at) => at > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html.match(/min-h-11/g)?.length).toBe(4);
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
    expect(cls(byData(tree, 'data-gallery-replace'))).not.toContain(LEADING_PULL);
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

  it('dots sit directly under the picture; the toolbar comes after them', () => {
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
    const firstDot = html.indexOf('Go to slide 1');
    const toolbar = html.indexOf('data-test-toolbar');
    expect(lastSlide).toBeGreaterThan(-1);
    expect(firstDot).toBeGreaterThan(lastSlide);
    expect(toolbar).toBeGreaterThan(firstDot);
  });

  it('Add inserts after the slide on show (the old slide ⋮ Add image after this)', () => {
    expect(GALLERY).toContain(
      'if (onAddAfter !== undefined && items.length > 0) onAddAfter(shownIndex);',
    );
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

describe('#26 Reorder: hold and drag only, saved on drop', () => {
  function reorderModel(over: Partial<ReorderModel> = {}): ReorderModel {
    return {
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
      ...over,
    };
  }

  it('no reorder buttons: no Make first / last, Move left / right, Save order or Cancel', () => {
    const tree = reorderView(reorderModel());
    const html = renderToStaticMarkup(tree);
    for (const gone of ['Make first', 'Make last', 'Move left', 'Move right', 'Save order']) {
      expect(html).not.toContain(gone);
    }
    expect(html).not.toContain('>Cancel<');
    for (const hook of ['data-reorder-left', 'data-reorder-right', 'data-reorder-save']) {
      expect(byData(tree, hook)).toBeUndefined();
    }
    expect(elements(tree).filter((el) => el.type === Button)).toHaveLength(0);
  });

  it('one helper line: "Hold and drag a photo to reorder"', () => {
    expect(REORDER_HELPER).toBe('Hold and drag a photo to reorder');
    const html = renderToStaticMarkup(reorderView(reorderModel()));
    expect(html.split(REORDER_HELPER)).toHaveLength(2);
    expect(html).not.toContain('pick a slide and move it');
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

  it('the lifted tile moves on X only (translateX); the row still scrolls', () => {
    const tree = reorderView(reorderModel({ drag: { id: 'aa-0', dx: 42 } }));
    const html = renderToStaticMarkup(tree);
    expect(html).toContain('transform:translateX(42px)');
    expect(html).toContain('data-reorder-lifted');
    expect(html).not.toMatch(/rotate|scale\(/);
    // Hold, not touch: the row scrolls under a finger until a photo is lifted.
    expect(html).not.toContain('touch-none');
    // Nothing animates movement, so reduced motion is respected.
    expect(GALLERY).not.toMatch(/transition-transform|transition-all/);
  });

  it('the tools row rides under the strip with Reorder pressed (it leaves the mode)', () => {
    const onReorder = vi.fn();
    const toolbar = galleryToolsRow(toolsModel({ reordering: true, onReorder }));
    const tree = reorderView(reorderModel({ toolbar }));
    const reorder = byData(tree, 'data-gallery-reorder');
    expect((reorder?.props as { 'aria-pressed'?: boolean })['aria-pressed']).toBe(true);
    expect((reorder?.props as { disabled?: boolean }).disabled).toBe(false);
    click(reorder);
    expect(onReorder).toHaveBeenCalledTimes(1);
    expect((byData(tree, 'data-gallery-add')?.props as { disabled?: boolean }).disabled).toBe(true);
  });

  it('drag math lands the tile by whole steps, clamped', () => {
    expect(dropIndex(0, 130, 100, 3)).toBe(1);
    expect(dropIndex(0, 900, 100, 3)).toBe(2);
    expect(dropIndex(2, -260, 100, 3)).toBe(0);
    expect(moveTo(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a']);
  });

  it('a drop saves at once through onSaveOrder (one gallery_set), held by LONG_PRESS_MS', () => {
    // One save path, called from a drop and from the arrow keys.
    expect(GALLERY.split('tools.onSaveOrder(')).toHaveLength(2);
    const up = GALLERY.slice(GALLERY.indexOf('onTilePointerUp: () => {'));
    expect(up.slice(0, up.indexOf('\n      },\n'))).toContain('saveOrder(moveTo(');
    // The hold lifts the tile; a refused save puts the saved order back.
    expect(GALLERY).toContain('const { handlers: holdHandlers } = useLongPress(');
    expect(GALLERY).toContain(
      'if (!ok) setReorderIds((current) => (current === null ? current : saved));',
    );
    expect(PAGE).toContain('onSaveOrder: commitGallery,');
    const commit = PAGE.slice(PAGE.indexOf('const commitGallery = useCallback('));
    expect(commit.slice(0, commit.indexOf('\n  );\n')).split('gallerySet(')).toHaveLength(2);
  });
});
