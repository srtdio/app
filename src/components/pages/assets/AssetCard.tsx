import { cn } from '@/lib/cn';
import { useLongPress } from '@/components/pages/assets/useLongPress';
import { Thumbnail, type ThumbnailFallback } from '@/components/media';
import { ICON_SIZE, IconCheck, IconMore } from '@/components/ui/icons';
import { IconButton } from '@/components/ui/IconButton';
import { PressableRow } from '@/components/ui/PressableRow';
import type { PresignCache } from '@/lib/asset-presign';
import { FileTile } from '@/components/ui/FileTile';
import { classifyFileKind } from '@/lib/chat/attachments';
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
  /** Long-press or the visible ⋯ button: open the bottom action sheet. */
  onLongPress: () => void;
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

export function AssetCard({
  item,
  presignEnabled,
  cache,
  onOpen,
  onLongPress,
  selectMode = false,
  selected = false,
  onToggleSelect,
  onStartSelect,
}: AssetCardProps) {
  const name = displayLabel(item);
  // Called unconditionally to satisfy the rules of hooks; its handlers are only
  // spread onto the button when select mode is off.
  const longPress = useLongPress(onLongPress, onOpen);

  // In select mode the card is a plain toggle: a tap selects/deselects and the
  // long-press + lightbox/link wiring is bypassed (you pick files, not open them).
  const interaction = selectMode
    ? { onClick: onToggleSelect, 'aria-pressed': selected, 'aria-label': `Select ${name}` }
    : { ...longPress, 'aria-label': item.kind === 'link' ? `Open ${name}` : `View ${name}` };

  return (
    <div className="relative">
      <PressableRow
        type="button"
        {...interaction}
        style={{ touchAction: 'manipulation' }}
        className={cn(
          'group relative flex h-full flex-col overflow-hidden border bg-panel transition-colors',
          selectMode && selected ? 'border-accent' : 'border-border',
          'hover:border-border-strong',
        )}
      >
        {selectMode ? (
          <span
            aria-hidden="true"
            className={cn(
              'absolute left-3.5 top-3.5 z-10 flex h-4 w-4 items-center justify-center rounded',
              selected
                ? 'bg-accent text-white'
                : 'border-[1.5px] border-white bg-black/15 shadow-[0_0_0_1px_rgba(0,0,0,0.3)]',
            )}
          >
            {selected ? <IconCheck size={12} /> : null}
          </span>
        ) : null}

        {item.kind !== 'image' && item.kind !== 'link' ? (
          // PDF, video, Office and other files: the stored thumbnail (PDF and
          // video) or the icon card, the name on two lines and kind, pages, size.
          <FileTile
            layout="card"
            kind={classifyFileKind(item.mimeType ?? '')}
            mime={item.mimeType ?? ''}
            name={name}
            versionId={item.currentVersionId}
            size={item.sizeBytes}
            pageCount={item.pageCount}
            cache={cache}
            presignEnabled={presignEnabled}
          />
        ) : (
          <AssetMedia item={item} name={name} cache={cache} presignEnabled={presignEnabled} />
        )}
      </PressableRow>
      {selectMode ? null : <CardMenuButton name={name} onPress={onLongPress} />}
      {selectMode || onStartSelect === undefined ? null : (
        <CardSelectBox name={name} onPress={onStartSelect} />
      )}
    </div>
  );
}

/**
 * The visible ⋯ on a card: a 44px hit area in the card's bottom-right corner,
 * on the size line, a sibling of the card button (buttons never nest). The bare
 * dots line up with the right edge of the kind label above and sit centred on
 * the size line; the hit area reaches 2px past the card edge so the card's own
 * spacing stays even. Opens the same menu as a long-press.
 */
export function CardMenuButton({ name, onPress }: { name: string; onPress: () => void }) {
  return (
    <IconButton
      type="button"
      label={`More actions for ${name}`}
      data-card-menu=""
      onClick={onPress}
      className="absolute -bottom-0.5 -right-0.5 z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      <IconMore size={ICON_SIZE.control} />
    </IconButton>
  );
}

/**
 * The round select box on a card: a 44px hit area in the top-left corner
 * holding an empty 16px square, a sibling of the card button (buttons never
 * nest). One tap starts selecting with this card ticked. The square sits in the
 * same spot as the select-mode tick, so the tap lands where the tick appears.
 */
export function CardSelectBox({ name, onPress }: { name: string; onPress: () => void }) {
  return (
    <IconButton
      type="button"
      label={`Select ${name}`}
      data-card-select=""
      onClick={onPress}
      className="absolute left-0 top-0 z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      <span className="h-4 w-4 rounded border-[1.5px] border-white bg-black/15 shadow-[0_0_0_1px_rgba(0,0,0,0.3)]" />
    </IconButton>
  );
}

/** An image or link card's thumbnail, name row and size or domain line (unchanged). */
function AssetMedia({
  item,
  name,
  cache,
  presignEnabled,
}: {
  item: AssetListItem;
  name: string;
  cache: PresignCache;
  presignEnabled: boolean;
}) {
  return (
    <>
      <Thumbnail
        assetVersionId={item.kind === 'image' ? item.currentVersionId : null}
        cache={cache}
        presignEnabled={presignEnabled}
        aspect="4/3"
        fallback={assetFallback(item)}
        alt={name}
      />

      <div className="flex flex-col gap-1.5 border-t border-border p-2.5">
        <div className="flex items-start gap-2">
          <span className="line-clamp-2 flex-1 break-words text-base font-medium" title={name}>
            {name}
          </span>
          {item.kind === 'image' ? (
            <span className="shrink-0 rounded bg-panel-2 px-1.5 py-px text-xs font-medium text-fg-3">
              {mimeBadge(item.mimeType)}
            </span>
          ) : null}
        </div>
        {/* One 20px line, room on the right for the card's ⋯. */}
        <div className="flex h-5 items-center pr-8 text-sm tabular-nums text-fg-3">
          <span className="truncate">
            {item.kind === 'link' ? linkDomain(item.externalUrl) : humanizeSize(item.sizeBytes)}
          </span>
        </div>
      </div>
    </>
  );
}
