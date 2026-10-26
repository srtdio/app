import { describe, expect, it } from 'vitest';
import { InMemoryAssetRepository } from './repository';
import {
  layoutOfBucket,
  originalKeyFor,
  planUploadTarget,
  resolveUploadTarget,
  thumbnailKeyFor,
} from './upload-target';

const WS = '11111111-1111-7111-8111-111111111111';
const ASSET = '55555555-5555-7555-8555-555555555555';
const VERSION = '66666666-6666-7666-8666-666666666666';
const USER = '33333333-3333-7333-8333-333333333333';
const TRACE = '0192f8a0-7d3e-7c4b-9a1f-2b3c4d5e6f70';
const SHARED = 'srtdio-files';
const LEGACY = 'assets-acme';

describe('planUploadTarget', () => {
  it('a workspace on the shared bucket writes there with ID-only keys, no move', () => {
    expect(
      planUploadTarget({ workspaceBucket: SHARED, sharedBucket: SHARED, storedObjects: null }),
    ).toEqual({ action: 'write', target: { bucket: SHARED, layout: 'shared' } });
    expect(
      planUploadTarget({ workspaceBucket: SHARED, sharedBucket: SHARED, storedObjects: 0 }),
    ).toEqual({ action: 'write', target: { bucket: SHARED, layout: 'shared' } });
  });

  it('an empty legacy workspace moves to the shared bucket', () => {
    expect(
      planUploadTarget({ workspaceBucket: LEGACY, sharedBucket: SHARED, storedObjects: 0 }),
    ).toEqual({ action: 'move', sharedBucket: SHARED });
  });

  it('a legacy workspace with files keeps its bucket and the legacy layout', () => {
    expect(
      planUploadTarget({ workspaceBucket: LEGACY, sharedBucket: SHARED, storedObjects: 3 }),
    ).toEqual({ action: 'write', target: { bucket: LEGACY, layout: 'legacy' } });
  });

  it('after a failed move (count unknown) a legacy workspace stays legacy', () => {
    expect(
      planUploadTarget({ workspaceBucket: LEGACY, sharedBucket: SHARED, storedObjects: null }),
    ).toEqual({ action: 'write', target: { bucket: LEGACY, layout: 'legacy' } });
  });

  it('refuses to run without a shared bucket name', () => {
    expect(() =>
      planUploadTarget({ workspaceBucket: LEGACY, sharedBucket: '', storedObjects: 0 }),
    ).toThrow('SHARED_ASSET_BUCKET');
  });
});

function legacyRepo(): InMemoryAssetRepository {
  const repo = new InMemoryAssetRepository();
  repo.assetBuckets.set(WS, LEGACY);
  return repo;
}

async function seedVersion(repo: InMemoryAssetRepository, r2Key: string): Promise<void> {
  await repo.insertVersion({
    id: VERSION,
    assetId: ASSET,
    workspaceId: WS,
    versionNumber: 1,
    kind: 'image',
    r2Key,
    mimeType: 'image/png',
    sha256: 'a'.repeat(64),
    sizeBytes: 10,
    uploadedBy: USER,
  });
}

