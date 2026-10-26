// Resumable uploads for the asset-upload Worker: R2 multipart through the
// Worker, then the assembled bytes run the same upload pipeline as a direct
// POST, so the 100 MB cap and every file-type rule stay where they are. The
// workspace storage cap runs at create (declared size) and again at complete
// (the real assembled size) before the parts are assembled.
//
// Stateless by design (no table holds upload sessions): the staging object key
// is `uploads/{workspace_id}/{upload_uuid}` (keys.ts uploadStagingKey), separate
// from the final key, and every call checks the key belongs to the workspace
// the verified caller is an active member of before touching R2. R2's own
// upload_id (unguessable) is needed too. The client keeps {key, upload_id} and
// can list the parts R2 already holds to resume from the last finished part
// after a dropped connection. The pipeline then stores the assembled bytes
// under the version's final key and the staging object is deleted.
//
// No call here ever creates a bucket. Create resolves the workspace's upload
// target (moving an empty legacy workspace to the shared bucket); a missing
// bucket is logged loudly and fails the call.
//
// Parts are a fixed 8 MB (the last one smaller), which R2 requires: every part
// but the last must be the same size.

import {
  UPLOAD_STAGING_PREFIX,
  isAllowedMime,
  isNoSuchBucketError,
  uploadStagingKey,
  type MultipartStorage,
  type StorageClient,
  type UploadedPart,
} from '@srtdio/storage';
import { MAX_FILE_SIZE_BYTES, err, ok, type Result } from '@/server/assets';
import { logger } from '@/server/logger';

export const MULTIPART_PART_SIZE = 8 * 1024 * 1024;

/** Most parts a file under the cap can need (100 MB / 8 MB, rounded up). */
export const MULTIPART_MAX_PARTS = Math.ceil(MAX_FILE_SIZE_BYTES / MULTIPART_PART_SIZE);

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

export type MultipartErrorCode =
  | 'bad_request'
  | 'forbidden'
  | 'not_found'
  | 'file_too_large'
  | 'empty_file'
  | 'unsupported_mime'
  | 'workspace_full'
  | 'usage_unavailable';

export interface MultipartError {
  code: MultipartErrorCode;
  message: string;
}

export interface MultipartDeps {
  storage: StorageClient & MultipartStorage;
  /** The workspace's stored R2 bucket (workspaces.asset_bucket), where its staging lives. */
  bucketFor(workspaceId: string): Promise<string>;
  /**
   * The bucket a new upload writes to (resolveUploadTarget in the Worker): may
   * move an empty legacy workspace to the shared bucket first. Create only.
   */
  uploadBucketFor(workspaceId: string, traceId: string): Promise<string>;
  /** Fresh upload id for a staging key; crypto.randomUUID in the Worker. */
  newId(): string;
  /** The workspace storage cap (checkWorkspaceCap in the Worker). */
  checkCap(input: {
    workspaceId: string;
    addBytes: number;
    traceId: string;
  }): Promise<Result<null, MultipartError>>;
}

/** The staging key for one upload into one workspace: uploads/<workspace_id>/<upload_id>. */
export function stagingKey(workspaceId: string, uploadId: string): string {
  return uploadStagingKey({ workspaceId, uploadId });
}

/** True when the key is a staging key minted for this workspace. */
export function ownsStagingKey(workspaceId: string, key: string): boolean {
  if (!new RegExp(`^${UUID}$`, 'i').test(workspaceId)) return false;
  return new RegExp(`^${UPLOAD_STAGING_PREFIX}${workspaceId}/${UUID}$`, 'i').test(key);
}

/** How many parts a file of this size uploads as. */
export function partCount(size: number): number {
  return Math.max(1, Math.ceil(size / MULTIPART_PART_SIZE));
}

interface Target {
  userId: string;
  workspaceId: string;
  key: string;
  uploadId: string;
  traceId: string;
}

function checkKey(input: Target): Result<null, MultipartError> {
  if (!ownsStagingKey(input.workspaceId, input.key)) {
    return err({ code: 'forbidden', message: 'This upload belongs to another workspace.' });
  }
  if (input.uploadId === '' || input.uploadId.length > 1024) {
    return err({ code: 'bad_request', message: 'Invalid upload_id.' });
  }
  return ok(null);
}

