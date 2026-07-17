import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import {
  PIN_ARM_PRESS_MS,
  activeSlideIndex,
  galleryView,
  slideTapAction,
} from '@/components/pages/pcs/PostGallery';
import { placePinFromEvent } from '@/components/pages/pcs/PostLightbox';
import { createLongPressController } from '@/components/ui/useLongPress';
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

  it('defaults render the scroll-snap carousel: native x scroller, full-width 4/5 slides', () => {
    const items = [item(0), item(1)];
    const tree = galleryView({ items, cache, presignEnabled: true, onOpen: () => {} });
    const all = elements(tree);

    // No grid container; a native overflow-x scroller with mandatory x snapping.
    expect(all.some((el) => className(el).startsWith('grid '))).toBe(false);
    const scroller = all.find((el) => className(el).includes('snap-x'))!;
    expect(className(scroller)).toContain('snap-mandatory');
    expect(className(scroller)).toContain('overflow-x-auto');

    // One full-width snapping slide per image, at the post 4/5 aspect.
    const slides = all.filter((el) => label(el)?.startsWith('View image'));
    expect(slides.length).toBe(2);
    for (const slide of slides) {
      expect(className(slide)).toContain('w-full');
      expect(className(slide)).toContain('shrink-0');
      expect(className(slide)).toContain('snap-center');
      expect(className(slide)).toContain('aspect-[4/5]');
    }
  });

  it('shows an n/N counter for the active slide (clamped into range)', () => {
    const items = [item(0), item(1), item(2)];
    const counterText = (activeIndex?: number): string | undefined => {
      const tree = galleryView({
        items,
        cache,
        presignEnabled: true,
        onOpen: () => {},
        ...(activeIndex !== undefined ? { activeIndex } : {}),
      });
      return elements(tree)
        .filter((el) => className(el).includes('text-overlay-fg'))
        .map((el) => (el.props as { children?: ReactNode }).children)
        .find((child): child is string => typeof child === 'string' && child.includes('/'));
    };
    expect(counterText()).toBe('1/3');
    expect(counterText(1)).toBe('2/3');
    // A shrunken gallery never points past the end.
    expect(counterText(9)).toBe('3/3');
  });

  it('renders one 44px dot per slide, marks the active one, and taps through', () => {
    const onDotClick = vi.fn();
    const items = [item(0), item(1), item(2)];
    const tree = galleryView({
      items,
      cache,
      presignEnabled: true,
      onOpen: () => {},
      activeIndex: 1,
      onDotClick,
    });
    const dots = elements(tree).filter((el) => label(el)?.startsWith('Go to slide'));
    expect(dots.map((el) => label(el))).toEqual([
      'Go to slide 1',
      'Go to slide 2',
      'Go to slide 3',
    ]);

    // Every dot is a 44px touch target; only the active slide's dot is current.
    for (const dot of dots) {
      expect(className(dot)).toContain('min-h-[44px]');
      expect(className(dot)).toContain('min-w-[44px]');
    }
    const current = dots.map((el) => (el.props as { 'aria-current'?: boolean })['aria-current']);
    expect(current).toEqual([false, true, false]);

    (dots[2]!.props as { onClick: () => void }).onClick();
    expect(onDotClick).toHaveBeenCalledWith(2);
  });

  it('omits the dots for a single slide and wires the native scroll listener', () => {
    const onScroll = vi.fn();
    const tree = galleryView({
      items: [item(0)],
      cache,
      presignEnabled: true,
      onOpen: () => {},
      onScroll,
    });
    const all = elements(tree);
    expect(all.some((el) => label(el)?.startsWith('Go to slide'))).toBe(false);
    const scroller = all.find((el) => className(el).includes('snap-x'))!;
    expect((scroller.props as { onScroll?: unknown }).onScroll).toBe(onScroll);
  });
});

