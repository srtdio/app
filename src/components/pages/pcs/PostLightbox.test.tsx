import { describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import {
  lightboxView,
  lightboxCounter,
  wrapIndex,
  pinPointFromRect,
  placePinFromEvent,
  pinButtonAction,
} from '@/components/pages/pcs/PostLightbox';
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

describe('pin placement helpers', () => {
  const rect = { left: 100, top: 50, width: 200, height: 100 };

  it('normalizes an in-rect tap and clamps to [0,1]', () => {
    expect(pinPointFromRect(rect, 200, 100)).toEqual({ x: 0.5, y: 0.5 });
    // The far corner clamps to the unit bound rather than overshooting.
    expect(pinPointFromRect(rect, 300, 150)).toEqual({ x: 1, y: 1 });
  });

  it('ignores a tap outside the rect', () => {
    expect(pinPointFromRect(rect, 50, 100)).toBeNull();
    expect(pinPointFromRect(rect, 200, 200)).toBeNull();
  });

  it('reads the rect off the tapped element (mocked getBoundingClientRect)', () => {
    const target = { getBoundingClientRect: vi.fn(() => rect) };
    expect(placePinFromEvent(target, 150, 75)).toEqual({ x: 0.25, y: 0.25 });
    expect(target.getBoundingClientRect).toHaveBeenCalledOnce();
  });

  it('disables placement while zoomed (exit zoom first)', () => {
    expect(pinButtonAction(true, false)).toBe('exit-zoom');
    expect(pinButtonAction(true, true)).toBe('exit-zoom');
    expect(pinButtonAction(false, false)).toBe('arm');
    expect(pinButtonAction(false, true)).toBe('disarm');
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

  it('arming shows placement mode and routes an image tap to onPlace, not zoom', () => {
    const onPlace = vi.fn();
    const onToggleZoom = vi.fn();
    const tree = lightboxView(props({ armed: true, onPlace, onToggleZoom }));
    // A placement hint is shown while armed.
    const hint = elements(tree).find((el) => (el.props as { role?: string }).role === 'status');
    expect(hint).toBeDefined();
    // The image tap places a pin and does not toggle zoom.
    const img = elements(tree).find((el) => el.type === 'img');
    (img!.props as { onClick: () => void }).onClick();
    expect(onPlace).toHaveBeenCalledOnce();
    expect(onToggleZoom).not.toHaveBeenCalled();
    // The crosshair cursor signals placement mode.
    expect((img!.props as { className: string }).className).toContain('cursor-crosshair');
  });

  it('an unarmed image tap still toggles zoom', () => {
    const onPlace = vi.fn();
    const onToggleZoom = vi.fn();
    const tree = lightboxView(props({ armed: false, onPlace, onToggleZoom }));
    expect(elements(tree).some((el) => (el.props as { role?: string }).role === 'status')).toBe(
      false,
    );
    const img = elements(tree).find((el) => el.type === 'img');
    (img!.props as { onClick: () => void }).onClick();
    expect(onToggleZoom).toHaveBeenCalledOnce();
    expect(onPlace).not.toHaveBeenCalled();
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
