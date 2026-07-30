// Pure transforms over a post's ordered gallery, expressed as an ordered list of
// asset_version_id uuids (the exact argument gallery_set takes). Every transform
// is non-mutating and total; the component layer applies one and then sends the
// result to gallerySet, so the reorder/add/remove logic is unit-tested with no
// React and no database. `removeAt` yields an empty list when the final image is
// removed; gallery_set now accepts an empty gallery (a post may hold no artwork).

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
 * Remove the item at `index`. Removing the last remaining image yields an empty
 * list; an empty gallery is allowed now (gallery_set accepts []). An
 * out-of-range index is a no-op copy.
 */
export function removeAt(ids: readonly string[], index: number): string[] {
  if (index < 0 || index >= ids.length) return [...ids];
  return ids.filter((_, i) => i !== index);
}
