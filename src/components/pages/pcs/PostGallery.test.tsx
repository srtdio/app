import { describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import { galleryView } from '@/components/pages/pcs/PostGallery';
import type { PresignCache } from '@/lib/asset-presign';
import type { GalleryItem } from '@srtdio/posts';

// The unit environment is node (no DOM renderer), so these specs walk the JSX
// tree returned by the hookless galleryView rather than mounting it. The
// stateful thumbnail (GalleryThumb) stays an unexpanded element, so the mocked
// cache is never actually called during the walk.

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

function label(el: ReactElement): string | undefined {
  return (el.props as { 'aria-label'?: string })['aria-label'];
}

function className(el: ReactElement): string {
  return (el.props as { className?: string }).className ?? '';
}

// A presign cache stub: the walk never reaches GalleryThumb's hooks, so peek and
// resolve only need to exist.
const cache = {
  peek: () => null,
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
    r2Key: `r2/${n}`,
    externalUrl: null,
  };
}

describe('galleryView', () => {
  it('renders one tile per image, in position order', () => {
    const items = [item(0), item(1), item(2)];
    const tree = galleryView({ items, cache, presignEnabled: true, onOpen: () => {} });
    const tiles = elements(tree).filter((el) => label(el)?.startsWith('View image'));
    expect(tiles.map((el) => label(el))).toEqual(['View image 1', 'View image 2', 'View image 3']);
  });

  it('opens the lightbox at the tapped tile index', () => {
    const onOpen = vi.fn();
    const items = [item(0), item(1)];
    const tree = galleryView({ items, cache, presignEnabled: true, onOpen });
    const second = elements(tree).find((el) => label(el) === 'View image 2');
    (second!.props as { onClick: () => void }).onClick();
    expect(onOpen).toHaveBeenCalledWith(1);
  });

  it('renders a calm empty state when the post has no images', () => {
    const tree = galleryView({ items: [], cache, presignEnabled: true, onOpen: () => {} });
    const hasTiles = elements(tree).some((el) => label(el)?.startsWith('View image'));
    expect(hasTiles).toBe(false);
    const strings = elements(tree)
      .map((el) => (el.props as { children?: ReactNode }).children)
      .filter((child): child is string => typeof child === 'string');
    expect(strings).toContain('No images on this post yet.');
  });

  it('honours the brief props: 2 columns, 3/2 aspect, no index badge', () => {
    const items = [item(0), item(1)];
    const tree = galleryView({
      items,
      cache,
      presignEnabled: true,
      onOpen: () => {},
      columns: 2,
      aspect: '3/2',
      showIndex: false,
    });
    const all = elements(tree);

    // The grid container is 2-up, without the responsive 3-/4-up classes.
    const grid = all.find((el) => className(el).startsWith('grid '))!;
    expect(className(grid)).toContain('grid-cols-2');
    expect(className(grid)).not.toContain('md:grid-cols-4');

    // Every tile renders at the 3/2 aspect.
    const tiles = all.filter((el) => label(el)?.startsWith('View image'));
    expect(tiles.length).toBe(2);
    expect(tiles.every((el) => className(el).includes('aspect-[3/2]'))).toBe(true);

    // No per-tile index badge is emitted.
    expect(all.some((el) => className(el).includes('text-overlay-fg'))).toBe(false);
  });

  it('defaults preserve the original post layout (4-up, 4/5, indexed)', () => {
    const items = [item(0), item(1)];
    const tree = galleryView({ items, cache, presignEnabled: true, onOpen: () => {} });
    const all = elements(tree);

    const grid = all.find((el) => className(el).startsWith('grid '))!;
    expect(className(grid)).toBe('grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4');

    const tiles = all.filter((el) => label(el)?.startsWith('View image'));
    expect(tiles.every((el) => className(el).includes('aspect-[4/5]'))).toBe(true);

    // The index badge is present by default.
    expect(all.some((el) => className(el).includes('text-overlay-fg'))).toBe(true);
  });
});
