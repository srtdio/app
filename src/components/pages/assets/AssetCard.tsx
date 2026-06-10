import { useEffect, useState } from 'react';
import { cn } from '@/lib/cn';
import { IconCheck, IconFile, IconLink } from '@/components/ui/icons';
import { useInView } from '@/lib/use-in-view';
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
  selected: boolean;
  /** True when a selection is in progress, so the checkbox stays visible. */
  selecting: boolean;
  /** Whether presigning is configured; when false, image tiles show a fallback. */
  presignEnabled: boolean;
  cache: PresignCache;
  onOpen: () => void;
  onToggleSelect: () => void;
}

/** Lazily presign and keep fresh the thumbnail URL for an image-kind card. */
function useThumbnail(
  item: AssetListItem,
  cache: PresignCache,
  enabled: boolean,
): {
  ref: React.RefObject<HTMLDivElement>;
  url: string | null;
  failed: boolean;
  onError: () => void;
} {
  const { ref, inView } = useInView<HTMLDivElement>();
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

export function AssetCard({
  item,
  selected,
  selecting,
  presignEnabled,
  cache,
  onOpen,
  onToggleSelect,
}: AssetCardProps) {
  const { ref, url, failed, onError } = useThumbnail(item, cache, presignEnabled);
  const name = displayLabel(item);
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
    <div
      ref={ref}
      className={cn(
        'group relative overflow-hidden rounded-xl border bg-panel transition-colors',
        selected
          ? 'border-accent ring-1 ring-accent-line'
          : 'border-border hover:border-border-strong',
      )}
    >
      <button
        type="button"
        aria-label={`Open ${name}`}
        onClick={onOpen}
        className="absolute inset-0 z-0 rounded-xl"
      />

      <button
        type="button"
        aria-label={selected ? `Deselect ${name}` : `Select ${name}`}
        aria-pressed={selected}
        onClick={onToggleSelect}
        className={cn(
          'absolute left-2 top-2 z-20 flex h-6 w-6 items-center justify-center rounded-md border transition-opacity',
          selected
            ? 'border-accent bg-accent text-accent-fg opacity-100'
            : 'border-border-strong bg-panel/90 text-transparent opacity-0 focus:opacity-100 group-hover:opacity-100',
          selecting && 'opacity-100',
        )}
      >
        <IconCheck size={14} />
      </button>

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

      <div className="pointer-events-none relative z-0 flex items-center gap-2 border-t border-border px-2.5 py-2">
        <span className="flex-1 truncate text-xs font-medium" title={name}>
          {name}
        </span>
        {item.kind === 'image' ? (
          <span className="shrink-0 rounded bg-panel-2 px-1.5 py-0.5 text-[10px] font-medium text-fg-3">
            {mimeBadge(item.mimeType)}
          </span>
        ) : null}
      </div>

      <div className="pointer-events-none relative z-0 px-2.5 pb-2 text-[11px] tabular-nums text-fg-3">
        {item.kind === 'link' ? linkDomain(item.externalUrl) : humanizeSize(item.sizeBytes)}
      </div>
    </div>
  );
}
