// The "{Platform} preview" on the post detail page and in the post composer.
// Phone: a full-screen page with "<" and the title; laptop: the right side
// panel, same content. The body draws the post the way its platform shows it
// (PostMock: the platform's own feed card or full screen), placed by the
// post's format, framed by the one frame rule (frameFor via preview-math), and
// one line under it saying what the platform cuts, with "Show cut" shading the
// hidden strips on the same media. Dimensions come from asset_versions
// width/height when present, else are measured in the browser once the media
// loads. The post page resolves saved media through its presign cache; the
// composer passes the unsaved draft's local object URLs. Presentation only: no
// server change, no backfill.

import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { Backdrop } from '@/components/ui/Backdrop';
import { Button } from '@/components/ui/Button';
import { Chip } from '@/components/ui/Chip';
import { HeaderBar } from '@/components/ui/HeaderBar';
import { Text } from '@/components/ui/Text';
import { ICON_SIZE, IconEye, IconFile } from '@/components/ui/icons';
import { cn } from '@/lib/cn';
import { useModalFocus } from '@/lib/modal-focus';
import { riseIn, riseOut, usePresence } from '@/lib/motion';
import { dimWith } from '@/lib/motion/overlays';
import { useIsLaptop } from '@/lib/use-is-laptop';
import type { PresignCache } from '@/lib/asset-presign';
import { VERTICAL_FRAME, type PlatformSize } from '@/lib/platform-specs';
import type { GalleryItem } from '@srtdio/posts';
import { isPostPlatform, platformLabel } from '@srtdio/posts';
import {
  captionClampLines,
  cropFor,
  cropLine,
  defaultSizeFor,
  frameRatio,
  postSize,
  sizesFor,
  specFor,
  type PreviewMedia,
} from '@/components/preview/preview-math';
import {
  PLACEMENT_LABEL,
  defaultPlacement,
  placementFormat,
  placementOptions,
  type Placement,
} from '@/components/preview/placement';
import { fullScreenOnly } from '@/components/preview/platform-look';
import { FeedMock, FullMock, MediaStage, type StageSlide } from '@/components/preview/PostMock';
import { useMediaUrl } from '@/components/preview/use-media-url';

type PreviewMediaKind = PreviewMedia | 'document' | 'none';

/** What a gallery item is, for the preview. */
export function previewMediaKind(item: GalleryItem | null): PreviewMediaKind {
  if (item === null) return 'none';
  const mime = item.mimeType ?? '';
  if (item.kind === 'image' || mime.startsWith('image/')) return 'image';
  if (item.kind === 'video' || mime.startsWith('video/')) return 'video';
  if (mime === 'application/pdf') return 'document';
  return 'none';
}

/** The chip's label and the panel title, e.g. "Instagram preview". */
export function previewChipLabel(platform: string): string {
  return `${platformLabel(platform)} preview`;
}

/** The chip that opens the panel: the shared 44px secondary button. */
export function PreviewChip({
  platform,
  onClick,
}: {
  platform: string;
  onClick: () => void;
}): ReactElement {
  return (
    <Button type="button" variant="secondary" onClick={onClick} className="">
      <IconEye size={ICON_SIZE.inline} />
      {previewChipLabel(platform)}
    </Button>
  );
}

/** One photo or video of the post, in gallery order. */
export interface PreviewSlide {
  item: GalleryItem;
  /** The draft's local object URL for this item; used as-is, never presigned. */
  localUrl?: string | null;
}

/** What the preview draws: the post (or the composer's draft) and its media. */
export interface PreviewBodyProps {
  platform: string;
  format: string;
  caption: string;
  /** The account shown on the mock: the workspace name. */
  handle: string;
  firstMedia: GalleryItem | null;
  /**
   * Every item in gallery order, first included (a carousel swipes them all).
   * Optional: absent, the preview draws firstMedia alone.
   */
  slides?: readonly PreviewSlide[];
  /** Saved media: resolved through the page's presign cache. */
  cache?: PresignCache;
  presignEnabled?: boolean;
  /** The draft's local object URL for firstMedia; used as-is, never presigned. */
  localUrl?: string | null;
}

interface PlatformPreviewPanelProps extends PreviewBodyProps {
  open: boolean;
  onClose: () => void;
}

/** The phone page and the laptop panel take the status-bar and home-indicator insets. */
const PREVIEW_BAR_SAFE =
  'h-[calc(3.5rem+env(safe-area-inset-top,0px))] pt-[env(safe-area-inset-top,0px)]';
const PREVIEW_BODY_SAFE = 'pb-[calc(1rem+env(safe-area-inset-bottom,0px))]';

