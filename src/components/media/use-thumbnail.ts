import { useEffect, useState } from 'react';
import { useInView } from '@/lib/use-in-view';
import type { PresignCache } from '@/lib/asset-presign';

/** Inputs for {@link useThumbnail}: a nullable version id plus the page's cache. */
export interface UseThumbnailArgs {
  /** The asset version to presign, or null when this tile shows a fallback. */
  assetVersionId: string | null;
  /** The page-owned presign cache; the hook never constructs one. */
  cache: PresignCache;
  /** False when presigning is unconfigured: the hook stays inert and shows a fallback. */
  enabled: boolean;
}

/** What {@link useThumbnail} returns: the inView ref plus the URL lifecycle. */
export interface ThumbnailHandle<T extends Element> {
  ref: React.RefObject<T>;
  url: string | null;
  failed: boolean;
  onError: () => void;
}

/**
 * Lazily presign and keep fresh one thumbnail URL. Generalized from the copies
 * AssetCard and PostCard each owned: gate the network on `enabled` and a non-null
 * id, defer it until the element scrolls into view (useInView), serve a warm URL
 * from the cache synchronously, and refresh shortly before expiry so a long-lived
 * card never shows a 403. A null id never fetches. The caller owns the cache.
 */
export function useThumbnail<T extends Element = HTMLDivElement>({
  assetVersionId,
  cache,
  enabled,
}: UseThumbnailArgs): ThumbnailHandle<T> {
  const { ref, inView } = useInView<T>();
  const active = enabled && assetVersionId !== null;
  const [url, setUrl] = useState<string | null>(() =>
    active && assetVersionId !== null ? (cache.peek(assetVersionId)?.url ?? null) : null,
  );
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!active || assetVersionId === null || !inView) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const load = async (): Promise<void> => {
      try {
        const presigned = await cache.resolve(assetVersionId);
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
  }, [active, assetVersionId, inView, cache]);

  // A presigned URL that 403s or is an unsupported image still must not render a
  // blank tile: fall back to the glyph on the <img>'s error event.
  return { ref, url, failed, onError: () => setFailed(true) };
}
