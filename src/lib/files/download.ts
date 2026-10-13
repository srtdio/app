// Save a file in place: one shared mechanism for the FileViewer and the image
// lightbox. The link comes from asset-read with Content-Disposition:
// attachment (or is a local blob), and a same-window anchor with the download
// attribute saves it: never a new tab or window, never window.open.

import type { PresignCache } from '@/lib/asset-presign';

/** A link held while it is in use; release() frees a local blob URL. */
export interface HeldLink {
  url: string;
  release: () => void;
}

const NOOP = (): void => undefined;

/** How long a blob link outlives the click that saves it. */
export const BLOB_RELEASE_MS = 30_000;

/** A fresh attachment-disposition link for a stored version, minted on every call. */
export function attachmentLink(cache: PresignCache, versionId: string): () => Promise<HeldLink> {
  return async () => ({ url: (await cache.freshUrl(versionId, 'attachment')).url, release: NOOP });
}

/**
 * Save a file through a same-window link with the download attribute. A
 * presigned attachment link makes the browser save it. Resolves false when the
 * link could not be minted.
 */
export async function saveFromLink(
  getLink: () => Promise<HeldLink>,
  name: string,
): Promise<boolean> {
  let link: HeldLink | null = null;
  try {
    link = await getLink();
    const anchor = document.createElement('a');
    anchor.href = link.url;
    anchor.download = name;
    anchor.rel = 'noopener';
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    return true;
  } catch {
    return false;
  } finally {
    // A blob link must outlive the click a moment; a presigned one needs no
    // release, so no timer is left behind for it.
    const held = link;
    if (held !== null && held.url.startsWith('blob:')) setTimeout(held.release, BLOB_RELEASE_MS);
  }
}
