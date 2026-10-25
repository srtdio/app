// The "{Platform} preview" side panel on the post detail page and in the post
// composer. It shows the post's first media and caption framed the way the
// workspace's platform frames them (sizes from src/lib/platform-specs.ts), then
// the original with the part that is shown. Dimensions come from asset_versions
// width/height when present, else are measured in the browser once the media
// loads. The post page resolves saved media through its presign cache; the
// composer passes the unsaved draft's local object URL. Presentation only: no
// server change, no backfill.

import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent, ReactElement, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { Backdrop } from '@/components/ui/Backdrop';
import { IconButton } from '@/components/ui/IconButton';
import { PressableRow } from '@/components/ui/PressableRow';
import { ICON_SIZE, IconEye, IconFile, IconX } from '@/components/ui/icons';
import { cn } from '@/lib/cn';
import { useModalFocus } from '@/lib/modal-focus';
import { DUR_BASE_MS } from '@/lib/motion';
import type { PresignCache } from '@/lib/asset-presign';
import type { PlatformSize } from '@/lib/platform-specs';
import type { GalleryItem } from '@srtdio/posts';
import { isPostPlatform, platformLabel } from '@srtdio/posts';
import {
  captionClampLines,
  cropFor,
  cropLine,
  defaultSizeFor,
  postSize,
  frameRatio,
  sizeMeta,
  sizesFor,
  specFor,
  type CropWindow,
  type PreviewMedia,
} from '@/components/preview/preview-math';

export type PreviewMediaKind = PreviewMedia | 'document' | 'none';

/** What the first gallery item is, for the preview. */
export function previewMediaKind(item: GalleryItem | null): PreviewMediaKind {
  if (item === null) return 'none';
  const mime = item.mimeType ?? '';
  if (item.kind === 'image' || mime.startsWith('image/')) return 'image';
  if (item.kind === 'video' || mime.startsWith('video/')) return 'video';
  if (mime === 'application/pdf') return 'document';
  return 'none';
}

/** The chip's label, e.g. "Instagram preview". */
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
    <Button
      type="button"
      variant="secondary"
      onClick={onClick}
      className="focus:outline-none focus-visible:ring-2 focus-visible:ring-accent motion-reduce:transition-none"
    >
      <IconEye size={ICON_SIZE.inline} />
      {previewChipLabel(platform)}
    </Button>
  );
}

