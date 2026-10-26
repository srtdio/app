import { describe, expect, it } from 'vitest';
import {
  countCheck,
  lifecycleXml,
  moveWithRetry,
  newKeyFor,
  parseCountChanged,
  parseOptions,
  planCopy,
  R2,
  uuidv7,
  verifyWorkspace,
  type DbObject,
  type MoveDeps,
  type MoveRpcResult,
} from './storage-move.ts';

const WS = '11111111-1111-4111-8111-111111111111';
const ASSET = '22222222-2222-4222-8222-222222222222';
const VERSION = '33333333-3333-4333-8333-333333333333';
const RENDITION = '44444444-4444-4444-8444-444444444444';
const OLD = 'assets-gbl-apac';
const TARGET = 'srtdio-files';

function version(id: string, r2Key: string, sizeBytes: number | null = 10): DbObject {
  return { kind: 'version', id, workspaceId: WS, assetId: ASSET, r2Key, sizeBytes };
}

function rendition(id: string, r2Key: string, sizeBytes: number | null = 5): DbObject {
  return {
    kind: 'rendition',
    id,
    workspaceId: WS,
    versionId: VERSION,
    assetId: ASSET,
    role: 'thumbnail',
    r2Key,
    sizeBytes,
  };
}

/** SQL of storage_workspace_move, as a string template, for comparison. */
function sqlVersionKey(ws: string, assetId: string, id: string): string {
  return 'ws/' + ws + '/' + assetId + '/' + id + '/original';
}
function sqlRenditionKey(ws: string, assetId: string, versionId: string, role: string): string {
  return 'ws/' + ws + '/' + assetId + '/' + versionId + '/' + role;
}

describe('newKeyFor', () => {
  it('maps a version like the SQL', () => {
    expect(newKeyFor(version(VERSION, 'gbl/old/name.png'))).toBe(sqlVersionKey(WS, ASSET, VERSION));
  });

  it('maps a rendition with its version and role like the SQL', () => {
    expect(newKeyFor(rendition(RENDITION, 'gbl/old/thumb.jpg'))).toBe(
      sqlRenditionKey(WS, ASSET, VERSION, 'thumbnail'),
    );
  });

  it('keeps ws/ and induction-sample/ keys', () => {
    expect(newKeyFor(version(VERSION, 'ws/a/b/c/original'))).toBe('ws/a/b/c/original');
    expect(newKeyFor(rendition(RENDITION, 'induction-sample/x.jpg'))).toBe('induction-sample/x.jpg');
  });
});

describe('planCopy', () => {
  it('copies when the target is absent', () => expect(planCopy(10, null)).toBe('copy'));
  it('skips when the target has the same size', () => expect(planCopy(10, 10)).toBe('skip'));
  it('reports a conflict when the size differs', () => expect(planCopy(10, 11)).toBe('conflict'));
});

describe('countCheck and parseCountChanged', () => {
  it('matches equal counts', () => expect(countCheck(3, 3)).toEqual({ ok: true }));
  it('reports a changed count', () =>
    expect(countCheck(3, 4)).toEqual({ ok: false, expected: 3, live: 4 }));
  it('reads the live count from the PostgREST error', () => {
    expect(parseCountChanged({ code: 'P0001', message: 'object_count_changed', details: '7' })).toBe(7);
    expect(parseCountChanged({ message: 'workspace not found', details: null })).toBeNull();
    expect(parseCountChanged(null)).toBeNull();
  });
});

describe('parseOptions', () => {
  it('reads modes and workspace', () => {
    expect(parseOptions(['setup'])).toEqual({ mode: 'setup', workspace: 'all' });
    expect(parseOptions(['move', '--all'])).toEqual({ mode: 'move', workspace: 'all' });
    expect(parseOptions(['verify', '--workspace', WS])).toEqual({ mode: 'verify', workspace: WS });
    expect(parseOptions(['move', '--workspace', 'all'])).toEqual({ mode: 'move', workspace: 'all' });
  });
  it('rejects bad input', () => {
    expect(() => parseOptions(['delete', '--all'])).toThrow();
    expect(() => parseOptions(['move'])).toThrow();
    expect(() => parseOptions(['move', '--workspace', 'gbl'])).toThrow();
  });
});

describe('uuidv7', () => {
  it('has version 7 and variant 10 and the timestamp first', () => {
    const id = uuidv7(0x0123456789ab, new Uint8Array(10).fill(0xff));
    expect(id).toMatch(/^01234567-89ab-7fff-bfff-ffffffffffff$/);
  });
});

