import { describe, expect, it } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import { galleryView } from '@/components/pages/pcs/PostGallery';
import type { PresignCache } from '@/lib/asset-presign';
import type { GalleryItem } from '@srtdio/posts';

// T13: no ⋮ circle on the picture, and the no-callout / no-select slides. Hookless trees, walked.

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

describe('no ⋮ circle on the picture', () => {
  it('no slide carries an actions button or a dialog opener', () => {
    const tree = galleryView({ items, cache, presignEnabled: true, onOpen: () => {} });
    const all = elements(tree);
    expect(all.some((el) => label(el)?.endsWith(' actions') === true)).toBe(false);
    expect(
      all.some((el) => (el.props as { 'aria-haspopup'?: string })['aria-haspopup'] === 'dialog'),
    ).toBe(false);
    expect(all.some((el) => className(el).includes('rounded-full bg-overlay '))).toBe(false);
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
