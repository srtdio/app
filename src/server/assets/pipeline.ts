// The asset upload pipeline.
//
// Order (see PR description):
//   receive -> blocked type (svg, legacy Office) -> MIME allowlist -> size cap ->
//   magic bytes -> file-safety rules (filename, OLE2, encrypted PDF, Office
//   package inspection; @srtdio/storage file-safety.ts) -> EXIF strip (images) ->
//   virus scan -> sha256 -> R2 upload ->
//   insert asset (new) or asset_version (existing) -> bump current_version_id ->
//   return summary.
//
// Dedup: identical content (same sha256) within a workspace never stores twice.
// With no assetId, a matching hash returns the existing asset/version untouched,
// but only within the same origin: a chat upload reuses only the caller's own
// chat version, and a library upload never reuses a chat version.
// With an assetId, a matching hash returns that asset's existing version; a new
// hash appends version N+1 and advances current_version_id.
//
// Expected failures are returned as Result errors; only system faults throw.

import { v7 as uuidv7 } from 'uuid';
import { stripJpegMetadata } from './exif';
import type { VirusScanner } from './virus-scan';
import {
  buildR2Key,
  buildThumbnailKey,
  computeSha256,
  inspectUpload,
  isAllowedMime,
  isBlockedMime,
  isJpegMime,
  normalizeMime,
  readImageDimensions,
  verifyMagicBytes,
  type StorageClient,
} from '@srtdio/storage';
import { logger } from '../logger';
import {
  isFileVersionRef,
  type AssetRepository,
  type FileVersionKind,
  type RenditionStore,
} from './repository';
import {
  err,
  ok,
  type AssetMetaSummary,
  type AssetSummary,
  type Result,
  type UploadError,
  type UploadInput,
} from './types';

export const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024; // 100 MB

export interface PipelineDeps {
  storage: StorageClient;
  repository: AssetRepository;
  scanner: VirusScanner;
}

/**
 * Map a normalized, already-allowlisted MIME type to its stored-file kind.
 * Allowlist (mime.ts): image/* -> 'image', video/* -> 'video',
 * audio/* -> 'audio', application/pdf -> 'pdf', docx/xlsx/pptx -> 'document',
 * 'spreadsheet', 'presentation'. Anything else is impossible past the allowlist and
 * is a programming error, so it throws rather than guessing a kind.
 */
function fileKindForMime(mimeType: string): FileVersionKind {
  if (mimeType.startsWith('image/')) {
    return 'image';
  }
  if (mimeType.startsWith('video/')) {
    return 'video';
  }
  if (mimeType.startsWith('audio/')) {
    return 'audio';
  }
  if (mimeType === 'application/pdf') {
    return 'pdf';
  }
  if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    return 'document';
  }
  if (mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
    return 'spreadsheet';
  }
  if (mimeType === 'application/vnd.openxmlformats-officedocument.presentationml.presentation') {
    return 'presentation';
  }
  throw new Error(`no file kind mapping for allowed mime type ${mimeType}`);
}

/** Apply the format-specific sanitization step to the raw bytes. */
function sanitizeBytes(contentType: string, bytes: Uint8Array): Uint8Array {
  if (isJpegMime(contentType)) {
    return stripJpegMetadata(bytes);
  }
  return bytes;
}

function summaryFrom(input: {
  assetId: string;
  versionId: string;
  versionNumber: number;
  workspaceId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  r2Key: string;
  reused: boolean;
}): AssetSummary {
  return { ...input };
}

