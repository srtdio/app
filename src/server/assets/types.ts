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
