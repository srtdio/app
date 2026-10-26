import { describe, expect, it, vi } from 'vitest';
import type { ObjectPage } from '@srtdio/storage';
import type { TracedFetchFn } from '@/server/workers/chat-agora-rest';
// supabase-js for handleScheduled: each query records its chain of calls and
// answers from `answers`, keyed by table or rpc name.
const supa = vi.hoisted(() => ({
  calls: [] as Array<{ target: string; chain: Array<[string, unknown[]]> }>,
  answers: {} as Record<
    string,
    { data?: unknown; count?: number; error: null | { message: string } }
  >,
  key: null as string | null,
}));
vi.mock('@supabase/supabase-js', () => ({
  createClient: (_url: string, key: string) => {
    supa.key = key;
    const run = (target: string, first: [string, unknown[]]) => {
      const record = { target, chain: [first] };
      supa.calls.push(record);
      const chain: Record<string, unknown> = {};
      for (const name of ['select', 'eq', 'is', 'neq', 'not', 'in']) {
        chain[name] = (...args: unknown[]) => {
          record.chain.push([name, args]);
          return chain;
        };
      }
      chain.then = (resolve: (v: unknown) => unknown) =>
        resolve(supa.answers[target] ?? { data: null, error: null });
      return chain;
    };
    return {
      from: (table: string) => run(table, ['from', [table]]),
      rpc: (fn: string, args?: unknown) => run(fn, ['rpc', [fn, args]]),
    };
  },
}));

import {
  ASSET_BATCH_SIZE,
  ASSET_CALL_BUDGET,
  MAX_ASSET_BATCHES,
  RUN_CALL_BUDGET,
  createAgoraPurgeApi,
  SAMPLE_KEY_PREFIX,
  handleScheduled,
  runPurge,
  sharedBucketName,
  type StoragePurgeEnv,
  type DueAsset,
  type DueWorkspace,
  type PurgeAgora,
  type PurgeDb,
  type PurgeDeps,
  type PurgeStorage,
} from './storage-purge';

vi.mock('agora-token', () => ({
  ChatTokenBuilder: { buildAppToken: vi.fn(() => 'app-token') },
}));

const TRACE_ID = '0192f000-0000-7000-8000-000000000001';

/**
 * In-memory DB: due assets stay due until storagePurgeDone drops them, as the
 * real proc does; storagePurgeDue returns the first `limit` still-due rows.
 * `rows` holds every workspaces row (live or soft-deleted) by id -> asset_bucket;
 * the due workspaces are seeded into it and workspacePurgeDone removes them.
 */
function fakeDb(seed: { assets?: DueAsset[]; workspaces?: DueWorkspace[] } = {}) {
  const assets = [...(seed.assets ?? [])];
  const groups = new Map<string, string[]>();
  const rows = new Map<string, string | null>(
    (seed.workspaces ?? []).map((w) => [w.workspaceId, w.bucket]),
  );
  const doneCalls: string[][] = [];
  const workspacesDone: string[] = [];
  let dueCalls = 0;
  let calls = 0;
  const db: PurgeDb = {
    storagePurgeDue(limit) {
      calls += 1;
      dueCalls += 1;
      return Promise.resolve(assets.slice(0, limit));
    },
    storagePurgeDone(ids) {
      calls += 1;
      doneCalls.push(ids);
      let n = 0;
      for (const id of ids) {
        const at = assets.findIndex((a) => a.assetId === id);
        if (at >= 0) {
          assets.splice(at, 1);
          n += 1;
        }
      }
      return Promise.resolve(n);
    },
    workspacePurgeDue: () => {
      calls += 1;
      return Promise.resolve(seed.workspaces ?? []);
    },
    workspaceAgoraGroupIds: (ids) => {
      calls += 1;
      return Promise.resolve(new Map(ids.map((id) => [id, groups.get(id) ?? []])));
    },
    bucketSharers: (bucket, workspaceId) => {
      calls += 1;
      const sharers = [...rows].filter(([id, b]) => b === bucket && id !== workspaceId);
      return Promise.resolve(sharers.length);
    },
    workspacePurgeDone(id) {
      calls += 1;
      workspacesDone.push(id);
      rows.delete(id);
      return Promise.resolve();
    },
  };
  return {
    db,
    groups,
    rows,
    doneCalls,
    workspacesDone,
    remaining: () => assets.map((a) => a.assetId),
    dueCalls: () => dueCalls,
    calls: () => calls,
  };
}

/**
 * In-memory R2: deleting a missing key is success (R2 404 = gone).
 * PurgeStorage has no deleteBucket; `bucketDeletes` is a tripwire spy attached
 * beside it, so any untyped attempt to delete a bucket shows up in the tests.
 */
