import { describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import { lightboxView, lightboxCounter, wrapIndex } from '@/components/pages/pcs/PostLightbox';
import type { GalleryItem } from '@srtdio/posts';

// node test environment (no DOM renderer): walk the hookless lightboxView tree.

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

function byLabel(tree: ReactNode, value: string): ReactElement | undefined {
  return elements(tree).find(
    (el) => (el.props as { 'aria-label'?: string })['aria-label'] === value,
  );
}

const ITEM: GalleryItem = {
  assetAttachmentId: 'aa',
  assetVersionId: 'ver',
  assetId: 'as',
  position: 0,
  filename: 'photo.png',
  mimeType: 'image/png',
  kind: 'image',
  width: 800,
  height: 1000,
  durationMs: null,
  r2Key: 'r2/x',
  externalUrl: null,
};

function props(overrides: Partial<Parameters<typeof lightboxView>[0]> = {}) {
  return {
    item: ITEM,
    index: 0,
    count: 3,
    presignEnabled: true,
    mediaSrc: 'https://signed/photo' as string | null,
    mediaFailed: false,
    zoomed: false,
    busy: false,
    onPrev: () => {},
    onNext: () => {},
    onJump: () => {},
    onClose: () => {},
    onToggleZoom: () => {},
    onDownload: () => {},
    onScrimTouchStart: () => {},
    onScrimTouchEnd: () => {},
    ...overrides,
  };
}

describe('wrapIndex', () => {
  it('wraps past both ends', () => {
    expect(wrapIndex(0, -1, 3)).toBe(2);
    expect(wrapIndex(2, 1, 3)).toBe(0);
    expect(wrapIndex(1, 1, 3)).toBe(2);
  });
  it('is safe for an empty list', () => {
    expect(wrapIndex(0, 1, 0)).toBe(0);
  });
});

describe('lightboxView', () => {
  it('shows the "i of n" counter', () => {
    const tree = lightboxView(props({ index: 0, count: 3 }));
    const strings = elements(tree)
      .map((el) => (el.props as { children?: ReactNode }).children)
      .filter((child): child is string => typeof child === 'string');
    expect(strings).toContain(lightboxCounter(0, 3));
    expect(strings).toContain('1 of 3');
  });

  it('wires the prev/next arrows to their handlers', () => {
    const onPrev = vi.fn();
    const onNext = vi.fn();
    const tree = lightboxView(props({ onPrev, onNext }));
    (byLabel(tree, 'Previous image')!.props as { onClick: () => void }).onClick();
    (byLabel(tree, 'Next image')!.props as { onClick: () => void }).onClick();
    expect(onPrev).toHaveBeenCalledOnce();
    expect(onNext).toHaveBeenCalledOnce();
  });

  it('keeps the pin button inert when onRequestPin is undefined', () => {
    const tree = lightboxView(props());
    const pin = byLabel(tree, 'Add pin');
    expect(pin).toBeDefined();
    expect((pin!.props as { disabled?: boolean }).disabled).toBe(true);
    expect((pin!.props as { onClick?: unknown }).onClick).toBeUndefined();
  });

  it('arms the pin button from onRequestPin and passes the index', () => {
    const onRequestPin = vi.fn();
    const tree = lightboxView(props({ index: 2, onRequestPin }));
    const pin = byLabel(tree, 'Add pin');
    expect((pin!.props as { disabled?: boolean }).disabled).toBe(false);
    (pin!.props as { onClick: () => void }).onClick();
    expect(onRequestPin).toHaveBeenCalledWith(2);
  });

  it('renders the pin overlay only when provided', () => {
    const withoutOverlay = lightboxView(props());
    expect(
      elements(withoutOverlay).some(
        (el) => (el.props as { 'data-testid'?: string })['data-testid'] === 'pins',
      ),
    ).toBe(false);

    const withOverlay = lightboxView(
      props({ pinOverlay: () => <span data-testid="pins">overlay</span> }),
    );
    expect(
      elements(withOverlay).some(
        (el) => (el.props as { 'data-testid'?: string })['data-testid'] === 'pins',
      ),
    ).toBe(true);
  });
});
