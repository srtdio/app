import { describe, expect, it } from 'vitest';
import {
  PresignCache,
  PresignError,
  requestPresignedUrl,
  type PresignDeps,
} from '@/lib/asset-presign';

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function okResponse(url: string, expiresInMs = 900_000): Response {
  return new Response(
    JSON.stringify({ url, expires_at: new Date(Date.now() + expiresInMs).toISOString() }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function baseDeps(over: Partial<PresignDeps> = {}): PresignDeps {
  return {
    endpoint: 'https://worker.test/read',
    getAccessToken: async () => 'token',
    fetcher: async () => okResponse('https://signed/x'),
    ...over,
  };
}

describe('requestPresignedUrl', () => {
  it('throws unconfigured when no endpoint is set', async () => {
    await expect(requestPresignedUrl(baseDeps({ endpoint: null }), 'v1')).rejects.toMatchObject({
      code: 'unconfigured',
    });
  });

  it('throws unauthenticated when there is no token', async () => {
    await expect(
      requestPresignedUrl(baseDeps({ getAccessToken: async () => null }), 'v1'),
    ).rejects.toBeInstanceOf(PresignError);
  });

  it('sends the asset_version_id and bearer token, returns url + expiry', async () => {
    let captured: { url: string; body: string; auth: string | null } | null = null;
    const deps = baseDeps({
      fetcher: async (input, init) => {
        captured = {
          url: String(input),
          body: String(init?.body),
          auth: new Headers(init?.headers).get('Authorization'),
        };
        return okResponse('https://signed/abc');
      },
    });
    const result = await requestPresignedUrl(deps, 'ver-9');
    expect(result.url).toBe('https://signed/abc');
    expect(result.expiresAt).toBeGreaterThan(Date.now());
    expect(captured!.url).toBe('https://worker.test/read');
    expect(JSON.parse(captured!.body)).toEqual({ asset_version_id: 'ver-9' });
    expect(captured!.auth).toBe('Bearer token');
  });

  it('throws request_failed on a non-2xx response', async () => {
    const deps = baseDeps({ fetcher: async () => new Response('no', { status: 403 }) });
    await expect(requestPresignedUrl(deps, 'v1')).rejects.toMatchObject({ code: 'request_failed' });
  });
});

describe('PresignCache', () => {
  it('caches by version id and does not re-presign a fresh url', async () => {
    let calls = 0;
    const cache = new PresignCache(
      baseDeps({
        fetcher: async () => {
          calls += 1;
          return okResponse(`https://signed/${calls}`);
        },
      }),
    );
    const first = await cache.resolve('x');
    const second = await cache.resolve('x');
    expect(calls).toBe(1);
    expect(second.url).toBe(first.url);
    expect(cache.peek('x')?.url).toBe(first.url);
  });

  it('never exceeds the concurrency cap', async () => {
    let active = 0;
    let max = 0;
    let calls = 0;
    const releases: Array<() => void> = [];
    const cache = new PresignCache(
      baseDeps({
        fetcher: () => {
          calls += 1;
          active += 1;
          max = Math.max(max, active);
          return new Promise<Response>((resolve) => {
            releases.push(() => {
              active -= 1;
              resolve(okResponse('https://signed/x'));
            });
          });
        },
      }),
      3,
    );

    const ids = Array.from({ length: 10 }, (_, i) => `v${i}`);
    const all = Promise.all(ids.map((id) => cache.resolve(id)));

    let guard = 0;
    while (guard < 100) {
      await tick();
      expect(active).toBeLessThanOrEqual(3);
      if (releases.length === 0) break;
      releases.shift()!();
      guard += 1;
    }
    await all;
    expect(max).toBe(3);
    expect(calls).toBe(10);
  });
});
