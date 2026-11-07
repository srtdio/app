import { mark } from '@/lib/perf-marks';
import {
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type ReactElement,
  type RefObject,
} from 'react';
import { Thumbnail } from '@/components/media';
import {
  ICON_SIZE,
  IconFile,
  IconImage,
  IconLink,
  IconPlay,
  IconVideo,
  type IconProps,
} from '@/components/ui/icons';
import {
  LIST_CARD_GRID,
  ListCard,
  type ListCardPicture,
  type ListCardSelect,
} from '@/components/ui/ListCard';
import { useMinuteClock } from '@/components/ui/use-minute-clock';
import {
  FileTile,
  fileTileMeta,
  storedThumbnailMeta,
  useNearViewport,
  useStoredThumbnail,
} from '@/components/ui/FileTile';
import { GlideItem } from '@/lib/motion';
import type { PresignCache } from '@/lib/asset-presign';
import { classifyFileKind } from '@/lib/chat/attachments';
import { formatDurationMs } from '@/lib/chat/media-items';
import { thumbnailKind } from '@/lib/files/thumbnail';
import { VIEWER_NAME_BUDGET, middleTruncate } from '@/lib/files/display-name';
import { formatAdded } from '@/lib/time';
import {
  displayLabel,
  fileExtension,
  humanizeSize,
  linkDomain,
  mimeBadge,
  type AssetKind,
  type AssetListItem,
} from '@/lib/assets';

/** Cards drawn first, and added each time the reader nears the end. */
export const ASSET_LIST_PAGE = 60;
/** How far below the last drawn card the next page starts drawing. */
const MORE_MARGIN = '800px';

/**
 * The preview (line 2): the type and size facts, built only from the fields the item already
 * holds (no read). A picture: "PNG · 2400 x 2400 · 2.4 MB"; a video: "MP4 · 0:15
 * · 18 MB"; a file: its kind, pages and size ("PDF · 12 pages · 6.1 MB"); a
 * link: its domain. A fact the item lacks is left out. Pure.
 */
export function assetFacts(item: AssetListItem): string {
  if (item.kind === 'link') return linkDomain(item.externalUrl);
  const size = item.sizeBytes !== null && item.sizeBytes > 0 ? humanizeSize(item.sizeBytes) : null;
  if (item.kind === 'image') {
    const dims =
      item.width !== null && item.height !== null && item.width > 0 && item.height > 0
        ? `${item.width} x ${item.height}`
        : null;
    return [mimeBadge(item.mimeType), dims, size].filter((part) => part !== null).join(' · ');
  }
  if (item.kind === 'video') {
    const length =
      item.durationMs !== null && item.durationMs > 0 ? formatDurationMs(item.durationMs) : null;
    return [mimeBadge(item.mimeType), length, size].filter((part) => part !== null).join(' · ');
  }
  const mime = item.mimeType ?? '';
  return fileTileMeta(
    mime,
    item.pageCount ?? storedThumbnailMeta(item.currentVersionId ?? '', mime)?.pageCount,
    item.sizeBytes,
  )
    .map((part) => part.text)
    .join(' · ');
}

/** Line 2's tag per stored kind (decision D): what the file is, not which chip holds it. */
const KIND_TAG: Record<AssetKind, string> = {
  image: 'Image',
  video: 'Video',
  audio: 'Audio',
  pdf: 'PDF',
  document: 'Doc',
  presentation: 'Doc',
  spreadsheet: 'Sheet',
  link: 'Link',
};

/**
 * Line 2's one grey tag: PDF, Doc, Sheet, Image or Video (Audio, Link), from
 * the stored kind, else from the MIME type; none when neither says. Pure.
 */
export function assetTypeTag(item: Pick<AssetListItem, 'kind' | 'mimeType'>): string | undefined {
  if (item.kind !== null) return KIND_TAG[item.kind];
  const mime = (item.mimeType ?? '').toLowerCase();
  if (mime.startsWith('image/')) return 'Image';
  if (mime.startsWith('video/')) return 'Video';
  if (mime.startsWith('audio/')) return 'Audio';
  if (mime === 'application/pdf') return 'PDF';
  if (mime.includes('spreadsheet') || mime.includes('excel') || mime === 'text/csv') return 'Sheet';
  if (mime.includes('word') || mime.includes('document') || mime.includes('presentation')) {
    return 'Doc';
  }
  return undefined;
}

