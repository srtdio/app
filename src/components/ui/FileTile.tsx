// A file's tile in a gallery or grid (briefs, posts, Assets): the stored
// thumbnail for a PDF or video, else the icon card the chat file bubble uses,
// over the name (two lines, cut in the middle, extension kept) and a meta line
// of kind (from the server-detected mime, never the name), page count when
// known, and size when known. The tile fills the box its parent sizes, so its
// height is final on first paint. The thumbnail is asked for only once the
// tile comes near the viewport, through the shared PresignCache (one request
// per version for the session; a version with none is remembered as absent).

import { useEffect, useRef, useState } from 'react';
import type { ReactElement, RefObject } from 'react';
import { IconFile, IconFileText, IconPlay, IconVideo } from '@/components/ui/icons';
import { cn } from '@/lib/cn';
import { humanizeSize } from '@/lib/assets';
import type { PresignCache } from '@/lib/asset-presign';
import { thumbnailMetaOf, type FileKind, type ThumbnailMeta } from '@/lib/chat/attachments';
import { VIEWER_NAME_BUDGET, fileKindLabel, middleTruncate } from '@/lib/files/display-name';
import { thumbnailKind } from '@/lib/files/thumbnail';

/** How far outside the viewport a tile starts loading its thumbnail. */
export const NEAR_VIEWPORT_MARGIN = '200px';

/** The kind glyph shared by the chat file bubble and the file tiles. */
export function KindIcon(props: { kind: FileKind; size: number }): ReactElement {
  if (props.kind === 'video') return <IconVideo size={props.size} />;
  if (props.kind === 'pdf' || props.kind === 'office') return <IconFileText size={props.size} />;
  return <IconFile size={props.size} />;
}

/** A recorded file's stored thumbnail, presigned through the shared cache. */
export function useStoredThumbnail(
  versionId: string,
  cache: PresignCache,
  enabled: boolean,
): { url: string | null; missing: boolean } {
  const [state, setState] = useState<{ url: string | null; missing: boolean }>(() => ({
    url: enabled && versionId !== '' ? (cache.peekThumbnail(versionId)?.url ?? null) : null,
    missing: false,
  }));
  useEffect(() => {
    if (!enabled || versionId === '') return;
    let live = true;
    cache
      .thumbnail(versionId)
      .then((presigned) => {
        if (live) setState({ url: presigned?.url ?? null, missing: presigned === null });
      })
      .catch(() => {
        if (live) setState({ url: null, missing: true });
      });
    return () => {
      live = false;
    };
  }, [versionId, cache, enabled]);
  return state;
}

/**
 * True once the element has come within NEAR_VIEWPORT_MARGIN of the viewport
 * (and stays true). Without IntersectionObserver it is true at once.
 */
export function useNearViewport(ref: RefObject<Element>): boolean {
  const [near, setNear] = useState(false);
  useEffect(() => {
    if (near) return;
    const el = ref.current;
    if (el === null || typeof IntersectionObserver === 'undefined') {
      setNear(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setNear(true);
          observer.disconnect();
        }
      },
      { rootMargin: NEAR_VIEWPORT_MARGIN },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, near]);
  return near;
}

/** The thumbnail meta recorded for a version this session (page count, size), or null. */
export function storedThumbnailMeta(versionId: string, mime: string): ThumbnailMeta | null {
  if (versionId === '') return null;
  return thumbnailMetaOf({ assetId: versionId, name: '', mime });
}

/** The tile's meta line: kind, page count (PDF, when known) and size (when known). Pure. */
export function fileTileMeta(
  mime: string,
  pageCount: number | undefined,
  size: number | null | undefined,
): Array<{ text: string; mono: boolean }> {
  const parts: Array<{ text: string; mono: boolean }> = [
    { text: fileKindLabel(mime), mono: false },
  ];
  if (pageCount !== undefined && pageCount > 0) {
    parts.push({ text: pageCount === 1 ? '1 page' : `${pageCount} pages`, mono: true });
  }
  if (size !== null && size !== undefined && size > 0) {
    parts.push({ text: humanizeSize(size), mono: true });
  }
  return parts;
}

export interface FileTileBodyProps {
  kind: FileKind;
  /** The stored thumbnail, once there is one; null shows the icon card. */
  thumbUrl: string | null;
  /** The full name; shown cut in the middle with its extension kept. */
  name: string;
  meta: Array<{ text: string; mono: boolean }>;
  onImageError?: (() => void) | undefined;
  /**
   * 'fill' (default): the tile fills a box its parent sizes (gallery tiles).
   * 'card': the thumbnail area is a fixed 4/3 box and the name always holds
   * two lines (Assets grid), so the card's height never changes.
   */
  layout?: 'fill' | 'card' | undefined;
}

