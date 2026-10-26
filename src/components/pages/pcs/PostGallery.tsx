import { useEffect, useRef, useState } from 'react';
import type {
  PointerEvent as ReactPointerEvent,
  MouseEvent as ReactMouseEvent,
  UIEvent as ReactUIEvent,
} from 'react';
import type { CSSProperties, ReactElement, ReactNode, Ref } from 'react';
import {
  ICON_SIZE,
  IconAssets,
  IconChevronLeft,
  IconChevronRight,
  IconGrip,
  IconHistory,
  IconImagePlus,
  IconLock,
  IconPin,
  IconPlus,
  IconSwitch,
} from '@/components/ui/icons';
import { dropIndex, moveTo } from '@/components/pages/pcs/gallery-transforms';
import { useLongPress } from '@/components/ui/useLongPress';
import { PostLightbox, placePinFromEvent } from '@/components/pages/pcs/PostLightbox';
import { FileTile, storedThumbnailMeta } from '@/components/ui/FileTile';
import { classifyFileKind, type FileKind } from '@/lib/chat/attachments';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { DropZone } from '@/components/ui/DropZone';
import { PressableRow } from '@/components/ui/PressableRow';
import type { PresignCache, PresignDeps } from '@/lib/asset-presign';
import { frameFor, type Frame } from '@/lib/platform-specs';
import { galleryItemMedia } from '@/components/media/PlatformFrame';
import {
  cutPercent,
  frameMap,
  IDENTITY_MAP,
  originalToFrame,
  type FrameMap,
  type PinDot,
} from '@/components/pages/pcs/pin-annotations';
import type { GalleryItem } from '@srtdio/posts';

/** The gesture handlers a tile spreads for long-press + right-click. */
interface TileGestures {
  onPointerDown: (event: ReactPointerEvent) => void;
  onPointerMove: (event: ReactPointerEvent) => void;
  onPointerUp: () => void;
  onPointerCancel: () => void;
  onContextMenu: (event: ReactMouseEvent) => void;
}

/** True when this item has an inline image preview worth resolving for a tile. */
function isImage(item: GalleryItem): boolean {
  return item.kind === 'image' || (item.mimeType ?? '').startsWith('image/');
}

/** True when this item is a video (by stored kind or mime). */
function isVideo(item: GalleryItem): boolean {
  return item.kind === 'video' || (item.mimeType ?? '').startsWith('video/');
}

/**
 * The file tile kind for a non-image item, from its stored kind and the
 * server-detected mime (never the file name); null for images. Pure.
 */
export function galleryFileKind(item: GalleryItem): FileKind | null {
  if (isImage(item)) return null;
  if (isVideo(item)) return 'video';
  return classifyFileKind(item.mimeType ?? '');
}

/**
 * The usable intrinsic size from a decoded image's naturalWidth/naturalHeight,
 * or null when either is zero, negative, or NaN (an undecoded or broken image
 * reports zeros). Pure, so the ribbon never reports a size that would poison the
 * measured-dimensions state. Exported for unit coverage.
 */
export function intrinsicSize(
  naturalWidth: number,
  naturalHeight: number,
): { width: number; height: number } | null {
  if (naturalWidth > 0 && naturalHeight > 0) return { width: naturalWidth, height: naturalHeight };
  return null;
}

/** Lazily resolve and render one tile's inline thumbnail, falling back to a glyph. */
function GalleryThumb({
  item,
  cache,
  presignEnabled,
  fit = 'cover',
  onMeasure,
}: {
  item: GalleryItem;
  cache: PresignCache;
  presignEnabled: boolean;
  /**
   * 'cover' crops to fill (the brief grid and the small thumbnails); 'fit'
   * scales the whole image into its box, never cropping (the post ribbon,
   * whose tile box already carries the image's own ratio).
   */
  fit?: 'cover' | 'fit';
  /**
   * Ribbon only: report the image's intrinsic size once it decodes, so a tile
   * whose stored dimensions are null can still hug its true ratio. Never fires
   * with a zero or NaN dimension, and never on a load error.
   */
  onMeasure?: ((width: number, height: number) => void) | undefined;
}) {
  const versionId = item.assetVersionId;
  const renderable = presignEnabled && isImage(item) && versionId !== '';
  const [url, setUrl] = useState<string | null>(() =>
    renderable ? (cache.peek(versionId)?.url ?? null) : null,
  );
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!renderable) return;
    let live = true;
    cache
      .resolve(versionId)
      .then((presigned) => {
        if (live) setUrl(presigned.url);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [renderable, versionId, cache]);

  if (renderable && url !== null && !failed) {
    return (
      <img
        src={url}
        alt={item.filename}
        loading="lazy"
        onError={() => setFailed(true)}
        onLoad={(event) => {
          if (onMeasure === undefined) return;
          const size = intrinsicSize(
            event.currentTarget.naturalWidth,
            event.currentTarget.naturalHeight,
          );
          if (size !== null) onMeasure(size.width, size.height);
        }}
        className={fit === 'fit' ? 'h-full w-full object-contain' : 'h-full w-full object-cover'}
      />
    );
  }
  // PDF, video, Office and other files: the file tile (stored thumbnail or
  // icon card, name and meta). Tapping it opens the file as before.
  const fileKind = galleryFileKind(item);
  if (fileKind !== null) {
    return (
      <FileTile
        kind={fileKind}
        mime={item.mimeType ?? ''}
        name={item.filename}
        versionId={versionId}
        pageCount={item.pageCount}
        cache={cache}
        presignEnabled={presignEnabled}
      />
    );
  }
  // Fallback covers a failed image presign and the unconfigured-env case
  // (presignEnabled false), so a tile never renders blank.
  return (
    <div className="flex h-full w-full items-center justify-center bg-panel-3 text-fg-3">
      <IconAssets size={ICON_SIZE.tray} />
    </div>
  );
}

// Map the column count to a literal Tailwind grid class. The brief gallery
// passes 2 and keeps its overview grid; any other explicit override keeps the
// old responsive grid. The post gallery default (4, i.e. the prop omitted)
// renders the scroll-snap carousel instead and never reaches this. Literal
// strings keep both classes visible to the Tailwind JIT scanner, which cannot
// see interpolated class names.
function gridClass(columns: number): string {
  return columns === 2
    ? 'grid grid-cols-2 gap-3'
    : 'grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4';
}

/**
 * The ribbon tile whose left edge is nearest the scroller's scrollLeft, given
 * each tile's measured left offset within the scroller. Tiles hug their images
 * so their widths vary by aspect ratio; the offsets are measured, never assumed
 * uniform. Pure so the scroll math is unit-testable without a DOM.
 */
export function nearestTileIndex(scrollLeft: number, tileOffsets: readonly number[]): number {
  let nearest = 0;
  let nearestDistance = Infinity;
  for (let i = 0; i < tileOffsets.length; i += 1) {
    const distance = Math.abs((tileOffsets[i] ?? 0) - scrollLeft);
    if (distance < nearestDistance) {
      nearest = i;
      nearestDistance = distance;
    }
  }
  return nearest;
}

