import { cn } from '@/lib/cn';
import { useLongPress } from '@/components/pages/assets/useLongPress';
import { Thumbnail, type ThumbnailFallback } from '@/components/media';
import { IconCheck, IconEllipsis } from '@/components/ui/icons';
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
      <button
        type="button"
        {...interaction}
        style={{ touchAction: 'manipulation' }}
        className={cn(
          'group relative flex h-full w-full flex-col overflow-hidden rounded-xl border bg-panel text-left transition-colors',
          selectMode && selected ? 'border-accent' : 'border-border',
          'hover:border-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
        )}
      >
        {selectMode ? (
          <span
            aria-hidden="true"
            className={cn(
              'absolute right-2 top-2 z-10 flex h-6 w-6 items-center justify-center rounded-full',
              selected ? 'bg-accent text-white' : 'border-2 border-white bg-black/40',
            )}
          >
            {selected ? <IconCheck size={14} /> : null}
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
      </button>
      {selectMode ? null : <CardMenuButton name={name} onPress={onLongPress} />}
    </div>
  );
}

/**
 * The visible ⋯ on a card: a 44px hit area in the top-right corner holding a
 * small chip, a sibling of the card button (buttons never nest). Opens the same
 * menu as a long-press. Shared by the folder card.
 */
export function CardMenuButton({ name, onPress }: { name: string; onPress: () => void }) {
  return (
    <button
      type="button"
      aria-label={`More actions for ${name}`}
      data-card-menu=""
      onClick={onPress}
      className="absolute right-0 top-0 z-10 inline-flex h-11 w-11 items-center justify-center rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      <span className="flex h-7 w-7 items-center justify-center rounded-full border border-border bg-panel text-fg shadow-sm">
        <IconEllipsis size={16} />
      </span>
    </button>
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

      <div className="flex items-start gap-2 border-t border-border px-2.5 py-2">
        <span className="line-clamp-2 flex-1 break-words text-xs font-medium" title={name}>
          {name}
        </span>
        {item.kind === 'image' ? (
          <span className="shrink-0 rounded bg-panel-2 px-1.5 py-0.5 text-[10px] font-medium text-fg-3">
            {mimeBadge(item.mimeType)}
          </span>
        ) : null}
      </div>

      <div className="px-2.5 pb-2 text-[11px] tabular-nums text-fg-3">
        {item.kind === 'link' ? linkDomain(item.externalUrl) : humanizeSize(item.sizeBytes)}
      </div>
    </>
  );
}