/** The tile's content, hook-free so tests render every state directly. */
export function FileTileBody(props: FileTileBodyProps): ReactElement {
  const { kind, thumbUrl } = props;
  const card = props.layout === 'card';
  return (
    <span
      data-file-tile={kind}
      className={cn('flex w-full flex-col bg-panel text-left', !card && 'h-full')}
    >
      <span
        className={cn(
          'relative block w-full overflow-hidden bg-panel-3',
          card ? 'aspect-[4/3]' : 'min-h-0 flex-1',
        )}
      >
        {thumbUrl !== null ? (
          <img
            data-file-tile-thumb=""
            src={thumbUrl}
            alt=""
            draggable={false}
            onError={props.onImageError}
            className={cn(
              'absolute inset-0 h-full w-full',
              kind === 'video' ? 'object-cover' : 'object-cover object-top',
            )}
          />
        ) : (
          <span
            data-file-tile-icon=""
            className="absolute inset-0 flex items-center justify-center text-fg-3"
          >
            <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-panel-2">
              <KindIcon kind={kind} size={20} />
            </span>
          </span>
        )}
        {kind === 'video' && thumbUrl !== null ? (
          <span className="absolute inset-0 flex items-center justify-center">
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-overlay text-overlay-fg">
              <IconPlay size={16} />
            </span>
          </span>
        ) : null}
      </span>
      <span
        className={cn(
          'flex w-full shrink-0 flex-col border-t border-border',
          // The Assets card: the same 10px footer as a picture card, the meta
          // line one 20px row with room on the right for the card's ⋯.
          card ? 'gap-1.5 p-2.5' : 'gap-0.5 px-2 py-1.5',
        )}
      >
        <span
          data-file-name=""
          title={props.name}
          className={cn(
            'line-clamp-2 text-xs font-medium leading-4 text-fg [overflow-wrap:anywhere]',
            card && 'h-8',
          )}
        >
          {middleTruncate(props.name, VIEWER_NAME_BUDGET)}
        </span>
        <span
          data-file-meta=""
          className={cn(
            'truncate text-[11px] leading-4 text-fg-3',
            card && 'flex h-5 items-center pr-8',
          )}
        >
          {props.meta.map((part, i) => (
            <span key={i}>
              {i > 0 ? ' · ' : null}
              <span className={part.mono ? 'font-mono' : undefined}>{part.text}</span>
            </span>
          ))}
        </span>
      </span>
    </span>
  );
}

export interface FileTileProps {
  kind: FileKind;
  /** The server-detected mime: the kind label and whether a thumbnail exists. */
  mime: string;
  name: string;
  /** The stored version; null or '' shows the icon card. */
  versionId: string | null;
  size?: number | null | undefined;
  /** The stored page count (PDF); null or absent falls back to this session's upload meta. */
  pageCount?: number | null | undefined;
  cache: PresignCache;
  presignEnabled: boolean;
  layout?: 'fill' | 'card' | undefined;
}

/**
 * The tile: a PDF or video asks for its stored thumbnail once near the
 * viewport; Office and other files, a failed or absent thumbnail, and an
 * unconfigured presign all show the icon card.
 */
export function FileTile(props: FileTileProps): ReactElement {
  const { kind, mime, cache, presignEnabled } = props;
  const versionId = props.versionId ?? '';
  const ref = useRef<HTMLSpanElement>(null);
  const near = useNearViewport(ref);
  const wantsThumb = presignEnabled && versionId !== '' && thumbnailKind(mime) !== null;
  const stored = useStoredThumbnail(versionId, cache, wantsThumb && near);
  // A thumbnail already cached paints on first render, before the tile is
  // known to be near (a peek is no request).
  const cached = wantsThumb ? (cache.peekThumbnail(versionId)?.url ?? null) : null;
  // A broken image hides only that version's thumbnail, never a newer one's.
  const [failedVersion, setFailedVersion] = useState<string | null>(null);
  const imageFailed = failedVersion === versionId;
  const meta = storedThumbnailMeta(versionId, mime);
  return (
    <span ref={ref} className={cn('block w-full', props.layout !== 'card' && 'h-full')}>
      <FileTileBody
        layout={props.layout}
        kind={kind}
        thumbUrl={wantsThumb && !imageFailed ? (stored.url ?? cached) : null}
        name={props.name}
        meta={fileTileMeta(mime, props.pageCount ?? meta?.pageCount, props.size)}
        onImageError={() => setFailedVersion(versionId)}
      />
    </span>
  );
}