describe('resolveUploadTarget', () => {
  const input = { workspaceId: WS, sharedBucket: SHARED, traceId: TRACE };

  it('zero objects: calls storage_workspace_move once with 0, then the shared layout', async () => {
    const repo = legacyRepo();
    const target = await resolveUploadTarget(repo, input);
    expect(target).toEqual({ bucket: SHARED, layout: 'shared' });
    expect(repo.moves).toEqual([
      { workspaceId: WS, bucket: SHARED, expectedObjects: 0, traceId: TRACE },
    ]);
    expect(await repo.getAssetBucket(WS)).toBe(SHARED);
  });

  it('shared bucket: no count, no move', async () => {
    const repo = new InMemoryAssetRepository();
    repo.assetBuckets.set(WS, SHARED);
    repo.countStoredObjects = () => Promise.reject(new Error('must not count'));
    const target = await resolveUploadTarget(repo, input);
    expect(target).toEqual({ bucket: SHARED, layout: 'shared' });
    expect(repo.moves).toHaveLength(0);
  });

  it('legacy bucket with files: legacy layout, no move', async () => {
    const repo = legacyRepo();
    await seedVersion(repo, `images/${ASSET}/v1-a.png`);
    const target = await resolveUploadTarget(repo, input);
    expect(target).toEqual({ bucket: LEGACY, layout: 'legacy' });
    expect(repo.moves).toHaveLength(0);
  });

  it('a legacy bucket holding only renditions still counts as holding files', async () => {
    const repo = legacyRepo();
    repo.renditionKeys.set(WS, [`images/${ASSET}/v1-thumb.jpg`]);
    expect(await resolveUploadTarget(repo, input)).toEqual({ bucket: LEGACY, layout: 'legacy' });
    expect(repo.moves).toHaveLength(0);
  });

  it('object_count_changed: falls back to the legacy path and never moves twice', async () => {
    const repo = legacyRepo();
    repo.moveConflict = { liveCount: 1 };
    const target = await resolveUploadTarget(repo, input);
    expect(target).toEqual({ bucket: LEGACY, layout: 'legacy' });
    expect(repo.moves).toHaveLength(1);
  });

  it('object_count_changed after a concurrent move: uses the shared bucket', async () => {
    const repo = legacyRepo();
    repo.moveWorkspaceStorage = (call) => {
      // Another upload moved the workspace between our count and our call.
      repo.assetBuckets.set(WS, call.bucket);
      return Promise.resolve({ moved: false, liveCount: 1 });
    };
    expect(await resolveUploadTarget(repo, input)).toEqual({ bucket: SHARED, layout: 'shared' });
  });

  it('onboarding sample rows hold no bytes: the move runs, expecting their count', async () => {
    const repo = legacyRepo();
    await seedVersion(repo, 'induction-sample/kr-ruffle.jpg');
    const target = await resolveUploadTarget(repo, input);
    expect(target).toEqual({ bucket: SHARED, layout: 'shared' });
    expect(repo.moves).toEqual([
      { workspaceId: WS, bucket: SHARED, expectedObjects: 1, traceId: TRACE },
    ]);
    // The move leaves sample keys alone.
    expect(repo.versions[0]?.r2_key).toBe('induction-sample/kr-ruffle.jpg');
  });

  it('a move fault other than object_count_changed propagates', async () => {
    const repo = legacyRepo();
    repo.moveWorkspaceStorage = () => Promise.reject(new Error('workspace not found'));
    await expect(resolveUploadTarget(repo, input)).rejects.toThrow('workspace not found');
  });
});

describe('keys per layout', () => {
  const ids = {
    workspaceId: WS,
    assetId: ASSET,
    versionId: VERSION,
    versionNumber: 2,
    kind: 'image',
  };

  it('shared layout keys carry ids only', () => {
    expect(originalKeyFor('shared', { ...ids, filename: 'Photo 1.png' })).toBe(
      `ws/${WS}/${ASSET}/${VERSION}/original`,
    );
    expect(thumbnailKeyFor('shared', ids)).toBe(`ws/${WS}/${ASSET}/${VERSION}/thumbnail`);
  });

  it('legacy layout keys keep the old shape', () => {
    expect(originalKeyFor('legacy', { ...ids, filename: 'Photo 1.png' })).toBe(
      `images/${ASSET}/v2-Photo_1.png`,
    );
    expect(thumbnailKeyFor('legacy', ids)).toBe(`images/${ASSET}/v2-thumb.jpg`);
  });

  it('layoutOfBucket compares with the shared bucket', () => {
    expect(layoutOfBucket(SHARED, SHARED)).toBe('shared');
    expect(layoutOfBucket(LEGACY, SHARED)).toBe('legacy');
  });
});
