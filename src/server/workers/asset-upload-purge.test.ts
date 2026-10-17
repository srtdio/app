import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair, type JWK, type KeyLike } from 'jose';
import { InMemoryMultipartStorage, R2StorageClient, type TracedFetch } from '@srtdio/storage';
import { err, ok } from '@/server/assets';

// Serve a local public key in place of the remote JWKS; ES256 verification
// itself stays real. Mirrors asset-upload.test.ts.
const mockedJwks = vi.hoisted(() => ({ keys: [] as JWK[] }));
vi.mock('jose', async (importOriginal) => {
  const actual = await importOriginal<typeof import('jose')>();
  return {
    ...actual,
    createRemoteJWKSet: () => actual.createLocalJWKSet(mockedJwks),
  };
});

// supabase-js: every client records the key and headers it was built with,
// the rpcs it ran and the table queries it built (each builder call in order),
// so a test can tell the caller-token client from the service role. A table
// query resolves to `tables[table]`. Only the default (live) deps reach it;
// injected deps never do.
const supa = vi.hoisted(() => ({
  rpcs: [] as Array<{ key: string; authorization: string | undefined; fn: string; args: unknown }>,
  clients: [] as Array<{ key: string; headers: Record<string, string> }>,
  responses: {} as Record<string, { data: unknown; error: { message: string } | null }>,
  queries: [] as Array<{ key: string; table: string; calls: Array<[string, ...unknown[]]> }>,
  tables: {} as Record<string, unknown[]>,
}));
vi.mock('@supabase/supabase-js', () => ({
  createClient: (
    _url: string,
    key: string,
    options?: { global?: { headers?: Record<string, string> } },
  ) => {
    const headers = options?.global?.headers ?? {};
    supa.clients.push({ key, headers });
    return {
      from: (table: string) => {
        const query = { key, table, calls: [] as Array<[string, ...unknown[]]> };
        supa.queries.push(query);
        const chain: Record<string, unknown> = {};
        for (const name of ['select', 'eq', 'is', 'in', 'not', 'order', 'limit']) {
          chain[name] = (...args: unknown[]) => {
            query.calls.push([name, ...args]);
            return chain;
          };
        }
        chain.maybeSingle = () => Promise.resolve({ data: null, error: null });
        chain.then = (resolve: (v: unknown) => unknown) =>
          resolve({ data: supa.tables[table] ?? [], error: null });
        return chain;
      },
      rpc: (fn: string, args: unknown) => {
        supa.rpcs.push({ key, authorization: headers.Authorization, fn, args });
        return Promise.resolve(supa.responses[fn] ?? { data: null, error: null });
      },
    };
  },
}));

import {
  createSupabasePurgeRequester,
  createSupabasePurgeStore,
  handlePurge,
  handlePurgeChat,
  type PurgeDeps,
  type PurgeDueRow,
  type PurgeEnv,
} from './asset-upload-purge';

const WS = '11111111-1111-7111-8111-111111111111';
const OTHER_WS = '22222222-2222-7222-8222-222222222222';
const OWNER = '33333333-3333-7333-8333-333333333333';
const MEMBER = '44444444-4444-7444-8444-444444444444';
const STRANGER = '55555555-5555-7555-8555-555555555555';
const A1 = 'a1111111-1111-7111-8111-111111111111';
const A2 = 'a2222222-2222-7222-8222-222222222222';
const A3 = 'a3333333-3333-7333-8333-333333333333';
const B1 = 'b1111111-1111-7111-8111-111111111111';
const TRACE = '01900000-0000-7000-8000-000000000000';

const env = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SECRET_KEY: 'service-role-key',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
} as PurgeEnv;

let privateKey: KeyLike;
beforeAll(async () => {
  const pair = await generateKeyPair('ES256');
  privateKey = pair.privateKey;
  mockedJwks.keys = [{ ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'ES256' }];
});

async function token(sub: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
    .setSubject(sub)
    .setExpirationTime('5m')
    .sign(privateKey);
}