/** What the preview draws: the post (or the composer's draft) and its first media. */
export interface PreviewBodyProps {
  platform: string;
  format: string;
  caption: string;
  /** The account shown on the mock: the workspace name. */
  handle: string;
  firstMedia: GalleryItem | null;
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

export function PlatformPreviewPanel(props: PlatformPreviewPanelProps): ReactElement | null {
  const { open, onClose } = props;
  const [rendered, setRendered] = useState(open);
  const [entered, setEntered] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setRendered(true);
      const raf = requestAnimationFrame(() => setEntered(true));
      return () => cancelAnimationFrame(raf);
    }
    setEntered(false);
    const timer = setTimeout(() => setRendered(false), DUR_BASE_MS);
    return () => clearTimeout(timer);
  }, [open]);

  // Focus lands on Close once the panel is in the DOM, Tab stays inside, and
  // the chip that opened it gets focus back on close (shared modal focus).
  useModalFocus(panelRef, open && rendered, {
    initial: () => closeRef.current?.querySelector('button'),
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
    <div
      className={cn(
        'fixed inset-0 z-50 transition-opacity duration-base motion-reduce:transition-none',
        entered ? 'opacity-100 ease-enter' : 'opacity-0 ease-exit',
      )}
    >
      <Backdrop position="absolute" aria-label="Close preview" onClick={onClose} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onKeyDown={onKeyDown}
        className={cn(
          'absolute inset-y-0 right-0 flex w-full max-w-[460px] flex-col border-l border-border-strong bg-panel shadow-2xl transition-transform duration-base motion-reduce:transition-none',
          entered ? 'translate-x-0 ease-enter' : 'translate-x-full ease-exit',
        )}
      >
        <div className="flex items-center gap-2.5 border-b border-border px-[18px] py-2">
          <h2 className="text-lg font-semibold">{title}</h2>
          <div ref={closeRef} className="ml-auto">
            <IconButton label="Close preview" onClick={onClose}>
              <IconX />
            </IconButton>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-[18px] py-4">
          {isPostPlatform(props.platform) ? <PreviewBody {...props} /> : null}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** The media's inline URL: the draft's local URL, else resolved through the presign cache. */
function useMediaUrl(
  item: GalleryItem | null,
  kind: PreviewMediaKind,
  cache: PresignCache | undefined,
  enabled: boolean,
  localUrl: string | null,
): string | null {
  const versionId = item?.assetVersionId ?? '';
  const renderable =
    localUrl === null &&
    cache !== undefined &&
    enabled &&
    versionId !== '' &&
    (kind === 'image' || kind === 'video');
  const [url, setUrl] = useState<string | null>(() =>
    renderable ? (cache.peek(versionId)?.url ?? null) : null,
  );
  useEffect(() => {
    if (!renderable) {
      setUrl(null);
      return;
    }
    let live = true;
    cache
      ?.resolve(versionId)
      .then((presigned) => {
        if (live) setUrl(presigned.url);
      })
      .catch(() => {
        if (live) setUrl(null);
      });
    return () => {
      live = false;
    };
  }, [renderable, versionId, cache]);
  return localUrl ?? url;
}

export function PreviewBody(props: PreviewBodyProps): ReactElement {
  const { platform, format, firstMedia } = props;
  const kind = previewMediaKind(firstMedia);
  const spec = specFor(platform);
  const mediaList: PreviewMedia = kind === 'video' ? 'video' : 'image';
  const listSizes = sizesFor(platform, mediaList);

  const [measured, setMeasured] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    setMeasured(null);
  }, [firstMedia?.assetVersionId]);
  const stored =
    firstMedia !== null &&
    firstMedia.width !== null &&
    firstMedia.height !== null &&
    firstMedia.width > 0 &&
    firstMedia.height > 0
      ? { w: firstMedia.width, h: firstMedia.height }
      : null;
  const dims = stored ?? measured;
  // The panel opens on the frame the post page shows ("This post"), then the
  // platform's published sizes to compare.
  const thisPost = postSize(platform, format, mediaList, dims);
  const sizes: readonly PlatformSize[] = thisPost !== null ? [thisPost, ...listSizes] : listSizes;
  const fallback =
    thisPost ??
    (isPostPlatform(platform) ? defaultSizeFor(platform, format, mediaList, dims) : null);

  const [label, setLabel] = useState<string | null>(fallback?.label ?? null);
  useEffect(() => {
    setLabel(fallback?.label ?? null);
  }, [fallback?.label]);
  const size = sizes.find((s) => s.label === label) ?? fallback;
  const url = useMediaUrl(
    firstMedia,
    kind,
    props.cache,
    props.presignEnabled === true,
    props.localUrl ?? null,
  );

  function measure(w: number, h: number): void {
    if (stored === null && w > 0 && h > 0) setMeasured({ w, h });
  }

  if (kind === 'document') {
    return (
      <div className="flex flex-col gap-3">
        <div className="flex min-h-[44px] items-center gap-2 rounded-md border border-border bg-panel-2 px-3 py-2">
          <IconFile size={ICON_SIZE.inline} />
          <span className="min-w-0 flex-1 truncate text-base text-fg">{firstMedia?.filename}</span>
        </div>
        <p className="text-base text-fg-2">
          {spec?.documentNote ?? 'Document pages are shown as-is, with no crop.'}
        </p>
      </div>
    );
  }

  if (size === null) return <p className="text-base text-fg-2">No preview.</p>;

  // Shorts with an image: the same "Shorts are video only." line the post page shows.
  const note =
    mediaList === 'video'
      ? spec?.videoNote
      : kind === 'image' && spec?.imageUnsupported !== undefined
        ? spec.imageUnsupported
        : spec?.imageNote;
  const media: ReactNode =
    url === null ? null : kind === 'video' ? (
      <video
        src={url}
        muted
        playsInline
        preload="metadata"
        aria-hidden
        onLoadedMetadata={(event) =>
          measure(event.currentTarget.videoWidth, event.currentTarget.videoHeight)
        }
      />
    ) : (
      <img
        src={url}
        alt=""
        onLoad={(event) =>
          measure(event.currentTarget.naturalWidth, event.currentTarget.naturalHeight)
        }
      />
    );

  return (
    <div className="flex flex-col gap-5">
      {sizes.length > 0 ? (
        <SizePicker sizes={sizes} value={size.label} onChange={setLabel} />
      ) : null}
      {note !== undefined ? <p className="text-base text-fg-2">{note}</p> : null}

      <LayoutMock
        size={size}
        handle={props.handle}
        caption={props.caption}
        media={media}
        hasMedia={kind !== 'none'}
      />

      {kind !== 'none' && media !== null ? <CropBox size={size} dims={dims} media={media} /> : null}
    </div>
  );
}

