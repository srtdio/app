import { useEffect, useState } from 'react';
import { cn } from '@/lib/cn';
import { IconCheck, IconFile, IconLink } from '@/components/ui/icons';
import { useInView } from '@/lib/use-in-view';
import type { PresignCache } from '@/lib/asset-presign';
import {
  fileExtension,
  humanizeSize,
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
): { ref: React.RefObject<HTMLDivElement>; url: string | null; failed: boolean } {
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

  return { ref, url, failed };
}

const TILE =
  'relative aspect-square w-full overflow-hidden bg-panel-2 flex items-center justify-center';

export function AssetCard({
  item,
  selected,
  selecting,
  presignEnabled,
  cache,
  onOpen,
  onToggleSelect,
}: AssetCardProps) {
  const { ref, url, failed } = useThumbnail(item, cache, presignEnabled);

  return (
    <div
      ref={ref}
      className={cn(
        'group relative rounded-xl border bg-panel overflow-hidden transition-colors',
        selected
          ? 'border-accent ring-1 ring-accent-line'
          : 'border-border hover:border-border-strong',
      )}
    >
      <button
        type="button"
        aria-label={`Open ${item.filename}`}
        onClick={onOpen}
        className="absolute inset-0 z-0 rounded-xl"
      />

      <button
        type="button"
        aria-label={selected ? `Deselect ${item.filename}` : `Select ${item.filename}`}
        aria-pressed={selected}
        onClick={onToggleSelect}
        className={cn(
          'absolute left-2 top-2 z-20 flex h-6 w-6 items-center justify-center rounded-md border transition-opacity',
          selected
            ? 'bg-accent text-accent-fg border-accent opacity-100'
            : 'bg-panel/90 border-border-strong text-transparent opacity-0 group-hover:opacity-100 focus:opacity-100',
          selecting && 'opacity-100',
        )}
      >
        <IconCheck size={14} />
      </button>

      <div className={TILE}>
        {item.kind === 'image' ? (
          url !== null ? (
            <img
              src={url}
              alt={item.filename}
              loading="lazy"
              className="h-full w-full object-cover"
            />
          ) : (
            <div className="text-fg-3 text-xs">{failed ? 'Preview unavailable' : ''}</div>
          )
        ) : item.kind === 'link' ? (
          <div className="flex flex-col items-center gap-1 px-3 text-center text-fg-2">
            <IconLink size={22} />
            <span className="text-xs truncate max-w-full">{linkDomain(item.externalUrl)}</span>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-1 text-fg-2">
            <IconFile size={24} />
            {fileExtension(item.filename) !== '' ? (
              <span className="text-[11px] font-medium tabular-nums">
                {fileExtension(item.filename)}
              </span>
            ) : null}
          </div>
        )}
      </div>

      <div className="relative z-0 flex items-center gap-2 px-2.5 py-2 border-t border-border pointer-events-none">
        <span className="flex-1 truncate text-xs font-medium">{item.filename}</span>
        {item.kind === 'image' ? (
          <span className="shrink-0 rounded bg-panel-2 px-1.5 py-0.5 text-[10px] font-medium text-fg-3">
            {mimeBadge(item.mimeType)}
          </span>
        ) : null}
      </div>

      <div className="relative z-0 px-2.5 pb-2 text-[11px] text-fg-3 tabular-nums pointer-events-none">
        {item.kind === 'link' ? linkDomain(item.externalUrl) : humanizeSize(item.sizeBytes)}
      </div>
    </div>
  );
}
