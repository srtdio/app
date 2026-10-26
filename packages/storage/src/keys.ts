// The one authoritative module for R2 object keys.
//
// Shared-bucket layout (every workspace in SHARED_ASSET_BUCKET, keyed by ids
// only; no filename, extension or kind is ever part of a key). It must equal
// what public.storage_workspace_move writes when it moves a workspace:
//
//   versions:   'ws/' || workspace_id || '/' || asset_id || '/' || version_id || '/original'
//   renditions: 'ws/' || workspace_id || '/' || v.asset_id || '/' || v.id || '/' || r.role
//
// Download and display names always come from the DB (assets.display_name /
// assets.filename) and the MIME type from asset_versions.mime_type; nothing may
// parse a name, extension or kind back out of a key.

/** Every shared-bucket key starts with this; storage_workspace_move skips keys that do. */
export const SHARED_KEY_PREFIX = 'ws/';

/** Static onboarding sample files: in no bucket, never moved, never counted as stored bytes. */
export const SAMPLE_KEY_PREFIX = 'induction-sample/';

/** Prefix of resumable-upload staging objects; never referenced by a DB row. */
export const UPLOAD_STAGING_PREFIX = 'uploads/';

/** A version's own bytes: ws/<workspace_id>/<asset_id>/<version_id>/original. */
export function versionKey(input: {
  workspaceId: string;
  assetId: string;
  versionId: string;
}): string {
  return `${SHARED_KEY_PREFIX}${input.workspaceId}/${input.assetId}/${input.versionId}/original`;
}

/** A version's rendition (today only 'thumbnail'): ws/<workspace_id>/<asset_id>/<version_id>/<role>. */
export function renditionKey(input: {
  workspaceId: string;
  assetId: string;
  versionId: string;
  role: string;
}): string {
  return `${SHARED_KEY_PREFIX}${input.workspaceId}/${input.assetId}/${input.versionId}/${input.role}`;
}

/** A resumable upload's staging object: uploads/<workspace_id>/<upload_id>. */
export function uploadStagingKey(input: { workspaceId: string; uploadId: string }): string {
  return `${UPLOAD_STAGING_PREFIX}${input.workspaceId}/${input.uploadId}`;
}

// ---------------------------------------------------------------------------
// LEGACY layout. Only for a workspace that still lives in its own per-workspace
// bucket and already holds files there, until the move job moves it to the
// shared bucket (storage_workspace_move renames these keys to the layout above).
// Never use these for a workspace whose asset_bucket is the shared bucket.
// ---------------------------------------------------------------------------

/**
 * Legacy folder segment for an asset kind. Pluralized for the common media
 * kinds; every other file-bearing kind falls back to its own kind string.
 */
const LEGACY_KIND_FOLDER: Readonly<Record<string, string>> = {
  image: 'images',
  video: 'videos',
  document: 'docs',
};

function legacyKindFolder(kind: string): string {
  return LEGACY_KIND_FOLDER[kind] ?? kind;
}

/**
 * LEGACY-BUCKET ONLY. Old version key: {kindFolder}/{asset_id}/v{n}-{filename},
 * the filename sanitized to a safe key segment.
 */
export function legacyVersionKey(input: {
  kind: string;
  assetId: string;
  versionNumber: number;
  filename: string;
}): string {
  const safeName = input.filename.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '') || 'file';
  return `${legacyKindFolder(input.kind)}/${input.assetId}/v${input.versionNumber}-${safeName}`;
}

/** LEGACY-BUCKET ONLY. Old thumbnail key: {kindFolder}/{asset_id}/v{n}-thumb.jpg. */
export function legacyThumbnailKey(input: {
  kind: string;
  assetId: string;
  versionNumber: number;
}): string {
  return `${legacyKindFolder(input.kind)}/${input.assetId}/v${input.versionNumber}-thumb.jpg`;
}