/** The sub claim of a token (base64url payload). */
function subOf(t: string): string {
  const payload = (t.split('.')[1] ?? '').replace(/-/g, '+').replace(/_/g, '/');
  return (JSON.parse(atob(payload)) as { sub: string }).sub;
}

interface FakeAsset {
  workspace: string;
  bucket: string;
  keys: string[];
  bytes: number;
  origin: 'library' | 'chat';
  purgeRequested: boolean;
  inUse: boolean;
}

/** One in-memory DB + R2 the deps read and write. */
function world() {
  const assets = new Map<string, FakeAsset>();
  const owners = new Map([
    [WS, OWNER],
    [OTHER_WS, STRANGER],
  ]);
  const members = new Set([`${OWNER}:${WS}`, `${MEMBER}:${WS}`, `${STRANGER}:${OTHER_WS}`]);
  const r2 = new InMemoryMultipartStorage();
  const failingKeys = new Set<string>();
  const tokensSeen: string[] = [];
  const doneCalls: string[][] = [];

  async function add(id: string, asset: Partial<FakeAsset> & { workspace: string }) {
    const full: FakeAsset = {
      bucket: `assets-${asset.workspace.slice(0, 4)}`,
      keys: [`images/${id}/v1-a.png`, `images/${id}/v1-thumb.jpg`],
      bytes: 100,
      origin: 'library',
      purgeRequested: false,
      inUse: false,
      ...asset,
    };
    assets.set(id, full);
    for (const key of full.keys) {
      await r2.putObject({
        bucket: full.bucket,
        key,
        body: new Uint8Array(1),
        contentType: 'image/png',
        traceId: TRACE,
      });
    }
  }

  const objects: PurgeDeps['objects'] = {
    deleteObject(bucket, key) {
      if (failingKeys.has(key)) return Promise.reject(new Error('R2 deleteObject failed (500)'));
      return r2.deleteObject(bucket, key);
    },
  };

  const deps: PurgeDeps = {
    objects,
    requestPurge: ({ token: t, workspaceId, assetIds }) => {
      tokensSeen.push(t);
      if (owners.get(workspaceId) !== subOf(t)) return Promise.resolve(err('owner_only'));
      let n = 0;
      for (const [id, a] of assets) {
        if (a.workspace !== workspaceId || a.origin !== 'library' || a.purgeRequested) continue;
        if (assetIds !== null && !assetIds.includes(id)) continue;
        a.purgeRequested = true;
        n += 1;
      }
      return Promise.resolve(ok(n));
    },
    store: {
      isActiveMember: ({ userId, workspaceId }) =>
        Promise.resolve(members.has(`${userId}:${workspaceId}`)),
      due: ({ workspaceId, assetIds, limit }) => {
        const rows: PurgeDueRow[] = [...assets]
          .filter(
            ([id, a]) =>
              a.workspace === workspaceId &&
              (assetIds === null || assetIds.includes(id)) &&
              a.purgeRequested &&
              !a.inUse,
          )
          .map(([id, a]) => ({
            asset_id: id,
            workspace_id: a.workspace,
            bucket: a.bucket,
            r2_keys: a.keys,
            bytes: a.bytes,
          }));
        return Promise.resolve(rows.slice(0, limit));
      },
      done: (ids) => {
        doneCalls.push([...ids]);
        let n = 0;
        for (const id of ids) if (assets.delete(id)) n += 1;
        return Promise.resolve(n);
      },
    },
  };
  return { assets, r2, failingKeys, tokensSeen, doneCalls, add, deps };
}

async function post(
  handler: typeof handlePurge,
  deps: PurgeDeps,
  body: unknown,
  sub: string | null,
): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (sub !== null) headers.set('Authorization', `Bearer ${await token(sub)}`);
  const request = new Request('https://upload.example/purge', {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const res = await handler(request, env, TRACE, 'https://srtd.io', deps);
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
    headers: res.headers,
  };
}

