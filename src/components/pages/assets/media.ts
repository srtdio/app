// Type-aware media classification + URL resolution for the Assets lightbox.
//
// The list/data layer (src/lib/assets.ts) only distinguishes image / link /
// file kinds. The viewer needs a finer split so it can pick a renderer, so this
// derives a MediaKind from the version's mime_type (with a filename-extension
// fallback) without touching the shared data layer. resolveAssetUrl reuses the
// existing presign helper (PresignCache.resolve); it does not duplicate it.

import type { AssetListItem } from '@/lib/assets';
import type { PresignCache } from '@/lib/asset-presign';
import { fileExtension } from '@/lib/assets';

export type MediaKind = 'image' | 'video' | 'pdf' | 'doc' | 'xls' | 'file';

const VIDEO_EXT = ['mp4', 'mov', 'webm', 'm4v', 'avi', 'mkv'];
const DOC_EXT = ['doc', 'docx', 'rtf', 'odt'];
const XLS_EXT = ['xls', 'xlsx', 'csv', 'ods'];

/**
 * Derive the viewer media kind from a version's mime_type, falling back to the
 * filename extension. Anything not recognised as renderable or a known office
 * type lands on 'file', which the lightbox shows as a download-only panel, so a
 * new server-side type never breaks the viewer.
 */
export function mediaKind(item: Pick<AssetListItem, 'kind' | 'mimeType' | 'filename'>): MediaKind {
  const mime = (item.mimeType ?? '').toLowerCase();
  const ext = fileExtension(item.filename).toLowerCase();
  if (item.kind === 'image' || mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/') || VIDEO_EXT.includes(ext)) return 'video';
  if (mime === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (mime.includes('word') || mime === 'application/msword' || DOC_EXT.includes(ext)) return 'doc';
  if (mime.includes('excel') || mime.includes('spreadsheet') || XLS_EXT.includes(ext)) return 'xls';
  return 'file';
}

/** Whether this kind renders inline in the lightbox (vs a download-only panel). */
export function isInlineRenderable(kind: MediaKind): boolean {
  return kind === 'image' || kind === 'video';
}

/** Short uppercase label for the type glyph and the Info "Type" field. */
export function typeLabel(kind: MediaKind): string {
  switch (kind) {
    case 'image':
      return 'IMAGE';
    case 'video':
      return 'VIDEO';
    case 'pdf':
      return 'PDF';
    case 'doc':
      return 'DOC';
    case 'xls':
      return 'XLS';
    default:
      return 'FILE';
  }
}

/** Resolve the openable URL for an asset: the external link, or a presigned GET. */
export async function resolveAssetUrl(item: AssetListItem, cache: PresignCache): Promise<string> {
  if (item.kind === 'link') {
    if (item.externalUrl === null) throw new Error('Link has no URL.');
    return item.externalUrl;
  }
  if (item.currentVersionId === null) throw new Error('Asset has no stored version.');
  return (await cache.resolve(item.currentVersionId)).url;
}
