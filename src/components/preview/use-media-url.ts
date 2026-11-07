// A preview slide's inline URL: the draft's local object URL as-is, else the
// saved file resolved through the page's presign cache (a cached URL paints on
// the first frame; never a new read on the page's own paint path).

import { useEffect, useState } from 'react';
import type { GalleryItem } from '@srtdio/posts';
import type { PresignCache } from '@/lib/asset-presign';

export function useMediaUrl(
  item: GalleryItem | null,
  kind: 'image' | 'video' | 'document' | 'none',
  cache: PresignCache | undefined,
  enabled: boolean,
  localUrl: string | null,
): string | null {
  const versionId = item?.assetVersionId ?? '';
  const renderable =
    localUrl === null &&
    cache !== undefined &&
    enabled &&
    versionId !== '' &&
    (kind === 'image' || kind === 'video');
  const [url, setUrl] = useState<string | null>(() =>
    renderable ? (cache.peek(versionId)?.url ?? null) : null,
  );
  useEffect(() => {
    if (!renderable) {
      setUrl(null);
      return;
    }
    let live = true;
    cache
      ?.resolve(versionId)
      .then((presigned) => {
        if (live) setUrl(presigned.url);
      })
      .catch(() => {
        if (live) setUrl(null);
      });
    return () => {
      live = false;
    };
  }, [renderable, versionId, cache]);
  return localUrl ?? url;
}
