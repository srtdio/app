import { mark } from '@/lib/perf-marks';
import {
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type ReactElement,
  type RefObject,
} from 'react';
import { cn } from '@/lib/cn';
import { ActionMenu, type ActionMenuItem, ActionMenuTrigger } from '@/components/ui/ActionMenu';
import { useMenuGesture } from '@/components/ui/useLongPress';
import { Thumbnail } from '@/components/media';
import {
  ICON_SIZE,
  IconCheck,
  IconCheckCircle,
  IconFile,
  IconImage,
  IconLink,
  IconVideo,
  type IconProps,
} from '@/components/ui/icons';
import { LIST_CARD_GRID, ListCard, type ListCardPicture } from '@/components/ui/ListCard';
import { useMinuteClock } from '@/components/ui/use-minute-clock';
import { FileTile, fileTileMeta, storedThumbnailMeta } from '@/components/ui/FileTile';
import { GlideItem } from '@/lib/motion';
import type { PresignCache } from '@/lib/asset-presign';
import { classifyFileKind } from '@/lib/chat/attachments';
import { formatDurationMs } from '@/lib/chat/media-items';
import { thumbnailKind } from '@/lib/files/thumbnail';
import { VIEWER_NAME_BUDGET, middleTruncate } from '@/lib/files/display-name';
import { formatRelative } from '@/lib/time';
import {
  KIND_TAB,
  TAB_LABELS,
  displayLabel,
  fileExtension,
  humanizeSize,
  linkDomain,
  mimeBadge,
  type AssetListItem,
} from '@/lib/assets';

/** Cards drawn first, and added each time the reader nears the end. */
export const ASSET_LIST_PAGE = 60;
/** How far below the last drawn card the next page starts drawing. */
const MORE_MARGIN = '800px';

/**
 * Line 2: the type and size facts, built only from the fields the item already
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

/** Line 3's one grey tag: the item's tab label (Media, PDF, Docs, Sheets, Links); none when unknown. */
export function assetTabTag(item: Pick<AssetListItem, 'kind'>): string | undefined {
  return item.kind === null ? undefined : TAB_LABELS[KIND_TAB[item.kind]];
}

/** The file-type glyph for the icon picture (one icon per concept). */
function assetIcon(item: AssetListItem): ComponentType<IconProps> {
  if (item.kind === 'link') return IconLink;
  if (item.kind === 'image') return IconImage;
  if (item.kind === 'video') return IconVideo;
  return IconFile;
}

/**
 * The picture slot: a picture's thumbnail; a file with a stored preview (PDF,
 * video, Word, Excel) its stored thumbnail, asked once near the viewport as
 * before; else the file-type icon in the icon box. A link has no picture of its
 * own on the item, so it shows the link icon.
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
          size="list"
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

/**
 * The 20 tick box in the ListCard `check` slot while selecting (where the ⋮
 * sits). Decorative: the card's own button carries aria-pressed and the toggle
 * (as the chat list's select check).
 */
export function AssetSelectTick({ selected }: { selected: boolean }): ReactElement {
  return (
    <span
      aria-hidden="true"
      data-card-tick={selected ? 'on' : 'off'}
      className={cn(
        'flex h-5 w-5 items-center justify-center rounded-sm border',
        selected ? 'border-transparent bg-accent text-accent-fg' : 'border-border-strong bg-panel',
      )}
    >
      {selected ? <IconCheck size={ICON_SIZE.inline} /> : null}
    </span>
  );
}

/**
 * The card's ⋮ rows: the page's rows plus Select (start selecting with this
 * card ticked), which sits with the other rows before Delete (always last).
 * Without onStartSelect the rows are the page's as they are. Pure.
 */
export function assetCardRows(
  menuItems: readonly ActionMenuItem[],
  onStartSelect: (() => void) | undefined,
): readonly ActionMenuItem[] {
  if (onStartSelect === undefined) return menuItems;
  const select: ActionMenuItem = {
    id: 'select',
    label: 'Select',
    icon: IconCheckCircle,
    onSelect: onStartSelect,
  };
  const last = menuItems[menuItems.length - 1];
  return last?.tone === 'danger'
    ? [...menuItems.slice(0, -1), select, last]
    : [...menuItems, select];
}

interface AssetListCardProps {
  item: AssetListItem;
  /** Whether presigning is configured; when false, pictures show the icon. */
  presignEnabled: boolean;
  cache: PresignCache;
  /** The list's one minute clock: line 3 reads "3 hours ago" against it. */
  now: Date;
  /** Tap: open the lightbox (files) or the external link (links). */
  onOpen: () => void;
  /** The rows of this card's ⋮ menu (ui/ActionMenu), opened by the ⋮, a long press or a right-click. */
  menuItems?: readonly ActionMenuItem[];
  /** When true, a tap toggles selection instead of opening, and the tick shows. */
  selectMode?: boolean;
  /** Whether this card is currently selected (only meaningful in select mode). */
  selected?: boolean;
  /** Toggle this card's selection (select mode only). */
  onToggleSelect?: () => void;
  /**
   * The ⋮ menu's Select row (outside select mode): start selecting with this
   * card already ticked. When undefined the row is left out.
   */
  onStartSelect?: (() => void) | undefined;
}