function fakeStorage(objects: Record<string, string[]> = {}, pageSize = 2) {
  const store = new Map(Object.entries(objects).map(([b, keys]) => [b, new Set(keys)]));
  const failKeys = new Set<string>();
  const deleted: string[] = [];
  const bucketDeletes = vi.fn<(bucket: string) => Promise<void>>(() => Promise.resolve());
  const listCursors: Array<string | null> = [];
  const listPrefixes: Array<string | null> = [];
  const purgeStorage: PurgeStorage = {
    deleteObject(bucket, key) {
      if (failKeys.has(key)) return Promise.reject(new Error(`R2 deleteObject failed (500)`));
      store.get(bucket)?.delete(key);
      deleted.push(`${bucket}/${key}`);
      return Promise.resolve();
    },
    listObjects({ bucket, prefix, cursor }) {
      listCursors.push(cursor ?? null);
      listPrefixes.push(prefix ?? null);
      // The cursor is the last key returned (S3 start-after), so it stays valid
      // while keys from earlier pages are being deleted.
      const after = cursor ?? '';
      const keys = [...(store.get(bucket) ?? [])]
        .sort()
        .filter((key) => key.startsWith(prefix ?? '') && key > after);
      const slice = keys.slice(0, pageSize);
      const next = keys.length > pageSize ? (slice[slice.length - 1] ?? null) : null;
      const page: ObjectPage = {
        objects: slice.map((key) => ({ key, size: 1 })),
        nextCursor: next,
      };
      return Promise.resolve(page);
    },
  };
  const storage: PurgeStorage = Object.assign(purgeStorage, { deleteBucket: bucketDeletes });
  return { storage, failKeys, deleted, bucketDeletes, listCursors, listPrefixes, store };
}

function fakeAgora() {
  const deleted: string[] = [];
  const failGroups = new Set<string>();
  let calls = 0;
  const agora: PurgeAgora = {
    deleteGroup(groupId) {
      calls += 1;
      if (failGroups.has(groupId))
        return Promise.reject(new Error('Agora delete_group failed: 401 unauthorized'));
      deleted.push(groupId);
      return Promise.resolve();
    },
  };
  return { agora, deleted, failGroups, calls: () => calls };
}