export async function runUploadPipeline(
  deps: PipelineDeps,
  input: UploadInput,
): Promise<Result<AssetSummary, UploadError>> {
  const { storage, repository, scanner } = deps;
  const mimeType = normalizeMime(input.contentType);

  // 1. MIME allowlist. SVG and legacy OLE Office get the "not allowed" refusal.
  if (isBlockedMime(input.contentType)) {
    return err({ code: 'blocked_type', message: "This file type isn't allowed" });
  }
  if (!isAllowedMime(input.contentType)) {
    return err({ code: 'unsupported_mime', message: `MIME type not allowed: ${mimeType}` });
  }

  // 2. Size cap (checked on the raw upload).
  if (input.bytes.byteLength === 0) {
    return err({ code: 'empty_file', message: 'Uploaded file is empty.' });
  }
  if (input.bytes.byteLength > MAX_FILE_SIZE_BYTES) {
    return err({
      code: 'file_too_large',
      message: `File exceeds ${MAX_FILE_SIZE_BYTES} bytes.`,
    });
  }

  // 2b. File-safety rules on the raw bytes and the client filename: disguised
  // or executable names, OLE2, encrypted files, and Office package inspection
  // (macros, embedded content, archive caps). Refusals are permanent 4xx. Runs
  // before the signature check so a password-protected Office file (OLE2 bytes
  // under a docx/xlsx/pptx MIME) gets the password copy, not a mismatch.
  const safety = await inspectUpload({
    filename: input.filename,
    mimeType,
    bytes: input.bytes,
  });
  if (!safety.ok) {
    return err({ code: safety.code, message: safety.message });
  }

  // 2c. Magic-byte check (after the allowlist, before sanitize): the declared
  // MIME type must match the file's actual leading bytes, so a renamed
  // executable cannot ride in under an allowed type.
  if (!verifyMagicBytes(input.bytes, mimeType)) {
    return err({ code: 'mime_mismatch', message: 'File contents do not match the file type.' });
  }

  // If a target asset is named, it must exist in this workspace (cross-tenant
  // and unknown ids are rejected here, not after doing work).
  let existingAssetId: string | null = null;
  if (input.assetId !== undefined) {
    const asset = await repository.getAsset(input.workspaceId, input.assetId);
    // A chat asset is never a version target: it reads as not found here so a
    // library upload cannot append to (or probe for) a chat file.
    if (!asset || asset.origin !== 'library') {
      return err({ code: 'not_found', message: 'Asset not found in this workspace.' });
    }
    existingAssetId = asset.id;
  }

  // 3-4. Sanitize: EXIF strip for JPEG.
  const sanitized = sanitizeBytes(input.contentType, input.bytes);

  // 5. Virus scan on the bytes that will actually be stored.
  const scan = await scanner.scan(sanitized);
  if (!scan.clean) {
    return err({
      code: 'virus_detected',
      message: 'Upload rejected by virus scan.',
      ...(scan.reason !== undefined ? { reason: scan.reason } : {}),
    });
  }

  // 6. Content hash of the sanitized bytes.
  const sha256 = await computeSha256(sanitized);
  const sizeBytes = sanitized.byteLength;
  const kind = fileKindForMime(mimeType);
  // Intrinsic pixel dimensions for images, probed on the sanitized bytes (what
  // the browser actually decodes; the JPEG path has already stripped EXIF). A
  // miss is expected for a corrupt/truncated image and never blocks the upload:
  // width/height stay null and the outcome is logged as a structured warning.
  let width: number | null = null;
  let height: number | null = null;
  if (kind === 'image') {
    const dims = readImageDimensions(sanitized, mimeType);
    if (dims.ok) {
      width = dims.width;
      height = dims.height;
    } else {
      logger.warn('asset image dimension probe failed', {
        trace_id: input.traceId,
        workspace_id: input.workspaceId,
        mime_type: mimeType,
        reason: dims.reason,
      });
    }
  }
  // The bucket is the workspace's stored, permanent name, never derived here.
  const bucket = await repository.getAssetBucket(input.workspaceId);

  // --- Existing-asset path: add a version or return the matching one. ---
  if (existingAssetId !== null) {
    const same = await repository.findVersionByShaForAsset(existingAssetId, sha256);
    if (same) {
      if (!isFileVersionRef(same)) {
        throw new Error(
          `asset_version ${same.id} matched a file upload by sha256 but is not a stored file`,
        );
      }
      return ok(
        summaryFrom({
          assetId: existingAssetId,
          versionId: same.id,
          versionNumber: same.versionNumber,
          workspaceId: input.workspaceId,
          filename: input.filename,
          mimeType: same.mimeType,
          sizeBytes: same.sizeBytes,
          sha256: same.sha256,
          r2Key: same.r2Key,
          reused: true,
        }),
      );
    }

    const previousMax = await repository.maxVersionNumber(existingAssetId);
    const versionNumber = previousMax + 1;
    const versionId = uuidv7();
    const r2Key = buildR2Key({
      kind,
      assetId: existingAssetId,
      versionNumber,
      filename: input.filename,
    });

    await storage.ensureBucket(bucket, input.traceId);
    await storage.putObject({
      bucket,
      key: r2Key,
      body: sanitized,
      contentType: mimeType,
      traceId: input.traceId,
    });

    await repository.insertVersion({
      id: versionId,
      assetId: existingAssetId,
      workspaceId: input.workspaceId,
      versionNumber,
      kind,
      r2Key,
      mimeType,
      sha256,
      sizeBytes,
      width,
      height,
      uploadedBy: input.uploadedBy,
    });
    await repository.setCurrentVersion(existingAssetId, versionId);
    await repository.writeAudit({
      traceId: input.traceId,
      workspaceId: input.workspaceId,
      action: 'asset.version.create',
      entityId: existingAssetId,
      actorUserId: input.uploadedBy,
      payload: { version_id: versionId, version_number: versionNumber, sha256 },
    });

    return ok(
      summaryFrom({
        assetId: existingAssetId,
        versionId,
        versionNumber,
        workspaceId: input.workspaceId,
        filename: input.filename,
        mimeType,
        sizeBytes,
        sha256,
        r2Key,
        reused: false,
      }),
    );
  }

  // --- New-upload path: dedup by content, else create asset + version 1. ---
  const dedup = await repository.findVersionBySha({
    workspaceId: input.workspaceId,
    sha256,
    origin: input.origin,
    uploadedBy: input.uploadedBy,
  });
  if (dedup) {
    if (!isFileVersionRef(dedup)) {
      throw new Error(
        `asset_version ${dedup.id} matched a file upload by sha256 but is not a stored file`,
      );
    }
    return ok(
      summaryFrom({
        assetId: dedup.assetId,
        versionId: dedup.id,
        versionNumber: dedup.versionNumber,
        workspaceId: input.workspaceId,
        filename: input.filename,
        mimeType: dedup.mimeType,
        sizeBytes: dedup.sizeBytes,
        sha256: dedup.sha256,
        r2Key: dedup.r2Key,
        reused: true,
      }),
    );
  }

  const assetId = uuidv7();
  const versionId = uuidv7();
  const versionNumber = 1;
  const r2Key = buildR2Key({
    kind,
    assetId,
    versionNumber,
    filename: input.filename,
  });

  await storage.ensureBucket(bucket, input.traceId);
  await storage.putObject({
    bucket,
    key: r2Key,
    body: sanitized,
    contentType: mimeType,
    traceId: input.traceId,
  });

  // Resolve the shown name. filename always stays the original upload name;
  // display_name controls only what users see. Precedence: an explicit
  // displayName, else a folder upload's auto-name ("<folder> 1", ...), else null.
  const trimmedDisplay = input.displayName?.trim();
  let displayName: string | null;
  if (trimmedDisplay !== undefined && trimmedDisplay !== '') {
    displayName = trimmedDisplay;
  } else if (input.folderId != null) {
    displayName = await repository.nextFolderUploadName(input.workspaceId, input.folderId);
  } else {
    displayName = null;
  }

  await repository.insertAsset({
    id: assetId,
    workspaceId: input.workspaceId,
    filename: input.filename,
    uploadedBy: input.uploadedBy,
    folderId: input.folderId ?? null,
    displayName,
    origin: input.origin,
  });
  await repository.insertVersion({
    id: versionId,
    assetId,
    workspaceId: input.workspaceId,
    versionNumber,
    kind,
    r2Key,
    mimeType,
    sha256,
    sizeBytes,
    width,
    height,
    uploadedBy: input.uploadedBy,
  });
  await repository.setCurrentVersion(assetId, versionId);
  await repository.writeAudit({
    traceId: input.traceId,
    workspaceId: input.workspaceId,
    action: 'asset.create',
    entityId: assetId,
    actorUserId: input.uploadedBy,
    payload: { version_id: versionId, version_number: versionNumber, sha256, origin: input.origin },
  });

  return ok(
    summaryFrom({
      assetId,
      versionId,
      versionNumber,
      workspaceId: input.workspaceId,
      filename: input.filename,
      mimeType,
      sizeBytes,
      sha256,
      r2Key,
      reused: false,
    }),
  );
}

