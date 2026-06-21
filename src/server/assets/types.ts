// Shared types for the asset upload pipeline.
//
// The pipeline never throws for an expected failure: every outcome the caller
// is meant to handle (a rejected MIME type, an oversized file, a virus hit, a
// cross-tenant lookup miss) is modelled as a typed `Result`. System failures
// (R2 unreachable, Postgres down) are thrown and propagate to the Worker, which
// maps them to a 500.

import type { Database } from '@srtdio/schemas';

export type AssetRow = Database['public']['Tables']['assets']['Row'];
export type AssetVersionRow = Database['public']['Tables']['asset_versions']['Row'];
export type FolderRow = Database['public']['Tables']['folders']['Row'];
export type AssetInsert = Database['public']['Tables']['assets']['Insert'];
export type AssetVersionInsert = Database['public']['Tables']['asset_versions']['Insert'];

/** Every expected, caller-handled failure in the pipeline. */
export type UploadErrorCode =
  | 'unsupported_mime'
  | 'mime_mismatch'
  | 'file_too_large'
  | 'virus_detected'
  | 'empty_file'
  | 'invalid_image'
  | 'not_found';

export interface UploadError {
  code: UploadErrorCode;
  message: string;
  /** Optional provider/scanner detail, e.g. the virus signature name. */
  reason?: string;
}

export type Result<T, E = UploadError> = { ok: true; value: T } | { ok: false; error: E };

export function ok<T>(value: T): { ok: true; value: T } {
  return { ok: true, value };
}

export function err<E>(error: E): { ok: false; error: E } {
  return { ok: false, error };
}

/** The summary returned to the client after a successful upload or dedup. */
export interface AssetSummary {
  assetId: string;
  versionId: string;
  versionNumber: number;
  workspaceId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  r2Key: string;
  /** true when the upload matched existing content and no new bytes were stored. */
  reused: boolean;
}

/**
 * Compact asset view returned by the link-create and rename routes. Unlike
 * {@link AssetSummary} (which describes a stored file and always carries byte
 * columns), this carries only the asset-level fields those routes touch.
 * `externalUrl` is set for a link asset and omitted otherwise.
 */
export interface AssetMetaSummary {
  assetId: string;
  workspaceId: string;
  filename: string;
  currentVersionId: string | null;
  externalUrl?: string;
}

/**
 * Expected, caller-handled failures unique to folder writes. A name collision is
 * the only domain error the folder repository methods surface as a Result; an
 * unknown/cross-tenant folder is caught by the route's getFolder check (404) and
 * a bad parent/target by a 400, so neither needs a code here. Routed through the
 * worker's status map the same way {@link UploadError} is.
 */
export type FolderErrorCode = 'folder_name_taken';

export interface FolderError {
  code: FolderErrorCode;
  message: string;
}

/** The folder view returned by the folder create/rename routes. */
export interface FolderSummary {
  id: string;
  name: string;
  parentId: string | null;
}

/** Create a folder. parentId null means a root folder. Actor is the verified sub. */
export interface CreateFolderInput {
  workspaceId: string;
  name: string;
  parentId: string | null;
  actorUserId: string;
  traceId: string;
}

/** Rename a folder in place; parent is never moved here. */
export interface RenameFolderInput {
  workspaceId: string;
  folderId: string;
  name: string;
  actorUserId: string;
  traceId: string;
}

/** Soft-delete a folder, reparenting its child folders and detaching its assets. */
export interface DeleteFolderInput {
  workspaceId: string;
  folderId: string;
  actorUserId: string;
  traceId: string;
}

/** Move assets into a folder (targetFolderId null = the All assets root). */
export interface MoveAssetsInput {
  workspaceId: string;
  assetIds: string[];
  targetFolderId: string | null;
  actorUserId: string;
  traceId: string;
}

/** Input to the pipeline. Bytes are the raw, pre-sanitization upload. */
export interface UploadInput {
  workspaceId: string;
  uploadedBy: string;
  filename: string;
  contentType: string;
  bytes: Uint8Array;
  /** When set, the upload is treated as a new version of this existing asset. */
  assetId?: string;
  traceId: string;
}
