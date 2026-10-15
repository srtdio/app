import { describe, expect, it, vi } from 'vitest';
import {
  cachedBucketBytes,
  fetchR2BucketBytes,
  parseR2StorageBytes,
  resolveWorkspaceUsage,
  usageBody,
  WARN_AT_BYTES,
  type UsageCache,
  type UsageStore,
} from './asset-upload-usage';

const MB = 1024 * 1024;
const NOW = new Date('2026-10-15T12:00:00Z');

function graphql(payloadSize: number | null) {
  return {
    data: {
      viewer: {
        accounts: [
          {
            r2StorageAdaptiveGroups:
              payloadSize === null
                ? []
                : [{ max: { payloadSize }, dimensions: { datetime: '2026-10-15T11:00:00Z' } }],
          },
        ],
      },
    },
  };
}

function memoryCache(): UsageCache & { size: () => number } {
  const map = new Map<string, string>();
  return {
    async match(request) {
      const body = map.get(request.url);
      return body === undefined ? undefined : new Response(body);
    },
    async put(request, response) {
      map.set(request.url, await response.text());
    },
    size: () => map.size,
  };
}

function store(bucket: string | null, exempt: boolean): UsageStore {
  return {
    workspace: vi.fn(async () => ({ bucket, ownerUserId: 'owner-1' })),
    isExemptOwner: vi.fn(async () => exempt),
  };
}

describe('usageBody thresholds', () => {
  it('warns at exactly 800 MB and above, never below', () => {
    expect(WARN_AT_BYTES).toBe(800 * MB);
    expect(usageBody(800 * MB - 1, false).warn).toBe(false);
    expect(usageBody(800 * MB, false)).toEqual({
      usedBytes: 800 * MB,
      warnAtBytes: 800 * MB,
      warn: true,
      exempt: false,
    });
    expect(usageBody(950 * MB, false).warn).toBe(true);
  });

  it('never warns an exempt owner', () => {
    expect(usageBody(999 * MB, true)).toEqual({
      usedBytes: 999 * MB,
      warnAtBytes: 800 * MB,
      warn: false,
      exempt: true,
    });
  });
});

describe('parseR2StorageBytes', () => {
  it('reads the latest payloadSize', () => {
    expect(parseR2StorageBytes(graphql(123))).toBe(123);
  });

  it('is 0 when the bucket has no sample yet', () => {
    expect(parseR2StorageBytes(graphql(null))).toBe(0);
  });

  it('is null on GraphQL errors or a malformed body', () => {
    expect(parseR2StorageBytes({ errors: [{ message: 'denied' }], data: null })).toBeNull();
    expect(parseR2StorageBytes({ data: {} })).toBeNull();
    expect(parseR2StorageBytes('nope')).toBeNull();
  });
});

describe('fetchR2BucketBytes', () => {
  const env = { CLOUDFLARE_ACCOUNT_ID: 'acct', CLOUDFLARE_ANALYTICS_TOKEN: 'tok' };

  it('queries r2StorageAdaptiveGroups for the bucket with the analytics token', async () => {
    const fetcher = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () =>
      Response.json(graphql(42 * MB)),
    );
    const bytes = await fetchR2BucketBytes({
      env,
      bucket: 'assets-ws-1',
      traceId: 't',
      now: NOW,
      fetcher,
    });
    expect(bytes).toBe(42 * MB);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://api.cloudflare.com/client/v4/graphql');
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer tok');
    const body = JSON.parse(String(init.body)) as {
      query: string;
      variables: Record<string, string>;
    };
    expect(body.query).toContain('r2StorageAdaptiveGroups');
    expect(body.query).toContain('payloadSize');
    expect(body.query).toContain('datetime_DESC');
    expect(body.variables).toMatchObject({ accountTag: 'acct', bucket: 'assets-ws-1' });
    expect(body.variables.end).toBe(NOW.toISOString());
  });

  it('is null when secrets are missing, Cloudflare errors, or is unreachable', async () => {
    const fetcher = vi.fn(async () => Response.json(graphql(1)));
    expect(
      await fetchR2BucketBytes({ env: {}, bucket: 'b', traceId: 't', now: NOW, fetcher }),
    ).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
    expect(
      await fetchR2BucketBytes({
        env,
        bucket: 'b',
        traceId: 't',
        now: NOW,
        fetcher: async () => new Response('', { status: 500 }),
      }),
    ).toBeNull();
    expect(
      await fetchR2BucketBytes({
        env,
        bucket: 'b',
        traceId: 't',
        now: NOW,
        fetcher: async () => {
          throw new Error('offline');
        },
      }),
    ).toBeNull();
  });
});

describe('cachedBucketBytes', () => {
  it('serves a warm bucket from the cache and caches only real readings', async () => {
    const cache = memoryCache();
    const load = vi.fn(async () => 5 * MB);
    expect(await cachedBucketBytes('b1', cache, load)).toBe(5 * MB);
    expect(await cachedBucketBytes('b1', cache, load)).toBe(5 * MB);
    expect(load).toHaveBeenCalledTimes(1);

    const failing = vi.fn(async () => null);
    expect(await cachedBucketBytes('b2', cache, failing)).toBeNull();
    expect(await cachedBucketBytes('b2', cache, failing)).toBeNull();
    expect(failing).toHaveBeenCalledTimes(2);
    expect(cache.size()).toBe(1);
  });
});

describe('resolveWorkspaceUsage', () => {
  it('warns a non-exempt workspace at 800 MB', async () => {
    const res = await resolveWorkspaceUsage({
      workspaceId: 'ws-1',
      store: store('assets-ws-1', false),
      cache: memoryCache(),
      readBytes: async () => 810 * MB,
    });
    expect(res).toEqual({ ok: true, value: usageBody(810 * MB, false) });
    expect(res.ok && res.value.warn).toBe(true);
  });

  it('marks an operator-owned workspace exempt and never warns', async () => {
    const res = await resolveWorkspaceUsage({
      workspaceId: 'ws-1',
      store: store('assets-ws-1', true),
      cache: null,
      readBytes: async () => 900 * MB,
    });
    expect(res.ok && res.value).toEqual({
      usedBytes: 900 * MB,
      warnAtBytes: 800 * MB,
      warn: false,
      exempt: true,
    });
  });

  it('is 0 bytes without a Cloudflare call when no bucket exists yet', async () => {
    const readBytes = vi.fn(async () => 1);
    const res = await resolveWorkspaceUsage({
      workspaceId: 'ws-1',
      store: store(null, false),
      cache: null,
      readBytes,
    });
    expect(res.ok && res.value.usedBytes).toBe(0);
    expect(readBytes).not.toHaveBeenCalled();
  });

  it('is a domain error, never a number, when Cloudflare cannot answer', async () => {
    const res = await resolveWorkspaceUsage({
      workspaceId: 'ws-1',
      store: store('assets-ws-1', false),
      cache: null,
      readBytes: async () => null,
    });
    expect(res).toEqual({
      ok: false,
      error: { code: 'usage_unavailable', message: 'Storage usage is unavailable right now.' },
    });
  });

  it('is not_found for a missing or deleted workspace', async () => {
    const res = await resolveWorkspaceUsage({
      workspaceId: 'ws-x',
      store: { workspace: async () => null, isExemptOwner: async () => false },
      cache: null,
      readBytes: async () => 1,
    });
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error.code).toBe('not_found');
  });
});
