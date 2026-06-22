// A fullscreen image viewer scoped to one comment's image attachments. It reuses
// the chat presign-with-refresh hook (useAttachmentUrl) against the SAME shared
// PresignCache the comment row already presigned through, so opening an image is
// a cache hit, never a new presign. Navigation math reuses PostLightbox's pure
// wrapIndex / lightboxCounter helpers. The dark scrim is theme-independent (the
// `overlay` tokens render the same dark backdrop in light and dark mode).

import { useEffect, useRef } from 'react';
import type { ReactElement } from 'react';
import { IconChevronLeft, IconChevronRight, IconX } from '@/components/ui/icons';
import { useAttachmentUrl } from '@/components/chat/MessageAttachments';
import { wrapIndex, lightboxCounter } from '@/components/pages/pcs/PostLightbox';
import type { PresignCache } from '@/lib/asset-presign';
import { classifyAttachment, type MessageAttachment } from '@/lib/chat/attachments';

const SWIPE_THRESHOLD = 48;

/**
 * Filter a comment's attachments to its images and locate the clicked one among
 * them. Returns the image list plus the clicked image's index (0 when the id is
 * not found but images exist; an all-files comment yields an empty list). Pure.
 */
export function commentImageNav(
  attachments: MessageAttachment[],
  clickedAssetId: string,
): { images: MessageAttachment[]; index: number } {
  const images = attachments.filter((a) => classifyAttachment(a.mime) === 'image');
  const found = images.findIndex((a) => a.assetId === clickedAssetId);
  return { images, index: found >= 0 ? found : 0 };
}

const TOOLBAR_BUTTON =
  'inline-flex h-11 w-11 items-center justify-center rounded-lg text-overlay-fg ' +
  'hover:bg-overlay-surface focus-visible:outline-none focus-visible:ring-2 ' +
  'focus-visible:ring-overlay-fg/70';

const ARROW_BUTTON =
  'absolute top-1/2 inline-flex h-11 w-11 -translate-y-1/2 items-center justify-center ' +
  'rounded-full bg-overlay-surface text-overlay-fg hover:bg-overlay-line ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-overlay-fg/70';

interface CommentImageLightboxProps {
  /** The IMAGE attachments for one comment, already filtered by the caller. */
  images: MessageAttachment[];
  index: number;
  cache: PresignCache;
  presignEnabled: boolean;
  onIndexChange: (index: number) => void;
  onClose: () => void;
}

/**
 * Fullscreen viewer for one comment's images: a dark scrim, the centered image,
 * a close button and (when there is more than one image) prev/next + a counter.
 * Esc closes, ArrowLeft/Right navigate (wrapping), tapping the scrim closes, and
 * a horizontal swipe past a small threshold navigates. Only the current image is
 * presigned, through the passed cache, so it is a cache hit and never an N+1.
 */
export function CommentImageLightbox({
  images,
  index,
  cache,
  presignEnabled,
  onIndexChange,
  onClose,
}: CommentImageLightboxProps): ReactElement | null {
  const current = images[index];
  const touchStartX = useRef<number | null>(null);

  const go = (delta: number): void => {
    onIndexChange(wrapIndex(index, delta, images.length));
  };

  // Esc closes; arrows navigate. Listener is torn down on unmount.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
      else if (event.key === 'ArrowLeft') go(-1);
      else if (event.key === 'ArrowRight') go(1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // Presign the current image only, reusing the shared cache: a cache hit.
  const { url, failed } = useAttachmentUrl(current?.assetId ?? '', cache, presignEnabled);

  if (current === undefined) return null;

  const onScrimTouchStart = (event: React.TouchEvent): void => {
    touchStartX.current = event.touches[0]?.clientX ?? null;
  };
  const onScrimTouchEnd = (event: React.TouchEvent): void => {
    const start = touchStartX.current;
    touchStartX.current = null;
    if (start === null) return;
    const delta = (event.changedTouches[0]?.clientX ?? start) - start;
    if (Math.abs(delta) > SWIPE_THRESHOLD) go(delta < 0 ? 1 : -1);
  };

  const multiple = images.length > 1;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Image viewer"
      className="fixed inset-0 z-50 flex flex-col bg-overlay"
    >
      <div className="flex h-14 shrink-0 items-center px-3">
        {multiple ? (
          <span className="shrink-0 tabular-nums text-sm text-overlay-fg-dim">
            {lightboxCounter(index, images.length)}
          </span>
        ) : null}
        <button
          type="button"
          aria-label="Close viewer"
          onClick={onClose}
          className={`${TOOLBAR_BUTTON} ml-auto`}
        >
          <IconX size={20} />
        </button>
      </div>

      <div
        className="relative flex flex-1 items-center justify-center overflow-hidden p-4"
        onClick={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
        onTouchStart={onScrimTouchStart}
        onTouchEnd={onScrimTouchEnd}
      >
        {multiple ? (
          <>
            <button
              type="button"
              aria-label="Previous image"
              onClick={() => go(-1)}
              className={`${ARROW_BUTTON} left-2`}
            >
              <IconChevronLeft size={20} />
            </button>
            <button
              type="button"
              aria-label="Next image"
              onClick={() => go(1)}
              className={`${ARROW_BUTTON} right-2`}
            >
              <IconChevronRight size={20} />
            </button>
          </>
        ) : null}

        {failed ? (
          <p className="text-sm text-overlay-fg-dim">Couldn&apos;t load this image</p>
        ) : url !== null ? (
          <img src={url} alt={current.name} className="max-h-full max-w-full object-contain" />
        ) : (
          <div className="h-10 w-10 animate-spin rounded-full border-2 border-overlay-line border-t-overlay-fg" />
        )}
      </div>
    </div>
  );
}
