// Dev-seed asset safety: buildAssetPlan with devSeed: true must shape the
// asset/version/attachment rows WITHOUT fetching any bytes or uploading to R2.
// The stubs here throw on use, so any network read or R2 write fails the test;
// the rows are still asserted to satisfy asset_versions_kind_shape (a non-link
// version carries r2_key + sha256 + size_bytes + mime_type, external_url null).

import { describe, expect, it } from 'vitest';

import {
  buildAssetPlan,
  type FetchResult,
  type MediaItem,
  type PlanContext,
} from '../src/assets.ts';

const CTX: PlanContext = {
  workspaceId: '0190a000-0000-7000-8000-0000000000ws',
  operatorUserId: '0190a000-0000-7000-8000-0000000000op',
  bucket: 'assets-test',
  traceId: '0190a000-0000-7000-8000-0000000000tr',
};

// A StorageClient stand-in that fails the test if anything tries to upload. The
// records arrays let us assert positively that no upload happened.
function noUploadStorage() {
  const uploads: string[] = [];
  const buckets: string[] = [];
  const storage = {
    ensureBucket: (bucket: string): Promise<void> => {
      buckets.push(bucket);
      return Promise.resolve();
    },
    putObject: (input: { key: string }): Promise<void> => {
      uploads.push(input.key);
      throw new Error(`dev-seed must not upload to R2 (got putObject for '${input.key}')`);
    },
  };
  return { storage, uploads, buckets };
}

// A fetch that fails the test if called: dev-seed must fetch no bytes.
function noFetchBytes() {
  const calls: string[] = [];
  const fetchBytes = (url: string): Promise<FetchResult> => {
    calls.push(url);
    throw new Error(`dev-seed must not fetch bytes (got fetch for '${url}')`);
  };
  return { fetchBytes, calls };
}

const fileItem = (url: string, position: number): MediaItem => ({
  type: 'file',
  url,
  entityType: 'post',
  entityId: '0190a000-0000-7000-8000-00000000post',
  position,
});

describe('buildAssetPlan dev-seed (no bytes, no upload)', () => {
  it('shapes one image asset/version/attachment without fetching or uploading', async () => {
    const { storage, uploads } = noUploadStorage();
    const { fetchBytes, calls } = noFetchBytes();

    const plan = await buildAssetPlan([fileItem('https://x.io/a.jpg', 0)], CTX, {
      storage,
      fetchBytes,
      devSeed: true,
    });

    // Exactly one of each row, no failures.
    expect(plan.assetRows).toHaveLength(1);
    expect(plan.versionRows).toHaveLength(1);
    expect(plan.attachmentRows).toHaveLength(1);
    expect(plan.summary).toMatchObject({ filesMigrated: 1, failed: 0 });

    // kind_shape compliance: real image kind, synthetic-but-present byte columns,
    // external_url null.
    const v = plan.versionRows[0];
    expect(v?.kind).toBe('image');
    expect(typeof v?.r2_key).toBe('string');
    expect((v?.r2_key as string).length).toBeGreaterThan(0);
    expect(v?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(v?.size_bytes as number).toBeGreaterThan(0);
    expect(v?.mime_type).toBe('image/jpeg');
    expect(v?.external_url).toBeNull();

    // Proof: neither stub was ever invoked (no network read, no R2 write).
    expect(calls).toHaveLength(0);
    expect(uploads).toHaveLength(0);
  });

  it('dedups two attachments of the same url to one asset, still no I/O', async () => {
    const { storage, uploads } = noUploadStorage();
    const { fetchBytes, calls } = noFetchBytes();

    const plan = await buildAssetPlan(
      [fileItem('https://x.io/a.jpg', 0), fileItem('https://x.io/a.jpg', 1)],
      CTX,
      { storage, fetchBytes, devSeed: true },
    );

    expect(plan.assetRows).toHaveLength(1);
    expect(plan.versionRows).toHaveLength(1);
    expect(plan.attachmentRows).toHaveLength(2);
    expect(plan.summary).toMatchObject({ filesMigrated: 1, deduped: 1 });

    const versionId = plan.versionRows[0]?.id;
    expect(plan.attachmentRows.every((r) => r.asset_version_id === versionId)).toBe(true);

    expect(calls).toHaveLength(0);
    expect(uploads).toHaveLength(0);
  });
});
