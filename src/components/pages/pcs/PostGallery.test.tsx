import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import {
  galleryFileKind,
  galleryView,
  galleryFrame,
  galleryFrameRatio,
  frameCut,
  frameKindNote,
  framePins,
  intrinsicSize,
  nearestTileIndex,
  resolveRibbonTileStyle,
  ribbonTileStyle,
  slideTapAction,
  soloTileStyle,
  viewerReplacesRibbon,
} from '@/components/pages/pcs/PostGallery';
import type { MeasuredDimensions } from '@/components/pages/pcs/PostGallery';
import {
  cutPercent,
  frameMap,
  IDENTITY_MAP,
  type PinDot,
} from '@/components/pages/pcs/pin-annotations';
import { IconButton } from '@/components/ui/IconButton';
import { Button } from '@/components/ui/Button';
import { DropZone } from '@/components/ui/DropZone';
import { frameFor } from '@/lib/platform-specs';
import { placePinFromEvent } from '@/components/pages/pcs/PostLightbox';
import { LONG_PRESS_MS, createLongPressController } from '@/components/ui/useLongPress';
import type { PresignCache } from '@/lib/asset-presign';
import { renderToStaticMarkup } from 'react-dom/server';
import { rememberThumbnail } from '@/lib/chat/attachments';
import type { GalleryItem } from '@srtdio/posts';

// The unit environment is node (no DOM renderer), so these specs walk the JSX
// tree returned by the hookless galleryView rather than mounting it. The
// stateful thumbnail (GalleryThumb) stays an unexpanded element, so the mocked
// cache is never actually called during the walk. IconButton (dots, pins) is
// hookless too, so it is expanded to the <button> it renders.