/**
 * A video's 48 picture: its stored frame (asked once near the viewport, the
 * same shared thumbnail read the file tiles use), else the video glyph, with
 * the media play badge and its length (when stored) at the bottom left, as in
 * the chat media grid. Paints the cached frame on first render.
 */
function AssetVideoThumb({
  item,
  cache,
  presignEnabled,
}: {
  item: AssetListItem;
  cache: PresignCache;
  presignEnabled: boolean;
}): ReactElement {
  const versionId = item.currentVersionId ?? '';
  const mime = item.mimeType ?? '';
  const ref = useRef<HTMLSpanElement>(null);
  const near = useNearViewport(ref);
  const wantsThumb = presignEnabled && versionId !== '' && thumbnailKind(mime) !== null;
  const stored = useStoredThumbnail(versionId, cache, wantsThumb && near);
  const cached = wantsThumb ? (cache.peekThumbnail(versionId)?.url ?? null) : null;
  const [failedVersion, setFailedVersion] = useState<string | null>(null);
  const url = wantsThumb && failedVersion !== versionId ? (stored.url ?? cached) : null;
  const length =
    item.durationMs !== null && item.durationMs > 0 ? formatDurationMs(item.durationMs) : null;
  return (
    <span
      ref={ref}
      data-asset-video-thumb=""
      className="relative block h-full w-full overflow-hidden bg-panel-2 text-fg-2"
    >
      {url !== null ? (
        <img
          src={url}
          alt=""
          draggable={false}
          onError={() => setFailedVersion(versionId)}
          className="absolute inset-0 h-full w-full object-cover"
        />
      ) : (
        <span aria-hidden="true" className="absolute inset-0 flex items-center justify-center">
          <IconVideo size={ICON_SIZE.picture} />
        </span>
      )}
      <span
        data-asset-play-badge=""
        aria-hidden="true"
        className="pointer-events-none absolute bottom-0.5 left-0.5 inline-flex max-w-full items-center gap-0.5 rounded-full bg-overlay px-1 text-xs text-overlay-fg lit-media"
      >
        <IconPlay size={ICON_SIZE.text} />
        {length !== null ? (
          <span data-asset-duration="" className="font-mono tabular-nums">
            {length}
          </span>
        ) : null}
      </span>
    </span>
  );
}

/** The file-type glyph for the icon picture (one icon per concept). */
function assetIcon(item: AssetListItem): ComponentType<IconProps> {
  if (item.kind === 'link') return IconLink;
  if (item.kind === 'image') return IconImage;
  return IconFile;
}

/**
 * The picture slot: a picture's thumbnail; a video its frame with the play
 * badge and length (AssetVideoThumb); a file with a stored preview (PDF,
 * Word, Excel) its stored thumbnail, asked once near the viewport as before;
 * else the file-type icon in the icon box. A link has no picture of its own on
 * the item, so it shows the link icon.
 */
function assetPicture(
  item: AssetListItem,
  name: string,
  cache: PresignCache,
  presignEnabled: boolean,
): ListCardPicture {
  const icon = assetIcon(item);
  if (item.kind === 'link') return { kind: 'icon', icon };
  if (item.kind === 'image') {
    return {
      kind: 'image',
      node: (
        <Thumbnail
          assetVersionId={item.currentVersionId}
          cache={cache}
          presignEnabled={presignEnabled}
          aspect="square"
          fallback={{ kind: 'file', extension: fileExtension(item.filename) }}
          fallbackTile={
            <span className="flex h-full w-full items-center justify-center bg-panel-2 text-fg-2">
              <IconImage size={ICON_SIZE.picture} />
            </span>
          }
          alt={name}
        />
      ),
    };
  }
  if (item.kind === 'video') {
    return {
      kind: 'image',
      node: <AssetVideoThumb item={item} cache={cache} presignEnabled={presignEnabled} />,
    };
  }
  const mime = item.mimeType ?? '';
  if (presignEnabled && item.currentVersionId !== null && thumbnailKind(mime) !== null) {
    return {
      kind: 'image',
      node: (
        <FileTile
          layout="thumb"
          kind={classifyFileKind(mime)}
          mime={mime}
          name={name}
          versionId={item.currentVersionId}
          size={item.sizeBytes}
          pageCount={item.pageCount}
          cache={cache}
          presignEnabled={presignEnabled}
        />
      ),
    };
  }
  return { kind: 'icon', icon };
}