// The ribbon's shared tile height cap. Width never passes the scroller column:
// every tile box caps at 100% of a definite width (the scroller, or the solo
// slot), never a shrink-to-fit parent, so no percentage is ever cyclic and an
// undecoded or huge image can never widen its tile.
const RIBBON_TILE_MAX_HEIGHT = 'clamp(200px, 38vh, 320px)';
// A solo image is not a peek ribbon: it fills the column at its own ratio, taller
// than a ribbon tile is allowed to be.
const SOLO_TILE_MAX_HEIGHT = '78vh';
// Unknown dimensions: a stable 4/5 box the image fits inside until it decodes.
const FALLBACK_RATIO = 4 / 5;

/** The usable w / h ratio, or the 4/5 fallback. Pure. */
function tileRatio(width: number | null, height: number | null): number {
  return width !== null && height !== null && width > 0 && height > 0
    ? width / height
    : FALLBACK_RATIO;
}

/**
 * The reserved box for one ribbon tile when the ribbon holds several. Width is
 * the height cap times the ratio, capped at the scroller's width (the tile is
 * the scroller's own flex item, so 100% is definite); aspect-ratio carries the
 * height, so a wide image renders shorter, never wider than the column. The
 * box holds no in-flow content, so the image can never size it. Pure.
 */
export function ribbonTileStyle(width: number | null, height: number | null): CSSProperties {
  const ratio = tileRatio(width, height);
  return {
    width: `calc(${RIBBON_TILE_MAX_HEIGHT} * ${ratio})`,
    aspectRatio: `${ratio}`,
    maxWidth: '100%',
  };
}

/**
 * The reserved box for the lone image: it fills the column width at its own
 * ratio, and a tall image narrows (width follows the 78vh height cap) instead
 * of overflowing. The box sits in a full-width slot, so 100% is definite. No
 * fixed width, so it can never be wider than the column. Pure.
 */
export function soloTileStyle(width: number | null, height: number | null): CSSProperties {
  const ratio = tileRatio(width, height);
  return {
    width: `min(100%, calc(${SOLO_TILE_MAX_HEIGHT} * ${ratio}))`,
    aspectRatio: `${ratio}`,
    maxWidth: '100%',
  };
}

/** A tile's intrinsic size measured from the decoded image, keyed by attachment id. */
export type MeasuredDimensions = Record<string, { width: number; height: number }>;

/**
 * The reserved box for one ribbon tile, resolving size by precedence: stored
 * intrinsic dimensions first, then the pair measured from the decoded image,
 * then the stable 4/5 fallback (until that image loads). The resolved dimensions
 * feed one authoritative sizing function: a peek tile ({@link ribbonTileStyle})
 * when the ribbon holds several images, or the full-width solo box
 * ({@link soloTileStyle}) when it holds exactly one. Pure.
 */
export function resolveRibbonTileStyle(
  item: GalleryItem,
  measured: MeasuredDimensions,
  solo = false,
): CSSProperties {
  let width: number | null = null;
  let height: number | null = null;
  const thumb = isImage(item)
    ? null
    : storedThumbnailMeta(item.assetVersionId, item.mimeType ?? '');
  if (item.width !== null && item.height !== null && item.width > 0 && item.height > 0) {
    width = item.width;
    height = item.height;
  } else if (thumb !== null) {
    // A file with a stored thumbnail: its box comes from the thumbnail's size.
    width = thumb.thumbW;
    height = thumb.thumbH;
  } else {
    const seen = measured[item.assetAttachmentId];
    if (seen !== undefined) {
      width = seen.width;
      height = seen.height;
    }
  }
  return solo ? soloTileStyle(width, height) : ribbonTileStyle(width, height);
}

/** An item's intrinsic size: stored first, then measured from the decoded image. */
function itemDims(
  item: GalleryItem,
  measured: MeasuredDimensions,
): { w: number; h: number } | null {
  if (item.width !== null && item.height !== null && item.width > 0 && item.height > 0) {
    return { w: item.width, h: item.height };
  }
  const seen = measured[item.assetAttachmentId];
  return seen !== undefined ? { w: seen.width, h: seen.height } : null;
}

/**
 * The post's platform frame from the shared frame rule, fed the FIRST item (a
 * carousel's first slide sets every slide's frame); null when the format has no
 * media box. Pure.
 */
export function galleryFrame(
  platform: string,
  format: string,
  items: readonly GalleryItem[],
  measured: MeasuredDimensions,
): Frame | null {
  const first = items[0];
  return frameFor(
    platform,
    format,
    first === undefined ? null : galleryItemMedia(first, itemDims(first, measured)),
  );
}

/** The frame's ratio (w / h) alone, or null. Pure. */
export function galleryFrameRatio(
  platform: string,
  format: string,
  items: readonly GalleryItem[],
  measured: MeasuredDimensions,
): number | null {
  return galleryFrame(platform, format, items, measured)?.ratio ?? null;
}

/** How one slide sits in the frame: cropped (cover) or fit with bands. Pure. */
export function slideMap(item: GalleryItem, measured: MeasuredDimensions, frame: Frame): FrameMap {
  return isImage(item) ? frameMap(itemDims(item, measured), frame.ratio, frame.fit) : IDENTITY_MAP;
}

/**
 * How much of a slide the platform frame cuts, as a whole percent: 0 with no
 * frame, a banded frame (nothing is cut), or a slide that is not an image. It
 * only decides the warning line under the picture; the post screen never crops.
 * Pure.
 */
export function frameCut(
  item: GalleryItem | undefined,
  measured: MeasuredDimensions,
  frame: Frame | null,
): number {
  if (frame === null || frame.fit !== 'cover' || item === undefined || !isImage(item)) return 0;
  return cutPercent(slideMap(item, measured, frame));
}

const EDGE_SHIFT: Record<string, string> = {
  left: 'translate-x-0 -translate-y-1/2',
  right: '-translate-x-full -translate-y-1/2',
  top: '-translate-x-1/2 translate-y-0',
  bottom: '-translate-x-1/2 -translate-y-full',
};

/**
 * Pins over a slide. Stored points are relative to the original; each is mapped
 * through the shown window (the post ribbon shows the whole original, so it
 * passes {@link IDENTITY_MAP}). Inside: the numbered dot at its exact spot.
 * Outside: a small marker on the nearest frame edge, still a 44px button.
 */
export function framePins(
  pins: readonly PinDot[],
  map: FrameMap,
  onPinClick: ((commentId: string) => void) | undefined,
): ReactElement {
  return (
    <div className="pointer-events-none absolute inset-0">
      {pins.map((pin) => {
        const at = originalToFrame(pin, map);
        return (
          <IconButton
            key={pin.annotationId}
            type="button"
            data-pin-edge={at.edge ?? undefined}
            label={at.edge === null ? `Pin ${pin.n}` : `Pin ${pin.n}, outside the frame`}
            onClick={() => onPinClick?.(pin.commentId)}
            style={{ left: `${at.x * 100}%`, top: `${at.y * 100}%` }}
            className={cn(
              'pointer-events-auto absolute focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-annotation-line',
              at.edge === null ? '-translate-x-1/2 -translate-y-1/2' : EDGE_SHIFT[at.edge],
            )}
          >
            {at.edge === null ? (
              <span className="flex h-6 w-6 items-center justify-center rounded-full border-2 border-annotation-line bg-annotation-bg text-sm font-semibold tabular-nums text-fg ring-2 ring-overlay-fg">
                {pin.n}
              </span>
            ) : (
              <span className="flex h-4 min-w-4 items-center justify-center rounded-full border border-annotation-line bg-annotation-bg px-1 text-sm font-semibold tabular-nums text-fg ring-2 ring-overlay-fg">
                {pin.n}
              </span>
            )}
          </IconButton>
        );
      })}
    </div>
  );
}

