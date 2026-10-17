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
      for (const name of ['select', 'eq', 'is', 'neq', 'not']) {
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
  MAX_ASSET_BATCHES,
  createAgoraPurgeApi,
  handleScheduled,
  runPurge,
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
 */
function fakeDb(seed: { assets?: DueAsset[]; workspaces?: DueWorkspace[] } = {}) {
  const assets = [...(seed.assets ?? [])];
  const groups = new Map<string, string[]>();
  const liveBuckets = new Set<string>();
  const doneCalls: string[][] = [];
  const workspacesDone: string[] = [];
  let dueCalls = 0;
  const db: PurgeDb = {
    storagePurgeDue(limit) {
      dueCalls += 1;
      return Promise.resolve(assets.slice(0, limit));
    },
    storagePurgeDone(ids) {
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
    workspacePurgeDue: () => Promise.resolve(seed.workspaces ?? []),
    workspaceAgoraGroupIds: (id) => Promise.resolve(groups.get(id) ?? []),
    bucketInUse: (bucket) => Promise.resolve(liveBuckets.has(bucket)),
    workspacePurgeDone(id) {
      workspacesDone.push(id);
      return Promise.resolve();
    },
  };
  return {
    db,
    groups,
    liveBuckets,
    doneCalls,
    workspacesDone,
    remaining: () => assets.map((a) => a.assetId),
    dueCalls: () => dueCalls,
  };
}

/** In-memory R2: deleting a missing key is success (R2 404 = gone). */
function fakeStorage(objects: Record<string, string[]> = {}, pageSize = 2) {
  const store = new Map(Object.entries(objects).map(([b, keys]) => [b, new Set(keys)]));
  const failKeys = new Set<string>();
  const deleted: string[] = [];
  const deletedBuckets: string[] = [];
  const listCursors: Array<string | null> = [];
  const storage: PurgeStorage = {
    deleteObject(bucket, key) {
      if (failKeys.has(key)) return Promise.reject(new Error(`R2 deleteObject failed (500)`));
      store.get(bucket)?.delete(key);
      deleted.push(`${bucket}/${key}`);
      return Promise.resolve();
    },
    listObjects({ bucket, cursor }) {
      listCursors.push(cursor ?? null);
      // The cursor is the last key returned (S3 start-after), so it stays valid
      // while keys from earlier pages are being deleted.
      const after = cursor ?? '';
      const keys = [...(store.get(bucket) ?? [])].sort().filter((key) => key > after);
      const slice = keys.slice(0, pageSize);
      const next = keys.length > pageSize ? (slice[slice.length - 1] ?? null) : null;
      const page: ObjectPage = {
        objects: slice.map((key) => ({ key, size: 1 })),
        nextCursor: next,
      };
      return Promise.resolve(page);
    },
    deleteBucket(bucket) {
      if ((store.get(bucket)?.size ?? 0) > 0) {
        return Promise.reject(new Error('R2 deleteBucket failed (409): BucketNotEmpty'));
      }
      store.delete(bucket);
      deletedBuckets.push(bucket);
      return Promise.resolve();
    },
  };
  return { storage, failKeys, deleted, deletedBuckets, listCursors, store };
}

function fakeAgora() {
  const deleted: string[] = [];
  const failGroups = new Set<string>();
  const agora: PurgeAgora = {
    deleteGroup(groupId) {
      if (failGroups.has(groupId))
        return Promise.reject(new Error('Agora delete_group failed: 500'));
      deleted.push(groupId);
      return Promise.resolve();
    },
  };
  return { agora, deleted, failGroups };
}

function deps(parts: Pick<PurgeDeps, 'db' | 'storage' | 'agora'>): PurgeDeps {
  return { ...parts, traceId: TRACE_ID, log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } };
}

function asset(id: string, keys: string[] = [`images/${id}/v1-a.png`]): DueAsset {
  return { assetId: id, bucket: 'assets-acme', keys };
}

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

  it('does not mark a row with a failed key and stops instead of spinning on it', async () => {
    const db = fakeDb({ assets: [asset('bad', ['ok', 'boom']), asset('good', ['fine'])] });
    const r2 = fakeStorage();
    r2.failKeys.add('boom');
    const d = deps({ db: db.db, storage: r2.storage, agora: fakeAgora().agora });
    const summary = await runPurge(d);
    expect(db.doneCalls).toEqual([['good']]);
    expect(db.remaining()).toEqual(['bad']);
    // Batch 1 marks good; batch 2 returns only bad, which is skipped, so nothing new is marked.
    expect(db.dueCalls()).toBe(2);
    expect(summary).toMatchObject({ assetsPurged: 1, assetsFailed: 1, keysFailed: 1 });
    expect(d.log.error).toHaveBeenCalledWith(
      'storage purge asset failed',
      expect.objectContaining({ asset_id: 'bad', failed_keys: 1 }),
    );
  });

  it('stops after one batch when every row fails', async () => {
    const db = fakeDb({ assets: [asset('a1', ['boom'])] });
    const r2 = fakeStorage();
    r2.failKeys.add('boom');
    await runPurge(deps({ db: db.db, storage: r2.storage, agora: fakeAgora().agora }));
    expect(db.dueCalls()).toBe(1);
    expect(db.doneCalls).toEqual([]);
  });

  it('asks for batches of ASSET_BATCH_SIZE and caps the run at MAX_ASSET_BATCHES', async () => {
    const total = ASSET_BATCH_SIZE * (MAX_ASSET_BATCHES + 2);
    const db = fakeDb({
      assets: Array.from({ length: total }, (_, i) => asset(`a${i}`, [])),
    });
    const due = vi.spyOn(db.db, 'storagePurgeDue');
    const summary = await runPurge(
      deps({ db: db.db, storage: fakeStorage().storage, agora: fakeAgora().agora }),
    );
    expect(due).toHaveBeenCalledTimes(MAX_ASSET_BATCHES);
    expect(due).toHaveBeenCalledWith(ASSET_BATCH_SIZE);
    expect(summary.assetsPurged).toBe(ASSET_BATCH_SIZE * MAX_ASSET_BATCHES);
    expect(db.remaining()).toHaveLength(ASSET_BATCH_SIZE * 2);
  });
});