/** In-memory buckets and DB. Records every storage call; offers no delete. */
function world(objects: DbObject[], buckets: Record<string, Record<string, number>>) {
  const store = new Map<string, Map<string, number>>();
  for (const [name, keys] of Object.entries(buckets)) store.set(name, new Map(Object.entries(keys)));
  const calls: string[] = [];
  const rows = [...objects];
  const rpcCalls: number[] = [];
  let onRpc: ((expected: number) => MoveRpcResult) | null = null;
  const deps: MoveDeps = {
    targetBucket: TARGET,
    concurrency: 3,
    listObjects: () => {
      calls.push('list');
      return Promise.resolve([...rows]);
    },
    headObject: (bucket, key) => {
      calls.push(`head:${bucket}/${key}`);
      return Promise.resolve(store.get(bucket)?.get(key) ?? null);
    },
    copyObject: ({ sourceBucket, sourceKey, targetBucket, targetKey }) => {
      calls.push(`copy:${sourceBucket}/${sourceKey}->${targetBucket}/${targetKey}`);
      const size = store.get(sourceBucket)?.get(sourceKey);
      if (size === undefined) return Promise.reject(new Error('no source'));
      if (!store.has(targetBucket)) store.set(targetBucket, new Map());
      store.get(targetBucket)?.set(targetKey, size);
      return Promise.resolve();
    },
    moveRpc: ({ expectedObjects }) => {
      rpcCalls.push(expectedObjects);
      if (onRpc !== null) return Promise.resolve(onRpc(expectedObjects));
      return Promise.resolve(
        expectedObjects === rows.length ? { ok: true } : { ok: false, countChanged: rows.length },
      );
    },
  };
  return {
    deps,
    store,
    calls,
    rows,
    rpcCalls,
    setRpc: (fn: (expected: number) => MoveRpcResult) => {
      onRpc = fn;
    },
  };
}

const V2 = '55555555-5555-4555-8555-555555555555';

describe('moveWithRetry', () => {
  it('copies to the new keys, verifies, counts samples, and moves', async () => {
    const w = world(
      [
        version(VERSION, 'gbl/a.png'),
        rendition(RENDITION, 'gbl/a-thumb.jpg'),
        version(V2, 'induction-sample/s.png'),
      ],
      { [OLD]: { 'gbl/a.png': 10, 'gbl/a-thumb.jpg': 5 } },
    );
    const report = await moveWithRetry({ id: WS, bucket: OLD }, w.deps);
    expect(report).toMatchObject({ copied: 2, skipped: 0, verified: 3, moved: true, problems: [] });
    expect(w.store.get(TARGET)?.get(sqlVersionKey(WS, ASSET, VERSION))).toBe(10);
    expect(w.store.get(TARGET)?.get(sqlRenditionKey(WS, ASSET, VERSION, 'thumbnail'))).toBe(5);
    expect(w.rpcCalls).toEqual([3]);
    expect(w.calls.some((c) => c.includes('induction-sample'))).toBe(false);
    // Source objects are never removed.
    expect(w.store.get(OLD)?.size).toBe(2);
  });

  it('skips an object already in the target at the same size', async () => {
    const w = world([version(VERSION, 'gbl/a.png')], {
      [OLD]: { 'gbl/a.png': 10 },
      [TARGET]: { [sqlVersionKey(WS, ASSET, VERSION)]: 10 },
    });
    const report = await moveWithRetry({ id: WS, bucket: OLD }, w.deps);
    expect(report).toMatchObject({ copied: 0, skipped: 1, verified: 1, moved: true });
    expect(w.calls.some((c) => c.startsWith('copy:'))).toBe(false);
  });

  it('never overwrites a differing target: stops the workspace without the rpc', async () => {
    const key = sqlVersionKey(WS, ASSET, VERSION);
    const w = world([version(VERSION, 'gbl/a.png')], {
      [OLD]: { 'gbl/a.png': 10 },
      [TARGET]: { [key]: 99 },
    });
    const report = await moveWithRetry({ id: WS, bucket: OLD }, w.deps);
    expect(report.moved).toBe(false);
    expect(report.problems[0]).toContain('left untouched');
    expect(w.store.get(TARGET)?.get(key)).toBe(99);
    expect(w.rpcCalls).toEqual([]);
  });

  it('stops when a source object is missing', async () => {
    const w = world([version(VERSION, 'gbl/gone.png')], { [OLD]: {} });
    const report = await moveWithRetry({ id: WS, bucket: OLD }, w.deps);
    expect(report.moved).toBe(false);
    expect(w.rpcCalls).toEqual([]);
  });

  it('on object_count_changed re-lists, copies the new object and succeeds', async () => {
    const w = world([version(VERSION, 'gbl/a.png')], { [OLD]: { 'gbl/a.png': 10, 'gbl/b.png': 7 } });
    let first = true;
    w.setRpc((expected) => {
      if (first) {
        first = false;
        // An upload landed between the copy and the switch.
        w.rows.push(version(V2, 'gbl/b.png'));
        return { ok: false, countChanged: 2 };
      }
      return expected === w.rows.length ? { ok: true } : { ok: false, countChanged: w.rows.length };
    });
    const report = await moveWithRetry({ id: WS, bucket: OLD }, w.deps);
    expect(report).toMatchObject({ copied: 2, verified: 2, moved: true });
    expect(w.rpcCalls).toEqual([1, 2]);
    expect(w.store.get(TARGET)?.get(sqlVersionKey(WS, ASSET, V2))).toBe(7);
    // The first object is not copied twice.
    expect(w.calls.filter((c) => c.startsWith('copy:'))).toHaveLength(2);
  });

  it('stops after 3 retries when the count keeps changing', async () => {
    const w = world([version(VERSION, 'gbl/a.png')], { [OLD]: { 'gbl/a.png': 10 } });
    w.setRpc((expected) => ({ ok: false, countChanged: expected + 1 }));
    const report = await moveWithRetry({ id: WS, bucket: OLD }, w.deps);
    expect(report.moved).toBe(false);
    expect(w.rpcCalls).toHaveLength(4);
    expect(report.problems[0]).toContain('after 3 retries');
  });
});