/**
 * Start a resumable upload. Size and type are pre-checked here so a file the
 * pipeline would refuse never sends a byte; the pipeline checks again on
 * complete.
 */
export async function createUpload(
  deps: MultipartDeps,
  input: {
    userId: string;
    workspaceId: string;
    size: number;
    contentType: string;
    traceId: string;
  },
): Promise<
  Result<{ key: string; uploadId: string; partSize: number; partCount: number }, MultipartError>
> {
  if (!Number.isInteger(input.size) || input.size < 0) {
    return err({ code: 'bad_request', message: 'size must be a whole number of bytes.' });
  }
  if (input.size === 0) {
    return err({ code: 'empty_file', message: 'File is empty.' });
  }
  if (input.size > MAX_FILE_SIZE_BYTES) {
    return err({ code: 'file_too_large', message: `File exceeds ${MAX_FILE_SIZE_BYTES} bytes.` });
  }
  if (!isAllowedMime(input.contentType)) {
    return err({ code: 'unsupported_mime', message: 'This file type is not supported.' });
  }
  const cap = await deps.checkCap({
    workspaceId: input.workspaceId,
    addBytes: input.size,
    traceId: input.traceId,
  });
  if (!cap.ok) return cap;
  const bucket = await deps.uploadBucketFor(input.workspaceId, input.traceId);
  const key = stagingKey(input.workspaceId, deps.newId());
  let uploadId: string;
  try {
    uploadId = await deps.storage.createMultipartUpload({
      bucket,
      key,
      contentType: input.contentType,
      traceId: input.traceId,
    });
  } catch (error) {
    if (isNoSuchBucketError(error)) {
      logger.error('asset upload target bucket does not exist; uploads never create buckets', {
        trace_id: input.traceId,
        workspace_id: input.workspaceId,
        bucket,
      });
    }
    throw error;
  }
  return ok({
    key,
    uploadId,
    partSize: MULTIPART_PART_SIZE,
    partCount: partCount(input.size),
  });
}

/** Store one part. Every part is at most 8 MB; R2 enforces equal sizes on complete. */
export async function uploadPart(
  deps: MultipartDeps,
  input: Target & { partNumber: number; body: Uint8Array },
): Promise<Result<{ partNumber: number; etag: string }, MultipartError>> {
  const checked = checkKey(input);
  if (!checked.ok) return checked;
  if (
    !Number.isInteger(input.partNumber) ||
    input.partNumber < 1 ||
    input.partNumber > MULTIPART_MAX_PARTS
  ) {
    return err({
      code: 'bad_request',
      message: `part_number must be 1 to ${MULTIPART_MAX_PARTS}.`,
    });
  }
  if (input.body.byteLength === 0) {
    return err({ code: 'empty_file', message: 'Part is empty.' });
  }
  if (input.body.byteLength > MULTIPART_PART_SIZE) {
    return err({ code: 'file_too_large', message: 'Part exceeds 8 MB.' });
  }
  const bucket = await deps.bucketFor(input.workspaceId);
  const existing = await deps.storage.listParts({
    bucket,
    key: input.key,
    uploadId: input.uploadId,
    traceId: input.traceId,
  });
  if (existing === null) {
    return err({ code: 'not_found', message: 'Upload not found.' });
  }
  const etag = await deps.storage.uploadPart({
    bucket,
    key: input.key,
    uploadId: input.uploadId,
    partNumber: input.partNumber,
    body: input.body,
    traceId: input.traceId,
  });
  return ok({ partNumber: input.partNumber, etag });
}

/** The parts already stored, so a client can resume after the last finished one. */
export async function listUploadedParts(
  deps: MultipartDeps,
  input: Target,
): Promise<Result<UploadedPart[], MultipartError>> {
  const checked = checkKey(input);
  if (!checked.ok) return checked;
  const bucket = await deps.bucketFor(input.workspaceId);
  const parts = await deps.storage.listParts({
    bucket,
    key: input.key,
    uploadId: input.uploadId,
    traceId: input.traceId,
  });
  if (parts === null) {
    return err({ code: 'not_found', message: 'Upload not found.' });
  }
  return ok(parts);
}