function deps(
  parts: Pick<PurgeDeps, 'db' | 'storage' | 'agora'> & { sharedBucket?: string | null },
): PurgeDeps {
  return {
    sharedBucket: null,
    ...parts,
    traceId: TRACE_ID,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
}

function asset(id: string, keys: string[] = [`images/${id}/v1-a.png`]): DueAsset {
  return { assetId: id, bucket: 'assets-acme', keys };
}

const keys = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

describe('runPurge: assets', () => {
  it('deletes every key and marks the rows done', async () => {
    const db = fakeDb({ assets: [asset('a1', ['k1', 'k2']), asset('a2', ['k3'])] });
    const r2 = fakeStorage();
    const summary = await runPurge(
      deps({ db: db.db, storage: r2.storage, agora: fakeAgora().agora }),
    );
    expect(r2.deleted).toEqual(['assets-acme/k1', 'assets-acme/k2', 'assets-acme/k3']);
    expect(db.doneCalls).toEqual([['a1', 'a2']]);
    expect(db.remaining()).toEqual([]);
    expect(summary).toMatchObject({ assetsPurged: 2, keysDeleted: 3, keysFailed: 0, batches: 2 });
  });

  it('treats a key that is already gone (404) as deleted', async () => {
    // fakeStorage's deleteObject resolves for a key it never held, as R2 does on 404.
    const db = fakeDb({ assets: [asset('a1', ['never-uploaded'])] });
    const summary = await runPurge(
      deps({ db: db.db, storage: fakeStorage().storage, agora: fakeAgora().agora }),
    );
    expect(db.doneCalls).toEqual([['a1']]);
    expect(summary.assetsPurged).toBe(1);
  });

  it('never deletes an induction-sample/ key; the row still goes', async () => {
    const sample = `${SAMPLE_KEY_PREFIX}np-01.jpg`;
    const db = fakeDb({
      assets: [
        asset('a1', [sample, 'images/a1/v1-a.png']),
        { assetId: 'a2', bucket: null, keys: [`${SAMPLE_KEY_PREFIX}look-1.jpg`] },
      ],
    });
    const r2 = fakeStorage({ 'assets-acme': [sample] });
    const summary = await runPurge(
      deps({ db: db.db, storage: r2.storage, agora: fakeAgora().agora }),
    );
    expect(r2.deleted).toEqual(['assets-acme/images/a1/v1-a.png']);
    expect(r2.store.get('assets-acme')?.has(sample)).toBe(true);
    expect(db.doneCalls).toEqual([['a1', 'a2']]);
    expect(summary).toMatchObject({ assetsPurged: 2, assetsFailed: 0 });
  });

  it('does not mark a row with a failed key and stops instead of spinning on it', async () => {
    const db = fakeDb({ assets: [asset('bad', ['ok', 'boom']), asset('good', ['fine'])] });
    const r2 = fakeStorage();
    r2.failKeys.add('boom');
    const d = deps({ db: db.db, storage: r2.storage, agora: fakeAgora().agora });
    const summary = await runPurge(d);
    expect(db.doneCalls).toEqual([['good']]);
    expect(db.remaining()).toEqual(['bad']);
    expect(summary).toMatchObject({ assetsPurged: 1, assetsFailed: 1, keysFailed: 1 });
    expect(d.log.error).toHaveBeenCalledWith(
      'storage purge asset failed',
      expect.objectContaining({ asset_id: 'bad', failed_keys: 1 }),
    );
  });

  it('stops after one batch when every row fails', async () => {
    const db = fakeDb({ assets: [asset('bad', ['boom'])] });
    const r2 = fakeStorage();
    r2.failKeys.add('boom');
    const summary = await runPurge(
      deps({ db: db.db, storage: r2.storage, agora: fakeAgora().agora }),
    );
    expect(db.dueCalls()).toBe(1);
    expect(db.doneCalls).toEqual([]);
    expect(summary.batches).toBe(1);
  });

  it('asks for batches of ASSET_BATCH_SIZE', async () => {
    const db = fakeDb({ assets: [asset('a1', [])] });
    const due = vi.spyOn(db.db, 'storagePurgeDue');
    await runPurge(deps({ db: db.db, storage: fakeStorage().storage, agora: fakeAgora().agora }));
    expect(due).toHaveBeenCalledWith(ASSET_BATCH_SIZE);
  });

  it('caps the run at MAX_ASSET_BATCHES even when every batch makes progress', async () => {
    // Keyless rows cost no R2 calls; a db that always answers with a fresh row
    // would otherwise loop forever.
    const db = fakeDb();
    let n = 0;
    vi.spyOn(db.db, 'storagePurgeDue').mockImplementation(() =>
      Promise.resolve([{ assetId: `a${(n += 1)}`, bucket: 'assets-acme', keys: [] }]),
    );
    vi.spyOn(db.db, 'storagePurgeDone').mockResolvedValue(1);
    const summary = await runPurge(
      deps({ db: db.db, storage: fakeStorage().storage, agora: fakeAgora().agora }),
    );
    expect(summary.batches).toBeLessThanOrEqual(MAX_ASSET_BATCHES);
    expect(summary.calls).toBeLessThanOrEqual(RUN_CALL_BUDGET);
  });
});

describe('runPurge: workspaces', () => {
  it('deletes Agora groups, pages through and empties a legacy bucket no other row names, leaves it in place, then marks done', async () => {
    const db = fakeDb({ workspaces: [{ workspaceId: 'w1', bucket: 'assets-acme' }] });
    db.groups.set('w1', ['g1', 'g2']);
    const r2 = fakeStorage({ 'assets-acme': ['k1', 'k2', 'k3', 'k4', 'k5'] }, 2);
    const agora = fakeAgora();
    const summary = await runPurge(deps({ db: db.db, storage: r2.storage, agora: agora.agora }));
    expect(agora.deleted).toEqual(['g1', 'g2']);
    expect(r2.listCursors).toEqual([null, 'k2', 'k4']);
    expect(r2.listPrefixes).toEqual([null, null, null]);
    expect(r2.deleted).toHaveLength(5);
    expect(r2.store.get('assets-acme')?.size).toBe(0);
    expect(r2.bucketDeletes).not.toHaveBeenCalled();
    expect(db.workspacesDone).toEqual(['w1']);
    expect(summary).toMatchObject({ workspacesPurged: 1, workspacesFailed: 0 });
  });

  it('reads the Agora groups of every due workspace in one query', async () => {
    const db = fakeDb({
      workspaces: [
        { workspaceId: 'w1', bucket: null },
        { workspaceId: 'w2', bucket: null },
      ],
    });
    const groupsQuery = vi.spyOn(db.db, 'workspaceAgoraGroupIds');
    await runPurge(deps({ db: db.db, storage: fakeStorage().storage, agora: fakeAgora().agora }));
    expect(groupsQuery).toHaveBeenCalledTimes(1);
    expect(groupsQuery).toHaveBeenCalledWith(['w1', 'w2']);
    expect(db.workspacesDone).toEqual(['w1', 'w2']);
  });

  it('marks a workspace with no bucket done after its Agora groups go', async () => {
    const db = fakeDb({ workspaces: [{ workspaceId: 'w1', bucket: null }] });
    db.groups.set('w1', ['g1']);
    const agora = fakeAgora();
    const r2 = fakeStorage();
    await runPurge(deps({ db: db.db, storage: r2.storage, agora: agora.agora }));
    expect(agora.deleted).toEqual(['g1']);
    expect(r2.listCursors).toEqual([]);
    expect(db.workspacesDone).toEqual(['w1']);
  });

  it('still runs the workspace pass when the asset pass throws', async () => {
    const db = fakeDb({ workspaces: [{ workspaceId: 'w1', bucket: null }] });
    vi.spyOn(db.db, 'storagePurgeDue').mockRejectedValue(new Error('db down'));
    await runPurge(deps({ db: db.db, storage: fakeStorage().storage, agora: fakeAgora().agora }));
    expect(db.workspacesDone).toEqual(['w1']);
  });
});

describe('runPurge: root cause regression (Agora 401 stranded every workspace)', () => {
  it('a failing Agora group delete is logged and never blocks the bytes or purge_done', async () => {
    const db = fakeDb({ workspaces: [{ workspaceId: 'w1', bucket: 'assets-acme' }] });
    db.groups.set('w1', ['g1', 'g2']);
    const agora = fakeAgora();
    agora.failGroups.add('g1');
    const r2 = fakeStorage({ 'assets-acme': ['k1'] });
    const d = deps({ db: db.db, storage: r2.storage, agora: agora.agora });
    const summary = await runPurge(d);
    expect(agora.deleted).toEqual(['g2']);
    expect(r2.store.get('assets-acme')?.size).toBe(0);
    expect(r2.bucketDeletes).not.toHaveBeenCalled();
    expect(db.workspacesDone).toEqual(['w1']);
    expect(summary).toMatchObject({
      workspacesPurged: 1,
      workspacesFailed: 0,
      agoraGroupsFailed: 1,
    });
    expect(d.log.error).toHaveBeenCalledWith(
      'storage purge agora group not deleted',
      expect.objectContaining({
        workspace_id: 'w1',
        group_ids: ['g1'],
        error: expect.stringContaining('401') as unknown,
      }),
    );
    expect(d.log.error).not.toHaveBeenCalledWith(
      'storage purge workspace failed',
      expect.anything(),
    );
  });

  it('35 due workspaces whose Agora deletes all fail still drain within the run budget', async () => {
    const due = Array.from({ length: 35 }, (_, i) => ({ workspaceId: `w${i}`, bucket: null }));
    const db = fakeDb({ workspaces: due });
    for (const w of due) db.groups.set(w.workspaceId, [`g-${w.workspaceId}`]);
    const agora = fakeAgora();
    for (const w of due) agora.failGroups.add(`g-${w.workspaceId}`);
    const r2 = fakeStorage();
    const summary = await runPurge(deps({ db: db.db, storage: r2.storage, agora: agora.agora }));
    // Every call (Supabase, R2, Agora) counts, so the run never passes the cap
    // the old 900-call budget ignored ("Too many subrequests").
    expect(db.calls() + agora.calls()).toBe(summary.calls);
    expect(summary.calls).toBeLessThanOrEqual(RUN_CALL_BUDGET);
    expect(summary.workspacesPurged).toBeGreaterThan(0);
    expect(summary.workspacesFailed).toBe(0);
    expect(db.workspacesDone).toHaveLength(summary.workspacesPurged);
  });
});

describe('runPurge: rule a, the shared bucket', () => {
  it('deletes only ws/<id>/ keys; other workspaces keys and the bucket stay', async () => {
    const db = fakeDb({ workspaces: [{ workspaceId: 'w1', bucket: 'assets-shared' }] });
    db.rows.set('w2', 'assets-shared');
    const r2 = fakeStorage(
      {
        'assets-shared': ['ws/w1/images/a', 'ws/w1/images/b', 'ws/w1/docs/c', 'ws/w2/images/d'],
      },
      2,
    );
    const sharers = vi.spyOn(db.db, 'bucketSharers');
    const summary = await runPurge(
      deps({
        db: db.db,
        storage: r2.storage,
        agora: fakeAgora().agora,
        sharedBucket: 'assets-shared',
      }),
    );
    expect(r2.listPrefixes.every((p) => p === 'ws/w1/')).toBe(true);
    expect([...r2.deleted].sort()).toEqual([
      'assets-shared/ws/w1/docs/c',
      'assets-shared/ws/w1/images/a',
      'assets-shared/ws/w1/images/b',
    ]);
    expect([...(r2.store.get('assets-shared') ?? [])]).toEqual(['ws/w2/images/d']);
    expect(r2.bucketDeletes).not.toHaveBeenCalled();
    expect(sharers).not.toHaveBeenCalled();
    expect(db.workspacesDone).toEqual(['w1']);
    expect(summary.workspacesPurged).toBe(1);
  });

  it('with SHARED_ASSET_BUCKET unset, rule a never matches: the bucket is treated as legacy', async () => {
    const db = fakeDb({ workspaces: [{ workspaceId: 'w1', bucket: 'assets-shared' }] });
    db.rows.set('w2', 'assets-shared');
    const r2 = fakeStorage({ 'assets-shared': ['ws/w2/images/d'] });
    await runPurge(
      deps({ db: db.db, storage: r2.storage, agora: fakeAgora().agora, sharedBucket: null }),
    );
    expect(r2.deleted).toEqual([]);
    expect(r2.bucketDeletes).not.toHaveBeenCalled();
    expect(db.workspacesDone).toEqual(['w1']);
  });

  it('sharedBucketName reads SHARED_ASSET_BUCKET and treats unset or blank as null', () => {
    expect(sharedBucketName({})).toBeNull();
    expect(sharedBucketName({ SHARED_ASSET_BUCKET: '  ' })).toBeNull();
    expect(sharedBucketName({ SHARED_ASSET_BUCKET: ' assets-shared ' })).toBe('assets-shared');
  });
});

describe('runPurge: rule b, legacy buckets shared with other rows', () => {
  it('a bucket another soft-deleted row names: R2 untouched, purge_done still runs, sharers logged', async () => {
    const db = fakeDb({ workspaces: [{ workspaceId: 'w1', bucket: 'assets-legacy' }] });
    db.rows.set('w9', 'assets-legacy'); // soft-deleted, not yet due
    const r2 = fakeStorage({ 'assets-legacy': ['images/x'] });
    const d = deps({ db: db.db, storage: r2.storage, agora: fakeAgora().agora });
    const summary = await runPurge(d);
    expect(r2.listCursors).toEqual([]);
    expect(r2.deleted).toEqual([]);
    expect(r2.bucketDeletes).not.toHaveBeenCalled();
    expect(db.workspacesDone).toEqual(['w1']);
    expect(summary).toMatchObject({ workspacesPurged: 1, workspacesFailed: 0 });
    expect(d.log.info).toHaveBeenCalledWith(
      'storage purge bucket shared; left in place',
      expect.objectContaining({ workspace_id: 'w1', bucket: 'assets-legacy', sharers: 1 }),
    );
  });

  it('a bucket a live workspace now uses keeps its objects; the deleted row still goes', async () => {
    const db = fakeDb({ workspaces: [{ workspaceId: 'w1', bucket: 'assets-acme' }] });
    db.rows.set('live', 'assets-acme');
    const r2 = fakeStorage({ 'assets-acme': ['live-file'] });
    await runPurge(deps({ db: db.db, storage: r2.storage, agora: fakeAgora().agora }));
    expect(r2.deleted).toEqual([]);
    expect(r2.store.get('assets-acme')?.has('live-file')).toBe(true);
    expect(db.workspacesDone).toEqual(['w1']);
  });

  it('the last row referencing the bucket is the one that empties it; the bucket stays', async () => {
    const db = fakeDb({
      workspaces: [
        { workspaceId: 'w1', bucket: 'assets-legacy' },
        { workspaceId: 'w2', bucket: 'assets-legacy' },
      ],
    });
    const r2 = fakeStorage({ 'assets-legacy': ['images/a', 'images/b'] });
    const sharers = vi.spyOn(db.db, 'bucketSharers');
    await runPurge(deps({ db: db.db, storage: r2.storage, agora: fakeAgora().agora }));
    expect(sharers).toHaveBeenNthCalledWith(1, 'assets-legacy', 'w1');
    expect(sharers).toHaveBeenNthCalledWith(2, 'assets-legacy', 'w2');
    expect(r2.listCursors).toEqual([null]);
    expect(r2.deleted).toHaveLength(2);
    expect(r2.store.get('assets-legacy')?.size).toBe(0);
    expect(r2.bucketDeletes).not.toHaveBeenCalled();
    expect(db.workspacesDone).toEqual(['w1', 'w2']);
  });
});

describe('runPurge: rule c, induction-sample keys', () => {
  it('a legacy bucket holding a sample key keeps that key and the bucket; the rest go', async () => {
    const sample = `${SAMPLE_KEY_PREFIX}np-01.jpg`;
    const db = fakeDb({ workspaces: [{ workspaceId: 'w1', bucket: 'assets-acme' }] });
    const r2 = fakeStorage({ 'assets-acme': [sample, 'images/x', 'images/y'] });
    await runPurge(deps({ db: db.db, storage: r2.storage, agora: fakeAgora().agora }));
    expect([...r2.deleted].sort()).toEqual(['assets-acme/images/x', 'assets-acme/images/y']);
    expect(r2.store.get('assets-acme')?.has(sample)).toBe(true);
    expect(r2.bucketDeletes).not.toHaveBeenCalled();
    expect(db.workspacesDone).toEqual(['w1']);
  });
});

describe('runPurge: regression (R2 bucket delete returned 403 on the 26 Oct run)', () => {
  it('never deletes a bucket: shared, legacy with sharers, legacy with a sample key, plain legacy', async () => {
    const sample = `${SAMPLE_KEY_PREFIX}np-01.jpg`;
    const db = fakeDb({
      workspaces: [
        { workspaceId: 'w1', bucket: 'assets-shared' },
        { workspaceId: 'w2', bucket: 'assets-shared-legacy' },
        { workspaceId: 'w3', bucket: 'assets-sample' },
        { workspaceId: 'w4', bucket: 'assets-plain' },
      ],
    });
    db.rows.set('w9', 'assets-shared-legacy');
    const r2 = fakeStorage(
      {
        'assets-shared': ['ws/w1/a', 'ws/w5/b'],
        'assets-shared-legacy': ['images/x'],
        'assets-sample': [sample, 'images/y'],
        'assets-plain': ['images/z', 'docs/q'],
      },
      1000,
    );
    // An untyped attempt would hit the tripwire, and an R2 bucket delete 403s.
    r2.bucketDeletes.mockRejectedValue(new Error('R2 deleteBucket failed (403)'));
    const d = deps({
      db: db.db,
      storage: r2.storage,
      agora: fakeAgora().agora,
      sharedBucket: 'assets-shared',
    });
    const summary = await runPurge(d);
    expect(r2.bucketDeletes).not.toHaveBeenCalled();
    expect([...r2.store.keys()].sort()).toEqual([
      'assets-plain',
      'assets-sample',
      'assets-shared',
      'assets-shared-legacy',
    ]);
    expect([...(r2.store.get('assets-shared') ?? [])]).toEqual(['ws/w5/b']);
    expect([...(r2.store.get('assets-shared-legacy') ?? [])]).toEqual(['images/x']);
    expect([...(r2.store.get('assets-sample') ?? [])]).toEqual([sample]);
    expect(r2.store.get('assets-plain')?.size).toBe(0);
    expect(db.workspacesDone).toEqual(['w1', 'w2', 'w3', 'w4']);
    expect(summary).toMatchObject({ workspacesPurged: 4, workspacesFailed: 0 });
    expect(d.log.info).toHaveBeenCalledWith(
      'storage purge bucket left empty',
      expect.objectContaining({ workspace_id: 'w4', bucket: 'assets-plain' }),
    );
    expect(d.log.error).not.toHaveBeenCalled();
  });
});

describe('createAgoraPurgeApi.deleteGroup', () => {
  const CONFIG = { appId: 'app', appCertificate: 'cert', restUrl: 'https://a.example/org/app/' };

  function fetchReturning(response: Response) {
    return vi.fn<TracedFetchFn>(() => Promise.resolve(response));
  }

  it('sends DELETE chatgroups/{id} with the app token and trace id', async () => {
    const fetchImpl = fetchReturning(new Response('{}', { status: 200 }));
    await createAgoraPurgeApi(CONFIG, fetchImpl).deleteGroup('g1', TRACE_ID);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://a.example/org/app/chatgroups/g1',
      { method: 'DELETE', headers: { authorization: 'Bearer app-token' } },
      TRACE_ID,
    );
  });

  it('treats 404 as already deleted', async () => {
    const fetchImpl = fetchReturning(new Response('group not found', { status: 404 }));
    await expect(createAgoraPurgeApi(CONFIG, fetchImpl).deleteGroup('g1', TRACE_ID)).resolves.toBe(
      undefined,
    );
  });

  it('throws on any other failure', async () => {
    const fetchImpl = fetchReturning(new Response('boom', { status: 500 }));
    await expect(
      createAgoraPurgeApi(CONFIG, fetchImpl).deleteGroup('g1', TRACE_ID),
    ).rejects.toThrow('Agora delete_group failed: 500 boom');
  });
});

