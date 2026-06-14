// Pure, React-free helpers behind the PCS post action sheet (F8): build the
// in-app deep link to a post, decide whether a gallery holds images to download,
// and shape resolved gallery URLs into ordered download descriptors. No domain is
// ever hardcoded here: the origin is supplied by the caller
// (window.location.origin) and the path by the repo's existing post route
// builder, so this stays correct across environments and unit-testable without a
// DOM. There is no share-token concept in the MVP; the link is an authenticated
// in-app URL, nothing more.

/** The minimal slice of a gallery item the download gating reads. */
export interface GalleryImageLike {
  /** asset_versions.kind (image / video / file / link). */
  kind: string;
  /** assets/asset_versions mime type, or null when unknown. */
  mimeType: string | null;
}

/** One gallery image after its download URL was resolved (or failed). */
export interface ResolvedDownload {
  /** The presigned attachment URL, or null when its presign failed. */
  url: string | null;
  /** The file name to save the download as (the gallery item's filename). */
  filename: string;
}

/** A ready-to-trigger download: a non-empty URL paired with its file name. */
export interface DownloadDescriptor {
  url: string;
  filename: string;
}

/**
 * Join an origin and an in-app route path into one absolute URL, tolerant of
 * trailing slashes on the origin and a missing leading slash on the path, so the
 * result is correct whether window.location.origin ends in a slash or not. The
 * origin's scheme + host are preserved verbatim; no domain is hardcoded.
 */
export function buildPostLink(origin: string, postRoutePath: string): string {
  const base = origin.replace(/\/+$/, '');
  const path = postRoutePath.startsWith('/') ? postRoutePath : `/${postRoutePath}`;
  return `${base}${path}`;
}

/** True when this item is an image worth offering for download. */
export function isDownloadableImage(item: GalleryImageLike): boolean {
  return item.kind === 'image' || (item.mimeType ?? '').startsWith('image/');
}

/**
 * Whether "Download all images" should be offered at all: true only when the
 * gallery holds at least one image (videos/files/links alone do not count).
 */
export function canDownloadAll(gallery: readonly GalleryImageLike[]): boolean {
  return gallery.some(isDownloadableImage);
}

/**
 * Shape resolved gallery items into ordered download descriptors, preserving the
 * gallery order and dropping any whose URL did not resolve. Pure transform: the
 * component resolves the URLs through the existing presign path, then hands the
 * results here before triggering the browser downloads.
 */
export function toDownloadDescriptors(resolved: readonly ResolvedDownload[]): DownloadDescriptor[] {
  const out: DownloadDescriptor[] = [];
  for (const item of resolved) {
    if (item.url !== null && item.url !== '') {
      out.push({ url: item.url, filename: item.filename });
    }
  }
  return out;
}
