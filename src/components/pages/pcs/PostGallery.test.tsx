import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import {
  PIN_ARM_PRESS_MS,
  galleryView,
  intrinsicSize,
  nearestTileIndex,
  resolveRibbonTileStyle,
  ribbonTileStyle,
  slideTapAction,
} from '@/components/pages/pcs/PostGallery';
import type { MeasuredDimensions } from '@/components/pages/pcs/PostGallery';
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

// A tile whose stored asset_versions.width/height are still null (the common
// case this PR fixes): its ribbon size must come from the measured pair, or the
// 4/5 fallback until the image decodes.
function nullDimItem(n: number): GalleryItem {
  return { ...item(n), width: null, height: null };
}

// The tile <button>'s reserved style box, pulled from the ribbon tree.
function tileStyle(tree: ReactNode, index: number): unknown {
  const tile = elements(tree).find((el) => label(el) === `View image ${index + 1}`)!;
  return (tile.props as { style?: unknown }).style;
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

  it('defaults render the uncropped snap ribbon: native x scroller, snap-start tiles, no aspect crop', () => {
    const items = [item(0), item(1)];
    const tree = galleryView({ items, cache, presignEnabled: true, onOpen: () => {} });
    const all = elements(tree);

    // No grid container; a native overflow-x scroller with mandatory x snapping
    // and centre cross-axis alignment.
    expect(all.some((el) => className(el).startsWith('grid '))).toBe(false);
    const scroller = all.find((el) => className(el).includes('snap-x'))!;
    expect(className(scroller)).toContain('snap-mandatory');
    expect(className(scroller)).toContain('overflow-x-auto');
    expect(className(scroller)).toContain('items-center');

    // One snapping tile per image, hugging its image via a reserved style box:
    // no full-width slides, no aspect crop classes, snap-align start.
    const tiles = all.filter((el) => label(el)?.startsWith('View image'));
    expect(tiles.length).toBe(2);
    for (const tile of tiles) {
      expect(className(tile)).not.toContain('w-full');
      expect(className(tile)).not.toContain('aspect-[4/5]');
      expect(className(tile)).not.toContain('aspect-[3/2]');
      expect(className(tile)).toContain('shrink-0');
      expect(className(tile)).toContain('snap-start');
      expect((tile.props as { style?: unknown }).style).toEqual(ribbonTileStyle(800, 1000));
    }
  });

  it('reserves each ribbon tile box from the intrinsic dimensions, capped to the clamp and viewport', () => {
    // Portrait 800x1000: width derived from the height cap times the ratio, the
    // aspect ratio carried on the box, both caps applied.
    expect(ribbonTileStyle(800, 1000)).toEqual({
      width: 'calc(clamp(200px, 38vh, 320px) * 0.8)',
      aspectRatio: '800 / 1000',
      maxWidth: 'calc(100vw - 2rem)',
      maxHeight: 'clamp(200px, 38vh, 320px)',
    });
    // Wide 2000x1000: twice as wide as tall, still viewport-capped so it renders
    // shorter (via aspect-ratio) rather than wider.
    expect(ribbonTileStyle(2000, 1000)).toEqual({
      width: 'calc(clamp(200px, 38vh, 320px) * 2)',
      aspectRatio: '2000 / 1000',
      maxWidth: 'calc(100vw - 2rem)',
      maxHeight: 'clamp(200px, 38vh, 320px)',
    });
    // Either dimension missing or unusable degrades to a stable fallback box.
    const fallback = {
      height: 'clamp(200px, 38vh, 320px)',
      aspectRatio: '4 / 5',
      maxWidth: 'calc(100vw - 2rem)',
    };
    expect(ribbonTileStyle(null, 1000)).toEqual(fallback);
    expect(ribbonTileStyle(800, null)).toEqual(fallback);
    expect(ribbonTileStyle(0, 1000)).toEqual(fallback);
  });

  it('appends the dashed Add tile only when onAddSlide is provided', () => {
    const onAddSlide = vi.fn();
    const items = [item(0), item(1)];
    const tree = galleryView({ items, cache, presignEnabled: true, onOpen: () => {}, onAddSlide });
    const all = elements(tree);
    const addTile = all.find((el) => label(el) === 'Add image')!;
    expect(addTile).toBeDefined();

    // Fixed narrow width, dashed border, the shared height cap, snapping like a tile.
    expect(className(addTile)).toContain('w-20');
    expect(className(addTile)).toContain('border-dashed');
    expect(className(addTile)).toContain('shrink-0');
    expect(className(addTile)).toContain('snap-start');
    expect((addTile.props as { style?: unknown }).style).toEqual({
      height: 'clamp(200px, 38vh, 320px)',
    });

    // It trails the image tiles inside the scroller and calls the append flow.
    const scroller = all.find((el) => className(el).includes('snap-x'))!;
    const inScroller = elements((scroller.props as { children?: ReactNode }).children);
    const labels = inScroller.map((el) => label(el)).filter((l) => l !== undefined);
    expect(labels).toEqual(['View image 1', 'View image 2', 'Add image']);
    (addTile.props as { onClick: () => void }).onClick();
    expect(onAddSlide).toHaveBeenCalledOnce();

    // Without onAddSlide the ribbon has no Add tile.
    const viewOnly = galleryView({ items, cache, presignEnabled: true, onOpen: () => {} });
    expect(elements(viewOnly).some((el) => label(el) === 'Add image')).toBe(false);
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

describe('ribbon tile sizing hugs the true aspect ratio', () => {
  // A tile whose stored dimensions are present sizes straight from them, so its
  // reserved box carries the image's own ratio and nothing letterboxes.
  it('sizes a wide panorama short: width cap bites, height follows the ratio', () => {
    const style = resolveRibbonTileStyle({ ...item(0), width: 3000, height: 750 }, {});
    expect(style).toEqual(ribbonTileStyle(3000, 750));
    expect(style).toMatchObject({
      aspectRatio: '3000 / 750',
      maxWidth: 'calc(100vw - 2rem)',
      maxHeight: 'clamp(200px, 38vh, 320px)',
    });
  });

  it('sizes a tall portrait tall: height cap bites, width follows the ratio', () => {
    const style = resolveRibbonTileStyle({ ...item(0), width: 1080, height: 1350 }, {});
    expect(style).toEqual(ribbonTileStyle(1080, 1350));
    expect(style).toMatchObject({ aspectRatio: '1080 / 1350' });
  });

  it('sizes a square tile square', () => {
    const style = resolveRibbonTileStyle({ ...item(0), width: 1000, height: 1000 }, {});
    expect(style).toEqual(ribbonTileStyle(1000, 1000));
    expect(style).toMatchObject({ aspectRatio: '1000 / 1000' });
  });

  it('uses the 4/5 fallback when stored dimensions are null and nothing is measured yet', () => {
    const style = resolveRibbonTileStyle(nullDimItem(0), {});
    expect(style).toEqual(ribbonTileStyle(null, null));
    expect(style).toMatchObject({ aspectRatio: '4 / 5' });
  });

  it('uses the measured ratio once a null-dimension tile has loaded', () => {
    const measured: MeasuredDimensions = { 'aa-0': { width: 3000, height: 750 } };
    expect(resolveRibbonTileStyle(nullDimItem(0), measured)).toEqual(ribbonTileStyle(3000, 750));
  });

  it('prefers stored dimensions over any measured pair', () => {
    const measured: MeasuredDimensions = { 'aa-0': { width: 3000, height: 750 } };
    // item(0) carries stored 800x1000; the measured pair must not win.
    expect(resolveRibbonTileStyle(item(0), measured)).toEqual(ribbonTileStyle(800, 1000));
  });

  it('threads measured dimensions through the ribbon tree onto the tile box', () => {
    const items = [nullDimItem(0), nullDimItem(1)];
    const measured: MeasuredDimensions = { 'aa-0': { width: 3000, height: 750 } };

    // Before any load: both tiles fall back to the stable 4/5 box.
    const cold = galleryView({ items, cache, presignEnabled: true, onOpen: () => {} });
    expect(tileStyle(cold, 0)).toEqual(ribbonTileStyle(null, null));
    expect(tileStyle(cold, 1)).toEqual(ribbonTileStyle(null, null));

    // After aa-0 measures: its tile snaps to the measured ratio; aa-1 still falls back.
    const warm = galleryView({
      items,
      cache,
      presignEnabled: true,
      onOpen: () => {},
      measuredDimensions: measured,
    });
    expect(tileStyle(warm, 0)).toEqual(ribbonTileStyle(3000, 750));
    expect(tileStyle(warm, 1)).toEqual(ribbonTileStyle(null, null));
  });

  it('wires onMeasure into the ribbon thumbnail, keyed by attachment id', () => {
    const onMeasure = vi.fn();
    const items = [nullDimItem(0), nullDimItem(1)];
    const tree = galleryView({
      items,
      cache,
      presignEnabled: true,
      onOpen: () => {},
      onMeasure,
    });
    // Each ribbon tile wraps a GalleryThumb element carrying an onMeasure that
    // binds the tile's attachment id; invoking the second one reports for aa-1.
    const thumbs = elements(tree).filter(
      (el) => typeof el.type === 'function' && 'onMeasure' in (el.props as object),
    );
    expect(thumbs.length).toBe(2);
    (thumbs[1]!.props as { onMeasure: (w: number, h: number) => void }).onMeasure(1080, 1350);
    expect(onMeasure).toHaveBeenCalledWith('aa-1', 1080, 1350);
  });
});

describe('intrinsicSize ignores unusable natural dimensions', () => {
  it('returns the pair for a decoded image', () => {
    expect(intrinsicSize(3000, 750)).toEqual({ width: 3000, height: 750 });
  });

  it('returns null for zero, negative, or NaN, so state is never poisoned', () => {
    expect(intrinsicSize(0, 1000)).toBeNull();
    expect(intrinsicSize(800, 0)).toBeNull();
    expect(intrinsicSize(0, 0)).toBeNull();
    expect(intrinsicSize(-1, 1000)).toBeNull();
    expect(intrinsicSize(Number.NaN, 1000)).toBeNull();
    expect(intrinsicSize(800, Number.NaN)).toBeNull();
  });
});

describe('nearestTileIndex', () => {
  it('returns the tile whose left edge is nearest the scroll offset, for varying widths', () => {
    // Tiles 0/250/650: a wide middle tile does not skew the result.
    const offsets = [0, 250, 650];
    expect(nearestTileIndex(0, offsets)).toBe(0);
    expect(nearestTileIndex(120, offsets)).toBe(0);
    expect(nearestTileIndex(130, offsets)).toBe(1);
    expect(nearestTileIndex(400, offsets)).toBe(1);
    expect(nearestTileIndex(460, offsets)).toBe(2);
    expect(nearestTileIndex(9999, offsets)).toBe(2);
  });

  it('is stable at boundaries and tolerates empty and negative input', () => {
    expect(nearestTileIndex(0, [])).toBe(0);
    expect(nearestTileIndex(-40, [0, 300])).toBe(0);
    // An exact tie keeps the earlier tile.
    expect(nearestTileIndex(150, [0, 300])).toBe(0);
  });
});