/** Input to {@link createLinkAsset}. The actor is the verified JWT sub. */
export interface LinkInput {
  workspaceId: string;
  uploadedBy: string;
  /** User-given asset name; stored as assets.filename. */
  name: string;
  /** The external URL; stored as asset_versions.external_url (^https?://). */
  url: string;
  traceId: string;
}

/**
 * Create a link asset: an assets row plus a single version-1 link version, with
 * current_version_id pointing at it. No R2, no sha256, no dedup - a link has no
 * bytes. The version's shape (kind='link', external_url set, byte columns null)
 * is fixed by the repository so it satisfies the DB's kind_shape_check. Mirrors
 * the new-upload path of {@link runUploadPipeline} without the storage steps.
 */
export async function createLinkAsset(
  repository: AssetRepository,
  input: LinkInput,
): Promise<AssetMetaSummary> {
  const assetId = uuidv7();
  const versionId = uuidv7();
  const versionNumber = 1;

  await repository.insertAsset({
    id: assetId,
    workspaceId: input.workspaceId,
    filename: input.name,
    uploadedBy: input.uploadedBy,
  });
  await repository.insertVersion({
    id: versionId,
    assetId,
    workspaceId: input.workspaceId,
    versionNumber,
    kind: 'link',
    externalUrl: input.url,
    uploadedBy: input.uploadedBy,
  });
  await repository.setCurrentVersion(assetId, versionId);
  await repository.writeAudit({
    traceId: input.traceId,
    workspaceId: input.workspaceId,
    action: 'asset.create',
    entityId: assetId,
    actorUserId: input.uploadedBy,
    payload: { version_id: versionId, version_number: versionNumber, external_url: input.url },
  });

  return {
    assetId,
    workspaceId: input.workspaceId,
    filename: input.name,
    currentVersionId: versionId,
    externalUrl: input.url,
  };
}

