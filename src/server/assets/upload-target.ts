// Where an upload's bytes go: which bucket, and which key layout.
//
//   - Workspace already on the shared bucket (asset_bucket === SHARED_ASSET_BUCKET):
//     write there, ID-only keys (keys.ts versionKey / renditionKey).
//   - Workspace on a legacy per-workspace bucket that holds no stored objects:
//     move it to the shared bucket first (storage_workspace_move, which only
//     renames keys and flips asset_bucket; there are no bytes to copy), then
//     write there with ID-only keys. If the move raises object_count_changed,
//     re-read the bucket: shared if someone else moved it, else the legacy path.
//   - Legacy bucket that already holds files: keep writing there, legacy keys,
//     until the move job moves the whole workspace.
//
// The decision is the pure planUploadTarget; resolveUploadTarget is its IO
// wrapper. Nothing here ever creates a bucket.

import { legacyThumbnailKey, legacyVersionKey, renditionKey, versionKey } from '@srtdio/storage';
import { logger } from '../logger';
import type { AssetRepository } from './repository';

export type UploadLayout = 'shared' | 'legacy';

export interface UploadTarget {
  bucket: string;
  layout: UploadLayout;
}

export type UploadTargetPlan =
  | { action: 'write'; target: UploadTarget }
  /** Move the workspace to the shared bucket, then write there with ID-only keys. */
  | { action: 'move'; sharedBucket: string };

/**
 * The upload target decision. `storedObjects` is the workspace's count of
 * stored objects (versions + renditions with a bucket key), or null when it
 * was not counted or a move must not be tried (after a failed move).
 */
export function planUploadTarget(input: {
  workspaceBucket: string;
  sharedBucket: string;
  storedObjects: number | null;
}): UploadTargetPlan {
  if (input.sharedBucket === '') {
    throw new Error('SHARED_ASSET_BUCKET is not set');
  }
  if (input.workspaceBucket === input.sharedBucket) {
    return { action: 'write', target: { bucket: input.sharedBucket, layout: 'shared' } };
  }
  if (input.storedObjects === 0) {
    return { action: 'move', sharedBucket: input.sharedBucket };
  }
  return { action: 'write', target: { bucket: input.workspaceBucket, layout: 'legacy' } };
}

/** The repository calls resolveUploadTarget needs. */
export type UploadTargetRepository = Pick<
  AssetRepository,
  'getAssetBucket' | 'countStoredObjects' | 'countKeyedRows' | 'moveWorkspaceStorage'
>;

/**
 * Resolve the upload target for a workspace, moving an empty legacy workspace
 * to the shared bucket on the way (one storage_workspace_move call at most).
 * Counts are head queries and run only for a legacy workspace.
 */
export async function resolveUploadTarget(
  repository: UploadTargetRepository,
  input: { workspaceId: string; sharedBucket: string; traceId: string },
): Promise<UploadTarget> {
  const workspaceBucket = await repository.getAssetBucket(input.workspaceId);
  const storedObjects =
    workspaceBucket === input.sharedBucket
      ? null
      : await repository.countStoredObjects(input.workspaceId);
  const plan = planUploadTarget({
    workspaceBucket,
    sharedBucket: input.sharedBucket,
    storedObjects,
  });
  if (plan.action === 'write') return plan.target;

  // No bytes in a bucket. Rows with an r2_key can still exist (the onboarding
  // sample's induction-sample/ keys, which the move leaves alone); the RPC
  // compares p_expected_objects with all of them, so pass that count.
  const expectedObjects = await repository.countKeyedRows(input.workspaceId);
  const moved = await repository.moveWorkspaceStorage({
    workspaceId: input.workspaceId,
    bucket: plan.sharedBucket,
    expectedObjects,
    traceId: input.traceId,
  });
  if (moved.moved) {
    logger.info('workspace moved to the shared asset bucket on first upload', {
      trace_id: input.traceId,
      workspace_id: input.workspaceId,
      bucket: plan.sharedBucket,
    });
    return { bucket: plan.sharedBucket, layout: 'shared' };
  }

  logger.warn('workspace move on first upload lost a race; object count changed', {
    trace_id: input.traceId,
    workspace_id: input.workspaceId,
    expected_objects: expectedObjects,
    live_count: moved.liveCount,
  });
  // A concurrent upload may have moved it already; never try a second move.
  const after = planUploadTarget({
    workspaceBucket: await repository.getAssetBucket(input.workspaceId),
    sharedBucket: input.sharedBucket,
    storedObjects: null,
  });
  if (after.action !== 'write') {
    throw new Error('upload target plan asked for a second move');
  }
  return after.target;
}

/** The key of a version's own bytes for the target's layout. */
export function originalKeyFor(
  layout: UploadLayout,
  input: {
    workspaceId: string;
    assetId: string;
    versionId: string;
    versionNumber: number;
    kind: string;
    filename: string;
  },
): string {
  return layout === 'shared'
    ? versionKey({
        workspaceId: input.workspaceId,
        assetId: input.assetId,
        versionId: input.versionId,
      })
    : legacyVersionKey({
        kind: input.kind,
        assetId: input.assetId,
        versionNumber: input.versionNumber,
        filename: input.filename,
      });
}

/** The key of a version's thumbnail rendition for the target's layout. */
export function thumbnailKeyFor(
  layout: UploadLayout,
  input: {
    workspaceId: string;
    assetId: string;
    versionId: string;
    versionNumber: number;
    kind: string;
  },
): string {
  return layout === 'shared'
    ? renditionKey({
        workspaceId: input.workspaceId,
        assetId: input.assetId,
        versionId: input.versionId,
        role: 'thumbnail',
      })
    : legacyThumbnailKey({
        kind: input.kind,
        assetId: input.assetId,
        versionNumber: input.versionNumber,
      });
}

/** The layout already in force for a workspace bucket, without moving anything. */
export function layoutOfBucket(bucket: string, sharedBucket: string): UploadLayout {
  return bucket === sharedBucket ? 'shared' : 'legacy';
}
