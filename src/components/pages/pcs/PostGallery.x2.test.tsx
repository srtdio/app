import { describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import { galleryView, pinControls, slideMenuButton } from '@/components/pages/pcs/PostGallery';
import type { PresignCache } from '@/lib/asset-presign';
import type { GalleryItem } from '@srtdio/posts';

// H2 / H3 / T13: the visible Add pin (with Cancel while armed), the visible ⋯
// per slide, and the no-callout / no-select slides. Hookless trees, walked.

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

function text(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join('');
  if (node === null || typeof node !== 'object' || !('props' in node)) return '';
  return text((node as ReactElement<{ children?: ReactNode }>).props.children);
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

const items = [item(0), item(1), item(2)];

describe('Add pin (H2)', () => {
  it('shows a 44px Add pin for anyone who can comment, arming the current slide', () => {
    const onArmPin = vi.fn();
    const tree = galleryView({
      items,
      cache,
      presignEnabled: true,
      onOpen: () => {},
      activeIndex: 1,
      onArmPin,
    });
    const all = elements(tree);
    const add = all.find((el) => 'data-add-pin' in (el.props as object))!;
    expect(add).toBeDefined();
    expect(text(add)).toContain('Add pin');
    expect(className(add)).toContain('min-h-[44px]');
    (add.props as { onClick: () => void }).onClick();
    expect(onArmPin).toHaveBeenCalledWith(1);
    expect(all.some((el) => 'data-cancel-pin' in (el.props as object))).toBe(false);
  });

  it('while armed: the hint pill, a Cancel that disarms, and no Add pin', () => {
    const onDisarmPin = vi.fn();
    const tree = galleryView({
      items,
      cache,
      presignEnabled: true,
      onOpen: () => {},
      pinArmedIndex: 0,
      onArmPin: () => {},
      onDisarmPin,
    });
    const all = elements(tree);
    expect(all.some((el) => (el.props as { role?: string }).role === 'status')).toBe(true);
    const cancel = all.find((el) => 'data-cancel-pin' in (el.props as object))!;
    expect(text(cancel)).toBe('Cancel');
    (cancel.props as { onClick: () => void }).onClick();
    expect(onDisarmPin).toHaveBeenCalledTimes(1);
    expect(all.some((el) => 'data-add-pin' in (el.props as object))).toBe(false);
  });

  it('nothing is offered to a viewer who cannot comment', () => {
    expect(pinControls(0, null, undefined, undefined)).toBeNull();
    const tree = galleryView({ items, cache, presignEnabled: true, onOpen: () => {} });
    expect(elements(tree).some((el) => 'data-add-pin' in (el.props as object))).toBe(false);
  });
});

describe('slide ⋯ (H3)', () => {
  it('renders a 44px actions button per slide for the agency side, opening the slide actions', () => {
    const onSlideMenu = vi.fn();
    const tree = galleryView({ items, cache, presignEnabled: true, onOpen: () => {}, onSlideMenu });
    const menus = elements(tree).filter((el) => label(el)?.endsWith(' actions') === true);
    expect(menus.map(label)).toEqual(['Slide 1 actions', 'Slide 2 actions', 'Slide 3 actions']);
    for (const menu of menus) expect(className(menu)).toContain('h-11 w-11');
    (menus[2]?.props as { onClick: () => void }).onClick();
    expect(onSlideMenu).toHaveBeenCalledWith(2);
  });

  it('is absent for the client side', () => {
    expect(slideMenuButton(0, undefined)).toBeNull();
    const tree = galleryView({ items, cache, presignEnabled: true, onOpen: () => {} });
    expect(elements(tree).some((el) => label(el)?.endsWith(' actions') === true)).toBe(false);
  });
});

describe('slides never select or call out on long-press (T13)', () => {
  it('every carousel slide carries select-none and -webkit-touch-callout:none', () => {
    const tree = galleryView({ items, cache, presignEnabled: true, onOpen: () => {} });
    const slides = elements(tree).filter((el) => label(el)?.startsWith('View image') === true);
    expect(slides).toHaveLength(3);
    for (const slide of slides) {
      expect(className(slide)).toContain('select-none');
      expect(className(slide)).toContain('[-webkit-touch-callout:none]');
    }
  });
});