describe('runPurge: per-workspace isolation', () => {
  it('a workspace whose key delete fails is not marked done; the others still purge', async () => {
    const db = fakeDb({
      workspaces: [
        { workspaceId: 'w1', bucket: 'assets-one' },
        { workspaceId: 'w2', bucket: 'assets-two' },
      ],
    });
    const r2 = fakeStorage({ 'assets-one': ['boom'], 'assets-two': ['x'] });
    r2.failKeys.add('boom');
    const d = deps({ db: db.db, storage: r2.storage, agora: fakeAgora().agora });
    const summary = await runPurge(d);
    expect(db.workspacesDone).toEqual(['w2']);
    expect(r2.store.get('assets-two')?.size).toBe(0);
    expect(r2.bucketDeletes).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ workspacesPurged: 1, workspacesFailed: 1 });
    expect(d.log.error).toHaveBeenCalledWith(
      'storage purge workspace failed',
      expect.objectContaining({ workspace_id: 'w1' }),
    );
  });

  it('a legacy bucket is emptied and left in place; the workspace is still marked done', async () => {
    const db = fakeDb({ workspaces: [{ workspaceId: 'w1', bucket: 'assets-one' }] });
    const r2 = fakeStorage({ 'assets-one': ['a', 'b', 'c'] });
    const d = deps({ db: db.db, storage: r2.storage, agora: fakeAgora().agora });
    const summary = await runPurge(d);
    expect(r2.store.get('assets-one')?.size).toBe(0);
    expect(r2.store.has('assets-one')).toBe(true);
    expect(r2.bucketDeletes).not.toHaveBeenCalled();
    expect(db.workspacesDone).toEqual(['w1']);
    expect(summary).toMatchObject({ workspacesPurged: 1, workspacesFailed: 0 });
    expect(d.log.info).toHaveBeenCalledWith('storage purge bucket left empty', {
      trace_id: TRACE_ID,
      workspace_id: 'w1',
      bucket: 'assets-one',
    });
    expect(d.log.error).not.toHaveBeenCalled();
  });

  it('a workspace_purge_done failure is isolated to that workspace', async () => {
    const db = fakeDb({
      workspaces: [
        { workspaceId: 'w1', bucket: null },
        { workspaceId: 'w2', bucket: null },
      ],
    });
    const realDone = db.db.workspacePurgeDone.bind(db.db);
    vi.spyOn(db.db, 'workspacePurgeDone').mockImplementation((id) =>
      id === 'w1' ? Promise.reject(new Error('rpc failed')) : realDone(id),
    );
    const summary = await runPurge(
      deps({ db: db.db, storage: fakeStorage().storage, agora: fakeAgora().agora }),
    );
    expect(db.workspacesDone).toEqual(['w2']);
    expect(summary).toMatchObject({ workspacesPurged: 1, workspacesFailed: 1 });
  });
});