describe('pin placement on the inline slide (relocated F5 flow)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('long-press arms placement, then the next tap places via the existing onPlacePin path', () => {
    vi.useFakeTimers();
    const onPlacePin = vi.fn();
    const onRequestPin = vi.fn();
    // The component wires the shared long-press controller to arm the pressed
    // slide at ~500ms; replicate that wiring exactly.
    let armed: number | null = null;
    const pressedIndex = 1;
    const controller = createLongPressController({
      onLongPress: () => {
        armed = pressedIndex;
        onRequestPin(pressedIndex);
      },
      thresholdMs: PIN_ARM_PRESS_MS,
    });

    controller.handlers.onPointerDown({ clientX: 40, clientY: 40 });
    vi.advanceTimersByTime(PIN_ARM_PRESS_MS);
    controller.handlers.onPointerUp();
    expect(armed).toBe(pressedIndex);
    expect(onRequestPin).toHaveBeenCalledWith(pressedIndex);

    // The click trailing the arming long-press is swallowed, not placed.
    expect(slideTapAction(armed, pressedIndex, controller.consumeClickSuppression())).toBe(
      'suppress',
    );

    // The next tap on the armed slide converts to percentage coordinates and
    // calls the existing onPlacePin path.
    expect(slideTapAction(armed, pressedIndex, controller.consumeClickSuppression())).toBe('place');
    const slideRect = { left: 100, top: 50, width: 200, height: 100 };
    const target = { getBoundingClientRect: () => slideRect };
    const point = placePinFromEvent(target, 150, 75)!;
    onPlacePin(pressedIndex, point.x, point.y);
    expect(onPlacePin).toHaveBeenCalledWith(pressedIndex, 0.25, 0.25);
  });

  it('routes taps by arming state: place on the armed slide, disarm elsewhere, open otherwise', () => {
    expect(slideTapAction(null, 0, false)).toBe('open');
    expect(slideTapAction(2, 2, false)).toBe('place');
    expect(slideTapAction(2, 0, false)).toBe('disarm');
    expect(slideTapAction(2, 2, true)).toBe('suppress');
  });

  it('shows the hint pill and crosshair on the armed carousel slide, and taps route through onSlideTap', () => {
    const onSlideTap = vi.fn();
    const items = [item(0), item(1), item(2)];
    const tree = galleryView({
      items,
      cache,
      presignEnabled: true,
      onOpen: () => {},
      pinArmedIndex: 1,
      onSlideTap,
    });
    const all = elements(tree);

    const pill = all.find((el) => (el.props as { role?: string }).role === 'status');
    expect(pill).toBeDefined();
    const pillText = all
      .map((el) => (el.props as { children?: ReactNode }).children)
      .filter((child): child is string => typeof child === 'string');
    expect(pillText).toContain('Tap the image to place a pin');

    const armedSlide = all.find((el) => label(el) === 'View image 2')!;
    expect(className(armedSlide)).toContain('cursor-crosshair');
    const otherSlide = all.find((el) => label(el) === 'View image 1')!;
    expect(className(otherSlide)).not.toContain('cursor-crosshair');

    const event = { currentTarget: {}, clientX: 5, clientY: 5 };
    (armedSlide.props as { onClick: (e: unknown) => void }).onClick(event);
    expect(onSlideTap).toHaveBeenCalledWith(1, event);
  });

  it('renders no hint pill while unarmed', () => {
    const tree = galleryView({
      items: [item(0), item(1)],
      cache,
      presignEnabled: true,
      onOpen: () => {},
      pinArmedIndex: null,
    });
    expect(elements(tree).some((el) => (el.props as { role?: string }).role === 'status')).toBe(
      false,
    );
  });
});

describe('activeSlideIndex', () => {
  it('rounds the scroll offset to the nearest slide', () => {
    expect(activeSlideIndex(0, 400, 3)).toBe(0);
    expect(activeSlideIndex(390, 400, 3)).toBe(1);
    expect(activeSlideIndex(810, 400, 3)).toBe(2);
  });

  it('clamps into range and tolerates a zero-width scroller', () => {
    expect(activeSlideIndex(9999, 400, 3)).toBe(2);
    expect(activeSlideIndex(-10, 400, 3)).toBe(0);
    expect(activeSlideIndex(120, 0, 3)).toBe(0);
    expect(activeSlideIndex(120, 400, 0)).toBe(0);
  });
});