/**
 * One Assets item on ui/ListCard: the picture, the name, the type and size
 * facts, then when it was added and its tab as the one grey tag, with the ⋮.
 * A tap opens it (the lightbox, or the link in a new tab); a long press or a
 * right-click opens the same ⋮ menu. In select mode a tap toggles it and the
 * tick takes the ⋮'s place, so the card never changes size.
 */
export function AssetListCard({
  item,
  presignEnabled,
  cache,
  now,
  onOpen,
  menuItems = [],
  selectMode = false,
  selected = false,
  onToggleSelect,
  onStartSelect,
}: AssetListCardProps) {
  const name = displayLabel(item);
  // The ⋮ menu's open state: the ⋮ toggles it; a long press (touch) or a
  // right-click (laptop) opens it (useMenuGesture, LONG_PRESS_MS).
  const [menuOpen, setMenuOpen] = useState(false);
  // Called unconditionally to satisfy the rules of hooks; its handlers are only
  // spread onto the card when select mode is off.
  const gesture = useMenuGesture(() => setMenuOpen(true));
  const isFile = item.kind !== 'image' && item.kind !== 'link';

  const rows = assetCardRows(menuItems, onStartSelect);

  return (
    <ListCard
      surface={{ 'data-asset-card': item.id }}
      selected={selectMode && selected}
      picture={assetPicture(item, name, cache, presignEnabled)}
      pictureHooks={{ 'data-asset-picture': '' }}
      title={
        <span data-asset-name="" title={name}>
          {isFile ? middleTruncate(name, VIEWER_NAME_BUDGET) : name}
        </span>
      }
      preview={assetFacts(item)}
      previewHooks={{ 'data-asset-meta': '' }}
      time={formatRelative(item.uploadedAt, now)}
      timeHooks={{ 'data-asset-uploaded': '' }}
      tag={assetTabTag(item)}
      tagHooks={{ 'data-asset-tag': '' }}
      // In select mode the card is a plain toggle: a tap selects/deselects and
      // the menu gesture + lightbox/link wiring is bypassed (you pick files,
      // not open them).
      onPress={
        selectMode
          ? () => onToggleSelect?.()
          : () => {
              // A tap opens; the click that trails a long-press does not.
              if (gesture.consumeClickSuppression()) return;
              onOpen();
            }
      }
      press={
        selectMode
          ? {
              'aria-pressed': selected,
              'aria-label': `Select ${name}`,
              style: { touchAction: 'manipulation' },
            }
          : {
              ...gesture.handlers,
              'aria-label': item.kind === 'link' ? `Open ${name}` : `View ${name}`,
              style: { touchAction: 'manipulation' },
            }
      }
      {...(selectMode
        ? {
            check: <AssetSelectTick selected={selected} />,
          }
        : {
            // The ⋮ on line 3, a sibling of the card's tap surface (buttons
            // never nest); its trigger takes the trailing rule. The laptop
            // popover anchors under it.
            menu: (
              <ActionMenu
                title={name}
                items={rows}
                open={menuOpen}
                onOpenChange={setMenuOpen}
                trigger={
                  <ActionMenuTrigger
                    type="button"
                    label={`More actions for ${name}`}
                    aria-expanded={menuOpen}
                    data-card-menu=""
                  />
                }
              />
            ),
          })}
    />
  );
}

interface AssetListProps {
  items: AssetListItem[];
  presignEnabled: boolean;
  cache: PresignCache;
  onOpen: (item: AssetListItem) => void;
  /** The rows of an item's ⋮ menu (its ⋮ or a long press opens it). */
  menuItemsFor?: (item: AssetListItem) => readonly ActionMenuItem[];
  /** When true, cards become selection toggles instead of openers. */
  selectMode?: boolean;
  /** The currently selected asset ids (select mode only). */
  selectedIds?: ReadonlySet<string>;
  /** Toggle one item's selection (select mode only). */
  onToggleSelect?: (item: AssetListItem) => void;
  /** A card's ⋮ Select row: start selecting with that item ticked. */
  onStartSelect?: ((item: AssetListItem) => void) | undefined;
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
export function AssetList({
  items,
  presignEnabled,
  cache,
  onOpen,
  menuItemsFor,
  selectMode = false,
  selectedIds,
  onToggleSelect,
  onStartSelect,
}: AssetListProps) {
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
              menuItems={menuItemsFor?.(item) ?? []}
              selectMode={selectMode}
              selected={selectedIds?.has(item.id) ?? false}
              onToggleSelect={() => onToggleSelect?.(item)}
              onStartSelect={onStartSelect === undefined ? undefined : () => onStartSelect(item)}
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