describe('runPurge: call budget (every Supabase, R2 and Agora call counts)', () => {
  it('lets the asset pass spend at most its share, whole rows only, and leaves the rest due', async () => {
    // The share covers the due read, the done write and 20 key deletes: 4 rows of 5.
    const db = fakeDb({
      assets: Array.from({ length: 10 }, (_, i) => asset(`a${i}`, keys(`a${i}-`, 5))),
    });
    const r2 = fakeStorage();
    const summary = await runPurge(
      deps({ db: db.db, storage: r2.storage, agora: fakeAgora().agora }),
    );
    expect(r2.deleted).toHaveLength(ASSET_CALL_BUDGET - 2);
    expect(db.doneCalls).toEqual([['a0', 'a1', 'a2', 'a3']]);
    expect(db.remaining()).toHaveLength(6);
    expect(db.dueCalls()).toBe(1);
    expect(summary.budgetExhausted).toBe(true);
    // + the workspace pass's own due read.
    expect(summary.calls).toBe(ASSET_CALL_BUDGET + 1);
  });

  it('skips a row with more keys than the asset share instead of stalling on it', async () => {
    const db = fakeDb({
      assets: [asset('huge', keys('h', ASSET_CALL_BUDGET - 1)), asset('small', ['s'])],
    });
    const r2 = fakeStorage();
    const summary = await runPurge(
      deps({ db: db.db, storage: r2.storage, agora: fakeAgora().agora }),
    );
    expect(r2.deleted).toEqual(['assets-acme/s']);
    expect(db.doneCalls).toEqual([['small']]);
    expect(summary).toMatchObject({ assetsPurged: 1, assetsFailed: 1 });
  });

  it('gives the workspace pass what the asset pass left, and never exceeds the run budget', async () => {
    const db = fakeDb({
      assets: [asset('a1', keys('k', 10))],
      workspaces: [{ workspaceId: 'w1', bucket: 'assets-big' }],
    });
    const r2 = fakeStorage({ 'assets-big': keys('o', 2000) }, 1000);
    const agora = fakeAgora();
    const summary = await runPurge(deps({ db: db.db, storage: r2.storage, agora: agora.agora }));
    const total = db.calls() + agora.calls() + r2.deleted.length + r2.listCursors.length;
    expect(total).toBe(RUN_CALL_BUDGET);
    expect(summary.calls).toBe(RUN_CALL_BUDGET);
    expect(summary.budgetExhausted).toBe(true);
    expect(db.workspacesDone).toEqual([]);
  });

  it('stops the workspace pass cleanly: the unfinished workspace is not marked done or failed', async () => {
    const db = fakeDb({
      workspaces: [
        { workspaceId: 'w1', bucket: 'assets-one' },
        { workspaceId: 'w2', bucket: 'assets-two' },
        { workspaceId: 'w3', bucket: null },
      ],
    });
    db.groups.set('w3', ['g3']);
    // w1 costs sharers + list + 3 deletes + done = 6 calls (no bucket delete); w2 cannot finish in the rest.
    const r2 = fakeStorage({ 'assets-one': keys('a', 3), 'assets-two': keys('b', 2000) }, 1000);
    const agora = fakeAgora();
    const d = deps({ db: db.db, storage: r2.storage, agora: agora.agora });
    const summary = await runPurge(d);
    expect(db.workspacesDone).toEqual(['w1']);
    expect(r2.store.get('assets-one')?.size).toBe(0);
    expect(r2.bucketDeletes).not.toHaveBeenCalled();
    expect(agora.deleted).toEqual([]);
    expect(summary).toMatchObject({
      workspacesPurged: 1,
      workspacesFailed: 0,
      calls: RUN_CALL_BUDGET,
      budgetExhausted: true,
    });
    expect(d.log.info).toHaveBeenCalledWith(
      'storage purge out of call budget; resuming next run',
      expect.objectContaining({ workspace_id: 'w2' }),
    );
    expect(d.log.error).not.toHaveBeenCalled();
  });

  it('counts Agora group deletes against the budget', async () => {
    const db = fakeDb({ workspaces: [{ workspaceId: 'w1', bucket: null }] });
    db.groups.set('w1', keys('g', RUN_CALL_BUDGET + 1));
    const agora = fakeAgora();
    const summary = await runPurge(
      deps({ db: db.db, storage: fakeStorage().storage, agora: agora.agora }),
    );
    // Asset due read + workspace due read + the groups query, then Agora.
    expect(agora.deleted).toHaveLength(RUN_CALL_BUDGET - 3);
    expect(db.workspacesDone).toEqual([]);
    expect(summary.budgetExhausted).toBe(true);
  });
});

