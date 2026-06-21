// Pure, dependency-free helpers behind the PCS version-history viewer (F7.5).
// The post snapshot is free-form jsonb: the canonical v2 shape written by
// _post_snapshot is { caption, gallery } (gallery = ordered asset_version_id
// strings), but legacy ETL rows carry a different shape entirely (content /
// images / canva_link / ...). Every function here is defensive: parseSnapshot
// never throws on an unexpected shape, and nothing is fabricated. These run in
// the UI only; the read itself is a plain RLS-scoped select (getPost).

import type { PostVersion } from '@srtdio/posts';
import type { Json } from '@srtdio/schemas';

/** The view-model for one immutable post version, camelCased off the raw row. */
export interface PostVersionView {
  id: string;
  versionNumber: number;
  /** The raw snapshot jsonb, parsed lazily by {@link parseSnapshot}. */
  snapshot: Json;
  /** Author uuid, or null when the row predates / lost its created_by (SET NULL). */
  createdBy: string | null;
  /** Cutover author name carried on legacy rows; null for natively-authored ones. */
  legacyAuthorName: string | null;
  createdAt: string;
}

/** What the read-only old-version view renders: nothing else is versioned. */
export interface ParsedSnapshot {
  caption: string | null;
  /** Ordered asset_version_id strings; [] for legacy/malformed snapshots. */
  galleryVersionIds: string[];
}

function isRecord(value: Json | null): value is { [key: string]: Json | undefined } {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Read the caption and gallery out of a version snapshot defensively. The v2
 * shape is { caption: string|null, gallery: string[] }; a legacy or malformed
 * snapshot (wrong keys, wrong types, a primitive, null) yields its caption when
 * that happens to be a string and an empty gallery. Never throws; never invents.
 */
export function parseSnapshot(raw: Json | null): ParsedSnapshot {
  if (!isRecord(raw)) return { caption: null, galleryVersionIds: [] };
  const caption = typeof raw.caption === 'string' ? raw.caption : null;
  const gallery = raw.gallery;
  const galleryVersionIds = Array.isArray(gallery)
    ? gallery.filter((value): value is string => typeof value === 'string')
    : [];
  return { caption, galleryVersionIds };
}

/** The highest version_number in the list, or null when there are no versions. */
export function currentVersionNumber<T extends { versionNumber: number }>(
  versions: readonly T[],
): number | null {
  let max: number | null = null;
  for (const version of versions) {
    if (max === null || version.versionNumber > max) max = version.versionNumber;
  }
  return max;
}

/** A copy of the list, newest first. Stable for equal version numbers. */
export function sortVersionsDesc<T extends { versionNumber: number }>(versions: readonly T[]): T[] {
  return [...versions].sort((a, b) => b.versionNumber - a.versionNumber);
}

/**
 * Map the raw embedded post_versions rows to the camelCased view-model, ordered
 * version_number ascending. Additive over getPost's existing `versions` field:
 * the raw rows are left untouched for existing callers; this is the shape the
 * F7.5 viewer consumes.
 */
export function toVersionViews(rows: readonly PostVersion[]): PostVersionView[] {
  return rows
    .map((row) => ({
      id: row.id,
      versionNumber: row.version_number,
      snapshot: row.snapshot,
      createdBy: row.created_by,
      legacyAuthorName: row.legacy_author_name,
      createdAt: row.created_at,
    }))
    .sort((a, b) => a.versionNumber - b.versionNumber);
}
