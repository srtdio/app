import { describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import {
  lightboxView,
  lightboxCounter,
  slideFromScroll,
  intrinsicSize,
  fitFrameStyle,
  pinPointFromRect,
  placePinFromEvent,
} from '@/components/pages/pcs/PostLightbox';
import type { LightboxViewProps, StageGestures } from '@/components/pages/pcs/PostLightbox';
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

// Every string that would render as text anywhere in the tree.
function collectStrings(node: ReactNode, out: string[]): void {
  if (typeof node === 'string') {
    out.push(node);
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((child) => collectStrings(child, out));
    return;
  }
  if (node === null || typeof node !== 'object' || !('props' in node)) return;
  collectStrings(((node as ReactElement).props as { children?: ReactNode }).children, out);
}

function strings(tree: ReactNode): string[] {
  const out: string[] = [];
  collectStrings(tree, out);
  return out;
}

function byLabel(tree: ReactNode, value: string): ReactElement | undefined {
  return elements(tree).find(
    (el) => (el.props as { 'aria-label'?: string })['aria-label'] === value,
  );
}

function className(el: ReactElement): string {
  return (el.props as { className?: string }).className ?? '';
}

function item(n: number, width: number | null = 1080, height: number | null = 1350): GalleryItem {
  return {
    assetAttachmentId: `aa-${n}`,
    assetVersionId: `ver-${n}`,
    assetId: `as-${n}`,
    position: n,
    filename: `secret-filename-${n}.png`,
    mimeType: 'image/png',
    kind: 'image',
    width,
    height,
    durationMs: null,
    r2Key: `r2/${n}`,
    externalUrl: null,
  };
}

const GESTURES: StageGestures = {
  onPointerDown: () => {},
  onPointerMove: () => {},
  onPointerUp: () => {},
  onPointerCancel: () => {},
  onWheel: () => {},
  onClick: () => {},
};

function props(overrides: Partial<LightboxViewProps> = {}): LightboxViewProps {
  return {
    items: [item(0), item(1), item(2)],
    index: 0,
    presignEnabled: true,
    chrome: true,
    busy: false,
    zoom: { scale: 1, x: 0, y: 0 },
    srcFor: (it) => `https://signed/${it.assetVersionId}`,
    failedFor: () => false,
    dimsFor: (it) =>
      it.width !== null && it.height !== null ? { width: it.width, height: it.height } : null,
    onClose: () => {},
    onDownload: () => {},
    onDotClick: () => {},
    onTrackScroll: () => {},
    onImageLoad: () => {},
    stageGestures: GESTURES,
    ...overrides,
  };
}

describe('pure helpers', () => {
  it('formats the mono counter as "n / N"', () => {
    expect(lightboxCounter(0, 3)).toBe('1 / 3');
    expect(lightboxCounter(2, 3)).toBe('3 / 3');
  });

  it('derives the resting slide from scroll offset, clamped', () => {
    expect(slideFromScroll(0, 400, 3)).toBe(0);
    expect(slideFromScroll(390, 400, 3)).toBe(1);
    expect(slideFromScroll(9999, 400, 3)).toBe(2);
    expect(slideFromScroll(100, 0, 3)).toBe(0);
  });

  it('prefers stored asset dimensions, then the measured fallback', () => {
    expect(intrinsicSize(item(0, 800, 1000), {})).toEqual({ width: 800, height: 1000 });
    expect(intrinsicSize(item(0, null, null), {})).toBeNull();
    expect(intrinsicSize(item(0, null, null), { 'ver-0': { width: 3, height: 4 } })).toEqual({
      width: 3,
      height: 4,
    });
    // A zero stored dimension is unusable; the measured value wins.
    expect(intrinsicSize(item(0, 0, 100), { 'ver-0': { width: 3, height: 4 } })).toEqual({
      width: 3,
      height: 4,
    });
  });

  it('builds the fit frame as an aspect-ratio box', () => {
    expect(fitFrameStyle(1080, 1920)).toEqual({ aspectRatio: '1080 / 1920' });
  });

  it('keeps the pin geometry helpers pure and clamped (used by the gallery now)', () => {
    const rect = { left: 100, top: 50, width: 200, height: 100 };
    expect(pinPointFromRect(rect, 200, 100)).toEqual({ x: 0.5, y: 0.5 });
    expect(pinPointFromRect(rect, 50, 100)).toBeNull();
    const target = { getBoundingClientRect: vi.fn(() => rect) };
    expect(placePinFromEvent(target, 150, 75)).toEqual({ x: 0.25, y: 0.25 });
  });
});

describe('lightboxView', () => {
  it('never renders a filename anywhere on the surface', () => {
    const tree = lightboxView(props());
    const all = elements(tree);
    const text = strings(tree).join(' ');
    expect(text).not.toContain('secret-filename');
    for (const el of all) {
      const p = el.props as { alt?: string; 'aria-label'?: string; title?: string };
      expect(p.alt ?? '').not.toContain('secret-filename');
      expect(p['aria-label'] ?? '').not.toContain('secret-filename');
      expect(p.title ?? '').not.toContain('secret-filename');
    }
  });

  it('shows only close, mono counter and Download in the top bar', () => {
    const tree = lightboxView(props({ index: 1 }));
    expect(byLabel(tree, 'Close viewer')).toBeDefined();
    expect(byLabel(tree, 'Download')).toBeDefined();
    expect(byLabel(tree, 'Present')).toBeUndefined();
    expect(byLabel(tree, 'Add pin')).toBeUndefined();
    expect(byLabel(tree, 'Slide actions')).toBeUndefined();
    expect(byLabel(tree, 'Zoom in')).toBeUndefined();
    const counter = elements(tree).find(
      (el) => (el.props as { children?: ReactNode }).children === '2 / 3',
    );
    expect(counter).toBeDefined();
    expect(className(counter!)).toContain('font-mono');
  });

  it('constrains the fit image against the fixed stage so it is fully visible', () => {
    const tree = lightboxView(props());
    const all = elements(tree);
    // The slide track and each stage are fixed/absolute boxes, never auto-height.
    const track = all.find((el) => className(el).includes('snap-x'))!;
    expect(className(track)).toContain('absolute inset-0');
    const frames = all.filter(
      (el) => (el.props as { style?: { aspectRatio?: string } }).style?.aspectRatio !== undefined,
    );
    expect(frames.length).toBeGreaterThan(0);
    for (const frame of frames) {
      expect(className(frame)).toContain('max-h-full');
      expect(className(frame)).toContain('max-w-full');
    }
    // Nothing in fit mode scrolls: the whole image is always in view.
    expect(all.some((el) => className(el).includes('overflow-auto'))).toBe(false);
  });

  it('renders the blurred cover backdrop behind each slide on the overlay dialog', () => {
    const tree = lightboxView(props());
    const dialog = elements(tree).find((el) => (el.props as { role?: string }).role === 'dialog')!;
    expect(className(dialog)).toContain('bg-overlay');
    const backdrops = elements(tree).filter((el) => className(el).includes('blur-[48px]'));
    expect(backdrops).toHaveLength(3);
    for (const b of backdrops) {
      expect(className(b)).toContain('object-cover');
    }
  });

  it('hides both chrome layers when chrome is off and shows them when on', () => {
    const off = lightboxView(props({ chrome: false }));
    const hidden = elements(off).filter(
      (el) => className(el).includes('opacity-0') && className(el).includes('pointer-events-none'),
    );
    expect(hidden.length).toBeGreaterThanOrEqual(2);
    const on = lightboxView(props());
    expect(
      elements(on).some(
        (el) =>
          className(el).includes('opacity-100') && !className(el).includes('pointer-events-none'),
      ),
    ).toBe(true);
  });

  it('manage row invokes the prewired existing mutation paths', () => {
    const manage = {
      onMakeFirst: vi.fn(),
      onMoveLeft: vi.fn(),
      onMoveRight: vi.fn(),
      onMakeLast: vi.fn(),
      onAddAfter: vi.fn(),
    };
    const tree = lightboxView(props({ index: 1, manage }));
    for (const [label, fn] of [
      ['Make first', manage.onMakeFirst],
      ['Move left', manage.onMoveLeft],
      ['Add image', manage.onAddAfter],
      ['Move right', manage.onMoveRight],
      ['Make last', manage.onMakeLast],
    ] as const) {
      const button = byLabel(tree, label)!;
      expect(button).toBeDefined();
      expect((button.props as { disabled?: boolean }).disabled ?? false).toBe(false);
      (button.props as { onClick: () => void }).onClick();
      expect(fn).toHaveBeenCalledOnce();
    }
    // Clients (no manage prop) never see the row.
    const clientTree = lightboxView(props({ index: 1 }));
    expect(byLabel(clientTree, 'Make first')).toBeUndefined();
    expect(byLabel(clientTree, 'Add image')).toBeUndefined();
  });

  it('disables left/first at position 1 and right/last at the end', () => {
    const manage = {
      onMakeFirst: () => {},
      onMoveLeft: () => {},
      onMoveRight: () => {},
      onMakeLast: () => {},
      onAddAfter: () => {},
    };
    const first = lightboxView(props({ index: 0, manage }));
    expect((byLabel(first, 'Make first')!.props as { disabled: boolean }).disabled).toBe(true);
    expect((byLabel(first, 'Move left')!.props as { disabled: boolean }).disabled).toBe(true);
    expect((byLabel(first, 'Move right')!.props as { disabled: boolean }).disabled).toBe(false);
    expect((byLabel(first, 'Make last')!.props as { disabled: boolean }).disabled).toBe(false);

    const last = lightboxView(props({ index: 2, manage }));
    expect((byLabel(last, 'Make first')!.props as { disabled: boolean }).disabled).toBe(false);
    expect((byLabel(last, 'Move left')!.props as { disabled: boolean }).disabled).toBe(false);
    expect((byLabel(last, 'Move right')!.props as { disabled: boolean }).disabled).toBe(true);
    expect((byLabel(last, 'Make last')!.props as { disabled: boolean }).disabled).toBe(true);
  });

  it('renders one snapping slide per item and 44px dots that jump', () => {
    const onDotClick = vi.fn();
    const tree = lightboxView(props({ onDotClick }));
    const all = elements(tree);
    const slides = all.filter((el) => className(el).includes('snap-center'));
    expect(slides).toHaveLength(3);
    const dots = all.filter((el) =>
      ((el.props as { 'aria-label'?: string })['aria-label'] ?? '').startsWith('Go to image'),
    );
    expect(dots).toHaveLength(3);
    for (const dot of dots) {
      expect(className(dot)).toContain('h-11');
      expect(className(dot)).toContain('w-11');
    }
    (dots[2]!.props as { onClick: () => void }).onClick();
    expect(onDotClick).toHaveBeenCalledWith(2);
  });

  it('disables slide swiping while zoomed past 1x', () => {
    const rest = lightboxView(props());
    const track = elements(rest).find((el) => className(el).includes('overscroll-x-contain'))!;
    expect(className(track)).toContain('overflow-x-auto');
    expect(className(track)).toContain('snap-mandatory');

    const zoomed = lightboxView(props({ zoom: { scale: 2.5, x: 10, y: -5 } }));
    const zTrack = elements(zoomed).find((el) => className(el).includes('overscroll-x-contain'))!;
    expect(className(zTrack)).toContain('overflow-x-hidden');
    expect(className(zTrack)).not.toContain('snap-mandatory');
  });

  it('renders the pin overlay over the sharp image only when provided', () => {
    const without = lightboxView(props());
    expect(
      elements(without).some(
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
