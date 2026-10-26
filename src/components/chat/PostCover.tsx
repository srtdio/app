// A post's picture in chat lists: the Share a post / Pick a post rows, the
// status drop-down rows and the composer's shared-post chip. It shows the
// post's first photo or video in display order (the same pick the chat post
// card uses). Every cover asks for the version's small stored copy first (an
// image's list copy, a video's frame), a few KB instead of the original; a
// photo without one falls back to the original, a video to its first frame,
// with a small play mark. A post with no photo or video keeps the neutral glyph.
// While the post's media is still unknown the box stays empty (no glyph), so
// a glyph never paints and then swaps for a picture. Tokens only, so light and
// dark follow the theme.

import { useRef, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { ICON_SIZE, IconPipeline, IconPlay } from '@/components/ui/icons';
import { useThumbnail } from '@/components/media/use-thumbnail';
import { useNearViewport, useStoredThumbnail } from '@/components/ui/FileTile';
import { PRESIGN_ENABLED, firstFrameSrc, sharedCardPresignCache } from '@/components/chat/PostCard';
import type { CardFirstMedia } from '../../../packages/posts/src/reads';

/** A post's cover: its first photo or video, null for none, undefined while unknown. */
type PostCoverState = CardFirstMedia | null | undefined;

/** The 48px rounded box every chat post list row uses for its picture. */
export const POST_COVER_BOX =
  'relative flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-panel-3 text-fg-3';

/** The boxed cover for a list row. */
export function PostCover(props: { cover: PostCoverState; fallback?: ReactNode }): ReactElement {
  return (
    <span aria-hidden="true" data-post-cover={coverKind(props.cover)} className={POST_COVER_BOX}>
      <PostCoverContent cover={props.cover} fallback={props.fallback} />
    </span>
  );
}

/** 'pending' | 'none' | 'image' | 'video', for the box's data attribute. Pure. */
export function coverKind(cover: PostCoverState): string {
  if (cover === undefined) return 'pending';
  if (cover === null) return 'none';
  return cover.kind;
}

/**
 * The cover filling whatever box holds it (the list box above, or the composer
 * chip's own box): nothing while unknown, the glyph for none, else the media.
 */
export function PostCoverContent(props: {
  cover: PostCoverState;
  fallback?: ReactNode;
}): ReactElement | null {
  const { cover } = props;
  if (cover === undefined) return null;
  const glyph = props.fallback ?? <IconPipeline size={ICON_SIZE.nav} />;
  if (cover === null) return <>{glyph}</>;
  return (
    <CoverMedia
      key={cover.assetVersionId}
      assetVersionId={cover.assetVersionId}
      video={cover.kind === 'video'}
      glyph={glyph}
    />
  );
}

/**
 * Warm the small copies of covers a list is about to show: presign each
 * version's stored copy and start its download, so the list paints its
 * pictures at once. Bounded by the shared presign cache's concurrency; a
 * version without a small copy is skipped (it loads when shown). Never throws.
 */
export function warmCoverImages(covers: ReadonlyArray<CardFirstMedia | null | undefined>): void {
  if (!PRESIGN_ENABLED || typeof Image === 'undefined') return;
  const cache = sharedCardPresignCache();
  for (const cover of covers) {
    if (cover === null || cover === undefined) continue;
    if (cache.peekThumbnail(cover.assetVersionId) !== null) continue;
    void cache
      .thumbnail(cover.assetVersionId)
      .then((presigned) => {
        if (presigned === null) return;
        const img = new Image();
        img.decoding = 'async';
        img.src = presigned.url;
      })
      .catch(() => undefined);
  }
}

/**
 * One cover: the version's small stored copy, asked for once near the
 * viewport (painted at once when already warmed). Without one, or when it
 * breaks, a photo falls back to its original and a video to its first frame.
 */
function CoverMedia(props: {
  assetVersionId: string;
  video: boolean;
  glyph: ReactNode;
}): ReactElement {
  const boxRef = useRef<HTMLSpanElement>(null);
  const near = useNearViewport(boxRef);
  const stored = useStoredThumbnail(
    props.assetVersionId,
    sharedCardPresignCache(),
    PRESIGN_ENABLED && near,
  );
  // A small copy already known (this session or kept on the device) paints on the first frame.
  const known = PRESIGN_ENABLED
    ? (sharedCardPresignCache().peekThumbnail(props.assetVersionId)?.url ?? null)
    : null;
  const [stillFailed, setStillFailed] = useState(false);
  const still = stillFailed ? null : (stored.url ?? known);
  const fallback = stored.missing || stillFailed;
  return (
    <span ref={boxRef} className="relative flex h-full w-full items-center justify-center">
      {still !== null ? (
        <img
          data-post-cover-still=""
          src={still}
          alt=""
          decoding="async"
          draggable={false}
          onError={() => setStillFailed(true)}
          className="h-full w-full object-cover"
        />
      ) : fallback ? (
        <CoverOriginal
          assetVersionId={props.assetVersionId}
          video={props.video}
          glyph={props.glyph}
        />
      ) : null}
      {props.video ? (
        <span
          data-post-cover-play=""
          className="pointer-events-none absolute bottom-1 right-1 flex h-4 w-4 items-center justify-center rounded-full bg-overlay text-overlay-fg"
        >
          <IconPlay size={12} />
        </span>
      ) : null}
    </span>
  );
}

/** The original file: a photo as itself, a video paused on its first frame. */
function CoverOriginal(props: {
  assetVersionId: string;
  video: boolean;
  glyph: ReactNode;
}): ReactElement {
  const thumb = useThumbnail<HTMLSpanElement>({
    assetVersionId: props.assetVersionId,
    cache: sharedCardPresignCache(),
    enabled: PRESIGN_ENABLED,
  });
  const url = thumb.failed ? null : thumb.url;
  return (
    <span ref={thumb.ref} className="flex h-full w-full items-center justify-center">
      {thumb.failed ? (
        props.glyph
      ) : url === null ? null : props.video ? (
        <video
          data-post-cover-frame=""
          src={firstFrameSrc(url)}
          preload="metadata"
          muted
          playsInline
          onError={thumb.onError}
          className="pointer-events-none h-full w-full object-cover"
        />
      ) : (
        <img
          src={url}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onError={thumb.onError}
          className="h-full w-full object-cover"
        />
      )}
    </span>
  );
}