describe('verifyWorkspace', () => {
  it('passes when every key is there at the DB size and skips samples', async () => {
    const key = sqlVersionKey(WS, ASSET, VERSION);
    const w = world([version(VERSION, key, 10), version(V2, 'induction-sample/s.png')], {
      [TARGET]: { [key]: 10 },
    });
    const report = await verifyWorkspace(WS, w.deps);
    expect(report).toEqual({ workspaceId: WS, verified: 2, problems: [] });
  });

  it('fails on a missing key or a size mismatch', async () => {
    const a = sqlVersionKey(WS, ASSET, VERSION);
    const b = sqlVersionKey(WS, ASSET, V2);
    const w = world([version(VERSION, a, 10), version(V2, b, 10)], { [TARGET]: { [a]: 11 } });
    const report = await verifyWorkspace(WS, w.deps);
    expect(report.verified).toBe(0);
    expect(report.problems).toHaveLength(2);
  });

  it('only checks existence when the DB has no size', async () => {
    const a = sqlVersionKey(WS, ASSET, VERSION);
    const w = world([version(VERSION, a, null)], { [TARGET]: { [a]: 3 } });
    expect((await verifyWorkspace(WS, w.deps)).problems).toEqual([]);
  });
});

describe('R2 client', () => {
  const env = {
    CLOUDFLARE_ACCOUNT_ID: 'acct',
    CLOUDFLARE_R2_ACCESS_KEY_ID: 'id',
    CLOUDFLARE_R2_SECRET_ACCESS_KEY: 'secret',
  };

  it('sends only HEAD and PUT for a move, never DELETE, with the trace id', async () => {
    const seen: { method: string; url: string; copySource: string | null; trace: string }[] = [];
    const r2 = new R2(env, (url, init, traceId) => {
      const headers = new Headers(init.headers);
      seen.push({
        method: init.method ?? 'GET',
        url,
        copySource: headers.get('x-amz-copy-source'),
        trace: traceId,
      });
      if (init.method === 'HEAD') {
        return Promise.resolve(new Response(null, { status: 200, headers: { 'content-length': '10' } }));
      }
      return Promise.resolve(new Response('<CopyObjectResult></CopyObjectResult>', { status: 200 }));
    });
    expect(await r2.headObject(OLD, 'gbl/a b.png', 't1')).toBe(10);
    await r2.copyObject({
      sourceBucket: OLD,
      sourceKey: 'gbl/a b.png',
      targetBucket: TARGET,
      targetKey: 'ws/x/y/z/original',
      traceId: 't1',
    });
    expect(seen.map((s) => s.method)).toEqual(['HEAD', 'PUT']);
    expect(seen.some((s) => s.method === 'DELETE')).toBe(false);
    expect(seen[1]?.url).toBe('https://acct.r2.cloudflarestorage.com/srtdio-files/ws/x/y/z/original');
    expect(seen[1]?.copySource).toBe('/assets-gbl-apac/gbl/a%20b.png');
    expect(seen.every((s) => s.trace === 't1')).toBe(true);
  });

  it('reports a missing object as null', async () => {
    const r2 = new R2(env, () => Promise.resolve(new Response(null, { status: 404 })));
    expect(await r2.headObject(TARGET, 'k', 't')).toBeNull();
  });

  it('fails a copy that answers 200 with an <Error> body', async () => {
    const r2 = new R2(env, () =>
      Promise.resolve(new Response('<Error><Code>InternalError</Code></Error>', { status: 200 })),
    );
    await expect(
      r2.copyObject({ sourceBucket: OLD, sourceKey: 'a', targetBucket: TARGET, targetKey: 'b', traceId: 't' }),
    ).rejects.toThrow();
  });

  it('builds lifecycle rules for uploads/ and multipart aborts', () => {
    const xml = lifecycleXml();
    expect(xml).toContain('<Prefix>uploads/</Prefix>');
    expect(xml).toContain('<Expiration><Days>1</Days></Expiration>');
    expect(xml).toContain('<DaysAfterInitiation>1</DaysAfterInitiation>');
  });
});
