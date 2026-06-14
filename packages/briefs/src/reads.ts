// The brief reference-image read layer: a plain RLS-scoped SELECT on
// asset_attachments, no proc involved. Tenant isolation is Postgres' job (the
// caller's JWT drives RLS), so this adds no membership check of its own. It
// mirrors @srtdio/posts getPostGallery exactly, but for entity_type='brief'.
// Briefs are read-only after creation; this is a pure read with no trace_id.

import type { Client, DomainError, Result } from '@srtdio/rpc';

/**
 * One image in a brief's reference gallery: an asset_attachments row joined to
 * its pinned version (asset_versions) and the parent asset's filename. Flattened
 * to exactly the fields the gallery + lightbox render, so the UI never reaches
 * back into the raw embedded shapes. Structurally identical to @srtdio/posts
 * GalleryItem so the shared PCS gallery/viewer consume it unchanged.
 */
export interface BriefGalleryItem {
  assetAttachmentId: string;
  assetVersionId: string;
  assetId: string;
  position: number;
  /** From assets.filename; a sensible fallback when the join is missing it. */
  filename: string;
  mimeType: string | null;
  /** asset_versions.kind (image / video / file / link); never null server-side. */
  kind: string;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  r2Key: string | null;
  externalUrl: string | null;
}

/** Shown when the parent asset has no filename (defensive; filename is NOT NULL). */
const GALLERY_FILENAME_FALLBACK = 'Untitled';

function transportError(message: string): DomainError {
  return { code: 'unknown', message };
}

// The shape of one embedded gallery row. asset_attachments.entity_id is a plain
// TEXT column with no FK to briefs, so the gallery cannot be embedded from briefs;
// it is read directly off asset_attachments and the version/asset are embedded
// here instead. Cast through `unknown` because the aliased select is wider than
// the generated row type can express.
interface GalleryRow {
  id: string;
  asset_id: string;
  asset_version_id: string;
  position: number;
  asset_versions: {
    mime_type: string | null;
    kind: string;
    width: number | null;
    height: number | null;
    duration_ms: number | null;
    r2_key: string | null;
    external_url: string | null;
  } | null;
  assets: { filename: string | null } | null;
}

/**
 * Read a brief's reference-image gallery in one round trip: every live
 * asset_attachments row for the brief, in display order, each joined to its
 * pinned asset_versions row and the parent asset's filename. No N+1, no per-row
 * loop. Returns [] (never null) when the brief has no images. A plain RLS-scoped
 * read, so it takes no trace_id.
 */
export async function getBriefGallery(
  client: Client,
  briefId: string,
): Promise<Result<BriefGalleryItem[]>> {
  const { data, error } = await client
    .from('asset_attachments')
    .select('*, asset_versions(*), assets:asset_id(filename)')
    .eq('entity_type', 'brief')
    .eq('entity_id', briefId)
    .is('deleted_at', null)
    .order('position', { ascending: true });

  if (error) return { ok: false, error: transportError(error.message) };

  const rows = (data ?? []) as unknown as GalleryRow[];
  return {
    ok: true,
    data: rows.map((row) => {
      const version = row.asset_versions;
      return {
        assetAttachmentId: row.id,
        assetVersionId: row.asset_version_id,
        assetId: row.asset_id,
        position: row.position,
        filename: row.assets?.filename ?? GALLERY_FILENAME_FALLBACK,
        mimeType: version?.mime_type ?? null,
        kind: version?.kind ?? 'file',
        width: version?.width ?? null,
        height: version?.height ?? null,
        durationMs: version?.duration_ms ?? null,
        r2Key: version?.r2_key ?? null,
        externalUrl: version?.external_url ?? null,
      };
    }),
  };
}
