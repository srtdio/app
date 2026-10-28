import { describe, expect, it } from 'vitest';
import {
  AudioR2,
  convertAll,
  copyKeyFor,
  listTargets,
  parseDurationMs,
  parseMode,
  selectTargets,
  verifyCopies,
  VoiceDb,
  type ConvertDeps,
  type CopyRow,
  type NewCopyRow,
  type WebmVersion,
} from './voice-convert.ts';
import type { TracedFetch } from './storage-move.ts';

const WS = '11111111-1111-4111-8111-111111111111';
const ASSET = '22222222-2222-4222-8222-222222222222';
const BUCKET = 'srtdio-files';

function webm(id: string, over: Partial<WebmVersion> = {}): WebmVersion {
  return {
    id,
    assetId: ASSET,
    workspaceId: WS,
    r2Key: `ws/${WS}/${ASSET}/${id}/original`,
    sizeBytes: 1000,
    bucket: BUCKET,
    assetDeleted: false,
    workspaceDeleted: false,
    ...over,
  };
}

const V1 = '33333333-3333-4333-8333-333333333331';
const V2 = '33333333-3333-4333-8333-333333333332';
const V3 = '33333333-3333-4333-8333-333333333333';
const V4 = '33333333-3333-4333-8333-333333333334';

describe('parseMode', () => {
  it('takes dry-run, convert and verify only', () => {
    expect(parseMode(['dry-run'])).toBe('dry-run');
    expect(parseMode(['convert'])).toBe('convert');
    expect(parseMode(['verify'])).toBe('verify');
    expect(() => parseMode(['delete'])).toThrow();
    expect(() => parseMode([])).toThrow();
  });
});

describe('selectTargets', () => {
  it('skips deleted assets, deleted workspaces and already converted versions', () => {
    const targets = selectTargets(
      [webm(V1), webm(V2, { assetDeleted: true }), webm(V3, { workspaceDeleted: true }), webm(V4)],
      new Set([V4]),
    );
    expect(targets.map((t) => t.id)).toEqual([V1]);
  });

  it('skips versions without a stored file, sample keys and a missing bucket', () => {
    const targets = selectTargets(
      [
        webm(V1, { r2Key: null }),
        webm(V2, { r2Key: 'induction-sample/voice.webm' }),
        webm(V3, { bucket: null }),
      ],
      new Set(),
    );
    expect(targets).toEqual([]);
  });

  it('puts the copy next to the original under /compressed', () => {
    expect(copyKeyFor({ workspaceId: WS, assetId: ASSET, id: V1 })).toBe(
      `ws/${WS}/${ASSET}/${V1}/compressed`,
    );
  });
});

describe('parseDurationMs', () => {
  it('rounds seconds to ms and rejects junk', () => {
    expect(parseDurationMs('12.3456\n')).toBe(12346);
    expect(parseDurationMs('N/A')).toBeNull();
    expect(parseDurationMs('0')).toBeNull();
  });
});

interface Fakes {
  deps: ConvertDeps;
  objects: Map<string, Uint8Array>;
  rows: NewCopyRow[];
  puts: string[];
}

function fakes(versions: WebmVersion[], copies: CopyRow[] = []): Fakes {
  const objects = new Map<string, Uint8Array>();
  for (const v of versions) if (v.r2Key !== null) objects.set(v.r2Key, new Uint8Array(1000));
  const rows: NewCopyRow[] = [];
  const puts: string[] = [];
  const deps: ConvertDeps = {
    webmVersions: () => Promise.resolve(versions),
    copyRows: () => Promise.resolve(copies),
    getObject: (_bucket, key) => {
      const body = objects.get(key);
      return body === undefined
        ? Promise.reject(new Error('R2 GET failed (404)'))
        : Promise.resolve(body);
    },
    putCopy: (_bucket, key, body) => {
      puts.push(key);
      objects.set(key, body);
      return Promise.resolve();
    },
    headObject: (_bucket, key) => Promise.resolve(objects.get(key)?.byteLength ?? null),
    transcode: () => Promise.resolve({ bytes: new Uint8Array(400), durationMs: 5000 }),
    insertCopyRow: (row) => {
      rows.push(row);
      return Promise.resolve();
    },
    concurrency: 1,
  };
  return { deps, objects, rows, puts };
}

