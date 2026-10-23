import { describe, expect, it } from 'vitest';
import {
  copyBucket,
  parseOptions,
  verifyBuckets,
  type CopyStorage,
} from './copy-workspace-storage.ts';

/** In-memory buckets: bucket -> key -> size. Records every call. */
function fakeStorage(initial: Record<string, Record<string, number>>): {
  storage: CopyStorage;
  buckets: Map<string, Map<string, number>>;
  calls: string[];
  failKeys: Set<string>;
} {
  const buckets = new Map<string, Map<string, number>>();
  for (const [name, objects] of Object.entries(initial)) {
    buckets.set(name, new Map(Object.entries(objects)));
  }
  const calls: string[] = [];
  const failKeys = new Set<string>();
  const storage: CopyStorage = {
    ensureBucket(bucket) {
      calls.push(`ensure:${bucket}`);
      if (!buckets.has(bucket)) buckets.set(bucket, new Map());
      return Promise.resolve();
    },
    listObjects({ bucket, cursor }) {
      calls.push(`list:${bucket}`);
      const keys = [...(buckets.get(bucket) ?? new Map<string, number>()).entries()].sort();
      // Two objects per page, to exercise paging.
      const start = cursor === null || cursor === undefined ? 0 : Number(cursor);
      const page = keys.slice(start, start + 2);
      const next = start + 2 < keys.length ? String(start + 2) : null;
      return Promise.resolve({
        objects: page.map(([key, size]) => ({ key, size })),
        nextCursor: next,
      });
    },
    copyObject({ sourceBucket, targetBucket, key }) {
      calls.push(`copy:${key}`);
      if (failKeys.has(key)) return Promise.reject(new Error('boom'));
      const size = buckets.get(sourceBucket)?.get(key);
      if (size === undefined) return Promise.reject(new Error('missing source'));
      buckets.get(targetBucket)?.set(key, size);
      return Promise.resolve();
    },
  };
  return { storage, buckets, calls, failKeys };
}

const noSleep = (): Promise<void> => Promise.resolve();

describe('parseOptions', () => {
  it('reads source, target and mode', () => {
    expect(
      parseOptions(['--source', 'assets-gbl', '--target', 'assets-gbl-apac', '--mode', 'copy']),
    ).toEqual({ source: 'assets-gbl', target: 'assets-gbl-apac', mode: 'copy' });
  });

  it('refuses source = target, a non assets- target, and an unknown mode', () => {
    expect(() =>
      parseOptions(['--source', 'assets-a', '--target', 'assets-a', '--mode', 'copy']),
    ).toThrow('different');
    expect(() =>
      parseOptions(['--source', 'assets-a', '--target', 'srtdio-logs', '--mode', 'copy']),
    ).toThrow('assets-');
    expect(() =>
      parseOptions(['--source', 'assets-a', '--target', 'assets-b', '--mode', 'delete']),
    ).toThrow('copy or verify');
    expect(() => parseOptions(['--source', 'assets-a', '--mode', 'copy'])).toThrow('--target');
  });
});

describe('copyBucket', () => {
  it('creates the target, copies every object across pages, and never deletes', async () => {
    const { storage, buckets, calls } = fakeStorage({
      'assets-gbl': { a: 1, b: 2, c: 3, d: 4, e: 5 },
    });
    const report = await copyBucket(
      storage,
      { source: 'assets-gbl', target: 'assets-gbl-apac', mode: 'copy' },
      { traceId: 't', sleep: noSleep },
    );
    expect(calls[0]).toBe('ensure:assets-gbl-apac');
    expect(report).toEqual({ copied: 5, skipped: 0, conflicts: [], failed: [] });
    expect([...(buckets.get('assets-gbl-apac') ?? new Map()).entries()].sort()).toEqual([
      ['a', 1],
      ['b', 2],
      ['c', 3],
      ['d', 4],
      ['e', 5],
    ]);
    expect(buckets.get('assets-gbl')?.size).toBe(5);
    expect(calls.some((call) => call.startsWith('delete'))).toBe(false);
  });

  it('skips objects already copied at the same size, so a re-run copies only new ones', async () => {
    const { storage, calls } = fakeStorage({
      'assets-cv': { a: 1, b: 2, new: 9 },
      'assets-cv-apac': { a: 1, b: 2 },
    });
    const report = await copyBucket(
      storage,
      { source: 'assets-cv', target: 'assets-cv-apac', mode: 'copy' },
      { traceId: 't', sleep: noSleep },
    );
    expect(report.copied).toBe(1);
    expect(report.skipped).toBe(2);
    expect(calls.filter((call) => call.startsWith('copy:'))).toEqual(['copy:new']);
  });

  it('never overwrites a target object of a different size: it reports it', async () => {
    const { storage, buckets, calls } = fakeStorage({
      'assets-s': { a: 1 },
      'assets-t': { a: 7 },
    });
    const report = await copyBucket(
      storage,
      { source: 'assets-s', target: 'assets-t', mode: 'copy' },
      { traceId: 't', sleep: noSleep },
    );
    expect(report.conflicts).toEqual(['a']);
    expect(buckets.get('assets-t')?.get('a')).toBe(7);
    expect(calls.some((call) => call.startsWith('copy:'))).toBe(false);
  });

  it('retries a failing copy, then records it as failed without stopping the rest', async () => {
    const { storage, calls, failKeys } = fakeStorage({ 'assets-s': { bad: 1, good: 2 } });
    failKeys.add('bad');
    const report = await copyBucket(
      storage,
      { source: 'assets-s', target: 'assets-t', mode: 'copy' },
      { traceId: 't', sleep: noSleep },
    );
    expect(calls.filter((call) => call === 'copy:bad')).toHaveLength(4);
    expect(report.failed).toEqual([{ key: 'bad', reason: 'boom' }]);
    expect(report.copied).toBe(1);
  });

  it('refuses source = target before touching storage', async () => {
    const { storage, calls } = fakeStorage({ 'assets-a': { a: 1 } });
    await expect(
      copyBucket(
        storage,
        { source: 'assets-a', target: 'assets-a', mode: 'copy' },
        { traceId: 't', sleep: noSleep },
      ),
    ).rejects.toThrow('different');
    expect(calls).toEqual([]);
  });
});

describe('verifyBuckets', () => {
  it('matches when every source key is in the target at the same size', async () => {
    const { storage } = fakeStorage({
      'assets-s': { a: 1, b: 2, c: 3 },
      'assets-t': { a: 1, b: 2, c: 3 },
    });
    const report = await verifyBuckets(
      storage,
      { source: 'assets-s', target: 'assets-t', mode: 'verify' },
      't',
    );
    expect(report).toMatchObject({ ok: true, sourceCount: 3, targetCount: 3, sourceBytes: 6 });
  });

  it('reports missing and size-mismatched keys and is not ok', async () => {
    const { storage } = fakeStorage({
      'assets-s': { a: 1, b: 2, c: 3 },
      'assets-t': { a: 1, b: 5 },
    });
    const report = await verifyBuckets(
      storage,
      { source: 'assets-s', target: 'assets-t', mode: 'verify' },
      't',
    );
    expect(report.ok).toBe(false);
    expect(report.missing).toEqual(['c']);
    expect(report.sizeMismatch).toEqual(['b']);
  });
});