/**
 * What a slide tap does given the pin-arming state: the click trailing the
 * arming long-press is swallowed, a tap on the armed slide places the pin, a
 * tap anywhere else while armed just disarms, and an unarmed tap opens the
 * lightbox. Pure so the relocated placement flow is unit-testable without a DOM.
 */
export function slideTapAction(
  armedIndex: number | null,
  index: number,
  suppressed: boolean,
): 'suppress' | 'place' | 'disarm' | 'open' {
  if (suppressed) return 'suppress';
  if (armedIndex === index) return 'place';
  if (armedIndex !== null) return 'disarm';
  return 'open';
}

/**
 * Whether the in-place viewer takes the ribbon's slot: a tile is open (openIndex
 * set) and the gallery has images. Empty and upload states carry no open index,
 * so they always fall through to the ribbon branch. Pure so the ribbon<->viewer
 * swap is unit-testable without a DOM renderer.
 */
export function viewerReplacesRibbon(openIndex: number | null, itemCount: number): boolean {
  return openIndex !== null && itemCount > 0;
}

// Map the aspect token to a literal Tailwind arbitrary-aspect class, for the same
// JIT-visibility reason. The default (4/5) matches the post gallery's tiles; the
// brief gallery passes 3/2.
function aspectClass(aspect: string): string {
  return aspect === '3/2' ? 'aspect-[3/2]' : 'aspect-[4/5]';
}

interface GalleryViewProps {
  items: GalleryItem[];
  cache: PresignCache;
  presignEnabled: boolean;
  onOpen: (index: number) => void;
  /** Grid columns. Defaults to the post gallery's responsive 4-up grid. */
  columns?: number;
  /** Tile aspect ratio token. Defaults to the post gallery's 4/5. */
  aspect?: string;
  /** Per-tile index badge. Defaults to on, as the post gallery shows it. */
  showIndex?: boolean;
  /** Gesture handlers per tile (long-press + right-click). */
  slideGestures?: ((index: number) => TileGestures) | undefined;
  /** Swallow the click that trails a long-press. */
  consumeClickSuppression?: (() => boolean) | undefined;
  /** F7: pin-count badge per tile; the badge renders only when this returns > 0. */
  pinCountFor?: ((item: GalleryItem) => number) | undefined;
  /** F7: agency-only append flow, wired to the zero-asset empty-state upload zone. */
  onAddSlide?: (() => void) | undefined;
  /** Carousel: the slide the counter and dots highlight. Defaults to the first. */
  activeIndex?: number;
  /** Carousel: ref to the native scroller so a dot tap can scroll it. */
  scrollerRef?: Ref<HTMLDivElement> | undefined;
  /** Carousel: native scroll listener that derives the active index. */
  onScroll?: ((event: ReactUIEvent<HTMLDivElement>) => void) | undefined;
  /** Carousel: a dot tap requests a native smooth scroll to that slide. */
  onDotClick?: ((index: number) => void) | undefined;
  /** F5 relocation: the slide index armed for pin placement, or null. */
  pinArmedIndex?: number | null;
  /** F5 relocation: an armed tap on a slide, with the click event for the rect. */
  onSlideTap?: ((index: number, event: ReactMouseEvent<HTMLButtonElement>) => void) | undefined;
  /** Ribbon: dimensions measured from decoded images, keyed by attachment id. */
  measuredDimensions?: MeasuredDimensions;
  /** Ribbon: report a tile's intrinsic size once its image decodes. */
  onMeasure?: ((assetAttachmentId: string, width: number, height: number) => void) | undefined;
  /**
   * The post's platform frame. Never crops: the ribbon always shows every
   * picture whole. It only decides the warning line under the picture.
   */
  frame?: Frame | null;
  /** The platform's display name, for the warning line. */
  platformLabel?: string;
  /** The warning line's "See preview": opens the platform Preview panel. */
  onSeePreview?: (() => void) | undefined;
  /** Current-version pins per slide (relative to the original). */
  pinsFor?: ((item: GalleryItem) => PinDot[]) | undefined;
  onPinClick?: ((commentId: string) => void) | undefined;
  /**
   * H2: the visible "Add pin" button under the carousel arms placement on the
   * current slide (the long-press still works); absent for viewers who cannot
   * comment and on the brief grid.
   */
  onArmPin?: ((index: number) => void) | undefined;
  /** H2: the Cancel shown while armed. */
  onDisarmPin?: (() => void) | undefined;
  /**
   * The post gallery's one toolbar row (Add, Replace, Reorder, Add pin, v{n}),
   * rendered under the dots in place of the standalone pin row. Absent keeps the
   * standalone pin row.
   */
  toolbar?: ReactNode;
}

/**
 * The pin toolbar button: "Add pin" (pin icon + text, 44px) for anyone who can
 * comment, or Cancel while a slide is armed. Nothing when pins are not on
 * offer. Pure.
 */
export function pinButton(
  active: number,
  pinArmedIndex: number | null,
  onArmPin: ((index: number) => void) | undefined,
  onDisarmPin: (() => void) | undefined,
): ReactElement | null {
  if (onArmPin === undefined) return null;
  return pinArmedIndex === null ? (
    <Button type="button" variant="secondary" data-add-pin="" onClick={() => onArmPin(active)}>
      <IconPin size={ICON_SIZE.inline} />
      Add pin
    </Button>
  ) : (
    <Button type="button" variant="secondary" data-cancel-pin="" onClick={() => onDisarmPin?.()}>
      Cancel
    </Button>
  );
}

/**
 * The standalone pin row under the carousel, used only when the gallery has no
 * toolbar row (the toolbar otherwise carries the pin button). Pure.
 */
export function pinControls(
  active: number,
  pinArmedIndex: number | null,
  onArmPin: ((index: number) => void) | undefined,
  onDisarmPin: (() => void) | undefined,
): ReactElement | null {
  const button = pinButton(active, pinArmedIndex, onArmPin, onDisarmPin);
  if (button === null) return null;
  return <div className="mt-2 flex items-center gap-2">{button}</div>;
}

/** What the gallery tools row under the picture needs. */
export interface GalleryToolsModel {
  /** Creator on draft / review / parked / rejected: Add, Replace, Reorder show. */
  canEdit: boolean;
  /** Spec B4: a creator on an approved post sees a lock in place of the tools. */
  locked?: boolean;
  itemCount: number;
  /** The current version number; the v{n} button hides when null. */
  versionNumber: number | null;
  saving: boolean;
  /** The one inline error line from the last failed gallery write. */
  error: string | null;
  onAdd: () => void;
  onReplace: () => void;
  onReorder: () => void;
  onVersions: () => void;
  /** The Add pin (or Cancel while armed) button, from {@link pinButton}. */
  pin?: ReactElement | null;
}