let w: ReturnType<typeof world>;
beforeEach(() => {
  w = world();
  supa.rpcs = [];
  supa.clients = [];
  supa.responses = {};
  supa.queries = [];
  supa.tables = {};
});

describe('POST /purge', () => {
  it('lets the owner empty Recently deleted and reports requested, removed, freed bytes', async () => {
    await w.add(A1, { workspace: WS, bytes: 1000 });
    await w.add(A2, { workspace: WS, bytes: 24 });
    const res = await post(handlePurge, w.deps, { workspace_id: WS }, OWNER);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ requested: 2, removed: 2, freedBytes: 1024 });
    expect(w.r2.objects.size).toBe(0);
    expect(w.assets.size).toBe(0);
    expect(res.headers.get('X-Trace-Id')).toBe(TRACE);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://srtd.io');
  });

  it('runs asset_purge_request with the caller token', async () => {
    await post(handlePurge, w.deps, { workspace_id: WS }, OWNER);
    expect(w.tokensSeen).toHaveLength(1);
    expect(subOf(w.tokensSeen[0] ?? '')).toBe(OWNER);
  });

  it('is 403 owner_only for a member who is not the owner, and touches nothing', async () => {
    await w.add(A1, { workspace: WS });
    const res = await post(handlePurge, w.deps, { workspace_id: WS }, MEMBER);
    expect(res.status).toBe(403);
    expect((res.body.error as { code: string }).code).toBe('owner_only');
    expect(w.assets.size).toBe(1);
    expect(w.r2.objects.size).toBe(2);
  });

  it('purges only the given ids', async () => {
    await w.add(A1, { workspace: WS, bytes: 5 });
    await w.add(A2, { workspace: WS, bytes: 7 });
    const res = await post(handlePurge, w.deps, { workspace_id: WS, asset_ids: [A2] }, OWNER);
    expect(res.body).toEqual({ requested: 1, removed: 1, freedBytes: 7 });
    expect([...w.assets.keys()]).toEqual([A1]);
  });

  it('never sweeps another workspace, even when its rows are due', async () => {
    await w.add(B1, { workspace: OTHER_WS, purgeRequested: true });
    await w.add(A1, { workspace: WS });
    const res = await post(handlePurge, w.deps, { workspace_id: WS }, OWNER);
    expect(res.body).toEqual({ requested: 1, removed: 1, freedBytes: 100 });
    expect([...w.assets.keys()]).toEqual([B1]);
    expect(w.doneCalls).toEqual([[A1]]);
  });

  it('skips rows storage_purge_due leaves out (in use)', async () => {
    await w.add(A1, { workspace: WS, inUse: true });
    const res = await post(handlePurge, w.deps, { workspace_id: WS }, OWNER);
    expect(res.body).toEqual({ requested: 1, removed: 0, freedBytes: 0 });
    expect(w.doneCalls).toEqual([]);
  });

  it('is idempotent: a second call finds nothing and succeeds', async () => {
    await w.add(A1, { workspace: WS });
    await post(handlePurge, w.deps, { workspace_id: WS }, OWNER);
    const again = await post(handlePurge, w.deps, { workspace_id: WS }, OWNER);
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ requested: 0, removed: 0, freedBytes: 0 });
  });

  it('fails loudly on a key that will not delete, keeps that row, and a retry finishes it', async () => {
    await w.add(A1, { workspace: WS, bytes: 10 });
    await w.add(A2, { workspace: WS, bytes: 20 });
    w.failingKeys.add(`images/${A2}/v1-thumb.jpg`);
    const res = await post(handlePurge, w.deps, { workspace_id: WS }, OWNER);
    expect(res.status).toBe(500);
    expect((res.body.error as { code: string }).code).toBe('internal_error');
    expect(w.doneCalls).toEqual([[A1]]);
    expect([...w.assets.keys()]).toEqual([A2]);

    w.failingKeys.clear();
    const retry = await post(handlePurge, w.deps, { workspace_id: WS }, OWNER);
    expect(retry.body).toEqual({ requested: 0, removed: 1, freedBytes: 20 });
    expect(w.r2.objects.size).toBe(0);
  });

  it('treats a key already gone from R2 (404) as deleted', async () => {
    await w.add(A1, { workspace: WS });
    const calls: string[] = [];
    const notFound: TracedFetch = (input, init) => {
      calls.push(`${init?.method ?? 'GET'} ${String(input)}`);
      return Promise.resolve(
        new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 }),
      );
    };
    const objects = new R2StorageClient(
      {
        CLOUDFLARE_ACCOUNT_ID: 'acct',
        CLOUDFLARE_R2_ACCESS_KEY_ID: 'key',
        CLOUDFLARE_R2_SECRET_ACCESS_KEY: 'secret',
      },
      notFound,
    );
    const res = await post(handlePurge, { ...w.deps, objects }, { workspace_id: WS }, OWNER);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ requested: 1, removed: 1, freedBytes: 100 });
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.startsWith('DELETE '))).toBe(true);
  });

  it('is 401 without a valid bearer', async () => {
    expect((await post(handlePurge, w.deps, { workspace_id: WS }, null)).status).toBe(401);
  });

  it.each([
    ['not JSON', 'nope'],
    ['a bad workspace id', { workspace_id: 'x' }],
    ['an empty id list', { workspace_id: WS, asset_ids: [] }],
    ['a bad id', { workspace_id: WS, asset_ids: ['x'] }],
    ['more than 1000 ids', { workspace_id: WS, asset_ids: Array<string>(1001).fill(A1) }],
  ])('is 400 bad_request for %s', async (_label, body) => {
    const res = await post(handlePurge, w.deps, body, OWNER);
    expect(res.status).toBe(400);
    expect((res.body.error as { code: string }).code).toBe('bad_request');
    expect(w.tokensSeen).toEqual([]);
  });
});