/** Drop an unfinished upload. Idempotent. */
export async function abortUpload(
  deps: MultipartDeps,
  input: Target,
): Promise<Result<null, MultipartError>> {
  const checked = checkKey(input);
  if (!checked.ok) return checked;
  const bucket = await deps.bucketFor(input.workspaceId);
  await deps.storage.abortMultipartUpload({
    bucket,
    key: input.key,
    uploadId: input.uploadId,
    traceId: input.traceId,
  });
  return ok(null);
}

/**
 * Check the stored parts form one valid file: numbered 1..n with no gap, every
 * part but the last exactly 8 MB, the total within the cap.
 */
export function validateParts(parts: readonly UploadedPart[]): Result<null, MultipartError> {
  if (parts.length === 0) {
    return err({ code: 'empty_file', message: 'No parts were uploaded.' });
  }
  let total = 0;
  for (const [index, part] of parts.entries()) {
    if (part.partNumber !== index + 1) {
      return err({ code: 'bad_request', message: `Part ${index + 1} is missing.` });
    }
    const last = index === parts.length - 1;
    if (!last && part.size !== MULTIPART_PART_SIZE) {
      return err({ code: 'bad_request', message: `Part ${part.partNumber} is not 8 MB.` });
    }
    total += part.size;
  }
  if (total > MAX_FILE_SIZE_BYTES) {
    return err({ code: 'file_too_large', message: `File exceeds ${MAX_FILE_SIZE_BYTES} bytes.` });
  }
  return ok(null);
}

/** Drop a refused upload's parts and staging object. Best effort, never throws. */
async function discardStaged(deps: MultipartDeps, bucket: string, input: Target): Promise<void> {
  try {
    await deps.storage.abortMultipartUpload({
      bucket,
      key: input.key,
      uploadId: input.uploadId,
      traceId: input.traceId,
    });
  } catch (error) {
    logger.error('multipart abort after refusal failed', { key: input.key, error: String(error) });
  }
  try {
    await deps.storage.deleteObject(bucket, input.key, input.traceId);
  } catch (error) {
    logger.error('multipart staging delete after refusal failed', {
      key: input.key,
      error: String(error),
    });
  }
}

/**
 * Assemble the parts and read the whole file back for the pipeline. A retried
 * complete (the first one assembled the object but its response was lost)
 * finds no upload and reads the already-assembled staging object instead.
 * The workspace cap runs on the real size before assembly (or, on a retry, on
 * the assembled object); a refused upload is aborted and its staging removed.
 */
export async function completeUpload(
  deps: MultipartDeps,
  input: Target,
): Promise<Result<{ bucket: string; bytes: Uint8Array }, MultipartError>> {
  const checked = checkKey(input);
  if (!checked.ok) return checked;
  const bucket = await deps.bucketFor(input.workspaceId);
  const fits = async (addBytes: number): Promise<Result<null, MultipartError>> => {
    const cap = await deps.checkCap({
      workspaceId: input.workspaceId,
      addBytes,
      traceId: input.traceId,
    });
    if (!cap.ok) await discardStaged(deps, bucket, input);
    return cap;
  };
  const parts = await deps.storage.listParts({
    bucket,
    key: input.key,
    uploadId: input.uploadId,
    traceId: input.traceId,
  });
  if (parts !== null) {
    const valid = validateParts(parts);
    if (!valid.ok) return valid;
    const cap = await fits(parts.reduce((total, part) => total + part.size, 0));
    if (!cap.ok) return cap;
    await deps.storage.completeMultipartUpload({
      bucket,
      key: input.key,
      uploadId: input.uploadId,
      parts,
      traceId: input.traceId,
    });
  }
  const bytes = await deps.storage.getObject(bucket, input.key, input.traceId);
  if (bytes === null) {
    return err({ code: 'not_found', message: 'Upload not found.' });
  }
  if (bytes.byteLength > MAX_FILE_SIZE_BYTES) {
    await deps.storage.deleteObject(bucket, input.key, input.traceId);
    return err({ code: 'file_too_large', message: `File exceeds ${MAX_FILE_SIZE_BYTES} bytes.` });
  }
  if (parts === null) {
    const cap = await fits(bytes.byteLength);
    if (!cap.ok) return cap;
  }
  return ok({ bucket, bytes });
}
