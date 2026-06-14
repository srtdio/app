import { cn } from '@/lib/cn';
import { useLongPress } from '@/components/pages/assets/useLongPress';
import { Thumbnail, type ThumbnailFallback } from '@/components/media';
import type { PresignCache } from '@/lib/asset-presign';
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
  /** Long-press: open the bottom action sheet. */
  onLongPress: () => void;
}

/** The non-image tile for a card: a link domain, or a file extension glyph. */
function assetFallback(item: AssetListItem): ThumbnailFallback {
  if (item.kind === 'link') return { kind: 'link', label: linkDomain(item.externalUrl) };
  return { kind: 'file', extension: fileExtension(item.filename) };
}

export function AssetCard({ item, presignEnabled, cache, onOpen, onLongPress }: AssetCardProps) {
  const name = displayLabel(item);
  const longPress = useLongPress(onLongPress, onOpen);

  return (
    <button
      type="button"
      aria-label={item.kind === 'link' ? `Open ${name}` : `View ${name}`}
      {...longPress}
      style={{ touchAction: 'manipulation' }}
      className={cn(
        'group relative flex flex-col overflow-hidden rounded-xl border border-border bg-panel text-left transition-colors',
        'hover:border-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
      )}
    >
      <Thumbnail
        assetVersionId={item.kind === 'image' ? item.currentVersionId : null}
        cache={cache}
        presignEnabled={presignEnabled}
        aspect="4/3"
        fallback={assetFallback(item)}
        alt={name}
      />

      <div className="flex items-center gap-2 border-t border-border px-2.5 py-2">
        <span className="flex-1 truncate text-xs font-medium" title={name}>
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
    </button>
  );
}
