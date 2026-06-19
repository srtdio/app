// Boundary coverage for the read-only cutover validator. No database, no real R2:
// the v1 counts, the v2 COUNT/SELECT, and the byte-presence probe are all injected.
// Object presence is backed by the in-memory storage client so a missing object is
// a real absence, not a stubbed boolean.

import { describe, expect, it } from 'vitest';

import { InMemoryStorageClient } from '@srtdio/storage';

import {
  validateCutover,
  type ImageVersionRow,
  type TableName,
  type ValidateDeps,
} from '../../packages/etl/src/validate';

const BUCKET = 'assets-test';

// v1 counts chosen so the plan is posts=3, briefs=2, post_versions=4+1=5, comments=5.
function sourceCounts(): ValidateDeps['source'] {
  return {
    countPosts: () => Promise.resolve(3),
    countRequests: () => Promise.resolve(2),
    countPostVersionsJoined: () => Promise.resolve(4),
    countPostsWithoutVersions: () => Promise.resolve(1),
    countMigratableComments: () => Promise.resolve(5),
  };
}

const PLAN_TARGET: Record<TableName, number> = {
  posts: 3,
  briefs: 2,
  post_versions: 5,
  comments: 5,
};

function fileRow(key: string, size = 2048): ImageVersionRow {
  return {
    kind: 'image',
    r2_key: key,
    sha256: 'a'.repeat(64),
    size_bytes: size,
    mime_type: 'image/jpeg',
    external_url: null,
  };
}

function linkRow(url = 'https://drive.example/folder'): ImageVersionRow {
  return {
    kind: 'link',
    r2_key: null,
    sha256: null,
    size_bytes: null,
    mime_type: null,
    external_url: url,
  };
}

interface Opts {
  targetOver?: Partial<Record<TableName, number>>;
  rows?: ImageVersionRow[];
  presentKeys?: string[];
}

function makeDeps(opts: Opts = {}): ValidateDeps {
  const storage = new InMemoryStorageClient();
  for (const key of opts.presentKeys ?? []) {
    void storage.putObject({
      bucket: BUCKET,
      key,
      body: new Uint8Array([1, 2, 3]),
      contentType: 'image/jpeg',
      traceId: 't',
    });
  }
  const target = { ...PLAN_TARGET, ...(opts.targetOver ?? {}) };
  return {
    source: sourceCounts(),
    countTargetRows: (t) => Promise.resolve(target[t]),
    readImageVersions: () => Promise.resolve(opts.rows ?? []),
    objectExists: (bucket, key) => Promise.resolve(storage.get(bucket, key) !== undefined),
    assetBucket: BUCKET,
  };
}

function check(
  report: { checks: Array<{ name: string; ok: boolean; detail: string }> },
  name: string,
) {
  const found = report.checks.find((c) => c.name === name);
  expect(found, `check '${name}' should exist`).toBeDefined();
  return found!;
}

describe('validateCutover', () => {
  it('passes when counts match and every object is present', async () => {
    const report = await validateCutover(
      makeDeps({
        rows: [fileRow('images/a/v1-a.jpg'), fileRow('images/b/v1-b.jpg'), linkRow()],
        presentKeys: ['images/a/v1-a.jpg', 'images/b/v1-b.jpg'],
      }),
    );
    expect(report.ok).toBe(true);
    expect(report.checks.every((c) => c.ok)).toBe(true);
    expect(check(report, 'bytes-present').detail).toBe('present=2 total=2');
    expect(report.digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('fails and names the table and delta on a count mismatch', async () => {
    const report = await validateCutover(
      makeDeps({
        targetOver: { comments: 4 },
        rows: [fileRow('images/a/v1-a.jpg')],
        presentKeys: ['images/a/v1-a.jpg'],
      }),
    );
    expect(report.ok).toBe(false);
    const comments = check(report, 'count:comments');
    expect(comments.ok).toBe(false);
    expect(comments.detail).toContain('delta=-1');
    // Non-vacuous: the other count checks still pass, so it is specifically the
    // comments table that flipped ok to false.
    expect(check(report, 'count:posts').ok).toBe(true);
    expect(check(report, 'count:briefs').ok).toBe(true);
    expect(check(report, 'count:post_versions').ok).toBe(true);
  });

  it('fails when a file object is absent from the bucket', async () => {
    const report = await validateCutover(
      makeDeps({
        rows: [fileRow('images/a/v1-a.jpg'), fileRow('images/missing/v1-x.jpg')],
        presentKeys: ['images/a/v1-a.jpg'],
      }),
    );
    expect(report.ok).toBe(false);
    const bytes = check(report, 'bytes-present');
    expect(bytes.ok).toBe(false);
    expect(bytes.detail).toBe('present=1 total=2');
    // Shape and counts are fine: it is specifically the missing object that fails.
    expect(check(report, 'asset-shape').ok).toBe(true);
  });

  it('fails a non-link row whose size_bytes is the dev-seed stub (1)', async () => {
    const stub = fileRow('images/s/v1-s.jpg', 1);
    const report = await validateCutover(
      makeDeps({ rows: [stub], presentKeys: ['images/s/v1-s.jpg'] }),
    );
    expect(report.ok).toBe(false);
    const shape = check(report, 'asset-shape');
    expect(shape.ok).toBe(false);
    expect(shape.detail).toContain('malformed_file=1');
  });

  it('passes a well-formed link row (no bytes, no R2 key)', async () => {
    const report = await validateCutover(makeDeps({ rows: [linkRow()] }));
    expect(report.ok).toBe(true);
    expect(check(report, 'asset-shape').ok).toBe(true);
    expect(check(report, 'bytes-present').detail).toBe('present=0 total=0');
  });

  it('non-vacuous: the all-match case is ok, and a single wrong count flips ok to false', async () => {
    const ok = await validateCutover(
      makeDeps({ rows: [fileRow('images/a/v1-a.jpg')], presentKeys: ['images/a/v1-a.jpg'] }),
    );
    expect(ok.ok).toBe(true);
    const broken = await validateCutover(
      makeDeps({
        targetOver: { posts: 99 },
        rows: [fileRow('images/a/v1-a.jpg')],
        presentKeys: ['images/a/v1-a.jpg'],
      }),
    );
    expect(broken.ok).toBe(false);
    expect(check(broken, 'count:posts').ok).toBe(false);
  });
});
