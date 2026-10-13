import { describe, expect, it, vi } from 'vitest';
import {
  PresignCache,
  PresignError,
  fetchPdfStream,
  requestPresignedUrl,
  requestThumbnailUrl,
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

describe('requestThumbnailUrl and the thumbnail cache', () => {
  const noRendition = (): Response =>
    new Response(JSON.stringify({ error: 'no_rendition' }), { status: 404 });

  it('asks asset-read for the thumbnail rendition of the version', async () => {
    const fetcher = vi.fn<PresignDeps['fetcher']>(async () => okResponse('https://signed/thumb'));
    const url = await requestThumbnailUrl(baseDeps({ fetcher }), 'v1');
    expect(url?.url).toBe('https://signed/thumb');
    const [, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      asset_version_id: 'v1',
      rendition: 'thumbnail',
    });
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer token');
  });

  it('404 no_rendition is null; any other failure throws', async () => {
    expect(await requestThumbnailUrl(baseDeps({ fetcher: async () => noRendition() }), 'v1')).toBe(
      null,
    );
    await expect(
      requestThumbnailUrl(
        baseDeps({ fetcher: async () => new Response('{}', { status: 403 }) }),
        'v1',
      ),
    ).rejects.toBeInstanceOf(PresignError);
    await expect(
      requestThumbnailUrl(
        baseDeps({ fetcher: async () => new Response('{"error":{}}', { status: 404 }) }),
        'v1',
      ),
    ).rejects.toBeInstanceOf(PresignError);
  });

  it('caches a thumbnail until 60 s before expiry, then asks again', async () => {
    const fetcher = vi.fn<PresignDeps['fetcher']>(async () =>
      okResponse('https://signed/thumb', 120_000),
    );
    const cache = new PresignCache(baseDeps({ fetcher }));
    await cache.thumbnail('v1');
    await cache.thumbnail('v1');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(cache.peekThumbnail('v1')?.url).toBe('https://signed/thumb');

    const short = vi.fn<PresignDeps['fetcher']>(async () => okResponse('https://signed/s', 30_000));
    const near = new PresignCache(baseDeps({ fetcher: short }));
    await near.thumbnail('v1');
    await near.thumbnail('v1');
    expect(short).toHaveBeenCalledTimes(2);
  });

  it('no_rendition is remembered as absent for the session (one request)', async () => {
    const fetcher = vi.fn<PresignDeps['fetcher']>(async () => noRendition());
    const cache = new PresignCache(baseDeps({ fetcher }));
    expect(await cache.thumbnail('v1')).toBe(null);
    expect(await cache.thumbnail('v1')).toBe(null);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('concurrent asks share one request; the thumbnail never touches the file URL cache', async () => {
    const fetcher = vi.fn<PresignDeps['fetcher']>(async () => okResponse('https://signed/thumb'));
    const cache = new PresignCache(baseDeps({ fetcher }));
    await Promise.all([cache.thumbnail('v1'), cache.thumbnail('v1')]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(cache.peek('v1')).toBe(null);
  });

  it('freshUrl never uses the cache (a fresh link on every viewer open)', async () => {
    const fetcher = vi.fn<PresignDeps['fetcher']>(async () => okResponse('https://signed/x'));
    const cache = new PresignCache(baseDeps({ fetcher }));
    await cache.resolve('v1');
    await cache.freshUrl('v1');
    await cache.freshUrl('v1', 'attachment');
    expect(fetcher).toHaveBeenCalledTimes(3);
    const last = fetcher.mock.calls[2] as [string, RequestInit];
    expect(JSON.parse(String(last[1].body))).toEqual({
      asset_version_id: 'v1',
      disposition: 'attachment',
    });
  });
});

describe('fetchPdfStream', () => {
  it('posts stream:true with the signal and resolves the 2xx response', async () => {
    const body = new Response('%PDF-1.4');
    const fetcher = vi.fn<PresignDeps['fetcher']>(async () => body);
    const controller = new AbortController();
    const response = await fetchPdfStream(baseDeps({ fetcher }), 'v1', controller.signal);
    expect(response).toBe(body);
    const [, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ asset_version_id: 'v1', stream: true });
    expect(init.signal).toBe(controller.signal);
  });

  it('a refusal throws PresignError (the viewer shows its error card)', async () => {
    await expect(
      fetchPdfStream(baseDeps({ fetcher: async () => new Response('{}', { status: 403 }) }), 'v1'),
    ).rejects.toMatchObject({ code: 'request_failed' });
    await expect(fetchPdfStream(baseDeps({ endpoint: null }), 'v1')).rejects.toMatchObject({
      code: 'unconfigured',
    });
  });
});