describe('handleScheduled live wiring', () => {
  const ENV: StoragePurgeEnv = {
    SUPABASE_URL: 'https://db.test',
    SUPABASE_SECRET_KEY: 'service-role-key',
    CLOUDFLARE_ACCOUNT_ID: 'acct',
    CLOUDFLARE_R2_ACCESS_KEY_ID: 'akid',
    CLOUDFLARE_R2_SECRET_ACCESS_KEY: 'secret',
    AGORA_APP_ID: 'app',
    AGORA_APP_CERTIFICATE: 'cert',
    AGORA_CHAT_REST_URL: 'https://agora.test/org/app',
  };

  it('counts every other row (live or soft-deleted) on the bucket, and leaves a shared one in R2', async () => {
    supa.calls = [];
    supa.answers = {
      storage_purge_due: { data: [], error: null },
      workspace_purge_due: { data: [{ workspace_id: 'w1', bucket: 'assets-acme' }], error: null },
      chat_channels: { data: [], error: null },
      workspaces: { count: 1, error: null },
      workspace_purge_done: { data: null, error: null },
    };
    const fetchSpy = vi.fn(() => Promise.resolve(new Response(null, { status: 500 })));
    vi.stubGlobal('fetch', fetchSpy);
    try {
      const summary = await handleScheduled(ENV);
      expect(supa.key).toBe('service-role-key');
      const groups = supa.calls.find((c) => c.target === 'chat_channels');
      expect(groups?.chain).toEqual([
        ['from', ['chat_channels']],
        ['select', ['workspace_id, agora_group_id']],
        ['in', ['workspace_id', ['w1']]],
        ['not', ['agora_group_id', 'is', null]],
      ]);
      const guard = supa.calls.find((c) => c.target === 'workspaces');
      expect(guard?.chain).toEqual([
        ['from', ['workspaces']],
        ['select', ['id', { count: 'exact', head: true }]],
        ['eq', ['asset_bucket', 'assets-acme']],
        ['neq', ['id', 'w1']],
      ]);
      expect(supa.calls.map((c) => c.target)).toContain('workspace_purge_done');
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(summary).toMatchObject({ workspacesPurged: 1, workspacesFailed: 0 });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
