// Pure transforms over a post's ordered gallery, expressed as an ordered list of
// asset_version_id uuids (the exact argument gallery_set takes). Every transform
// is non-mutating and total; the component layer applies one and then sends the
// result to gallerySet, so the reorder/add/remove logic is unit-tested with no
// React and no database. `removeAt` may yield an empty list: gallery_set accepts
// [], so removing the final image is allowed and leaves the post with no artwork.

import type { GalleryItem } from '@srtdio/posts';
import { errorText } from '@/lib/error-copy';

/** Swap the item at `index` with the one before it. Out of range is a no-op. */
export function moveLeft(ids: readonly string[], index: number): string[] {
  const next = [...ids];
  if (index <= 0 || index >= next.length) return next;
  const prev = next[index - 1];
  const cur = next[index];
  if (prev === undefined || cur === undefined) return next;
  next[index - 1] = cur;
  next[index] = prev;
  return next;
}

/** Swap the item at `index` with the one after it. Out of range is a no-op. */
export function moveRight(ids: readonly string[], index: number): string[] {
  const next = [...ids];
  if (index < 0 || index >= next.length - 1) return next;
  const cur = next[index];
  const after = next[index + 1];
  if (cur === undefined || after === undefined) return next;
  next[index] = after;
  next[index + 1] = cur;
  return next;
}

/** Add a new version id at the end of the gallery. */
export function append(ids: readonly string[], versionId: string): string[] {
  return [...ids, versionId];
}

/** Insert a new version id immediately after `index`, clamped into range. */
export function insertAfter(ids: readonly string[], index: number, versionId: string): string[] {
  const next = [...ids];
  const at = Math.min(Math.max(index + 1, 0), next.length);
  next.splice(at, 0, versionId);
  return next;
}

/**
 * Remove the item at `index`. Removing the sole remaining image yields an empty
 * list, which gallery_set accepts (the post is left with no artwork). An
 * out-of-range index is a no-op copy.
 */
export function removeAt(ids: readonly string[], index: number): string[] {
  if (index < 0 || index >= ids.length) return [...ids];
  return ids.filter((_, i) => i !== index);
}

/**
 * Put the item at `index` in place of a new version id (Replace: one picture
 * swapped, every other slide kept in order). Out of range is a no-op copy.
 */
export function replaceAt(ids: readonly string[], index: number, versionId: string): string[] {
  if (index < 0 || index >= ids.length) return [...ids];
  return ids.map((id, i) => (i === index ? versionId : id));
}

/**
 * Move the item at `from` to position `to` (clamped into range), shifting the
 * items between. Reorder mode builds its whole draft order with this and saves
 * it once. Out of range `from` is a no-op copy.
 */
export function moveTo<T>(ids: readonly T[], from: number, to: number): T[] {
  const next = [...ids];
  if (from < 0 || from >= next.length) return next;
  const target = Math.min(Math.max(to, 0), next.length - 1);
  const [moved] = next.splice(from, 1);
  if (moved === undefined) return [...ids];
  next.splice(target, 0, moved);
  return next;
}

/**
 * Where a dragged reorder tile lands: its start index shifted by how many tile
 * steps the pointer travelled along the row, clamped into range. Pure.
 */
export function dropIndex(from: number, dx: number, step: number, count: number): number {
  if (count <= 0) return 0;
  const shift = step > 0 ? Math.round(dx / step) : 0;
  return Math.min(Math.max(from + shift, 0), count - 1);
}

/** The approved-lock exception gallery_set (and the other edit procs) raise. */
export const POST_APPROVED_LOCKED = 'post_approved_locked';

/**
 * The one inline line a failed gallery write shows in the tools row:
 * "Couldn't update the gallery. {reason}", the approved lock included. Pure.
 */
export function galleryWriteErrorCopy(error: { code: string; message: string }): string {
  return errorText('update the gallery', error);
}

/**
 * A version snapshot's gallery (bare asset_version_ids) as gallery items for
 * the thumbnail renderer: a version still attached reuses its stored metadata
 * (kind, mime, size); any other id renders as an image tile, which falls back to
 * the glyph if it is not one. Keys stay unique even when an id repeats. Pure.
 */
export function snapshotItems(
  versionIds: readonly string[],
  known: readonly GalleryItem[],
): GalleryItem[] {
  return versionIds.map((versionId, position) => {
    const match = known.find((item) => item.assetVersionId === versionId);
    const assetAttachmentId = `snapshot-${position}-${versionId}`;
    if (match !== undefined) return { ...match, assetAttachmentId, position };
    return {
      assetAttachmentId,
      assetVersionId: versionId,
      assetId: '',
      position,
      filename: `Image ${position + 1}`,
      mimeType: null,
      kind: 'image',
      width: null,
      height: null,
      durationMs: null,
      pageCount: null,
      r2Key: null,
      externalUrl: null,
    };
  });
}