function SizePicker({
  sizes,
  value,
  onChange,
}: {
  sizes: readonly PlatformSize[];
  value: string;
  onChange: (label: string) => void;
}): ReactElement {
  return (
    <div role="radiogroup" aria-label="Size" className="grid grid-cols-2 gap-2">
      {sizes.map((size) => {
        const selected = size.label === value;
        return (
          <PressableRow
            key={size.label}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(size.label)}
            className={cn(
              'flex flex-col items-start justify-center border px-3 py-1.5 transition-colors motion-reduce:transition-none',
              selected ? 'border-accent-line bg-accent-soft text-fg' : 'border-border text-fg-2',
            )}
          >
            <span className="text-base font-medium">{size.label}</span>
            <span className="text-sm text-fg-3">{sizeMeta(size)}</span>
          </PressableRow>
        );
      })}
    </div>
  );
}

function clampStyle(lines: number): CSSProperties {
  return {
    display: '-webkit-box',
    WebkitLineClamp: lines,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
  };
}

/** The platform's frame: a feed card, or a full-screen vertical / story / banded frame. */
function LayoutMock({
  size,
  handle,
  caption,
  media,
  hasMedia,
}: {
  size: PlatformSize;
  handle: string;
  caption: string;
  media: ReactNode;
  hasMedia: boolean;
}): ReactElement {
  const ratio = frameRatio(size);
  const avatar = <Avatar name={handle.trim()} role="header" />;
  const placeholder = (
    <span className="flex h-full w-full items-center justify-center text-sm text-fg-3">
      {hasMedia ? 'Loading' : 'Photos and videos show up here.'}
    </span>
  );

  // A feed post fit with bands (Threads, never cropped) keeps the feed card.
  const feedLetterbox = size.layout === 'letterbox' && size.feedCard === true;
  if (size.layout === 'feed' || feedLetterbox) {
    return (
      <figure
        aria-label="Feed preview"
        className="overflow-hidden rounded-xl border border-border bg-panel"
      >
        <div className="flex items-center gap-2 px-3 py-2">
          {avatar}
          <span className="truncate text-base font-semibold text-fg">{handle}</span>
        </div>
        <div
          data-mock-fit={feedLetterbox ? 'contain' : 'cover'}
          className={cn(
            'w-full overflow-hidden [&>img]:h-full [&>img]:w-full [&>video]:h-full [&>video]:w-full',
            feedLetterbox
              ? 'bg-black [&>img]:object-contain [&>video]:object-contain'
              : 'bg-panel-3 [&>img]:object-cover [&>video]:object-cover',
          )}
          style={{ aspectRatio: String(ratio) }}
        >
          {media ?? placeholder}
        </div>
        {caption !== '' ? (
          <figcaption
            className="px-3 py-2 text-base text-fg [overflow-wrap:anywhere]"
            style={clampStyle(captionClampLines(size))}
          >
            <span className="font-semibold">{handle}</span> {caption}
          </figcaption>
        ) : null}
      </figure>
    );
  }

  const contain = size.layout === 'bands' || size.layout === 'letterbox';
  return (
    <figure
      aria-label={size.layout === 'story' ? 'Story preview' : 'Full-screen preview'}
      className="relative mx-auto w-full max-w-[280px] overflow-hidden rounded-2xl bg-black"
      style={{ aspectRatio: String(ratio) }}
    >
      {size.layout === 'bands' && media !== null ? (
        <div
          aria-hidden
          className="absolute inset-0 scale-110 opacity-70 blur-xl [&>img]:h-full [&>img]:w-full [&>img]:object-cover [&>video]:h-full [&>video]:w-full [&>video]:object-cover"
        >
          {media}
        </div>
      ) : null}
      <div
        className={cn(
          'absolute inset-0 flex items-center justify-center [&>img]:h-full [&>img]:w-full [&>video]:h-full [&>video]:w-full',
          contain
            ? '[&>img]:object-contain [&>video]:object-contain'
            : '[&>img]:object-cover [&>video]:object-cover',
        )}
      >
        {media ?? placeholder}
      </div>
      {size.layout === 'story' ? (
        <div className="absolute inset-x-0 top-0 flex flex-col gap-2 p-3">
          <span className="h-0.5 w-full rounded-full bg-white/60" />
          <span className="flex items-center gap-2">
            {avatar}
            <span className="truncate text-base font-semibold text-white">{handle}</span>
          </span>
        </div>
      ) : (
        <figcaption className="absolute inset-x-0 bottom-0 flex flex-col gap-1 bg-gradient-to-t from-black/70 to-transparent p-3 pt-10 text-white">
          <span className="flex items-center gap-2">
            {avatar}
            <span className="truncate text-base font-semibold">{handle}</span>
          </span>
          {caption !== '' ? (
            <span
              className="text-md [overflow-wrap:anywhere]"
              style={clampStyle(captionClampLines(size))}
            >
              {caption}
            </span>
          ) : null}
        </figcaption>
      )}
    </figure>
  );
}