export function PlatformPreviewPanel(props: PlatformPreviewPanelProps): ReactElement | null {
  const { open, onClose } = props;
  const backRef = useRef<HTMLButtonElement>(null);
  const dimRef = useRef<HTMLButtonElement>(null);
  // Motion (docs/motion.md): rendered at rest. Phone: the page rises from the
  // bottom edge and leaves the same way. Laptop: a side panel, instant, the
  // dim behind it. Never a fade.
  const isLaptop = useIsLaptop();
  const laptopRef = useRef(isLaptop);
  laptopRef.current = isLaptop;
  const presence = usePresence<HTMLDivElement>(open, {
    enter: (el) => {
      if (laptopRef.current) return;
      return dimWith(el, dimRef.current, riseIn(el));
    },
    exit: (el) => {
      if (laptopRef.current) return riseOut(null);
      return dimWith(el, dimRef.current, riseOut(el));
    },
  });
  const rendered = presence.rendered;
  const panelRef = presence.ref;

  // Focus lands on "<" once the panel is in the DOM, Tab stays inside, and the
  // chip that opened it gets focus back on close (shared modal focus).
  useModalFocus(panelRef, open && rendered, {
    initial: () => backRef.current,
  });

  if (!rendered) return null;

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onClose();
    }
  }

  const title = isPostPlatform(props.platform) ? previewChipLabel(props.platform) : 'Preview';

  return createPortal(
    <div className="fixed inset-0 z-sheet">
      {isLaptop ? (
        <Backdrop ref={dimRef} position="absolute" aria-label="Close preview" onClick={onClose} />
      ) : null}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-preview-panel={isLaptop ? 'side' : 'page'}
        onKeyDown={onKeyDown}
        className={cn(
          'absolute flex flex-col will-change-transform',
          isLaptop
            ? 'inset-y-0 right-0 w-full max-w-md border-l bg-panel lit-overlay'
            : 'inset-0 bg-bg',
        )}
      >
        <HeaderBar
          compact
          title={title}
          onBack={onClose}
          backProps={{ buttonRef: backRef }}
          className={PREVIEW_BAR_SAFE}
        />
        <div className={cn('min-h-0 flex-1 overflow-y-auto px-4 pt-4', PREVIEW_BODY_SAFE)}>
          {isPostPlatform(props.platform) ? <PreviewBody {...props} /> : null}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** A full-screen frame: Reel, Story, Shorts bands, TikTok letterbox. */
function isFullScreen(size: PlatformSize): boolean {
  if (size.layout === 'letterbox') return size.feedCard !== true;
  return size.layout === 'vertical' || size.layout === 'story' || size.layout === 'bands';
}

/** The size the preview draws: the frame the post page shows, for the picked placement. */
function shownSize(
  platform: string,
  format: string,
  placement: Placement,
  media: PreviewMedia,
  kind: PreviewMediaKind,
  dims: { w: number; h: number } | null,
): PlatformSize | null {
  const shownFormat = placementFormat(platform, format, placement);
  const size =
    postSize(platform, shownFormat, media, dims) ??
    (kind !== 'none' && isPostPlatform(platform)
      ? defaultSizeFor(platform, shownFormat, media, dims)
      : null);
  // A plain video placed in the feed before its size is known: the platform's
  // Feed size, not the 9:16 video default.
  if (
    placementOptions(platform, format) !== null &&
    placement === 'feed' &&
    size !== null &&
    size.layout !== 'feed'
  ) {
    return sizesFor(platform, 'video').find((s) => s.label === PLACEMENT_LABEL.feed) ?? size;
  }
  return size;
}

export function PreviewBody(props: PreviewBodyProps): ReactElement {
  const { platform, format, firstMedia } = props;
  const kind = previewMediaKind(firstMedia);
  const spec = specFor(platform);
  const mediaList: PreviewMedia = kind === 'video' ? 'video' : 'image';

  const url = useMediaUrl(
    firstMedia,
    kind,
    props.cache,
    props.presignEnabled === true,
    props.localUrl ?? null,
  );
  // The measure belongs to the file on screen: it carries the src it was read
  // from and only counts while that src is shown. Keyed on the version id it was
  // lost when an upload finished (the id lands, the blob URL stays, no new load).
  // Cleared by an effect on the URL it raced the image: a photo already decoded
  // (the composer's frame showed the same blob) measured in the ref callback,
  // then the effect wiped it and no load event followed, so the panel stuck on
  // "Measuring the original."
  const [measured, setMeasured] = useState<{ src: string; w: number; h: number } | null>(null);
  const stored =
    firstMedia !== null &&
    firstMedia.width !== null &&
    firstMedia.height !== null &&
    firstMedia.width > 0 &&
    firstMedia.height > 0
      ? { w: firstMedia.width, h: firstMedia.height }
      : null;
  const shown = measured !== null && measured.src === url ? measured : null;
  const dims = stored ?? (shown !== null ? { w: shown.w, h: shown.h } : null);

  // Placement: fixed by the format, except a plain video on Instagram or
  // Facebook (Reel / Story / Feed chips; opens on Feed).
  const options = placementOptions(platform, format);
  const [placement, setPlacement] = useState<Placement>(() => defaultPlacement(format));
  useEffect(() => {
    setPlacement(defaultPlacement(format));
  }, [format]);
  const [showCut, setShowCut] = useState(false);

  /** src is the element's own src attribute, so a late load of a replaced file never counts. */
  function measure(src: string | null, w: number, h: number): void {
    if (stored === null && src !== null && w > 0 && h > 0) {
      setMeasured((prev) =>
        prev?.src === src && prev.w === w && prev.h === h ? prev : { src, w, h },
      );
    }
  }

  if (kind === 'document') {
    return (
      <div className="flex flex-col gap-3">
        <div className="flex min-h-11 items-center gap-2 rounded-xl border bg-panel-2 px-3 py-2 lit-card-muted">
          <IconFile size={ICON_SIZE.inline} />
          <span className="min-w-0 flex-1 truncate text-base text-fg">{firstMedia?.filename}</span>
        </div>
        <p className="text-base text-fg-2">
          {spec?.documentNote ?? 'Document pages are shown as-is, with no crop.'}
        </p>
      </div>
    );
  }

  if (!isPostPlatform(platform)) return <p className="text-base text-fg-2">No preview.</p>;

  const size = shownSize(platform, format, placement, mediaList, kind, dims);
  const full = size !== null ? isFullScreen(size) : fullScreenOnly(platform);
  if (size === null && kind !== 'none' && !full) {
    return <p className="text-base text-fg-2">No preview.</p>;
  }
  const ratio = size !== null ? frameRatio(size) : VERTICAL_FRAME.w / VERTICAL_FRAME.h;
  const result = size !== null && dims !== null && kind !== 'none' ? cropFor(dims, size) : null;
  const cutOn = showCut && result !== null && result.kind === 'cut' && dims !== null;

  // Shorts with an image: the same "Shorts are video only." line the post page shows.
  const note =
    size === null
      ? undefined
      : mediaList === 'video'
        ? spec?.videoNote
        : kind === 'image' && spec?.imageUnsupported !== undefined
          ? spec.imageUnsupported
          : spec?.imageNote;

  // The first slide is firstMedia (its URL is the one measured); the rest
  // follow in gallery order. Files that are not a photo or video are skipped.
  const slides: StageSlide[] = [];
  if (firstMedia !== null && (kind === 'image' || kind === 'video')) {
    slides.push({
      key: `first:${firstMedia.assetAttachmentId}`,
      item: firstMedia,
      kind,
      localUrl: props.localUrl ?? null,
    });
    (props.slides ?? []).slice(1).forEach((slide, at) => {
      const k = previewMediaKind(slide.item);
      if (k !== 'image' && k !== 'video') return;
      slides.push({
        key: `${at + 1}:${slide.item.assetAttachmentId}`,
        item: slide.item,
        kind: k,
        localUrl: slide.localUrl ?? null,
      });
    });
  }

  const layout = size?.layout;
  const stage = (
    <MediaStage
      key={cutOn ? 'cut' : 'slides'}
      slides={slides}
      firstUrl={url}
      cache={props.cache}
      presignEnabled={props.presignEnabled === true}
      fit={layout === 'bands' || layout === 'letterbox' ? 'contain' : 'cover'}
      bands={layout === 'bands' ? 'blur' : layout === 'letterbox' ? 'black' : 'none'}
      cut={
        cutOn && dims !== null && result !== null
          ? { window: result.window, mediaRatio: dims.w / dims.h, frameRatio: ratio }
          : null
      }
      carousel={!full}
      hasMedia={kind !== 'none'}
      onMeasure={measure}
    />
  );
  const media = size !== null || full ? { ratio, stage } : null;
  const clampLines = size !== null ? captionClampLines(size) : full ? 2 : 3;

  return (
    <div className="flex flex-col gap-4">
      {options !== null ? (
        <div role="group" aria-label="Placement" className="flex flex-wrap gap-2">
          {options.map((option) => (
            <Chip
              key={option}
              label={PLACEMENT_LABEL[option]}
              selected={option === placement}
              onClick={() => {
                setPlacement(option);
                setShowCut(false);
              }}
            />
          ))}
        </div>
      ) : null}
      {note !== undefined ? <p className="text-base text-fg-2">{note}</p> : null}

      {full ? (
        <FullMock
          platform={platform}
          handle={props.handle}
          caption={props.caption}
          clampLines={clampLines}
          media={media}
          story={layout === 'story'}
          ratio={ratio}
        />
      ) : (
        <FeedMock
          platform={platform}
          handle={props.handle}
          caption={props.caption}
          clampLines={clampLines}
          media={media}
        />
      )}

      {kind !== 'none' && size !== null ? (
        <div data-preview-cut="" className="flex min-h-11 items-center gap-3">
          {result === null ? (
            <Text role="secondary" className="min-w-0 flex-1">
              Measuring the original.
            </Text>
          ) : (
            <Text role="body" className="min-w-0 flex-1">
              {cropLine(result, platform)}
            </Text>
          )}
          {result !== null && result.kind === 'cut' ? (
            <Chip
              label="Show cut"
              selected={cutOn}
              className="shrink-0"
              onClick={() => setShowCut((on) => !on)}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