describe('runPurge: workspaces', () => {
  it('deletes Agora groups, pages through and empties the bucket, deletes it, then marks done', async () => {
    const db = fakeDb({ workspaces: [{ workspaceId: 'w1', bucket: 'assets-acme' }] });
    db.groups.set('w1', ['g1', 'g2']);
    const r2 = fakeStorage({ 'assets-acme': ['k1', 'k2', 'k3', 'k4', 'k5'] }, 2);
    const agora = fakeAgora();
    const summary = await runPurge(deps({ db: db.db, storage: r2.storage, agora: agora.agora }));
    expect(agora.deleted).toEqual(['g1', 'g2']);
    expect(r2.listCursors).toEqual([null, 'k2', 'k4']);
    expect(r2.deleted).toHaveLength(5);
    expect(r2.deletedBuckets).toEqual(['assets-acme']);
    expect(db.workspacesDone).toEqual(['w1']);
    expect(summary).toMatchObject({ workspacesPurged: 1, workspacesFailed: 0 });
  });

  it('isolates a failing workspace: the others still purge and it is not marked done', async () => {
    const db = fakeDb({
      workspaces: [
        { workspaceId: 'w1', bucket: 'assets-one' },
        { workspaceId: 'w2', bucket: 'assets-two' },
        { workspaceId: 'w3', bucket: 'assets-three' },
      ],
    });
    db.groups.set('w1', ['g1']);
    const agora = fakeAgora();
    agora.failGroups.add('g1');
    const r2 = fakeStorage({ 'assets-two': ['x'], 'assets-three': ['boom'] });
    r2.failKeys.add('boom');
    const d = deps({ db: db.db, storage: r2.storage, agora: agora.agora });
    const summary = await runPurge(d);
    expect(db.workspacesDone).toEqual(['w2']);
    expect(r2.deletedBuckets).toEqual(['assets-two']);
    expect(summary).toMatchObject({ workspacesPurged: 1, workspacesFailed: 2 });
    expect(d.log.error).toHaveBeenCalledWith(
      'storage purge workspace failed',
      expect.objectContaining({ workspace_id: 'w1' }),
    );
  });

  it('never wipes a bucket a live workspace now uses', async () => {
    const db = fakeDb({ workspaces: [{ workspaceId: 'w1', bucket: 'assets-acme' }] });
    db.liveBuckets.add('assets-acme');
    const r2 = fakeStorage({ 'assets-acme': ['live-file'] });
    const summary = await runPurge(
      deps({ db: db.db, storage: r2.storage, agora: fakeAgora().agora }),
    );
    expect(r2.deleted).toEqual([]);
    expect(db.workspacesDone).toEqual([]);
    expect(summary.workspacesFailed).toBe(1);
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

describe('runPurge: per-workspace isolation and the live-bucket guard', () => {
  it('checks the guard first: a live bucket keeps its Agora groups and its objects', async () => {
    const db = fakeDb({ workspaces: [{ workspaceId: 'w1', bucket: 'assets-acme' }] });
    db.groups.set('w1', ['g1']);
    db.liveBuckets.add('assets-acme');
    const inUse = vi.spyOn(db.db, 'bucketInUse');
    const agora = fakeAgora();
    const r2 = fakeStorage({ 'assets-acme': ['live-file'] });
    const d = deps({ db: db.db, storage: r2.storage, agora: agora.agora });
    await runPurge(d);
    expect(inUse).toHaveBeenCalledWith('assets-acme', 'w1');
    expect(agora.deleted).toEqual([]);
    expect(r2.listCursors).toEqual([]);
    expect(r2.deletedBuckets).toEqual([]);
    expect(r2.store.get('assets-acme')?.has('live-file')).toBe(true);
    expect(d.log.error).toHaveBeenCalledWith(
      'storage purge workspace failed',
      expect.objectContaining({
        workspace_id: 'w1',
        error: expect.stringContaining('in use by a live workspace') as unknown,
      }),
    );
  });

  it('a guarded workspace does not stop the next one', async () => {
    const db = fakeDb({
      workspaces: [
        { workspaceId: 'w1', bucket: 'assets-shared' },
        { workspaceId: 'w2', bucket: 'assets-two' },
      ],
    });
    db.liveBuckets.add('assets-shared');
    const r2 = fakeStorage({ 'assets-shared': ['keep'], 'assets-two': ['x', 'y'] });
    const summary = await runPurge(
      deps({ db: db.db, storage: r2.storage, agora: fakeAgora().agora }),
    );
    expect(db.workspacesDone).toEqual(['w2']);
    expect(r2.deletedBuckets).toEqual(['assets-two']);
    expect(r2.store.get('assets-shared')?.size).toBe(1);
    expect(summary).toMatchObject({ workspacesPurged: 1, workspacesFailed: 1 });
  });

  it('a workspace whose bucket fails to delete is not marked done; the next still purges', async () => {
    const db = fakeDb({
      workspaces: [
        { workspaceId: 'w1', bucket: 'assets-one' },
        { workspaceId: 'w2', bucket: 'assets-two' },
      ],
    });
    const r2 = fakeStorage({ 'assets-one': ['a'], 'assets-two': ['b'] });
    vi.spyOn(r2.storage, 'deleteBucket').mockImplementation((bucket) =>
      bucket === 'assets-one'
        ? Promise.reject(new Error('R2 deleteBucket failed (500)'))
        : Promise.resolve(),
    );
    const summary = await runPurge(
      deps({ db: db.db, storage: r2.storage, agora: fakeAgora().agora }),
    );
    expect(db.workspacesDone).toEqual(['w2']);
    expect(summary).toMatchObject({ workspacesPurged: 1, workspacesFailed: 1 });
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

  it('asks for live workspaces other than this one on the bucket, and keeps a bucket one uses', async () => {
    supa.calls = [];
    supa.answers = {
      storage_purge_due: { data: [], error: null },
      workspace_purge_due: { data: [{ workspace_id: 'w1', bucket: 'assets-acme' }], error: null },
      workspaces: { count: 1, error: null },
    };
    const fetchSpy = vi.fn(() => Promise.resolve(new Response(null, { status: 500 })));
    vi.stubGlobal('fetch', fetchSpy);
    try {
      const summary = await handleScheduled(ENV);
      expect(supa.key).toBe('service-role-key');
      const guard = supa.calls.find((c) => c.target === 'workspaces');
      expect(guard?.chain).toEqual([
        ['from', ['workspaces']],
        ['select', ['id', { count: 'exact', head: true }]],
        ['eq', ['asset_bucket', 'assets-acme']],
        ['is', ['deleted_at', null]],
        ['neq', ['id', 'w1']],
      ]);
      expect(supa.calls.map((c) => c.target)).not.toContain('workspace_purge_done');
      expect(supa.calls.map((c) => c.target)).not.toContain('chat_channels');
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(summary).toMatchObject({ workspacesPurged: 0, workspacesFailed: 1 });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