/**
 * Rename an asset: update assets.display_name only (the shown name). filename -
 * and therefore the file's extension and type glyph - is left intact, as are the
 * immutable version rows and attachments. Returns not_found for an unknown id or
 * one owned by another workspace, mirroring the cross-tenant guard elsewhere.
 */
export async function renameAsset(
  repository: AssetRepository,
  input: {
    workspaceId: string;
    assetId: string;
    name: string;
    actorUserId: string;
    traceId: string;
  },
): Promise<Result<AssetMetaSummary, UploadError>> {
  const asset = await repository.getAsset(input.workspaceId, input.assetId);
  // A chat file is not a library asset: it reads as not found here.
  if (!asset || asset.origin !== 'library') {
    return err({ code: 'not_found', message: 'Asset not found in this workspace.' });
  }

  await repository.renameAsset(input.workspaceId, input.assetId, input.name);
  await repository.writeAudit({
    traceId: input.traceId,
    workspaceId: input.workspaceId,
    action: 'asset.rename',
    entityId: input.assetId,
    actorUserId: input.actorUserId,
    payload: { display_name: input.name, previous_display_name: asset.display_name },
  });

  return ok({
    assetId: asset.id,
    workspaceId: asset.workspace_id,
    filename: asset.filename,
    displayName: input.name,
    currentVersionId: asset.current_version_id,
  });
}

/**
 * Read an asset's current summary, scoped to a workspace. Returns not_found for
 * an unknown id OR one owned by another workspace - this is the API-layer
 * cross-tenant guard for r2_keys.
 */