describe('POST /purge-chat', () => {
  it('removes purge-requested chat files and reports counts', async () => {
    await w.add(A1, { workspace: WS, origin: 'chat', purgeRequested: true, bytes: 40 });
    await w.add(A2, { workspace: WS, origin: 'chat', purgeRequested: true, bytes: 2 });
    const res = await post(
      handlePurgeChat,
      w.deps,
      { workspace_id: WS, asset_ids: [A1, A2] },
      MEMBER,
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ removed: 2, freedBytes: 42 });
    expect(w.tokensSeen).toEqual([]);
  });

  it('is 403 not_member for a caller outside the workspace', async () => {
    await w.add(A1, { workspace: WS, origin: 'chat', purgeRequested: true });
    const res = await post(
      handlePurgeChat,
      w.deps,
      { workspace_id: WS, asset_ids: [A1] },
      STRANGER,
    );
    expect(res.status).toBe(403);
    expect((res.body.error as { code: string }).code).toBe('not_member');
    expect(w.assets.size).toBe(1);
  });

  it('leaves rows without purge_requested_at, other ids, and other workspaces alone', async () => {
    await w.add(A1, { workspace: WS, origin: 'chat', purgeRequested: true });
    await w.add(A2, { workspace: WS, origin: 'chat', purgeRequested: false });
    await w.add(A3, { workspace: WS, origin: 'chat', purgeRequested: true });
    await w.add(B1, { workspace: OTHER_WS, origin: 'chat', purgeRequested: true });
    const res = await post(
      handlePurgeChat,
      w.deps,
      { workspace_id: WS, asset_ids: [A1, A2, B1] },
      MEMBER,
    );
    expect(res.body).toEqual({ removed: 1, freedBytes: 100 });
    expect([...w.assets.keys()].sort()).toEqual([A2, A3, B1].sort());
  });

  it('answers 200 with counts when a key fails, leaving that row for the nightly sweep', async () => {
    await w.add(A1, { workspace: WS, origin: 'chat', purgeRequested: true, bytes: 3 });
    await w.add(A2, { workspace: WS, origin: 'chat', purgeRequested: true, bytes: 9 });
    w.failingKeys.add(`images/${A1}/v1-a.png`);
    const res = await post(
      handlePurgeChat,
      w.deps,
      { workspace_id: WS, asset_ids: [A1, A2] },
      MEMBER,
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ removed: 1, freedBytes: 9 });
    expect([...w.assets.keys()]).toEqual([A1]);
  });

  it('is idempotent', async () => {
    await w.add(A1, { workspace: WS, origin: 'chat', purgeRequested: true });
    await post(handlePurgeChat, w.deps, { workspace_id: WS, asset_ids: [A1] }, MEMBER);
    const again = await post(
      handlePurgeChat,
      w.deps,
      { workspace_id: WS, asset_ids: [A1] },
      MEMBER,
    );
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ removed: 0, freedBytes: 0 });
  });

  it('requires asset_ids and a valid bearer', async () => {
    expect((await post(handlePurgeChat, w.deps, { workspace_id: WS }, MEMBER)).status).toBe(400);
    expect(
      (await post(handlePurgeChat, w.deps, { workspace_id: WS, asset_ids: [A1] }, null)).status,
    ).toBe(401);
  });
});

