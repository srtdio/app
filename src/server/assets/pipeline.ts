// The asset upload pipeline.
//
// Order (see PR description):
//   receive -> MIME allowlist -> size cap -> EXIF strip (images) ->
//   SVG sanitize (svg) -> virus scan -> sha256 -> R2 upload ->
//   insert asset (new) or asset_version (existing) -> bump current_version_id ->
//   return summary.
//
// Dedup: identical content (same sha256) within a workspace never stores twice.
// With no assetId, a matching hash returns the existing asset/version untouched.
// With an assetId, a matching hash returns that asset's existing version; a new
// hash appends version N+1 and advances current_version_id.
//
// Expected failures are returned as Result errors; only system faults throw.

import { v7 as uuidv7 } from 'uuid';
import { isAllowedMime, isJpegMime, isSvgMime, normalizeMime } from './mime';
import { stripJpegMetadata } from './exif';
import { sanitizeSvgBytes } from './svg';
import { computeSha256 } from './sha256';
import type { VirusScanner } from './virus-scan';
import { assetBucketName, buildR2Key, type StorageClient } from './storage';
import type { AssetRepository } from './repository';
import {
  err,
  ok,
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

/** Apply the format-specific sanitization step to the raw bytes. */
function sanitizeBytes(contentType: string, bytes: Uint8Array): Uint8Array {
  if (isSvgMime(contentType)) {
    return sanitizeSvgBytes(bytes);
  }
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

  // 1. MIME allowlist.
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

  // If a target asset is named, it must exist in this workspace (cross-tenant
  // and unknown ids are rejected here, not after doing work).
  let existingAssetId: string | null = null;
  if (input.assetId !== undefined) {
    const asset = await repository.getAsset(input.workspaceId, input.assetId);
    if (!asset) {
      return err({ code: 'not_found', message: 'Asset not found in this workspace.' });
    }
    existingAssetId = asset.id;
  }

  // 3-4. Sanitize: EXIF strip for JPEG, script/handler strip for SVG.
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
  const bucket = assetBucketName(input.workspaceId);

  // --- Existing-asset path: add a version or return the matching one. ---
  if (existingAssetId !== null) {
    const same = await repository.findVersionByShaForAsset(existingAssetId, sha256);
    if (same) {
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
      workspaceId: input.workspaceId,
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
      r2Key,
      mimeType,
      sha256,
      sizeBytes,
      uploadedBy: input.uploadedBy,
    });
    await repository.setCurrentVersion(existingAssetId, versionId);
    await repository.writeAudit({
      traceId: input.traceId,
      workspaceId: input.workspaceId,
      action: 'asset.version.create',
      entityId: existingAssetId,
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
  const dedup = await repository.findVersionBySha(input.workspaceId, sha256);
  if (dedup) {
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
    workspaceId: input.workspaceId,
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

  await repository.insertAsset({
    id: assetId,
    workspaceId: input.workspaceId,
    filename: input.filename,
    uploadedBy: input.uploadedBy,
  });
  await repository.insertVersion({
    id: versionId,
    assetId,
    workspaceId: input.workspaceId,
    versionNumber,
    r2Key,
    mimeType,
    sha256,
    sizeBytes,
    uploadedBy: input.uploadedBy,
  });
  await repository.setCurrentVersion(assetId, versionId);
  await repository.writeAudit({
    traceId: input.traceId,
    workspaceId: input.workspaceId,
    action: 'asset.create',
    entityId: assetId,
    payload: { version_id: versionId, version_number: versionNumber, sha256 },
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
  if (!asset || asset.current_version_id === null) {
    return err({ code: 'not_found', message: 'Asset not found in this workspace.' });
  }
  const current = await repository.getVersionById(input.workspaceId, asset.current_version_id);
  if (!current) {
    return err({ code: 'not_found', message: 'Asset version not found.' });
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
