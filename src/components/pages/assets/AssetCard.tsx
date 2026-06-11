import { useEffect, useState } from 'react';
import { cn } from '@/lib/cn';
import { IconFile, IconLink } from '@/components/ui/icons';
import { useInView } from '@/lib/use-in-view';
import { useLongPress } from '@/components/pages/assets/useLongPress';
import type { PresignCache } from '@/lib/asset-presign';
import {
  displayLabel,
  fileExtension,
  humanizeSize,
  imageTileState,
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

/** Lazily presign and keep fresh the thumbnail URL for an image-kind card. */
function useThumbnail(
  item: AssetListItem,
  cache: PresignCache,
  enabled: boolean,
): {
  ref: React.RefObject<HTMLButtonElement>;
  url: string | null;
  failed: boolean;
  onError: () => void;
} {
  const { ref, inView } = useInView<HTMLButtonElement>();
  const versionId = item.currentVersionId;
  const active = enabled && item.kind === 'image' && versionId !== null;
  const [url, setUrl] = useState<string | null>(() =>
    active && versionId !== null ? (cache.peek(versionId)?.url ?? null) : null,
  );
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!active || versionId === null || !inView) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const load = async (): Promise<void> => {
      try {
        const presigned = await cache.resolve(versionId);
        if (!live) return;
        setUrl(presigned.url);
        setFailed(false);
        // Refresh shortly before expiry so a long-lived card never shows a 403.
        const delay = Math.max(presigned.expiresAt - Date.now() - 60_000, 5_000);
        timer = setTimeout(() => {
          if (live) void load();
        }, delay);
      } catch {
        if (live) setFailed(true);
      }
    };
    void load();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [active, versionId, inView, cache]);

  // A presigned URL that 403s or is an unsupported image still must not render a
  // blank tile: fall back to the glyph on the <img>'s error event.
  return { ref, url, failed, onError: () => setFailed(true) };
}

const TILE = 'relative aspect-[4/3] w-full overflow-hidden flex items-center justify-center';

/** The glyph-and-label fallback shown when there is no usable image preview. */
function Fallback({ item }: { item: AssetListItem }) {
  if (item.kind === 'link') {
    return (
      <div className="flex flex-col items-center gap-1 px-3 text-center text-fg-2">
        <IconLink size={22} />
        <span className="max-w-full truncate text-xs">{linkDomain(item.externalUrl)}</span>
      </div>
    );
  }
  const ext = fileExtension(item.filename);
  return (
    <div className="flex flex-col items-center gap-1 text-fg-2">
      <IconFile size={24} />
      {ext !== '' ? <span className="text-[11px] font-medium tabular-nums">{ext}</span> : null}
    </div>
  );
}

export function AssetCard({ item, presignEnabled, cache, onOpen, onLongPress }: AssetCardProps) {
  const { ref, url, failed, onError } = useThumbnail(item, cache, presignEnabled);
  const name = displayLabel(item);
  const longPress = useLongPress(onLongPress, onOpen);
  const state =
    item.kind === 'image'
      ? imageTileState({
          enabled: presignEnabled,
          hasVersion: item.currentVersionId !== null,
          url,
          failed,
        })
      : 'fallback';

  return (
    <button
      ref={ref}
      type="button"
      aria-label={item.kind === 'link' ? `Open ${name}` : `View ${name}`}
      {...longPress}
      style={{ touchAction: 'manipulation' }}
      className={cn(
        'group relative flex flex-col overflow-hidden rounded-xl border border-border bg-panel text-left transition-colors',
        'hover:border-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
      )}
    >
      <div className={cn(TILE, state === 'image' ? 'bg-panel-2' : 'bg-panel-3')}>
        {state === 'shimmer' ? (
          <div className="h-full w-full animate-pulse bg-panel-2" />
        ) : state === 'image' && url !== null ? (
          <img
            src={url}
            alt={name}
            loading="lazy"
            onError={onError}
            className="h-full w-full object-cover"
          />
        ) : (
          <Fallback item={item} />
        )}
      </div>

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
