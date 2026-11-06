import { useState } from 'react';
import { cn } from '@/lib/cn';
import { ActionMenu, type ActionMenuItem, ActionMenuTrigger } from '@/components/ui/ActionMenu';
import { useMenuGesture } from '@/components/ui/useLongPress';
import { Thumbnail, type ThumbnailFallback } from '@/components/media';
import { ICON_SIZE, IconCheck } from '@/components/ui/icons';
import { IconButton } from '@/components/ui/IconButton';
import { Tile } from '@/components/ui/Tile';
import type { PresignCache } from '@/lib/asset-presign';
import { FileTile, fileTileMeta, storedThumbnailMeta } from '@/components/ui/FileTile';
import { classifyFileKind } from '@/lib/chat/attachments';
import { VIEWER_NAME_BUDGET, middleTruncate } from '@/lib/files/display-name';
import {
  displayLabel,
  fileExtension,
  humanizeSize,
  linkDomain,
  mimeBadge,
  type AssetListItem,
} from '@/lib/assets';

interface AssetCardProps {
  item: AssetListItem;
  /** Whether presigning is configured; when false, image tiles show a fallback. */
  presignEnabled: boolean;
  cache: PresignCache;
  /** Tap: open the lightbox (files) or the external link (links). */
  onOpen: () => void;
  /** The rows of this card's ⋯ menu (ui/ActionMenu), opened by the ⋯, a long press or a right-click. */
  menuItems?: readonly ActionMenuItem[];
  /** When true, a tap toggles selection instead of opening, and a tick is shown. */
  selectMode?: boolean;
  /** Whether this card is currently selected (only meaningful in select mode). */
  selected?: boolean;
  /** Toggle this card's selection (select mode only). */
  onToggleSelect?: () => void;
  /**
   * Tap the round box at the card's top left (outside select mode): start
   * selecting with this card already ticked. When undefined the box is hidden.
   */
  onStartSelect?: (() => void) | undefined;
}

/** The non-image tile for a card: a link domain, or a file extension glyph. */
function assetFallback(item: AssetListItem): ThumbnailFallback {
  if (item.kind === 'link') return { kind: 'link', label: linkDomain(item.externalUrl) };
  return { kind: 'file', extension: fileExtension(item.filename) };
}

/** An empty select box over media: overlay ink edge on the media badge fill, lit as media. */
export const SELECT_BOX_EMPTY = 'border-[1.5px] border-overlay-fg bg-overlay-badge lit-media';

export function AssetCard({
  item,
  presignEnabled,
  cache,
  onOpen,
  menuItems = [],
  selectMode = false,
  selected = false,
  onToggleSelect,
  onStartSelect,
}: AssetCardProps) {
  const name = displayLabel(item);
  // The ⋯ menu's open state: the ⋯ toggles it; a long press (touch) or a
  // right-click (laptop) opens it (useMenuGesture, LONG_PRESS_MS).
  const [menuOpen, setMenuOpen] = useState(false);
  // Called unconditionally to satisfy the rules of hooks; its handlers are only
  // spread onto the button when select mode is off.
  const gesture = useMenuGesture(() => setMenuOpen(true));

  // In select mode the card is a plain toggle: a tap selects/deselects and the
  // menu gesture + lightbox/link wiring is bypassed (you pick files, not open them).
  const interaction = selectMode
    ? { onClick: onToggleSelect, 'aria-pressed': selected, 'aria-label': `Select ${name}` }
    : {
        ...gesture.handlers,
        // A tap opens; the click that trails a long-press does not.
        onClick: () => {
          if (gesture.consumeClickSuppression()) return;
          onOpen();
        },
        'aria-label': item.kind === 'link' ? `Open ${name}` : `View ${name}`,
      };

  const isFile = item.kind !== 'image' && item.kind !== 'link';
  const fileMime = item.mimeType ?? '';
  // The caption below the picture: the name, then one meta line (a file's
  // kind, pages and size; a picture's type and size; a link's domain).
  const meta = isFile
    ? fileTileMeta(
        fileMime,
        item.pageCount ?? storedThumbnailMeta(item.currentVersionId ?? '', fileMime)?.pageCount,
        item.sizeBytes,
      )
        .map((part) => part.text)
        .join(' · ')
    : item.kind === 'link'
      ? linkDomain(item.externalUrl)
      : item.sizeBytes !== null && item.sizeBytes > 0
        ? `${mimeBadge(item.mimeType)} · ${humanizeSize(item.sizeBytes)}`
        : mimeBadge(item.mimeType);

  return (
    <Tile
      aspect="landscape"
      thumbnail={
        isFile ? (
          // PDF, video, Office and other files: the stored thumbnail (PDF and
          // video) or the icon card.
          <FileTile
            layout="thumb"
            kind={classifyFileKind(fileMime)}
            mime={fileMime}
            name={name}
            versionId={item.currentVersionId}
            size={item.sizeBytes}
            pageCount={item.pageCount}
            cache={cache}
            presignEnabled={presignEnabled}
          />
        ) : (
          <Thumbnail
            assetVersionId={item.kind === 'image' ? item.currentVersionId : null}
            cache={cache}
            presignEnabled={presignEnabled}
            aspect="4/3"
            fallback={assetFallback(item)}
            alt={name}
          />
        )
      }
      title={
        <span data-asset-name="" title={name}>
          {isFile ? middleTruncate(name, VIEWER_NAME_BUDGET) : name}
        </span>
      }
      meta={<span data-asset-meta="">{meta}</span>}
      {...(selectMode
        ? {
            corners: {
              tl: (
                <span
                  aria-hidden="true"
                  data-card-tick=""
                  className="flex h-11 w-11 items-center justify-center"
                >
                  <span
                    className={cn(
                      'flex h-4 w-4 items-center justify-center rounded',
                      selected ? 'bg-accent text-accent-fg' : SELECT_BOX_EMPTY,
                    )}
                  >
                    {selected ? <IconCheck size={ICON_SIZE.text} /> : null}
                  </span>
                </span>
              ),
            },
          }
        : {})}
      {...(selectMode || onStartSelect === undefined
        ? {}
        : { cornerActions: { tl: <CardSelectBox name={name} onPress={onStartSelect} /> } })}
      more={
        selectMode ? null : (
          // The ⋯ on the name line, a sibling of the tile's tap surface
          // (buttons never nest); its trigger takes the trailing rule, so the
          // dots end on the tile's edge. The laptop popover anchors under it.
          <ActionMenu
            title={name}
            items={menuItems}
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
        )
      }
      press={{
        ...interaction,
        selected: selectMode && selected,
        style: { touchAction: 'manipulation' },
      }}
    />
  );
}

/**
 * The round select box on a card: a 44px hit area in the top-left corner
 * holding an empty 16px square, a ui/Tile corner action (outside the tile's
 * tap surface: buttons never nest). One tap starts selecting with this card ticked. The square sits in the
 * same spot as the select-mode tick, so the tap lands where the tick appears.
 */
export function CardSelectBox({ name, onPress }: { name: string; onPress: () => void }) {
  return (
    <IconButton type="button" label={`Select ${name}`} data-card-select="" onClick={onPress}>
      <span className={cn('h-4 w-4 rounded', SELECT_BOX_EMPTY)} />
    </IconButton>
  );
}