/** The original, with the "Shown" window drawn over it and the crop line. */
function CropBox({
  size,
  dims,
  media,
}: {
  size: PlatformSize;
  dims: { w: number; h: number } | null;
  media: ReactNode;
}): ReactElement {
  if (dims === null) {
    return <p className="text-sm text-fg-3">Measuring the original.</p>;
  }
  const result = cropFor(dims, size);
  return (
    <section aria-label="Crop" className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold uppercase tracking-[0.06em] text-fg-2">
        Original · {dims.w} x {dims.h}
      </h3>
      <div
        className="relative mx-auto w-full max-w-[320px] overflow-hidden rounded-md bg-panel-3 [&>img]:h-full [&>img]:w-full [&>img]:object-fill [&>video]:h-full [&>video]:w-full [&>video]:object-fill"
        style={{ aspectRatio: String(dims.w / dims.h) }}
      >
        {media}
        <ShownWindow window={result.window} />
      </div>
      <p className="text-base text-fg">{cropLine(result)}</p>
    </section>
  );
}

function ShownWindow({ window: win }: { window: CropWindow }): ReactElement {
  const pct = (n: number): string => `${n * 100}%`;
  return (
    <div
      className="absolute rounded-sm border-2 border-accent shadow-[var(--shadow-spotlight)]"
      style={{ left: pct(win.x), top: pct(win.y), width: pct(win.w), height: pct(win.h) }}
    >
      <span className="absolute left-1 top-1 rounded bg-accent px-1.5 py-0.5 text-xs font-semibold text-accent-fg">
        Shown
      </span>
    </div>
  );
}
