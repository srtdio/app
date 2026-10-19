// A post's picture in chat lists: the Share a post / Pick a post rows, the
// status drop-down rows and the composer's shared-post chip. It shows the
// post's first photo or video in display order (PostCardRow.firstMedia, the
// same pick the chat post card uses): a photo as itself, a video as its stored
// thumbnail or, without one, the video paused on its first frame, with a small
// play mark. A post with no photo or video keeps the neutral glyph.
// While the post's media is still unknown the box stays empty (no glyph), so
// a glyph never paints and then swaps for a picture. Tokens only, so light and
// dark follow the theme.

import { useRef, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { IconPipeline, IconPlay } from '@/components/ui/icons';
import { useThumbnail } from '@/components/media/use-thumbnail';
import { useNearViewport, useStoredThumbnail } from '@/components/ui/FileTile';
import { PRESIGN_ENABLED, firstFrameSrc, sharedCardPresignCache } from '@/components/chat/PostCard';
import type { CardFirstMedia, PostCardRow } from '../../../packages/posts/src/reads';

/** A post's cover: its first photo or video, null for none, undefined while unknown. */
export type PostCoverState = CardFirstMedia | null | undefined;

/**
 * The cover state for a looked-up post: undefined while the lookup is pending,
 * null when the post is not visible or has no photo or video. Pure.
 */
export function coverOf(post: PostCardRow | null | undefined): PostCoverState {
  if (post === undefined) return undefined;
  return post?.firstMedia ?? null;
}

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
  const glyph = props.fallback ?? <IconPipeline size={18} />;
  if (cover === null) return <>{glyph}</>;
  return cover.kind === 'video' ? (
    <CoverVideo assetVersionId={cover.assetVersionId} glyph={glyph} />
  ) : (
    <CoverImage assetVersionId={cover.assetVersionId} glyph={glyph} />
  );
}

/** A photo, presigned lazily once its row scrolls into view. */
function CoverImage(props: { assetVersionId: string; glyph: ReactNode }): ReactElement {
  const thumb = useThumbnail<HTMLSpanElement>({
    assetVersionId: props.assetVersionId,
    cache: sharedCardPresignCache(),
    enabled: PRESIGN_ENABLED,
  });
  return (
    <span ref={thumb.ref} className="flex h-full w-full items-center justify-center">
      {thumb.failed ? (
        props.glyph
      ) : thumb.url !== null ? (
        <img
          src={thumb.url}
          alt=""
          loading="lazy"
          draggable={false}
          onError={thumb.onError}
          className="h-full w-full object-cover"
        />
      ) : null}
    </span>
  );
}

/**
 * A video: its stored thumbnail rendition, asked for once near the viewport; a
 * version without one (older uploads), or a broken one, falls back to the video
 * itself paused on its first frame. The play mark sits bottom right.
 */
function CoverVideo(props: { assetVersionId: string; glyph: ReactNode }): ReactElement {
  const boxRef = useRef<HTMLSpanElement>(null);
  const near = useNearViewport(boxRef);
  const stored = useStoredThumbnail(
    props.assetVersionId,
    sharedCardPresignCache(),
    PRESIGN_ENABLED && near,
  );
  // A broken image drops only that version's thumbnail, never a newer one's.
  const [failedVersion, setFailedVersion] = useState<string | null>(null);
  const failed = failedVersion === props.assetVersionId;
  const still = failed ? null : stored.url;
  return (
    <span ref={boxRef} className="relative flex h-full w-full items-center justify-center">
      {still !== null ? (
        <img
          data-post-cover-still=""
          src={still}
          alt=""
          draggable={false}
          onError={() => setFailedVersion(props.assetVersionId)}
          className="h-full w-full object-cover"
        />
      ) : stored.missing || failed ? (
        <CoverVideoFrame assetVersionId={props.assetVersionId} glyph={props.glyph} />
      ) : null}
      <span
        data-post-cover-play=""
        className="pointer-events-none absolute bottom-1 right-1 flex h-4 w-4 items-center justify-center rounded-full bg-overlay text-overlay-fg"
      >
        <IconPlay size={8} />
      </span>
    </span>
  );
}

/** The video file itself, paused on its first frame (no stored thumbnail). */
function CoverVideoFrame(props: { assetVersionId: string; glyph: ReactNode }): ReactElement {
  const thumb = useThumbnail<HTMLSpanElement>({
    assetVersionId: props.assetVersionId,
    cache: sharedCardPresignCache(),
    enabled: PRESIGN_ENABLED,
  });
  return (
    <span ref={thumb.ref} className="flex h-full w-full items-center justify-center">
      {thumb.failed ? (
        props.glyph
      ) : thumb.url !== null ? (
        <video
          data-post-cover-frame=""
          src={firstFrameSrc(thumb.url)}
          preload="metadata"
          muted
          playsInline
          onError={thumb.onError}
          className="pointer-events-none h-full w-full object-cover"
        />
      ) : null}
    </span>
  );
}