interface AssetListCardProps {
  item: AssetListItem;
  /** Whether presigning is configured; when false, pictures show the icon. */
  presignEnabled: boolean;
  cache: PresignCache;
  /** The list's clock: the time reads when it was added, "10:27 AM" today else "2 Nov" (formatAdded). */
  now: Date;
  /** Tap: open the lightbox (files) or the external link (links). */
  onOpen: () => void;
  /**
   * Select mode (useListSelection().selectFor): a long-press or right-click
   * enters it with this card ticked; while it is on a tap toggles. Absent: the
   * card only opens.
   */
  select?: ListCardSelect | undefined;
}

/**
 * One Assets item on ui/ListCard: the picture; line 1 the file name and when
 * it was added (formatAdded); line 2 the type and size facts and its type
 * (PDF, Doc, Sheet, Image, Video) as the one grey tag. A tap opens it (the lightbox, or the link in a new tab).
 * No ⋮: a long-press or right-click selects it (ListCard `select`) and the
 * old menu rows live on the page's SelectBar.
 */
export function AssetListCard({
  item,
  presignEnabled,
  cache,
  now,
  onOpen,
  select,
}: AssetListCardProps) {
  const name = displayLabel(item);
  const isFile = item.kind !== 'image' && item.kind !== 'link';

  return (
    <ListCard
      surface={{ 'data-asset-card': item.id }}
      select={select}
      picture={assetPicture(item, name, cache, presignEnabled)}
      pictureHooks={{ 'data-asset-picture': '' }}
      title={
        <span data-asset-name="" title={name}>
          {isFile ? middleTruncate(name, VIEWER_NAME_BUDGET) : name}
        </span>
      }
      preview={assetFacts(item)}
      previewHooks={{ 'data-asset-meta': '' }}
      time={formatAdded(item.uploadedAt, now)}
      timeHooks={{ 'data-asset-uploaded': '' }}
      tag={assetTypeTag(item)}
      tagHooks={{ 'data-asset-tag': '' }}
      // In select mode ListCard takes the tap (it toggles), so this only opens.
      onPress={onOpen}
      press={{
        'aria-label': item.kind === 'link' ? `Open ${name}` : `View ${name}`,
        style: { touchAction: 'manipulation' },
      }}
    />
  );
}

interface AssetListProps {
  items: AssetListItem[];
  presignEnabled: boolean;
  cache: PresignCache;
  onOpen: (item: AssetListItem) => void;
  /** Each card's select mode (useListSelection().selectFor); absent: no select mode. */
  selectFor?: ((item: AssetListItem) => ListCardSelect) | undefined;
}

/**
 * How many cards to draw: the first page at once, then a page more each time
 * the end comes within MORE_MARGIN of the screen. A workspace with 1,500 files
 * draws a screenful straight away instead of 1,500 cards before anything shows.
 * Without IntersectionObserver every card is drawn.
 */
function useGrowingCount(total: number): {
  count: number;
  sentinelRef: RefObject<HTMLDivElement>;
} {
  const [count, setCount] = useState(ASSET_LIST_PAGE);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const more = count < total;
  useEffect(() => {
    if (!more) return;
    const el = sentinelRef.current;
    if (el === null || typeof IntersectionObserver === 'undefined') {
      setCount(total);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          mark('grid:grow');
          setCount((now) => now + ASSET_LIST_PAGE);
        }
      },
      { rootMargin: MORE_MARGIN },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [more, total, count]);
  return { count, sentinelRef };
}

/**
 * The Assets list: ListCards in LIST_CARD_GRID (one column on phone, 360+
 * auto-fill columns on laptop). One minute clock for the whole list ages every
 * card's "added" time together; no timer per card.
 */
export function AssetList({ items, presignEnabled, cache, onOpen, selectFor }: AssetListProps) {
  const { count, sentinelRef } = useGrowingCount(items.length);
  const nowMs = useMinuteClock();
  const now = new Date(nowMs);
  const shown = count >= items.length ? items : items.slice(0, count);
  return (
    <>
      <div data-asset-list="" className={LIST_CARD_GRID}>
        {/* List reflow (a delete, a new file, a column change) glides on X and Y. */}
        {shown.map((item) => (
          <GlideItem key={item.id} axis="xy" className="min-w-0">
            <AssetListCard
              item={item}
              presignEnabled={presignEnabled}
              cache={cache}
              now={now}
              onOpen={() => onOpen(item)}
              select={selectFor?.(item)}
            />
          </GlideItem>
        ))}
      </div>
      {shown.length < items.length ? (
        <div ref={sentinelRef} aria-hidden="true" data-asset-list-more="" className="h-px" />
      ) : null}
    </>
  );
}