describe('asset_purge_request runs as the caller, never the service role', () => {
  it('handlePurge passes the exact bearer token through', async () => {
    const t = await token(OWNER);
    const request = new Request('https://upload.example/purge', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${t}` },
      body: JSON.stringify({ workspace_id: WS }),
    });
    await handlePurge(request, env, TRACE, null, w.deps);
    expect(w.tokensSeen).toEqual([t]);
  });

  it('the live requester builds its client from the publishable key and the caller token', async () => {
    supa.responses.asset_purge_request = { data: 3, error: null };
    const res = await createSupabasePurgeRequester(env)({
      token: 'caller-jwt',
      workspaceId: WS,
      assetIds: [A1],
      traceId: TRACE,
    });
    expect(res).toEqual(ok(3));
    expect(supa.clients).toEqual([
      {
        key: 'sb_publishable_test',
        headers: { Authorization: 'Bearer caller-jwt', 'X-Trace-Id': TRACE },
      },
    ]);
    expect(supa.rpcs).toEqual([
      {
        key: 'sb_publishable_test',
        authorization: 'Bearer caller-jwt',
        fn: 'asset_purge_request',
        args: { p_workspace_id: WS, p_asset_ids: [A1], p_trace_id: TRACE },
      },
    ]);
  });

  it('sends p_asset_ids null for "everything" and maps the proc owner_only to a 403 result', async () => {
    supa.responses.asset_purge_request = { data: null, error: { message: 'owner_only' } };
    const res = await createSupabasePurgeRequester(env)({
      token: 'member-jwt',
      workspaceId: WS,
      assetIds: null,
      traceId: TRACE,
    });
    expect(res).toEqual(err('owner_only'));
    expect(supa.rpcs[0]?.args).toEqual({
      p_workspace_id: WS,
      p_asset_ids: null,
      p_trace_id: TRACE,
    });
  });

  it('throws on any other proc error instead of treating it as allowed', async () => {
    supa.responses.asset_purge_request = { data: null, error: { message: 'boom' } };
    await expect(
      createSupabasePurgeRequester(env)({
        token: 't',
        workspaceId: WS,
        assetIds: null,
        traceId: TRACE,
      }),
    ).rejects.toThrow('asset_purge_request failed: boom');
  });

  it('refuses to run without the publishable key and never falls back to the secret key', async () => {
    const noKey = { ...env, SUPABASE_PUBLISHABLE_KEY: '' } as PurgeEnv;
    await expect(
      createSupabasePurgeRequester(noKey)({
        token: 't',
        workspaceId: WS,
        assetIds: null,
        traceId: TRACE,
      }),
    ).rejects.toThrow('SUPABASE_PUBLISHABLE_KEY is not set');
    expect(supa.clients).toEqual([]);
    expect(supa.rpcs).toEqual([]);
  });

  it('with live deps, only the sweep read uses the service role', async () => {
    supa.responses.asset_purge_request = { data: 0, error: null };
    const t = await token(OWNER);
    const request = new Request('https://upload.example/purge', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${t}` },
      body: JSON.stringify({ workspace_id: WS }),
    });
    const res = await handlePurge(request, env, TRACE, null);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ requested: 0, removed: 0, freedBytes: 0 });
    const request_ = supa.rpcs.filter((r) => r.fn === 'asset_purge_request');
    expect(request_).toEqual([expect.objectContaining({ key: 'sb_publishable_test' })]);
    expect(request_[0]?.authorization).toBe(`Bearer ${t}`);
    expect(supa.rpcs.filter((r) => r.key === 'service-role-key')).toEqual([]);
    expect(supa.queries.map((q) => [q.key, q.table])).toEqual([['service-role-key', 'assets']]);
  });

  it('with live deps, an owner_only proc answer is 403 and nothing is swept', async () => {
    supa.responses.asset_purge_request = { data: null, error: { message: 'owner_only' } };
    const t = await token(MEMBER);
    const request = new Request('https://upload.example/purge', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${t}` },
      body: JSON.stringify({ workspace_id: WS }),
    });
    const res = await handlePurge(request, env, TRACE, null);
    expect(res.status).toBe(403);
    expect(supa.rpcs.map((r) => r.fn)).toEqual(['asset_purge_request']);
  });
});

describe('POST /purge-chat membership', () => {
  it('checks the verified caller, not an id in the body, and sweeps nothing for a non-member', async () => {
    await w.add(A1, { workspace: WS, origin: 'chat', purgeRequested: true });
    const isActiveMember = vi.spyOn(w.deps.store, 'isActiveMember');
    const due = vi.spyOn(w.deps.store, 'due');
    const res = await post(
      handlePurgeChat,
      w.deps,
      { workspace_id: WS, asset_ids: [A1], user_id: MEMBER },
      STRANGER,
    );
    expect(res.status).toBe(403);
    expect(isActiveMember).toHaveBeenCalledWith({ userId: STRANGER, workspaceId: WS });
    expect(due).not.toHaveBeenCalled();
    expect(w.r2.objects.size).toBe(2);
  });

  it('a member of another workspace cannot purge this one', async () => {
    await w.add(A1, { workspace: WS, origin: 'chat', purgeRequested: true });
    // STRANGER is an active member of OTHER_WS only.
    const res = await post(
      handlePurgeChat,
      w.deps,
      { workspace_id: WS, asset_ids: [A1] },
      STRANGER,
    );
    expect(res.status).toBe(403);
    expect(w.assets.has(A1)).toBe(true);
  });

  it('is 403 owner_only for /purge before any sweep read', async () => {
    const due = vi.spyOn(w.deps.store, 'due');
    const res = await post(handlePurge, w.deps, { workspace_id: WS }, MEMBER);
    expect(res.status).toBe(403);
    expect(due).not.toHaveBeenCalled();
  });
});

describe('the live due read', () => {
  const V1 = 'c1111111-1111-7111-8111-111111111111';
  const POST_LIVE = 'd1111111-1111-7111-8111-111111111111';
  const POST_GONE = 'd2222222-2222-7222-8222-222222222222';

  function assetRow(id: string, requestedAt: string, attachments: unknown[] = []) {
    return {
      id,
      workspace_id: WS,
      purge_requested_at: requestedAt,
      workspaces: { asset_bucket: 'assets-ws' },
      asset_versions: [
        {
          r2_key: `${id}/v1`,
          size_bytes: 10,
          asset_renditions: [
            { r2_key: `${id}/v1-thumb`, size_bytes: 2 },
            { r2_key: null, size_bytes: 1 },
          ],
        },
        { r2_key: null, size_bytes: null, asset_renditions: [] },
        { r2_key: `${id}/v2`, size_bytes: 5, asset_renditions: [] },
      ],
      asset_attachments: attachments,
    };
  }

  const due = (assetIds: string[] | null) =>
    createSupabasePurgeStore(env, TRACE).due({ workspaceId: WS, assetIds, limit: 1000 }, TRACE);

  it('reads only this workspace, never storage_purge_due, so rows due elsewhere cannot crowd it out', async () => {
    supa.tables.assets = [assetRow(A1, '2026-10-17T10:00:00Z')];
    const rows = await due(null);
    expect(rows.map((r) => r.asset_id)).toEqual([A1]);
    expect(supa.rpcs).toEqual([]);
    const [query] = supa.queries;
    expect(query?.key).toBe('service-role-key');
    expect(query?.table).toBe('assets');
    expect(query?.calls.slice(1)).toEqual([
      ['eq', 'workspace_id', WS],
      ['not', 'deleted_at', 'is', null],
      ['not', 'purge_requested_at', 'is', null],
      ['order', 'purge_requested_at'],
      ['limit', 1000],
    ]);
  });

  it('builds r2_keys as storage_purge_due does (version keys, then rendition keys) and sums bytes', async () => {
    supa.tables.assets = [assetRow(A1, '2026-10-17T10:00:00Z')];
    expect(await due(null)).toEqual([
      {
        asset_id: A1,
        workspace_id: WS,
        bucket: 'assets-ws',
        r2_keys: [`${A1}/v1`, `${A1}/v2`, `${A1}/v1-thumb`],
        bytes: 18,
      },
    ]);
  });

  it('filters by the given ids in chunks and keeps the oldest request first', async () => {
    supa.tables.assets = [
      assetRow(A2, '2026-10-17T11:00:00Z'),
      assetRow(A1, '2026-10-17T10:00:00Z'),
    ];
    const ids = Array.from(
      { length: 151 },
      (_, i) => `${String(i).padStart(8, '0')}${V1.slice(8)}`,
    );
    const rows = await due(ids);
    const idFilters = supa.queries
      .filter((q) => q.table === 'assets')
      .map((q) => q.calls.find((c) => c[0] === 'in'));
    expect(idFilters).toEqual([
      ['in', 'id', ids.slice(0, 150)],
      ['in', 'id', ids.slice(150)],
    ]);
    // Each chunk read returns both fixtures here; the order is by request time.
    expect(rows.map((r) => r.asset_id)).toEqual([A1, A1, A2, A2]);
  });

  it('drops rows asset_in_use would keep: a live attachment to a live post', async () => {
    supa.tables.assets = [
      assetRow(A1, '2026-10-17T10:00:00Z', [
        { entity_type: 'post', entity_id: POST_LIVE, deleted_at: null },
      ]),
      assetRow(A2, '2026-10-17T10:00:00Z', [
        { entity_type: 'post', entity_id: POST_GONE, deleted_at: null },
        { entity_type: 'post', entity_id: POST_LIVE, deleted_at: '2026-10-01T00:00:00Z' },
        { entity_type: 'toString', entity_id: POST_LIVE, deleted_at: null },
        { entity_type: 'post', entity_id: POST_LIVE.toUpperCase(), deleted_at: null },
      ]),
    ];
    supa.tables.posts = [{ id: POST_LIVE }];
    const rows = await due(null);
    expect(rows.map((r) => r.asset_id)).toEqual([A2]);
    const posts = supa.queries.find((q) => q.table === 'posts');
    expect(posts?.calls).toEqual([
      ['select', 'id'],
      ['in', 'id', [POST_LIVE, POST_GONE]],
      ['is', 'deleted_at', null],
    ]);
    expect(supa.queries.map((q) => q.table)).toEqual(['assets', 'posts']);
  });
});