function flatten(node: ReactNode, out: ReactElement[]): void {
  if (Array.isArray(node)) {
    node.forEach((child) => flatten(child, out));
    return;
  }
  if (node === null || typeof node !== 'object' || !('props' in node)) return;
  const raw = node as ReactElement;
  const el =
    raw.type === IconButton ? IconButton(raw.props as Parameters<typeof IconButton>[0]) : raw;
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

// A tile whose stored asset_versions.width/height are still null (the common
// case this PR fixes): its ribbon size must come from the measured pair, or the
// 4/5 fallback until the image decodes.
function nullDimItem(n: number): GalleryItem {
  return { ...item(n), width: null, height: null };
}

// The ribbon tile boxes (each holds its absolutely placed tile <button>).
function tileBoxes(tree: ReactNode): ReactElement[] {
  return elements(tree).filter(
    (el) => (el.props as Record<string, unknown>)['data-ribbon-tile'] !== undefined,
  );
}

// A ribbon tile's reserved style box, pulled from the ribbon tree.
function tileStyle(tree: ReactNode, index: number): unknown {
  return (tileBoxes(tree)[index]!.props as { style?: unknown }).style;
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

    // One snapping box per image, hugging its image via a reserved style box:
    // no full-width slides, no aspect crop classes, snap-align start. The tile
    // button fills its box absolutely, so the image never sizes the box.
    const boxes = tileBoxes(tree);
    expect(boxes.length).toBe(2);
    for (const box of boxes) {
      expect(className(box)).not.toContain('w-full');
      expect(className(box)).not.toContain('aspect-[4/5]');
      expect(className(box)).toContain('shrink-0');
      expect(className(box)).toContain('snap-start');
      expect(className(box)).toContain('overflow-hidden');
      expect((box.props as { style?: unknown }).style).toEqual(ribbonTileStyle(800, 1000));
    }
    const tiles = all.filter((el) => label(el)?.startsWith('View image'));
    expect(tiles.length).toBe(2);
    for (const tile of tiles) expect(className(tile)).toContain('absolute inset-0');
    // The whole image fits its box, never cropped.
    const fits = all
      .filter((el) => (el.props as { fit?: string }).fit !== undefined)
      .map((el) => (el.props as { fit: string }).fit);
    expect(fits).toEqual(['fit', 'fit']);
  });

  it('reserves each ribbon tile box from the intrinsic dimensions, capped to the clamp and column', () => {
    // Portrait 800x1000: width derived from the height cap times the ratio, the
    // aspect ratio carried on the box, capped at the scroller column.
    expect(ribbonTileStyle(800, 1000)).toEqual({
      width: 'calc(clamp(200px, 38vh, 320px) * 0.8)',
      aspectRatio: '0.8',
      maxWidth: '100%',
    });
    // Wide 2000x1000: twice as wide as tall, still column-capped so it renders
    // shorter (via aspect-ratio) rather than wider.
    expect(ribbonTileStyle(2000, 1000)).toEqual({
      width: 'calc(clamp(200px, 38vh, 320px) * 2)',
      aspectRatio: '2',
      maxWidth: '100%',
    });
    // Either dimension missing or unusable degrades to a stable 4/5 box.
    const fallback = {
      width: 'calc(clamp(200px, 38vh, 320px) * 0.8)',
      aspectRatio: '0.8',
      maxWidth: '100%',
    };
    expect(ribbonTileStyle(null, 1000)).toEqual(fallback);
    expect(ribbonTileStyle(800, null)).toEqual(fallback);
    expect(ribbonTileStyle(0, 1000)).toEqual(fallback);
  });

  it('never renders an add tile on the post ribbon, even when onAddSlide is provided', () => {
    const onAddSlide = vi.fn();
    const items = [item(0), item(1)];
    const tree = galleryView({ items, cache, presignEnabled: true, onOpen: () => {}, onAddSlide });
    const all = elements(tree);

    // No add affordance sits on the ribbon: no "Add image" tile, no dashed tile.
    expect(all.some((el) => label(el) === 'Add image')).toBe(false);
    expect(all.some((el) => className(el).includes('border-dashed'))).toBe(false);

    // The scroller holds exactly the image tiles, with nothing trailing them.
    const scroller = all.find((el) => className(el).includes('snap-x'))!;
    const inScroller = elements((scroller.props as { children?: ReactNode }).children);
    const labels = inScroller.map((el) => label(el)).filter((l) => l !== undefined);
    expect(labels).toEqual(['View image 1', 'View image 2']);
  });

  it('offers the only add affordance through the zero-asset empty state', () => {
    const onAddSlide = vi.fn();
    const tree = galleryView({
      items: [],
      cache,
      presignEnabled: true,
      onOpen: () => {},
      onAddSlide,
    });
    const texts = elements(tree)
      .map((el) => (el.props as { children?: ReactNode }).children)
      .filter((child): child is string => typeof child === 'string');
    expect(texts).toContain('Add images');

    // The upload zone is wired to the append flow.
    const zone = elements(tree).find((el) => el.type === DropZone)!;
    (zone.props as { onClick: () => void }).onClick();
    expect(onAddSlide).toHaveBeenCalledOnce();

    // A view-only empty gallery (no onAddSlide) shows no add affordance at all.
    const viewOnly = galleryView({ items: [], cache, presignEnabled: true, onOpen: () => {} });
    const viewOnlyTexts = elements(viewOnly)
      .map((el) => (el.props as { children?: ReactNode }).children)
      .filter((child): child is string => typeof child === 'string');
    expect(viewOnlyTexts).not.toContain('Add images');
  });

  it('sizes a lone image to fill the column at its own ratio, never overflowing', () => {
    // A single image is not a peek tile: it fills the column width, keeps its own
    // aspect ratio (fit, no crop), and a tall image narrows to the 78vh cap.
    const items = [item(0)]; // stored 800x1000
    const tree = galleryView({ items, cache, presignEnabled: true, onOpen: () => {} });
    const all = elements(tree);
    const style = tileStyle(tree, 0) as Record<string, unknown>;
    expect(style).toEqual(soloTileStyle(800, 1000));
    expect(style.width).toBe('min(100%, calc(78vh * 0.8))');
    expect(style.aspectRatio).toBe('0.8');
    expect(style.maxWidth).toBe('100%');

    // The box carries no aspect-crop class and clips; the image fits inside.
    const box = tileBoxes(tree)[0]!;
    expect(className(box)).not.toContain('aspect-[4/5]');
    expect(className(box)).toContain('overflow-hidden');

    // The single-image index chip still reads 1/1, exactly as before.
    const chip = all
      .filter((el) => className(el).includes('text-overlay-fg'))
      .map((el) => (el.props as { children?: ReactNode }).children)
      .find((child): child is string => typeof child === 'string' && child.includes('/'));
    expect(chip).toBe('1/1');
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
    // slide at the one LONG_PRESS_MS; replicate that wiring exactly.
    let armed: number | null = null;
    const pressedIndex = 1;
    const controller = createLongPressController({
      onLongPress: () => {
        armed = pressedIndex;
        onRequestPin(pressedIndex);
      },
    });

    controller.handlers.onPointerDown({ clientX: 40, clientY: 40 });
    vi.advanceTimersByTime(LONG_PRESS_MS);
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
      aspectRatio: '4',
      maxWidth: '100%',
    });
  });

  it('sizes a tall portrait tall: height cap bites, width follows the ratio', () => {
    const style = resolveRibbonTileStyle({ ...item(0), width: 1080, height: 1350 }, {});
    expect(style).toEqual(ribbonTileStyle(1080, 1350));
    expect(style).toMatchObject({ aspectRatio: '0.8' });
  });

  it('sizes a square tile square', () => {
    const style = resolveRibbonTileStyle({ ...item(0), width: 1000, height: 1000 }, {});
    expect(style).toEqual(ribbonTileStyle(1000, 1000));
    expect(style).toMatchObject({ aspectRatio: '1' });
  });

  it('uses the 4/5 fallback when stored dimensions are null and nothing is measured yet', () => {
    const style = resolveRibbonTileStyle(nullDimItem(0), {});
    expect(style).toEqual(ribbonTileStyle(null, null));
    expect(style).toMatchObject({ aspectRatio: '0.8' });
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

describe('ribbon <-> in-place viewer swap', () => {
  it('keeps the ribbon while no tile is open', () => {
    // openIndex null: the ribbon renders, never the in-place viewer.
    expect(viewerReplacesRibbon(null, 3)).toBe(false);
    // A galleryView call with no open index still yields the ribbon tiles.
    const tree = galleryView({
      items: [item(0), item(1)],
      cache,
      presignEnabled: true,
      onOpen: () => {},
    });
    expect(elements(tree).some((el) => label(el)?.startsWith('View image'))).toBe(true);
  });

  it('replaces the ribbon with the in-place viewer once a tile is opened', () => {
    // A non-null open index over a non-empty gallery swaps in the viewer.
    expect(viewerReplacesRibbon(0, 3)).toBe(true);
    expect(viewerReplacesRibbon(2, 3)).toBe(true);
  });

  it('never swaps in the viewer for the empty and upload states', () => {
    // Empty gallery: even a stray index keeps the ribbon branch (empty/upload UI).
    expect(viewerReplacesRibbon(0, 0)).toBe(false);
    expect(viewerReplacesRibbon(null, 0)).toBe(false);
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

describe('file tiles (T8)', () => {
  function fileItem(n: number, mimeType: string | null, kind = 'file'): GalleryItem {
    return { ...nullDimItem(n), filename: `deck-${n}.pdf`, mimeType, kind };
  }

  it('picks the tile kind from the stored kind and mime, never the name; images get none', () => {
    expect(galleryFileKind(fileItem(0, 'application/pdf'))).toBe('pdf');
    expect(galleryFileKind(fileItem(0, null, 'video'))).toBe('video');
    expect(galleryFileKind(fileItem(0, 'video/mp4'))).toBe('video');
    expect(
      galleryFileKind(
        fileItem(0, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
      ),
    ).toBe('office');
    expect(galleryFileKind(fileItem(0, null))).toBe('file');
    expect(galleryFileKind(item(0))).toBeNull();
  });

  it.each([2, 4])('a PDF tile renders the file tile in the %s-column gallery', (columns) => {
    const html = renderToStaticMarkup(
      galleryView({
        items: [fileItem(0, 'application/pdf'), item(1)],
        cache,
        presignEnabled: true,
        onOpen: () => {},
        columns,
        aspect: '3/2',
      }),
    );
    expect(html).toContain('data-file-tile="pdf"');
    expect(html).toContain('deck-0.pdf');
    expect(html).toMatch(/data-file-meta[^>]*><span><span>PDF</);
  });

  it('a tapped file tile opens its slide (which opens the FileViewer)', () => {
    const onOpen = vi.fn();
    const tree = galleryView({
      items: [fileItem(0, 'application/pdf')],
      cache,
      presignEnabled: true,
      onOpen,
      columns: 2,
    });
    const tile = elements(tree).find((el) => label(el) === 'View image 1');
    (tile?.props as { onClick: () => void }).onClick();
    expect(onOpen).toHaveBeenCalledWith(0);
  });

  it('the ribbon reserves a file tile from its stored thumbnail size, else the fixed 4/5 box', () => {
    const pdf = fileItem(7, 'application/pdf');
    expect(resolveRibbonTileStyle(pdf, {})).toEqual(ribbonTileStyle(null, null));
    rememberThumbnail(pdf.assetVersionId, { width: 600, height: 800, pageCount: 2 });
    expect(resolveRibbonTileStyle(pdf, {})).toEqual(ribbonTileStyle(600, 800));
  });
});

describe('the post screen shows every picture whole', () => {
  const tall = (n: number): GalleryItem => ({ ...item(n), width: 1080, height: 1920 });
  const square = (n: number): GalleryItem => ({ ...item(n), width: 1080, height: 1080 });
  const lineOf = (tree: ReactNode) =>
    elements(tree).find(
      (el) => (el.props as Record<string, unknown>)['data-frame-cut'] !== undefined,
    );
  const noteOf = (tree: ReactNode) =>
    elements(tree).find(
      (el) => (el.props as Record<string, unknown>)['data-frame-note'] !== undefined,
    );
  const lineText = (tree: ReactNode): string | undefined =>
    elements(lineOf(tree))
      .map((el) => (el.props as { children?: ReactNode }).children)
      .find((child): child is string => typeof child === 'string' && child.includes('cuts'));

  it('a solo tile is never wider than its column: no fixed px width, full-width slot', () => {
    for (const [w, h] of [
      [1080, 1080],
      [1080, 1350],
      [1080, 1920],
      [6000, 1000],
      [null, null],
    ] as const) {
      const style = soloTileStyle(w, h);
      // Width is capped by 100% of a definite slot, never a px value.
      expect(String(style.width)).toMatch(/^min\(100%, /);
      expect(String(style.width)).not.toMatch(/\d+px/);
      expect(style.maxWidth).toBe('100%');
    }
    // The real bug: a text post, one 1080x1080 image. The slot is the scroller's
    // full-width snap item, so the tile's 100% is never a cyclic percentage.
    const items = [square(0)];
    const tree = galleryView({
      items,
      cache,
      presignEnabled: true,
      onOpen: () => {},
      measuredDimensions: { 'aa-0': { width: 1080, height: 1080 } },
    });
    const slot = elements(tree).find(
      (el) => (el.props as Record<string, unknown>)['data-ribbon-slot'] !== undefined,
    )!;
    expect(className(slot)).toContain('w-full');
    expect(className(slot)).toContain('shrink-0');
    expect(className(slot)).toContain('snap-start');
    expect(tileBoxes((slot.props as { children?: ReactNode }).children)).toHaveLength(1);
    expect(tileStyle(tree, 0)).toEqual(soloTileStyle(1080, 1080));
    // Multi-image tiles cap at the scroller column too.
    expect(ribbonTileStyle(6000, 1000).maxWidth).toBe('100%');
  });

  it('a text post with an image and a single_image post both render the unframed ribbon', () => {
    for (const format of ['text', 'single_image']) {
      const items = [square(0)];
      const tree = galleryView({
        items,
        cache,
        presignEnabled: true,
        onOpen: () => {},
        frame: galleryFrame('linkedin', format, items, {}),
        platformLabel: 'LinkedIn',
      });
      expect(tileBoxes(tree)).toHaveLength(1);
      expect(tileStyle(tree, 0)).toEqual(soloTileStyle(1080, 1080));
      const fits = elements(tree)
        .filter((el) => (el.props as { fit?: string }).fit !== undefined)
        .map((el) => (el.props as { fit: string }).fit);
      expect(fits).toEqual(['fit']);
    }
    expect(galleryFrame('linkedin', 'text', [square(0)], {})).toBeNull();
    expect(galleryFrame('linkedin', 'single_image', [square(0)], {})).not.toBeNull();
  });

  it('warns how much the platform cuts, never cropping the picture', () => {
    const items = [tall(0)];
    const frame = frameFor('linkedin', 'single_image', { kind: 'image', w: 1080, h: 1920 });
    expect(frame?.fit).toBe('cover');
    const n = cutPercent(frameMap({ w: 1080, h: 1920 }, frame!.ratio, 'cover'));
    expect(n).toBeGreaterThan(0);
    expect(frameCut(items[0], {}, galleryFrame('linkedin', 'single_image', items, {}))).toBe(n);
    const tree = galleryView({
      items,
      cache,
      presignEnabled: true,
      onOpen: () => {},
      frame: galleryFrame('linkedin', 'single_image', items, {}),
      platformLabel: 'LinkedIn',
      onSeePreview: () => {},
    });
    expect(lineText(tree)).toBe(`LinkedIn cuts ${n}% of this.`);
    expect(className(lineOf(tree)!)).not.toContain('text-fg-3');
    const p = elements(lineOf(tree)).find((el) => el.type === 'p');
    expect(className(p!)).toBe('text-base text-fg-2');
    // The picture itself is the whole image in a box of its own ratio.
    expect(tileStyle(tree, 0)).toEqual(soloTileStyle(1080, 1920));
  });

  it('shows no line when the frame fits, uses bands, or there is no frame', () => {
    const cases = [
      // LinkedIn square fits a square frame: nothing cut.
      ['linkedin', 'single_image', [square(0)]],
      // TikTok fits a 16:9 slide in 9:16 with bands: nothing cut.
      ['tiktok', 'video', [{ ...item(0), width: 1920, height: 1080 }]],
      // Text posts have no frame.
      ['linkedin', 'text', [tall(0)]],
    ] as const;
    for (const [platform, format, items] of cases) {
      const frame = galleryFrame(platform, format, [...items], {});
      if (platform === 'tiktok') expect(frame?.fit).toBe('contain');
      const tree = galleryView({
        items: [...items],
        cache,
        presignEnabled: true,
        onOpen: () => {},
        frame,
        platformLabel: 'P',
        onSeePreview: () => {},
      });
      expect(lineOf(tree)).toBeUndefined();
    }
  });

  it('shows no line when the active slide is not an image', () => {
    const video: GalleryItem = {
      ...tall(1),
      kind: 'video',
      mimeType: 'video/mp4',
      filename: 'clip.mp4',
    };
    const frame = galleryFrame('linkedin', 'single_image', [tall(0), video], {});
    expect(frameCut(video, {}, frame)).toBe(0);
    const tree = galleryView({
      items: [tall(0), video],
      cache,
      presignEnabled: true,
      onOpen: () => {},
      frame,
      platformLabel: 'LinkedIn',
      activeIndex: 1,
    });
    expect(lineOf(tree)).toBeUndefined();
  });

  it('"See preview" calls onSeePreview', () => {
    const onSeePreview = vi.fn();
    const onOpen = vi.fn();
    const items = [tall(0)];
    const tree = galleryView({
      items,
      cache,
      presignEnabled: true,
      onOpen,
      frame: galleryFrame('linkedin', 'single_image', items, {}),
      platformLabel: 'LinkedIn',
      onSeePreview,
    });
    const button = elements(lineOf(tree)).find((el) => el.type === Button)!;
    expect((button.props as { variant: string }).variant).toBe('link');
    expect((button.props as { children: string }).children).toBe('See preview');
    (button.props as { onClick: () => void }).onClick();
    expect(onSeePreview).toHaveBeenCalledOnce();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('pins render on the ribbon tiles at their stored positions, no frame mapping', () => {
    const items = [tall(0), square(1)];
    const pins: Record<string, PinDot[]> = {
      'aa-0': [{ n: 1, annotationId: 'a1', commentId: 'c1', x: 0.1, y: 0.05 }],
      'aa-1': [{ n: 2, annotationId: 'a2', commentId: 'c2', x: 0.75, y: 0.4 }],
    };
    const onPinClick = vi.fn();
    const tree = galleryView({
      items,
      cache,
      presignEnabled: true,
      onOpen: () => {},
      // A cropping frame must not move the pins: the picture is never cut.
      frame: galleryFrame('linkedin', 'single_image', items, {}),
      platformLabel: 'LinkedIn',
      pinsFor: (g) => pins[g.assetAttachmentId] ?? [],
      onPinClick,
    });
    const shown = elements(tree).filter((el) => /^Pin /.test(label(el) ?? ''));
    expect(shown.map(label)).toEqual(['Pin 1', 'Pin 2']);
    const style = (el: ReactElement) =>
      (el.props as { style: { left: string; top: string } }).style;
    expect(style(shown[0]!)).toEqual({ left: '10%', top: '5%' });
    expect(style(shown[1]!)).toEqual({ left: '75%', top: '40%' });
    expect((shown[0]!.props as Record<string, unknown>)['data-pin-edge']).toBeUndefined();
    (shown[1]!.props as { onClick: () => void }).onClick();
    expect(onPinClick).toHaveBeenCalledWith('c2');
    // Each pin sits inside its own tile box.
    const boxes = tileBoxes(tree);
    expect(elements(boxes[0]).some((el) => label(el) === 'Pin 1')).toBe(true);
    expect(elements(boxes[1]).some((el) => label(el) === 'Pin 2')).toBe(true);
  });

  it('YouTube Shorts with an image shows the same note as the panel', () => {
    const items = [{ ...item(1), width: 1920, height: 1080 }];
    expect(frameKindNote('youtube_shorts', items)).toBe('Shorts are video only.');
    expect(frameKindNote('tiktok', items)).toBeNull();
    const tree = galleryView({
      items,
      cache,
      presignEnabled: true,
      onOpen: () => {},
      frame: galleryFrame('youtube_shorts', 'short', items, {}),
      frameNote: frameKindNote('youtube_shorts', items),
      platformLabel: 'YouTube Shorts',
    });
    const note = noteOf(tree);
    expect((note?.props as { children: string }).children).toBe('Shorts are video only.');
    expect(className(note!)).toBe('mt-1 text-base text-fg-2');
    // The picture is still the whole image in the unframed ribbon.
    expect(tileBoxes(tree)).toHaveLength(1);
  });

  it('the platform note and the cut line show together, neither hiding the other', () => {
    const items = [tall(0)];
    const onSeePreview = vi.fn();
    const frame = galleryFrame('linkedin', 'single_image', items, {});
    const tree = galleryView({
      items,
      cache,
      presignEnabled: true,
      onOpen: () => {},
      frame,
      frameNote: 'Shorts are video only.',
      platformLabel: 'LinkedIn',
      onSeePreview,
    });
    const n = frameCut(items[0], {}, frame);
    expect(n).toBeGreaterThan(0);
    expect(lineText(tree)).toBe(`LinkedIn cuts ${n}% of this.`);
    expect((noteOf(tree)?.props as { children: string }).children).toBe('Shorts are video only.');
    // The cut line comes first, then the note.
    const all = elements(tree);
    expect(all.indexOf(lineOf(tree)!)).toBeLessThan(all.indexOf(noteOf(tree)!));
    const button = elements(lineOf(tree)).find((el) => el.type === Button)!;
    (button.props as { onClick: () => void }).onClick();
    expect(onSeePreview).toHaveBeenCalledOnce();
  });

  it('text formats have no frame', () => {
    expect(galleryFrameRatio('x', 'text', [item(1)], {})).toBeNull();
  });

  it('the frame comes from the first slide, measured when not stored', () => {
    const first = { ...item(1), width: null, height: null };
    expect(galleryFrameRatio('instagram', 'carousel', [first], {})).toBeCloseTo(0.8);
    expect(
      galleryFrameRatio('instagram', 'carousel', [first], {
        'aa-1': { width: 1080, height: 1080 },
      }),
    ).toBe(1);
  });

  it('framePins with the identity map draws every pin at its stored spot', () => {
    const tree = framePins(
      [{ n: 1, annotationId: 'a1', commentId: 'c1', x: 0.5, y: 0.25 }],
      IDENTITY_MAP,
      () => {},
    );
    const pin = elements(tree).find((el) => label(el) === 'Pin 1');
    expect((pin?.props as { style: { left: string; top: string } }).style).toEqual({
      left: '50%',
      top: '25%',
    });
    expect(className(pin!)).toContain('h-11 w-11');
  });
});