describe('convertAll', () => {
  it('writes only /compressed copies and one row per target', async () => {
    const f = fakes([webm(V1), webm(V2, { assetDeleted: true })]);
    const original = f.objects.get(webm(V1).r2Key ?? '');
    const results = await convertAll(f.deps);
    expect(results).toEqual([
      { id: V1, ok: true, sourceBytes: 1000, copyBytes: 400, durationMs: 5000 },
    ]);
    expect(f.puts).toEqual([`ws/${WS}/${ASSET}/${V1}/compressed`]);
    expect(f.objects.get(webm(V1).r2Key ?? '')).toBe(original);
    expect(f.rows).toHaveLength(1);
    expect(f.rows[0]).toMatchObject({
      assetVersionId: V1,
      workspaceId: WS,
      r2Key: `ws/${WS}/${ASSET}/${V1}/compressed`,
      sizeBytes: 400,
      durationMs: 5000,
    });
    expect(f.rows[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('logs one failure and carries on with the rest', async () => {
    const f = fakes([webm(V1), webm(V2)]);
    f.objects.delete(webm(V1).r2Key ?? '');
    const results = await convertAll(f.deps);
    expect(results.find((r) => r.id === V1)?.ok).toBe(false);
    expect(results.find((r) => r.id === V2)?.ok).toBe(true);
    expect(f.rows.map((r) => r.assetVersionId)).toEqual([V2]);
  });

  it('writes no row when the stored copy has the wrong size', async () => {
    const f = fakes([webm(V1)]);
    f.deps.headObject = () => Promise.resolve(1);
    const results = await convertAll(f.deps);
    expect(results[0]?.ok).toBe(false);
    expect(f.rows).toEqual([]);
  });

  it('skips versions that already have a compressed row on a re-run', async () => {
    const copy: CopyRow = {
      id: 'r1',
      assetVersionId: V1,
      r2Key: `ws/${WS}/${ASSET}/${V1}/compressed`,
      sizeBytes: 400,
      bucket: BUCKET,
    };
    const f = fakes([webm(V1)], [copy]);
    expect(await listTargets(f.deps)).toEqual([]);
    expect(await convertAll(f.deps)).toEqual([]);
    expect(f.puts).toEqual([]);
  });
});

describe('verifyCopies', () => {
  it('flags a missing object, a wrong size and a target without a row', async () => {
    const copies: CopyRow[] = [
      {
        id: 'r1',
        assetVersionId: V1,
        r2Key: `ws/${WS}/${ASSET}/${V1}/compressed`,
        sizeBytes: 400,
        bucket: BUCKET,
      },
      {
        id: 'r2',
        assetVersionId: V2,
        r2Key: `ws/${WS}/${ASSET}/${V2}/compressed`,
        sizeBytes: 400,
        bucket: BUCKET,
      },
    ];
    const f = fakes([webm(V1), webm(V2), webm(V3)], copies);
    f.objects.set(`ws/${WS}/${ASSET}/${V2}/compressed`, new Uint8Array(399));
    const result = await verifyCopies(f.deps);
    expect(result.checked).toBe(0);
    expect(result.problems).toHaveLength(3);
    expect(result.problems.join('\n')).toMatch(/r1 .*object missing/);
    expect(result.problems.join('\n')).toMatch(/r2 .*399 bytes/);
    expect(result.problems.join('\n')).toMatch(new RegExp(`version ${V3}: no compressed copy`));
  });

  it('passes when every copy is in place', async () => {
    const copies: CopyRow[] = [
      {
        id: 'r1',
        assetVersionId: V1,
        r2Key: `ws/${WS}/${ASSET}/${V1}/compressed`,
        sizeBytes: 400,
        bucket: BUCKET,
      },
    ];
    const f = fakes([webm(V1), webm(V2, { workspaceDeleted: true })], copies);
    f.objects.set(`ws/${WS}/${ASSET}/${V1}/compressed`, new Uint8Array(400));
    expect(await verifyCopies(f.deps)).toEqual({ checked: 1, problems: [] });
  });
});

describe('real R2 and Supabase clients', () => {
  it('never send DELETE and never write asset_versions', async () => {
    const calls: Array<{ method: string; url: string }> = [];
    const fetch: TracedFetch = (url, init) => {
      const method = init.method ?? 'GET';
      calls.push({ method, url });
      if (url.includes('/rest/v1/asset_versions')) {
        const page =
          method === 'GET' && !url.includes('id=gt.')
            ? [
                {
                  id: V1,
                  asset_id: ASSET,
                  workspace_id: WS,
                  r2_key: `ws/${WS}/${ASSET}/${V1}/original`,
                  size_bytes: 1000,
                  assets: { deleted_at: null },
                  workspaces: { deleted_at: null, asset_bucket: BUCKET },
                },
              ]
            : [];
        return Promise.resolve(Response.json(page));
      }
      if (url.includes('/rest/v1/asset_renditions')) {
        return Promise.resolve(
          method === 'GET' ? Response.json([]) : new Response(null, { status: 201 }),
        );
      }
      if (method === 'HEAD') {
        return Promise.resolve(
          new Response(null, { status: 200, headers: { 'content-length': '4' } }),
        );
      }
      return Promise.resolve(new Response(new Uint8Array(1000), { status: 200 }));
    };
    const r2 = new AudioR2(
      {
        CLOUDFLARE_ACCOUNT_ID: 'acct',
        CLOUDFLARE_R2_ACCESS_KEY_ID: 'id',
        CLOUDFLARE_R2_SECRET_ACCESS_KEY: 'secret',
      },
      fetch,
    );
    const db = new VoiceDb('https://db.test', 'key', fetch);
    const results = await convertAll({
      webmVersions: () => db.webmVersions('t'),
      copyRows: () => db.copyRows('t'),
      getObject: (b, k) => r2.getObject(b, k, 't'),
      putCopy: (b, k, body) => r2.putCopy(b, k, body, 't'),
      headObject: (b, k) => r2.headObject(b, k, 't'),
      transcode: () => Promise.resolve({ bytes: new Uint8Array(4), durationMs: 1000 }),
      insertCopyRow: (row) => db.insertCopyRow(row, 't'),
    });
    expect(results.map((r) => r.ok)).toEqual([true]);
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    expect(
      calls.filter((c) => c.url.includes('/rest/v1/asset_versions') && c.method !== 'GET'),
    ).toEqual([]);
    const puts = calls.filter((c) => c.method === 'PUT');
    expect(puts).toHaveLength(1);
    expect(puts[0]?.url.endsWith('/compressed')).toBe(true);
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.url)).toEqual([
      'https://db.test/rest/v1/asset_renditions',
    ]);
  });

  it('putCopy refuses any key that is not a copy', async () => {
    const r2 = new AudioR2(
      {
        CLOUDFLARE_ACCOUNT_ID: 'acct',
        CLOUDFLARE_R2_ACCESS_KEY_ID: 'id',
        CLOUDFLARE_R2_SECRET_ACCESS_KEY: 'secret',
      },
      () => Promise.resolve(new Response(null)),
    );
    await expect(
      r2.putCopy(BUCKET, `ws/${WS}/${ASSET}/${V1}/original`, new Uint8Array(1), 't'),
    ).rejects.toThrow(/compressed/);
  });
});