/**
 * #26: the one toolbar row under the dots. Left: Add, Replace, Reorder (creators
 * on an editable stage), then Add pin (anyone who can comment); a creator on an
 * approved post sees one 14px lock in place of the edit tools. Right: the v{n}
 * button that opens the versions sheet. The left group wraps inside its own
 * column so v{n} stays on the right at 360px. Nothing when there is nothing to
 * show. Pure.
 */
export function galleryToolsRow(model: GalleryToolsModel): ReactElement | null {
  const { canEdit, itemCount, versionNumber, saving, error } = model;
  const pin = model.pin ?? null;
  const locked = !canEdit && model.locked === true;
  if (!canEdit && !locked && versionNumber === null && pin === null) return null;
  return (
    <div data-gallery-tools="" className="mt-2 flex flex-col gap-1">
      <div className="flex items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          {locked ? (
            <span
              aria-hidden
              data-gallery-lock=""
              className="inline-flex h-11 w-11 items-center justify-center text-fg-3"
            >
              <IconLock size={ICON_SIZE.inline} />
            </span>
          ) : null}
          {canEdit ? (
            <>
              <Button
                type="button"
                data-gallery-add=""
                disabled={saving}
                onClick={model.onAdd}
                variant="secondary"
              >
                <IconPlus size={ICON_SIZE.inline} />
                Add
              </Button>
              <Button
                type="button"
                data-gallery-replace=""
                disabled={saving || itemCount === 0}
                onClick={model.onReplace}
                variant="secondary"
              >
                <IconSwitch size={ICON_SIZE.inline} />
                Replace
              </Button>
              <Button
                type="button"
                data-gallery-reorder=""
                disabled={saving || itemCount < 2}
                onClick={model.onReorder}
                variant="secondary"
              >
                <IconGrip size={ICON_SIZE.inline} />
                Reorder
              </Button>
            </>
          ) : null}
          {pin}
        </div>
        {versionNumber !== null ? (
          <Button
            type="button"
            data-gallery-versions=""
            onClick={model.onVersions}
            aria-label={`Versions, current version ${versionNumber}`}
            aria-haspopup="dialog"
            variant="secondary"
            className="shrink-0 tabular-nums"
          >
            <IconHistory size={ICON_SIZE.inline} />
            {`v${versionNumber}`}
          </Button>
        ) : null}
      </div>
      {error !== null ? (
        <p role="alert" data-gallery-error="" className="text-base text-bad">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** What the reorder strip needs; the wrapper owns the draft order and drag state. */
export interface ReorderModel {
  /** The draft order (current items, rearranged). */
  items: readonly GalleryItem[];
  cache: PresignCache;
  presignEnabled: boolean;
  /** Platform frame ratio (w / h) for the tiles; 4/5 when the post has none. */
  ratio: number;
  /** The tile being dragged and how far it has travelled along the row. */
  drag: { id: string; dx: number } | null;
  /** The tile the Move left / Move right buttons act on. */
  selectedId: string | null;
  /** The draft differs from the saved order. */
  changed: boolean;
  saving: boolean;
  error: string | null;
  onSelect: (id: string) => void;
  onMove: (id: string, delta: -1 | 1) => void;
  onTilePointerDown: (id: string, event: ReactPointerEvent<HTMLButtonElement>) => void;
  onTilePointerMove: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onTilePointerUp: () => void;
  onSave: () => void;
  onCancel: () => void;
  tileRef?: ((id: string, el: HTMLButtonElement | null) => void) | undefined;
}

/**
 * #26: reorder mode. The slides sit in one horizontal row; a tile drags along
 * the row only (translateX, no rotation, no scale), arrow keys and the Move
 * buttons move the selected tile, and one "Save order" writes the whole order
 * once. The dragged tile follows the pointer directly; nothing else animates,
 * so reduced motion needs no special case beyond the motion-safe colour fade.
 * Pure.
 */
export function reorderView(model: ReorderModel): ReactElement {
  const { items, drag, selectedId, changed, saving, error, ratio } = model;
  const selectedIndex = items.findIndex((item) => item.assetAttachmentId === selectedId);
  return (
    <div data-reorder="" className="flex flex-col gap-2">
      <p className="text-base text-fg-2">Drag to reorder, or pick a slide and move it.</p>
      <div className="flex gap-2 overflow-x-auto overscroll-x-contain py-1" role="list">
        {items.map((item, index) => {
          const dragging = drag !== null && drag.id === item.assetAttachmentId;
          const selected = item.assetAttachmentId === selectedId;
          return (
            <div key={item.assetAttachmentId} role="listitem" className="shrink-0">
              <PressableRow
                inline
                type="button"
                buttonRef={
                  model.tileRef !== undefined
                    ? (el) => model.tileRef?.(item.assetAttachmentId, el)
                    : undefined
                }
                data-reorder-tile=""
                aria-pressed={selected}
                aria-label={`Slide ${index + 1} of ${items.length}. Use the arrow keys to move it.`}
                onClick={() => model.onSelect(item.assetAttachmentId)}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                    event.preventDefault();
                    model.onMove(item.assetAttachmentId, event.key === 'ArrowLeft' ? -1 : 1);
                  }
                }}
                onPointerDown={(event) => model.onTilePointerDown(item.assetAttachmentId, event)}
                onPointerMove={model.onTilePointerMove}
                onPointerUp={model.onTilePointerUp}
                onPointerCancel={model.onTilePointerUp}
                style={
                  dragging && drag !== null
                    ? { aspectRatio: `${ratio}`, transform: `translateX(${drag.dx}px)` }
                    : { aspectRatio: `${ratio}` }
                }
                className={cn(
                  'relative flex h-24 min-w-[44px] touch-none cursor-grab items-center justify-center overflow-hidden border-2 bg-panel-2 motion-safe:transition-colors',
                  SLIDE_PRESS_CLASS,
                  selected ? 'border-accent' : 'border-border',
                  dragging && 'z-10 cursor-grabbing shadow-lg',
                )}
              >
                <GalleryThumb
                  item={item}
                  cache={model.cache}
                  presignEnabled={model.presignEnabled}
                />
                <span className="pointer-events-none absolute bottom-1 left-1 rounded bg-overlay px-1 text-xs font-medium tabular-nums text-overlay-fg">
                  {index + 1}
                </span>
              </PressableRow>
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          data-reorder-left=""
          disabled={saving || selectedIndex <= 0}
          onClick={() => {
            if (selectedId !== null) model.onMove(selectedId, -1);
          }}
          variant="secondary"
        >
          <IconChevronLeft size={ICON_SIZE.inline} />
          Move left
        </Button>
        <Button
          type="button"
          data-reorder-right=""
          disabled={saving || selectedIndex < 0 || selectedIndex >= items.length - 1}
          onClick={() => {
            if (selectedId !== null) model.onMove(selectedId, 1);
          }}
          variant="secondary"
        >
          Move right
          <IconChevronRight size={ICON_SIZE.inline} />
        </Button>
        <span className="flex-1" />
        <Button
          type="button"
          data-reorder-cancel=""
          disabled={saving}
          onClick={model.onCancel}
          variant="secondary"
        >
          Cancel
        </Button>
        <Button
          type="button"
          variant="primary"
          data-reorder-save=""
          disabled={saving || !changed}
          onClick={model.onSave}
        >
          {saving ? 'Saving…' : 'Save order'}
        </Button>
      </div>
      {error !== null ? (
        <p role="alert" data-gallery-error="" className="text-base text-bad">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * #35: a version's pictures as small platform-shaped thumbnails (the versions
 * sheet rows and the old-version view). Read-only: no buttons, no gestures.
 */
export function SnapshotThumbs({
  items,
  cache,
  presignEnabled,
  ratio,
  size = 'sm',
  max,
}: {
  items: readonly GalleryItem[];
  cache: PresignCache;
  presignEnabled: boolean;
  /** Platform frame ratio (w / h). */
  ratio: number;
  /** 'xs' for the versions sheet rows, 'sm' for small rows, 'lg' for the old-version view. */
  size?: 'xs' | 'sm' | 'lg';
  /** Show at most this many, then a +n count. */
  max?: number;
}) {
  const shown = max !== undefined ? items.slice(0, max) : items;
  const extra = items.length - shown.length;
  return (
    <div
      data-snapshot-thumbs=""
      className={cn('flex items-center', size === 'lg' ? 'gap-2 overflow-x-auto' : 'gap-1')}
    >
      {shown.map((item) => (
        <div
          key={item.assetAttachmentId}
          style={{ aspectRatio: `${ratio}` }}
          className={cn(
            'shrink-0 overflow-hidden border border-border bg-panel-2',
            size === 'xs' ? 'h-8 rounded' : size === 'sm' ? 'h-10 rounded' : 'h-40 rounded-lg',
          )}
        >
          <GalleryThumb item={item} cache={cache} presignEnabled={presignEnabled} />
        </div>
      ))}
      {extra > 0 ? (
        <span className="shrink-0 text-sm tabular-nums text-fg-3">{`+${extra}`}</span>
      ) : null}
    </div>
  );
}

// T13: a long-press on a slide must never open the browser's image callout or
// start a text selection; the callout property is inherited by the image inside.
const SLIDE_PRESS_CLASS = 'select-none [-webkit-touch-callout:none]';

/**
 * The gallery's presentational tree, kept hookless so the tree-walking unit tests
 * can exercise it without a DOM renderer. The post gallery default (columns
 * omitted) renders an uncropped horizontal snap ribbon: a native overflow-x
 * scroller with x-mandatory snapping and snap-start tiles that hug their images
 * at true aspect ratio (heights vary by ratio inside the shared caps), an n/N
 * counter, and 44px dot indicators. A lone image is not a peek tile: it fills the
 * column at its own ratio. There is no add tile on the ribbon; the zero-asset
 * empty state carries the only add affordance. No JS-driven animation; all motion
 * is native scrolling on the X axis. The brief gallery overrides columns / aspect
 * / showIndex and keeps its
 * cropped overview grid; the empty and upload states are unchanged. Pin
 * placement is armed by a long-press on a ribbon tile (pinArmedIndex shows the
 * hint pill) and the next tap routes through onSlideTap.
 */
export function galleryView({
  items,
  cache,
  presignEnabled,
  onOpen,
  columns = 4,
  aspect = '4/5',
  showIndex = true,
  slideGestures,
  consumeClickSuppression,
  pinCountFor,
  onAddSlide,
  activeIndex = 0,
  scrollerRef,
  onScroll,
  onDotClick,
  pinArmedIndex = null,
  onSlideTap,
  measuredDimensions = {},
  onMeasure,
  frame = null,
  platformLabel = '',
  onSeePreview,
  pinsFor,
  onPinClick,
  onArmPin,
  onDisarmPin,
  toolbar,
}: GalleryViewProps): ReactElement {
  if (items.length === 0) {
    // Agency-side (onAddSlide present): a full-width "Add images" upload zone in
    // place of the empty text, wired to the append flow. Brief galleries omit
    // onAddSlide and keep the calm, view-only empty line unchanged.
    if (onAddSlide !== undefined) {
      const zone = (
        <DropZone type="button" minHeight="panel" onClick={onAddSlide}>
          <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-panel-3 text-accent">
            <IconImagePlus size={ICON_SIZE.status} />
          </span>
          <span className="text-base font-medium text-fg">Add images</span>
          <span className="text-sm text-fg-3">Tap to upload</span>
        </DropZone>
      );
      return toolbar !== undefined && toolbar !== null ? (
        <div>
          {zone}
          {toolbar}
        </div>
      ) : (
        zone
      );
    }
    const none = (
      <div className="rounded-xl border border-border bg-panel-2 px-4 py-8 text-center text-base text-fg-3">
        <p>No images on this post yet.</p>
      </div>
    );
    return toolbar !== undefined && toolbar !== null ? (
      <div>
        {none}
        {toolbar}
      </div>
    ) : (
      none
    );
  }
  // Non-default columns (the brief gallery's 2-up): the overview grid, unchanged.
  if (columns !== 4) {
    return (
      <div className={gridClass(columns)}>
        {items.map((item, index) => {
          const pinCount = pinCountFor !== undefined ? pinCountFor(item) : 0;
          return (
            <PressableRow
              key={item.assetAttachmentId}
              type="button"
              aria-label={`View image ${index + 1}`}
              {...(slideGestures !== undefined ? slideGestures(index) : {})}
              onClick={() => {
                if (consumeClickSuppression !== undefined && consumeClickSuppression()) return;
                onOpen(index);
              }}
              className={`group relative ${aspectClass(aspect)} overflow-hidden border border-border bg-panel-2 transition-colors hover:border-border-strong`}
            >
              <GalleryThumb item={item} cache={cache} presignEnabled={presignEnabled} />
              {showIndex ? (
                <span className="absolute left-1.5 bottom-1.5 rounded bg-overlay px-1.5 py-0.5 text-xs font-medium tabular-nums text-overlay-fg">
                  {index + 1}/{items.length}
                </span>
              ) : null}
              {pinCount > 0 ? (
                <span className="absolute right-1.5 top-1.5 inline-flex items-center gap-0.5 rounded bg-overlay px-1.5 py-0.5 text-xs font-medium tabular-nums text-overlay-fg">
                  <IconPin size={ICON_SIZE.inline} />
                  {pinCount}
                </span>
              ) : null}
            </PressableRow>
          );
        })}
      </div>
    );
  }

  // Post gallery default: the uncropped horizontal snap ribbon. Each tile hugs
  // its image at true aspect ratio inside the shared caps, so tile widths and
  // heights vary; motion stays native scrolling on the X axis only. The counter
  // and dots reflect activeIndex, clamped so a shrinking gallery never points
  // past the end while the scroll listener catches up.
  const active = Math.min(Math.max(activeIndex, 0), items.length - 1);
  const dots =
    items.length > 1 ? (
      <div className="flex flex-wrap items-center justify-center">
        {items.map((item, index) => (
          <IconButton
            key={item.assetAttachmentId}
            type="button"
            label={`Go to slide ${index + 1}`}
            aria-current={index === active}
            onClick={() => {
              if (onDotClick !== undefined) onDotClick(index);
            }}
          >
            <span
              className={`h-2 w-2 rounded-full transition-colors ${
                index === active ? 'bg-accent' : 'bg-border-strong'
              }`}
            />
          </IconButton>
        ))}
      </div>
    ) : null;

  // The warning line under the picture: how much the platform cuts the slide on
  // show. The picture itself is never cropped; the Preview panel shows the cut.
  const cut = frameCut(items[active], measuredDimensions, frame);
  const solo = items.length === 1;
  return (
    <div>
      <div className="relative">
        {pinArmedIndex !== null ? (
          <div
            role="status"
            className="pointer-events-none absolute left-1/2 top-3 z-10 -translate-x-1/2 rounded-full bg-overlay-surface px-3 py-1.5 text-sm font-medium text-overlay-fg"
          >
            Tap the image to place a pin
          </div>
        ) : null}
        <div
          ref={scrollerRef}
          onScroll={onScroll}
          aria-roledescription="carousel"
          className="flex snap-x snap-mandatory items-center gap-3 overflow-x-auto overscroll-x-contain rounded-xl"
        >
          {items.map((item, index) => {
            const pinCount = pinCountFor !== undefined ? pinCountFor(item) : 0;
            // The tile box carries the reserved size; everything inside it is
            // absolutely placed, so the image can never size the box.
            const tile = (
              <div
                key={item.assetAttachmentId}
                data-ribbon-tile=""
                style={resolveRibbonTileStyle(item, measuredDimensions, solo)}
                className={cn('relative shrink-0 overflow-hidden', !solo && 'snap-start')}
              >
                <PressableRow
                  type="button"
                  aria-label={`View image ${index + 1}`}
                  {...(slideGestures !== undefined ? slideGestures(index) : {})}
                  onClick={(event) => {
                    if (onSlideTap !== undefined) {
                      onSlideTap(index, event);
                      return;
                    }
                    if (consumeClickSuppression !== undefined && consumeClickSuppression()) return;
                    onOpen(index);
                  }}
                  className={cn(
                    'group absolute inset-0 flex items-center justify-center border border-border bg-panel-2 transition-colors hover:border-border-strong focus-visible:ring-inset',
                    SLIDE_PRESS_CLASS,
                    pinArmedIndex === index && 'cursor-crosshair',
                  )}
                >
                  <GalleryThumb
                    item={item}
                    cache={cache}
                    presignEnabled={presignEnabled}
                    fit="fit"
                    onMeasure={
                      onMeasure !== undefined
                        ? (width, height) => onMeasure(item.assetAttachmentId, width, height)
                        : undefined
                    }
                  />
                </PressableRow>
                {pinsFor !== undefined ? framePins(pinsFor(item), IDENTITY_MAP, onPinClick) : null}
                {pinsFor === undefined && pinCount > 0 ? (
                  <span className="pointer-events-none absolute left-1.5 top-1.5 inline-flex items-center gap-0.5 rounded bg-overlay px-1.5 py-0.5 text-xs font-medium tabular-nums text-overlay-fg">
                    <IconPin size={ICON_SIZE.inline} />
                    {pinCount}
                  </span>
                ) : null}
              </div>
            );
            // A lone tile sits in a full-width snap slot (a definite width for
            // its 100%), centred when a tall image narrows it.
            return solo ? (
              <div
                key={item.assetAttachmentId}
                data-ribbon-slot=""
                className="flex w-full shrink-0 snap-start justify-center"
              >
                {tile}
              </div>
            ) : (
              tile
            );
          })}
        </div>
        {showIndex ? (
          <span
            aria-live="polite"
            className="pointer-events-none absolute left-2 bottom-2 rounded bg-overlay px-1.5 py-0.5 text-xs font-medium tabular-nums text-overlay-fg"
          >
            {`${active + 1}/${items.length}`}
          </span>
        ) : null}
      </div>
      {dots}
      {cut > 0 ? (
        <div data-frame-cut="" className="mt-1 flex flex-wrap items-center gap-x-1">
          <p className="text-base text-fg-2">{`${platformLabel} cuts ${cut}% of this.`}</p>
          {onSeePreview !== undefined ? (
            <Button type="button" variant="link" data-see-preview="" onClick={onSeePreview}>
              See preview
            </Button>
          ) : null}
        </div>
      ) : null}
      {toolbar ?? pinControls(active, pinArmedIndex, onArmPin, onDisarmPin)}
    </div>
  );
}

interface PostGalleryProps {
  items: GalleryItem[];
  cache: PresignCache;
  deps: PresignDeps;
  presignEnabled: boolean;
  /** Grid columns. Defaults to the post gallery's responsive 4-up grid. */
  columns?: number;
  /** Tile aspect ratio token. Defaults to the post gallery's 4/5. */
  aspect?: string;
  /** Per-tile index badge. Defaults to on, as the post gallery shows it. */
  showIndex?: boolean;
  /** F5: overlay rendered over the open slide (numbered pins); none when omitted. */
  pinOverlay?: (item: GalleryItem, index: number) => ReactNode;
  /** F5: fired when a long-press arms placement (clears any stale pin error). */
  onRequestPin?: (index: number) => void;
  /** F5: a placed pin reports the slide index + normalised point. */
  onPlacePin?: (index: number, x: number, y: number) => void;
  /** F7: pin-count badge per tile; the badge renders only when this returns > 0. */
  pinCountFor?: ((item: GalleryItem) => number) | undefined;
  /**
   * F7 (agency-side): open the slide-actions sheet (replace / remove) for a
   * slide. Reached by right-click on a slide; the lightbox no longer links here.
   */
  onSlideActions?: ((index: number) => void) | undefined;
  /** F7 (agency-side): the append flow, used by the zero-asset empty state. */
  onAddSlide?: (() => void) | undefined;
  /**
   * Lightbox manage row: the existing insert-after add/upload flow. #26: the
   * lightbox has no per-tap reorder; the Reorder mode saves one order.
   */
  onAddAfter?: ((index: number) => void) | undefined;
  /** Lightbox manage bar: remove the slide over the existing gallery_set commit. */
  onRemove?: ((index: number) => void) | undefined;
  /**
   * A gallery write is in flight: the lightbox blocks reorder and delete and
   * shows "Saving…", so two full-list writes never overlap.
   */
  saving?: boolean | undefined;
  /**
   * The post's platform (workspace platform + format). Never crops the picture;
   * it only decides the warning line under it. Absent on briefs.
   */
  frame?: { platform: string; format: string; platformLabel: string } | undefined;
  /** The warning line's "See preview": opens the platform Preview panel. */
  onSeePreview?: (() => void) | undefined;
  /** Current-version pins per slide, at their stored original-relative spots. */
  pinsFor?: ((item: GalleryItem) => PinDot[]) | undefined;
  onPinClick?: ((commentId: string) => void) | undefined;
  /**
   * #26: the tools row under the picture (post gallery only). Absent on briefs.
   * canEdit false (approvers, approved posts) leaves only the v{n} button and
   * also drops every edit path the gallery owns (slide ⋯, lightbox manage row,
   * the empty-state upload zone).
   */
  tools?: GalleryTools | undefined;
  /**
   * The slide the carousel currently shows, reported whenever it changes, so the
   * page can aim the header sheet's Remove image at it.
   */
  onActiveIndexChange?: ((index: number) => void) | undefined;
}

const EMPTY_EDIT: Pick<PostGalleryProps, 'onAddAfter' | 'onRemove'> = {};

/** The page's side of the #26 tools row. */
interface GalleryTools {
  canEdit: boolean;
  /** Spec B4: an approved post, seen by a creator: the tools row shows a lock. */
  locked?: boolean;
  versionNumber: number | null;
  /** The inline line from the last failed gallery write, or null. */
  error: string | null;
  onVersions: () => void;
  onAdd: () => void;
  /** Replace the picture at this index (one gallery_set). */
  onReplace: (index: number) => void;
  /** Save the whole draft order with one gallery_set; resolves true on success. */
  onSaveOrder: (assetVersionIds: string[]) => Promise<boolean>;
}

/**
 * A post's images as an uncropped horizontal snap ribbon (or a brief's as its
 * overview grid, via the columns override). Tapping a tile opens the PCS
 * {@link PostLightbox} at that index. Pin placement lives here now: a ~500ms
 * long-press on a tile arms it (hint pill), and the next tap on that tile
 * converts to percentage coordinates and calls the existing onPlacePin path.
 * The slide-actions sheet stays reachable by right-click on a tile.
 */
export function PostGallery({
  items,
  cache,
  deps,
  presignEnabled,
  columns = 4,
  aspect = '4/5',
  showIndex = true,
  pinOverlay,
  onRequestPin,
  onPlacePin,
  pinCountFor,
  saving = false,
  frame,
  onSeePreview,
  pinsFor,
  onPinClick,
  tools,
  onActiveIndexChange,
  ...editProps
}: PostGalleryProps) {
  // #26: an approved post (or an approver) gets no edit path from the gallery,
  // whatever the page wired: no slide ⋯, no lightbox manage row, no upload zone.
  const editLocked = tools !== undefined && !tools.canEdit;
  const onSlideActions = editLocked ? undefined : editProps.onSlideActions;
  const onAddSlide = editLocked ? undefined : editProps.onAddSlide;
  const { onAddAfter, onRemove } = editLocked ? EMPTY_EDIT : editProps;
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  // #26 reorder mode: a draft order of attachment ids (null when not
  // reordering), the tile under the pointer, and the selected tile.
  const [reorderIds, setReorderIds] = useState<string[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ id: string; dx: number } | null>(null);
  const dragRef = useRef<{ id: string; startX: number; step: number; dx: number } | null>(null);
  const tileEls = useRef(new Map<string, HTMLButtonElement>());
  const focusAfterMove = useRef<string | null>(null);
  useEffect(() => {
    const id = focusAfterMove.current;
    if (id === null) return;
    focusAfterMove.current = null;
    tileEls.current.get(id)?.focus();
  }, [reorderIds]);
  // Leaving the editable state (approved, or the gallery emptied) drops a draft.
  useEffect(() => {
    if (editLocked || items.length < 2) setReorderIds(null);
  }, [editLocked, items.length]);

  // Deleting the last image empties the gallery: the in-place viewer has nothing
  // to show, so clear the open index and let the ribbon branch fall through to
  // the zero-asset empty state.
  useEffect(() => {
    if (items.length === 0) setOpenIndex(null);
  }, [items.length]);

  // Carousel state: the active slide is derived from the native scroller's
  // offset (no JS animation, scrolling stays native). A dot tap asks the
  // scroller for a native smooth scroll to that slide's snap point.
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const shownIndex = items.length === 0 ? 0 : Math.min(Math.max(activeIndex, 0), items.length - 1);
  useEffect(() => {
    onActiveIndexChange?.(shownIndex);
  }, [shownIndex, onActiveIndexChange]);
  const handleScroll = (event: ReactUIEvent<HTMLDivElement>): void => {
    const el = event.currentTarget;
    // Measure each image tile's left edge; tile widths vary with aspect ratio, so
    // offsets are never assumed uniform.
    const offsets: number[] = [];
    for (let i = 0; i < items.length; i += 1) {
      const tile = el.children.item(i);
      offsets.push(tile instanceof HTMLElement ? tile.offsetLeft - el.offsetLeft : 0);
    }
    const next = nearestTileIndex(el.scrollLeft, offsets);
    setActiveIndex((prev) => (prev === next ? prev : next));
  };
  const scrollToSlide = (index: number): void => {
    const el = scrollerRef.current;
    if (el === null) return;
    const slide = el.children.item(index);
    if (slide instanceof HTMLElement) {
      el.scrollTo({ left: slide.offsetLeft - el.offsetLeft, behavior: 'smooth' });
    }
  };

  // Ribbon: intrinsic sizes recovered from decoded images, keyed by attachment
  // id, for tiles whose stored asset_versions.width/height are still null. Set
  // once per tile on first load so the tile snaps to its true ratio and never
  // resizes again; a zero/NaN natural dimension is filtered upstream in
  // GalleryThumb and never reaches here.
  const [measuredDimensions, setMeasuredDimensions] = useState<MeasuredDimensions>({});
  const handleMeasure = (assetAttachmentId: string, width: number, height: number): void => {
    setMeasuredDimensions((prev) =>
      prev[assetAttachmentId] !== undefined
        ? prev
        : { ...prev, [assetAttachmentId]: { width, height } },
    );
  };

  // F5 relocation: the slide currently armed for pin placement, or null.
  const [pinArmedIndex, setPinArmedIndex] = useState<number | null>(null);
  const canPlacePins = columns === 4 && onPlacePin !== undefined;

  // One long-press controller for the whole gallery: the pressed tile records
  // its index on pointer-down. In the carousel a fired long-press (the one
  // LONG_PRESS_MS) arms pin placement; in the grid (briefs) it keeps opening
  // the slide actions.
  const pressIndexRef = useRef(0);
  const pressPointerTypeRef = useRef('');
  const { handlers, consumeClickSuppression } = useLongPress(() => {
    if (canPlacePins) {
      setPinArmedIndex(pressIndexRef.current);
      onRequestPin?.(pressIndexRef.current);
      return;
    }
    if (onSlideActions !== undefined) onSlideActions(pressIndexRef.current);
  });

  const wantsGestures = canPlacePins || onSlideActions !== undefined;
  const slideGestures = wantsGestures
    ? (index: number): TileGestures => ({
        onPointerDown: (event) => {
          pressIndexRef.current = index;
          pressPointerTypeRef.current = event.pointerType;
          handlers.onPointerDown(event);
        },
        onPointerMove: (event) => handlers.onPointerMove(event),
        onPointerUp: () => handlers.onPointerUp(),
        onPointerCancel: () => handlers.onPointerCancel(),
        onContextMenu: (event) => {
          event.preventDefault();
          // Right-click keeps the slide-actions sheet reachable. Touch
          // long-presses also emit contextmenu in some browsers; those already
          // armed pin placement above, so only a real mouse opens the sheet.
          if (onSlideActions !== undefined && pressPointerTypeRef.current !== 'touch') {
            onSlideActions(index);
          }
        },
      })
    : undefined;

  // The platform frame only decides the warning line under the picture.
  const postFrame =
    frame !== undefined && columns === 4
      ? galleryFrame(frame.platform, frame.format, items, measuredDimensions)
      : null;

  // A carousel slide tap routes through the arming state: place on the armed
  // slide (existing onPlacePin path, percentage coords), disarm elsewhere,
  // otherwise open the lightbox.
  const handleSlideTap = (index: number, event: ReactMouseEvent<HTMLButtonElement>): void => {
    const action = slideTapAction(pinArmedIndex, index, consumeClickSuppression());
    if (action === 'suppress') return;
    if (action === 'place') {
      const point = placePinFromEvent(event.currentTarget, event.clientX, event.clientY);
      setPinArmedIndex(null);
      // The tile shows the whole original at its own ratio, so the tap point is
      // already original-relative: the stored image_x / image_y.
      if (point !== null) onPlacePin?.(index, point.x, point.y);
      return;
    }
    if (action === 'disarm') {
      setPinArmedIndex(null);
      return;
    }
    setOpenIndex(index);
  };

  const manage =
    onAddAfter !== undefined && onRemove !== undefined ? { onAddAfter, onRemove } : undefined;

  // #26 reorder mode: the draft order as items (unknown ids dropped, new items
  // appended so a concurrent refresh never loses a slide).
  const draftItems: GalleryItem[] | null =
    reorderIds === null
      ? null
      : [
          ...reorderIds
            .map((id) => items.find((item) => item.assetAttachmentId === id))
            .filter((item): item is GalleryItem => item !== undefined),
          ...items.filter((item) => !reorderIds.includes(item.assetAttachmentId)),
        ];
  const moveDraft = (id: string, delta: -1 | 1): void => {
    setReorderIds((current) => {
      if (current === null) return current;
      const from = current.indexOf(id);
      return from < 0 ? current : moveTo(current, from, from + delta);
    });
    setSelectedId(id);
    focusAfterMove.current = id;
  };
  // The pin button: the visible Add pin arms the same state the long-press does.
  const armPin = canPlacePins
    ? (index: number) => {
        setPinArmedIndex(index);
        onRequestPin?.(index);
      }
    : undefined;
  const disarmPin = canPlacePins ? () => setPinArmedIndex(null) : undefined;
  const toolsRow =
    tools !== undefined && columns === 4
      ? galleryToolsRow({
          canEdit: tools.canEdit,
          locked: tools.locked === true,
          itemCount: items.length,
          versionNumber: tools.versionNumber,
          saving,
          error: tools.error,
          // Add inserts after the slide on show (the old slide ⋯ "Add image
          // after this"); an empty gallery or no insert path appends.
          onAdd: () => {
            if (onAddAfter !== undefined && items.length > 0) onAddAfter(shownIndex);
            else tools.onAdd();
          },
          onReplace: () => tools.onReplace(shownIndex),
          onReorder: () => {
            setOpenIndex(null);
            setPinArmedIndex(null);
            setReorderIds(items.map((item) => item.assetAttachmentId));
            setSelectedId(null);
          },
          onVersions: tools.onVersions,
          pin: pinButton(shownIndex, canPlacePins ? pinArmedIndex : null, armPin, disarmPin),
        })
      : null;

  if (tools !== undefined && tools.canEdit && draftItems !== null) {
    const draftVersionIds = draftItems.map((item) => item.assetVersionId);
    const changed = draftItems.some(
      (item, index) => item.assetAttachmentId !== items[index]?.assetAttachmentId,
    );
    return reorderView({
      items: draftItems,
      cache,
      presignEnabled,
      ratio: postFrame?.ratio ?? 4 / 5,
      drag,
      selectedId,
      changed,
      saving,
      error: tools.error,
      onSelect: setSelectedId,
      onMove: moveDraft,
      onTilePointerDown: (id, event) => {
        if (event.pointerType === 'mouse' && event.button !== 0) return;
        const el = event.currentTarget;
        el.setPointerCapture?.(event.pointerId);
        // One step is a tile plus the row's gap-2 (8px).
        dragRef.current = { id, startX: event.clientX, step: el.offsetWidth + 8, dx: 0 };
        setSelectedId(id);
        setDrag({ id, dx: 0 });
      },
      onTilePointerMove: (event) => {
        const current = dragRef.current;
        if (current === null) return;
        current.dx = event.clientX - current.startX;
        setDrag({ id: current.id, dx: current.dx });
      },
      onTilePointerUp: () => {
        const current = dragRef.current;
        dragRef.current = null;
        setDrag(null);
        if (current === null) return;
        const { dx } = current;
        setReorderIds((ids) => {
          if (ids === null) return ids;
          const from = ids.indexOf(current.id);
          if (from < 0) return ids;
          const to = dropIndex(from, dx, current.step, ids.length);
          return to === from ? ids : moveTo(ids, from, to);
        });
      },
      onSave: () => {
        void tools.onSaveOrder(draftVersionIds).then((ok) => {
          if (ok) setReorderIds(null);
        });
      },
      onCancel: () => {
        setReorderIds(null);
        setDrag(null);
        dragRef.current = null;
      },
      tileRef: (id, el) => {
        if (el === null) tileEls.current.delete(id);
        else tileEls.current.set(id, el);
      },
    });
  }

  // When a tile is open the in-place viewer takes the ribbon's slot (the page
  // continues below it); closing returns to the ribbon. The empty and upload
  // states have no open index, so they always fall through to the ribbon branch.
  return viewerReplacesRibbon(openIndex, items.length) && openIndex !== null ? (
    <PostLightbox
      items={items}
      index={openIndex}
      presignEnabled={presignEnabled}
      cache={cache}
      deps={deps}
      onIndexChange={setOpenIndex}
      onClose={() => setOpenIndex(null)}
      pinOverlay={pinOverlay}
      manage={manage}
      saving={saving}
    />
  ) : (
    <>
      {galleryView({
        items,
        cache,
        presignEnabled,
        onOpen: setOpenIndex,
        columns,
        aspect,
        showIndex,
        slideGestures,
        consumeClickSuppression: wantsGestures ? consumeClickSuppression : undefined,
        pinCountFor,
        onAddSlide,
        activeIndex,
        scrollerRef,
        onScroll: handleScroll,
        onDotClick: scrollToSlide,
        pinArmedIndex: canPlacePins ? pinArmedIndex : null,
        onSlideTap: columns === 4 ? handleSlideTap : undefined,
        measuredDimensions,
        onMeasure: columns === 4 ? handleMeasure : undefined,
        frame: postFrame,
        platformLabel: frame?.platformLabel ?? '',
        onSeePreview,
        pinsFor,
        onPinClick,
        onArmPin: armPin,
        onDisarmPin: disarmPin,
        // One toolbar row under the dots; no ⋮ on the picture.
        toolbar: toolsRow ?? undefined,
      })}
    </>
  );
}