export async function getAssetSummary(
  repository: AssetRepository,
  input: { workspaceId: string; assetId: string },
): Promise<Result<AssetSummary, UploadError>> {
  const asset = await repository.getAsset(input.workspaceId, input.assetId);
  // A chat file is not a library asset: it reads as not found (no existence leak).
  if (!asset || asset.origin !== 'library' || asset.current_version_id === null) {
    return err({ code: 'not_found', message: 'Asset not found in this workspace.' });
  }
  const current = await repository.getVersionById(input.workspaceId, asset.current_version_id);
  if (!current) {
    return err({ code: 'not_found', message: 'Asset version not found.' });
  }
  if (!isFileVersionRef(current)) {
    throw new Error(`asset_version ${current.id} is the current version but is not a stored file`);
  }
  return ok({
    assetId: asset.id,
    versionId: current.id,
    versionNumber: current.versionNumber,
    workspaceId: asset.workspace_id,
    filename: asset.filename,
    mimeType: current.mimeType,
    sizeBytes: current.sizeBytes,
    sha256: current.sha256,
    r2Key: current.r2Key,
    reused: false,
  });
}

// ---------------------------------------------------------------------------
// Thumbnail rendition (sender-made JPEG for a pdf/video/office upload, or a
// raster image's small list copy).
// ---------------------------------------------------------------------------

/** Server-side caps; the client's numbers are never trusted. */
export const THUMBNAIL_MAX_BYTES = 300 * 1024;
export const THUMBNAIL_MAX_WIDTH = 580;
export const THUMBNAIL_MAX_HEIGHT = 1160;
export const THUMBNAIL_MAX_PAGE_COUNT = 10_000;

export interface ThumbnailDeps {
  storage: StorageClient;
  repository: AssetRepository;
  renditions: RenditionStore;
}

export interface ThumbnailInput {
  /** The upload's result: the parent version the thumbnail belongs to. */
  summary: AssetSummary;
  /** The `thumbnail` part's bytes. */
  bytes: Uint8Array;
  /** The raw `thumbnail_page_count` field, or null when absent. */
  pageCountField: string | null;
  traceId: string;
}

export type ThumbnailOutcome =
  | { stored: true; width: number; height: number; pageCount?: number }
  | { stored: false; reason: string };

/** The page count field: absent is null, a decimal 1..10000 is the number, else invalid. */
export function parsePageCount(field: string | null): number | null | 'invalid' {
  if (field === null) return null;
  if (!/^[0-9]{1,5}$/.test(field)) return 'invalid';
  const n = Number(field);
  return n >= 1 && n <= THUMBNAIL_MAX_PAGE_COUNT ? n : 'invalid';
}

/**
 * Validate a thumbnail part against the server's own reading of it: the
 * parent version must be a pdf, video, docx, xlsx or raster image (never pptx or svg), the
 * bytes a JPEG (FF D8 FF) of at
 * most 300 KiB whose SOF frame (parsed here) is at most 580 x 1160, and the
 * page count absent or 1..10000. Pure; the reason names the first miss.
 */
export function checkThumbnail(
  input: Pick<ThumbnailInput, 'summary' | 'bytes' | 'pageCountField'>,
):
  | { ok: true; width: number; height: number; pageCount: number | null }
  | { ok: false; reason: string } {
  const parent = normalizeMime(input.summary.mimeType);
  const kind =
    parent === 'application/pdf'
      ? 'pdf'
      : parent.startsWith('video/')
        ? 'video'
        : parent === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
            parent === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
          ? 'office'
          : parent.startsWith('image/') && parent !== 'image/svg+xml'
            ? 'image'
            : null;
  if (kind === null) return { ok: false, reason: 'parent_not_pdf_or_video' };
  const { bytes } = input;
  if (bytes.byteLength === 0 || bytes.byteLength > THUMBNAIL_MAX_BYTES) {
    return { ok: false, reason: 'size' };
  }
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
    return { ok: false, reason: 'not_jpeg' };
  }
  const dims = readImageDimensions(bytes, 'image/jpeg');
  if (!dims.ok) return { ok: false, reason: 'no_frame' };
  if (dims.width > THUMBNAIL_MAX_WIDTH || dims.height > THUMBNAIL_MAX_HEIGHT) {
    return { ok: false, reason: 'dimensions' };
  }
  const pages = parsePageCount(input.pageCountField);
  if (pages === 'invalid') return { ok: false, reason: 'page_count' };
  // A page count only means something on a PDF.
  return {
    ok: true,
    width: dims.width,
    height: dims.height,
    pageCount: kind === 'pdf' ? pages : null,
  };
}

