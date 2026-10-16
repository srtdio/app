import { describe, expect, it } from 'vitest';
import {
  MAX_CONCURRENT,
  barePreview,
  createPreviewClient,
  isAppLink,
  parsePreview,
  previewEndpoint,
  type PreviewClientDeps,
} from '@/lib/links/preview';

interface Deferred {
  url: string;
  init: RequestInit;
  resolve: (r: Response) => void;
}

function harness(overrides: Partial<PreviewClientDeps> = {}) {
  const calls: Deferred[] = [];
  const client = createPreviewClient({
    endpoint: 'https://lp.example',
    getToken: async () => 'jwt',
    fetcher: (url, init) =>
      new Promise<Response>((resolve, reject) => {
        calls.push({ url, init, resolve });
        init.signal?.addEventListener('abort', () =>
          reject(new DOMException('Aborted', 'AbortError')),
        );
      }),
    ...overrides,
  });
  return { client, calls };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

const FULL = {
  type: 'full',
  domain: 'example.com',
  path: '/a',
  letter: 'E',
  finalDomain: null,
  viaShortener: null,
  title: 'Title',
  description: null,
  siteName: null,
  video: false,
  durationSeconds: null,
};

describe('preview client', () => {
  it('dedupes concurrent requests for the same (normalized) URL', async () => {
    const { client, calls } = harness();
    const a = client.request('https://example.com/a?utm_source=x');
    const b = client.request('https://EXAMPLE.com/a#top');
    await flush();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://lp.example/preview?url=https%3A%2F%2Fexample.com%2Fa');
    expect(new Headers(calls[0]?.init.headers).get('authorization')).toBe('Bearer jwt');
    calls[0]?.resolve(ok(FULL));
    expect((await a).type).toBe('full');
    expect((await b).type).toBe('full');
    // Session cache: no second request, and peek answers synchronously.
    await client.request('https://example.com/a');
    expect(calls).toHaveLength(1);
    expect(client.peek('https://example.com/a')?.type).toBe('full');
  });

  it('runs at most 4 requests at once', async () => {
    const { client, calls } = harness();
    const all = Array.from({ length: 7 }, (_, i) => client.request(`https://example.com/${i}`));
    await flush();
    expect(MAX_CONCURRENT).toBe(4);
    expect(calls).toHaveLength(4);
    calls[0]?.resolve(ok(FULL));
    await flush();
    expect(calls).toHaveLength(5);
    for (const c of calls.slice(1)) c.resolve(ok(FULL));
    await flush();
    for (const c of calls.slice(5)) c.resolve(ok(FULL));
    await Promise.all(all);
    expect(calls).toHaveLength(7);
  });

  it('cancels the shared request only when every waiter aborts', async () => {
    const { client, calls } = harness();
    const one = new AbortController();
    const two = new AbortController();
    const p1 = client.request('https://example.com/x', one.signal);
    const p2 = client.request('https://example.com/x', two.signal);
    await flush();
    one.abort();
    await expect(p1).rejects.toThrow('Aborted');
    expect(calls[0]?.init.signal?.aborted).toBe(false);
    two.abort();
    await expect(p2).rejects.toThrow('Aborted');
    expect(calls[0]?.init.signal?.aborted).toBe(true);
    // A later request starts fresh.
    void client.request('https://example.com/x');
    await flush();
    expect(calls).toHaveLength(2);
  });

  it('never requests an unsafe link; answers the warning card locally', async () => {
    const { client, calls } = harness();
    const p = await client.request('http://g00gle-docs-share.top:8080/login');
    expect(p.type).toBe('unsafe');
    expect(calls).toHaveLength(0);
  });

  it('missing endpoint: every card is bare and nothing is requested', async () => {
    const { client, calls } = harness({ endpoint: null });
    expect(await client.request('https://example.com/a/b')).toEqual(
      barePreview('https://example.com/a/b'),
    );
    expect(client.peek('https://example.com/a/b')?.type).toBe('bare');
    expect(client.imageUrl('https://example.com/a')).toBeNull();
    expect(calls).toHaveLength(0);
    expect(previewEndpoint(undefined)).toBeNull();
    expect(previewEndpoint('')).toBeNull();
    expect(previewEndpoint('https://lp.example/')).toBe('https://lp.example');
  });

  it('degrades to bare on a failed request, never throws', async () => {
    const { client, calls } = harness();
    const p = client.request('https://example.com/down');
    await flush();
    calls[0]?.resolve(new Response('no', { status: 500 }));
    expect((await p).type).toBe('bare');
  });

  it('internal app links bypass previews', async () => {
    const { client, calls } = harness({ appOrigin: 'https://srtd.io' });
    expect((await client.request('https://srtd.io/p/abc')).type).toBe('bare');
    expect(calls).toHaveLength(0);
    expect(isAppLink('https://srtd.io/p/abc', 'https://srtd.io')).toBe(true);
    expect(isAppLink('https://example.com/p/abc', 'https://srtd.io')).toBe(false);
    expect(isAppLink('https://srtd.io/p/abc', null)).toBe(false);
  });
});

describe('parsePreview', () => {
  it('drops unknown reason text and caps strings', () => {
    const p = parsePreview(
      { type: 'unsafe', domain: 'x.top', reasons: ['Uses an unusual port', '<b>evil</b>'] },
      'https://x.top:8080/',
    );
    expect(p).toEqual({ type: 'unsafe', domain: 'x.top', reasons: ['Uses an unusual port'] });
    const long = parsePreview({ ...FULL, title: 'T'.repeat(900) }, 'https://example.com/a');
    expect(long.type === 'full' && long.title.length).toBe(200);
  });

  it('keeps the domain and path from the link, not the response', () => {
    const p = parsePreview({ ...FULL, domain: 'evil.com', path: '/x' }, 'https://example.com/a');
    expect(p.type === 'full' && p.domain).toBe('example.com');
    expect(p.type === 'full' && p.path).toBe('/a');
  });

  it('turns malformed bodies into bare', () => {
    expect(parsePreview(null, 'https://example.com/').type).toBe('bare');
    expect(parsePreview({ type: 'full' }, 'https://example.com/').type).toBe('bare');
    expect(parsePreview({ type: 'nope' }, 'https://example.com/').type).toBe('bare');
  });
});
