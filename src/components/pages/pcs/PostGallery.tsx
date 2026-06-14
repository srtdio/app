import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { IconAssets } from '@/components/ui/icons';
import { PostLightbox } from '@/components/pages/pcs/PostLightbox';
import type { PresignCache, PresignDeps } from '@/lib/asset-presign';
import type { GalleryItem } from '@srtdio/posts';

/** True when this item has an inline image preview worth resolving for a tile. */
function isImage(item: GalleryItem): boolean {
  return item.kind === 'image' || (item.mimeType ?? '').startsWith('image/');
}

/** Lazily resolve and render one tile's inline thumbnail, falling back to a glyph. */
function GalleryThumb({
  item,
  cache,
  presignEnabled,
}: {
  item: GalleryItem;
  cache: PresignCache;
  presignEnabled: boolean;
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
        className="h-full w-full object-cover"
      />
    );
  }
  // Fallback covers non-image kinds, a failed presign, and the unconfigured-env
  // case (presignEnabled false), so a tile never renders blank.
  return (
    <div className="flex h-full w-full items-center justify-center bg-panel-3 text-fg-3">
      <IconAssets size={22} />
    </div>
  );
}

interface GalleryViewProps {
  items: GalleryItem[];
  cache: PresignCache;
  presignEnabled: boolean;
  onOpen: (index: number) => void;
}

/**
 * The gallery's presentational tree, kept hookless so the tree-walking unit tests
 * can exercise it without a DOM renderer. Renders the ordered thumbnail grid, or a
 * calm empty state when the post has no images.
 */
export function galleryView({
  items,
  cache,
  presignEnabled,
  onOpen,
}: GalleryViewProps): ReactElement {
  if (items.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-panel-2 px-4 py-8 text-center text-sm text-fg-3">
        No images on this post yet.
      </div>
    );
  }
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
      {items.map((item, index) => (
        <button
          key={item.assetAttachmentId}
          type="button"
          aria-label={`View image ${index + 1}`}
          onClick={() => onOpen(index)}
          className="group relative aspect-[4/5] overflow-hidden rounded-xl border border-border bg-panel-2 transition-colors hover:border-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <GalleryThumb item={item} cache={cache} presignEnabled={presignEnabled} />
          <span className="absolute left-1.5 top-1.5 rounded bg-overlay px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-overlay-fg">
            {index + 1}/{items.length}
          </span>
        </button>
      ))}
    </div>
  );
}

interface PostGalleryProps {
  items: GalleryItem[];
  cache: PresignCache;
  deps: PresignDeps;
  presignEnabled: boolean;
}

/**
 * The post's images as an ordered, view-only thumbnail grid. Tapping a tile opens
 * the PCS {@link PostLightbox} at that index. No add/reorder/remove (F7) and no
 * pins/annotations (F5) here; the lightbox carries the inert F5 seams.
 */
export function PostGallery({ items, cache, deps, presignEnabled }: PostGalleryProps) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  return (
    <>
      {galleryView({ items, cache, presignEnabled, onOpen: setOpenIndex })}
      {openIndex !== null ? (
        <PostLightbox
          items={items}
          index={openIndex}
          presignEnabled={presignEnabled}
          cache={cache}
          deps={deps}
          onIndexChange={setOpenIndex}
          onClose={() => setOpenIndex(null)}
        />
      ) : null}
    </>
  );
}
