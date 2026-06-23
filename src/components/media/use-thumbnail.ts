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
 * Most automatic retries after a failed presign, so up to 4 total attempts. The
 * first lazy presign of a page load can fire before the session is warm and come
 * back unauthenticated (the data queries wait for the client and succeed); a few
 * bounded retries let the tile self-heal instead of latching the fallback until a
 * full reload remounts the card.
 */
export const THUMBNAIL_RETRY_CAP = 3;

/** Linear backoff between presign retries: 700ms, 1400ms, 2100ms. */
export function thumbnailRetryDelayMs(attempt: number): number {
  return 700 * attempt;
}

/** Sinks the load loop writes to, so the loop stays free of the React imports. */
export interface ThumbnailLoadCallbacks {
  setUrl: (url: string) => void;
  setFailed: (failed: boolean) => void;
}

/**
 * Drive one thumbnail's presign lifecycle: resolve a URL from the cache, retry a
 * failed presign up to {@link THUMBNAIL_RETRY_CAP} times with a short linear
 * backoff, then refresh shortly before expiry so a long-lived card never shows a
 * 403. Returns a cancel function: it flips the live flag and clears the one
 * pending timer (retry or refresh), so nothing fires after the caller unmounts.
 * The retry is hard-bounded and cannot loop forever. React-free so it can be unit
 * tested with a fake cache and fake timers (the effect below is the only caller).
 */
export function runThumbnailLoad(
  assetVersionId: string,
  cache: Pick<PresignCache, 'resolve'>,
  { setUrl, setFailed }: ThumbnailLoadCallbacks,
): () => void {
  let live = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Attempt count local to this run; reset on success so the periodic refresh
  // cycle below gets its own fresh budget of retries.
  let attempts = 0;
  const load = async (): Promise<void> => {
    try {
      const presigned = await cache.resolve(assetVersionId);
      if (!live) return;
      setUrl(presigned.url);
      setFailed(false);
      attempts = 0;
      // Refresh shortly before expiry so a long-lived card never shows a 403.
      const delay = Math.max(presigned.expiresAt - Date.now() - 60_000, 5_000);
      timer = setTimeout(() => {
        if (live) void load();
      }, delay);
    } catch {
      if (!live) return;
      // Only surface the fallback once the bounded retries are exhausted.
      if (attempts < THUMBNAIL_RETRY_CAP) {
        attempts += 1;
        timer = setTimeout(() => {
          if (live) void load();
        }, thumbnailRetryDelayMs(attempts));
      } else {
        setFailed(true);
      }
    }
  };
  void load();
  return () => {
    live = false;
    if (timer !== undefined) clearTimeout(timer);
  };
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
    return runThumbnailLoad(assetVersionId, cache, { setUrl, setFailed });
  }, [active, assetVersionId, inView, cache]);

  // A presigned URL that 403s or is an unsupported image still must not render a
  // blank tile: fall back to the glyph on the <img>'s error event.
  return { ref, url, failed, onError: () => setFailed(true) };
}