/**
 * Store the sender's thumbnail as the version's 'thumbnail' rendition: R2 put
 * at {kindFolder}/{asset_id}/v{n}-thumb.jpg, then the row (ON CONFLICT DO
 * NOTHING). A deduped upload writes only when the version has none yet. An
 * invalid thumbnail is ignored ({stored:false}); a storage or DB fault throws
 * and the caller logs it, the upload itself having already succeeded. An R2
 * object whose row insert then fails stays as an orphan (accepted).
 */
export async function storeThumbnailRendition(
  deps: ThumbnailDeps,
  input: ThumbnailInput,
): Promise<ThumbnailOutcome> {
  const checked = checkThumbnail(input);
  if (!checked.ok) return { stored: false, reason: checked.reason };
  // A pdf's page count is saved on its version once (never overwritten), in
  // parallel with the rendition; a failure is logged and never fails the upload.
  const pageWrite =
    checked.pageCount === null
      ? Promise.resolve()
      : savePageCount(deps.repository, input.summary.versionId, checked.pageCount, input.traceId);
  try {
    return await storeCheckedThumbnail(deps, input, checked);
  } finally {
    await pageWrite;
  }
}

async function savePageCount(
  repository: AssetRepository,
  versionId: string,
  pageCount: number,
  traceId: string,
): Promise<void> {
  try {
    await repository.setVersionPageCount(versionId, pageCount);
  } catch (err) {
    logger.warn('asset page count save failed', {
      trace_id: traceId,
      version_id: versionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function storeCheckedThumbnail(
  deps: ThumbnailDeps,
  input: ThumbnailInput,
  checked: { width: number; height: number; pageCount: number | null },
): Promise<ThumbnailOutcome> {
  const pageCount = checked.pageCount !== null ? { pageCount: checked.pageCount } : {};
  const { summary } = input;

  const existing = await deps.renditions.findRendition(summary.versionId, 'thumbnail');
  if (existing !== null) {
    if (existing.width === null || existing.height === null) {
      return { stored: false, reason: 'existing_without_size' };
    }
    return { stored: true, width: existing.width, height: existing.height, ...pageCount };
  }

  const kind = fileKindForMime(normalizeMime(summary.mimeType));
  const r2Key = buildThumbnailKey({
    kind,
    assetId: summary.assetId,
    versionNumber: summary.versionNumber,
  });
  // A file literally named "thumb.jpg" keys to the same object: never overwrite it.
  if (r2Key === summary.r2Key) return { stored: false, reason: 'key_collision' };

  const bucket = await deps.repository.getAssetBucket(summary.workspaceId);
  await deps.storage.putObject({
    bucket,
    key: r2Key,
    body: input.bytes,
    contentType: 'image/jpeg',
    traceId: input.traceId,
  });
  const inserted = await deps.renditions.insertRendition({
    id: uuidv7(),
    assetVersionId: summary.versionId,
    workspaceId: summary.workspaceId,
    role: 'thumbnail',
    r2Key,
    mimeType: 'image/jpeg',
    sha256: await computeSha256(input.bytes),
    sizeBytes: input.bytes.byteLength,
    width: checked.width,
    height: checked.height,
  });
  if (!inserted) {
    // Another upload of the same version won the insert: report its row.
    const winner = await deps.renditions.findRendition(summary.versionId, 'thumbnail');
    if (winner === null || winner.width === null || winner.height === null) {
      return { stored: false, reason: 'conflict' };
    }
    return { stored: true, width: winner.width, height: winner.height, ...pageCount };
  }
  return { stored: true, width: checked.width, height: checked.height, ...pageCount };
}
