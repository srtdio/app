import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  MAX_HEAD_BYTES,
  MemoryLayer,
  RateCap,
  USER_AGENT,
  cleanText,
  decodeEntities,
  handleRequest,
  normalizeUrl,
  parseDuration,
  type Fetcher,
  type LinkPreview,
  type LinkPreviewDeps,
} from './link-preview';

const TRACE = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const ENV = { SUPABASE_URL: 'https://test.supabase.co' };

interface Call {
  url: string;
  init: RequestInit;
  traceId: string;
}

type Route = (url: string, init: RequestInit) => Response | Promise<Response>;

function setup(route: Route, opts: { rate?: RateCap; user?: string | null } = {}) {
  const calls: Call[] = [];
  const fetcher: Fetcher = async (url, init, traceId) => {
    calls.push({ url, init, traceId });
    return route(url, init);
  };
  const deps: LinkPreviewDeps = {
    fetcher,
    cache: new MemoryLayer(null),
    rate: opts.rate ?? new RateCap(),
    verify: async (request) =>
      request.headers.get('authorization') === 'Bearer good'
        ? opts.user === undefined
          ? 'user-1'
          : opts.user
        : null,
  };
  const call = (path: string, auth = true): Promise<Response> =>
    handleRequest(
      new Request(`https://lp.example${path}`, {
        headers: {
          ...(auth ? { authorization: 'Bearer good' } : {}),
          'X-Trace-Id': TRACE,
          Origin: 'https://srtd.io',
          Cookie: 'sb=secret',
        },
      }),
      ENV,
      deps,
    );
  const preview = async (link: string): Promise<LinkPreview> => {
    const res = await call(`/preview?url=${encodeURIComponent(link)}`);
    expect(res.status).toBe(200);
    return (await res.json()) as LinkPreview;
  };
  return { calls, call, preview, deps };
}

function html(body: string, init: ResponseInit = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
    ...init,
  });
}

function redirect(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } });
}

const OG_PAGE = `<!doctype html><html><head>
<title>Fallback title</title>
<meta property="og:title" content="Festive hampers &amp; more &#8211; &quot;new&quot;">
<meta property="og:description" content="Our &lt;b&gt;Diwali&lt;/b&gt; range ships 20 Oct.">
<meta property="og:image" content="/img/hero.jpg">
<meta property="og:site_name" content="Northwind">
</head><body>ignored</body></html>`;

afterEach(() => {
  vi.useRealTimers();
});

describe('link-preview worker: auth, CORS, trace', () => {
  it('requires a valid Supabase JWT (401) and never fetches without one', async () => {
    const t = setup(() => html(OG_PAGE));
    const res = await t.call('/preview?url=https%3A%2F%2Fexample.com', false);
    expect(res.status).toBe(401);
    expect(t.calls).toHaveLength(0);
  });

  it('reflects an allowed origin and answers preflight for GET', async () => {
    const t = setup(() => html(OG_PAGE));
    const res = await t.call('/preview?url=https%3A%2F%2Fexample.com');
    expect(res.headers.get('access-control-allow-origin')).toBe('https://srtd.io');
    const pre = await handleRequest(
      new Request('https://lp.example/preview', {
        method: 'OPTIONS',
        headers: { Origin: 'https://test.srtdio-app.pages.dev' },
      }),
      ENV,
      t.deps,
    );
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe(
      'https://test.srtdio-app.pages.dev',
    );
    expect(pre.headers.get('access-control-allow-methods')).toBe('GET, OPTIONS');
  });

  it('forwards the inbound trace id and never forwards cookies or Authorization', async () => {
    const t = setup(() => html(OG_PAGE));
    const res = await t.call('/preview?url=https%3A%2F%2Fexample.com%2Fa');
    expect(res.headers.get('X-Trace-Id')).toBe(TRACE);
    expect(t.calls[0]?.traceId).toBe(TRACE);
    const sent = new Headers(t.calls[0]?.init.headers);
    expect(sent.get('user-agent')).toBe(USER_AGENT);
    expect(sent.get('authorization')).toBeNull();
    expect(sent.get('cookie')).toBeNull();
    expect(sent.get('origin')).toBeNull();
    expect(t.calls[0]?.init.redirect).toBe('manual');
  });

  it('caps each user at 120 previews per 10 minutes (429 beyond)', async () => {
    let now = 0;
    const rate = new RateCap(120, 600_000, () => now);
    const t = setup(() => html(OG_PAGE), { rate });
    for (let i = 0; i < 120; i += 1) expect(rate.take('user-1')).toBe(true);
    const res = await t.call('/preview?url=https%3A%2F%2Fexample.com');
    expect(res.status).toBe(429);
    now = 600_001;
    expect((await t.call('/preview?url=https%3A%2F%2Fexample.com')).status).toBe(200);
  });
});

describe('link-preview worker: safety', () => {
  it('answers unsafe links without any fetch', async () => {
    const t = setup(() => html(OG_PAGE));
    const p = await t.preview('http://g00gle-docs-share.top:8080/login');
    expect(p).toEqual({
      type: 'unsafe',
      domain: 'g00gle-docs-share.top',
      reasons: [
        'Uses an unusual port',
        'Not a secure (https) link',
        'Looks like a famous site but is spelled differently',
      ],
    });
    expect(t.calls).toHaveLength(0);
  });

  it('turns a redirect to a private host into unsafe naming the final host', async () => {
    const t = setup((url) =>
      url.startsWith('https://example.com') ? redirect('https://192.168.1.1/admin') : html(OG_PAGE),
    );
    const p = await t.preview('https://example.com/go');
    expect(p.type).toBe('unsafe');
    expect(p.type === 'unsafe' && p.domain).toBe('192.168.1.1');
    expect(t.calls.map((c) => c.url)).toEqual(['https://example.com/go']);
  });

  it('checks every hop: a redirect to plain http is unsafe and not fetched', async () => {
    const t = setup((url) =>
      url === 'https://example.com/a'
        ? redirect('https://example.com/b')
        : redirect('http://localhost/'),
    );
    const p = await t.preview('https://example.com/a');
    expect(p.type).toBe('unsafe');
    expect(t.calls).toHaveLength(2);
  });

  it('gives up after 5 redirects (bare)', async () => {
    let n = 0;
    const t = setup(() => {
      n += 1;
      return redirect(`https://example.com/r${n}`);
    });
    const p = await t.preview('https://example.com/start');
    expect(p.type).toBe('bare');
    expect(t.calls).toHaveLength(6);
  });
});

describe('link-preview worker: fetch limits', () => {
  it('times out after 5 s total (bare)', async () => {
    vi.useFakeTimers();
    const t = setup(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('x', 'AbortError')));
        }),
    );
    const pending = t.call('/preview?url=https%3A%2F%2Fslow.example.com');
    await vi.advanceTimersByTimeAsync(5_000);
    const res = await pending;
    expect(((await res.json()) as LinkPreview).type).toBe('bare');
  });

  it('only parses text/html (bare for anything else)', async () => {
    const t = setup(
      () =>
        new Response('{"og:title":"x"}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    expect((await t.preview('https://example.com/data')).type).toBe('bare');
  });

  it('stops reading at 512 KiB when </head> never comes', async () => {
    let pulled = 0;
    const chunk = new TextEncoder().encode(`<meta name="x" content="${'a'.repeat(16_000)}">`);
    const t = setup(() => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('<html><head><title>Big page</title>'));
        },
        pull(controller) {
          pulled += chunk.byteLength;
          controller.enqueue(chunk);
        },
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/html' } });
    });
    const p = await t.preview('https://example.com/huge');
    expect(p.type).toBe('text');
    expect(pulled).toBeLessThanOrEqual(MAX_HEAD_BYTES + 4 * chunk.byteLength);
  });

  it('stops at </head> and ignores the body', async () => {
    const t = setup(() => html('<head><title>Head title</title></head><body><title>Body</title>'));
    const p = await t.preview('https://example.com/');
    expect(p.type === 'text' && p.title).toBe('Head title');
  });
});

describe('link-preview worker: parsing', () => {
  it('reads og tags, resolves the image, decodes entities and strips tags', async () => {
    const t = setup(() => html(OG_PAGE));
    const p = await t.preview('https://www.example.com/p/C9x2?ref=1');
    expect(p).toEqual({
      type: 'full',
      domain: 'example.com',
      path: '/p/C9x2?ref=1',
      letter: 'E',
      finalDomain: null,
      viaShortener: null,
      title: 'Festive hampers & more – "new"',
      description: 'Our Diwali range ships 20 Oct.',
      siteName: 'Northwind',
      video: false,
      durationSeconds: null,
    });
    // The image URL stays server-side; the client only ever asks /image.
    expect(JSON.stringify(p)).not.toContain('hero.jpg');
  });

  it('falls back to twitter:* and then <title>', async () => {
    const t = setup((url) =>
      url.endsWith('/tw')
        ? html(
            '<head><meta name="twitter:title" content="Tw title"><meta name="twitter:image" content="https://cdn.example.com/t.png"></head>',
          )
        : html(
            '<head><title> Plain   &amp; simple </title><meta name="description" content="Desc"></head>',
          ),
    );
    const tw = await t.preview('https://example.com/tw');
    expect(tw.type === 'full' && tw.title).toBe('Tw title');
    const plainPage = await t.preview('https://example.com/plain');
    expect(plainPage.type).toBe('text');
    expect(plainPage.type === 'text' && plainPage.title).toBe('Plain & simple');
    expect(plainPage.type === 'text' && plainPage.description).toBe('Desc');
  });

  it('returns bare when nothing usable is on the page', async () => {
    const t = setup(() => html('<head></head>'));
    expect((await t.preview('https://example.com/x')).type).toBe('bare');
  });

  it('caps title at 200 and description at 400 characters', async () => {
    const t = setup(() =>
      html(
        `<head><meta property="og:title" content="${'T'.repeat(500)}"><meta property="og:description" content="${'D'.repeat(900)}"></head>`,
      ),
    );
    const p = await t.preview('https://example.com/long');
    expect(p.type === 'text' && Array.from(p.title).length).toBe(200);
    expect(p.type === 'text' && Array.from(p.description ?? '').length).toBe(400);
  });

  it('marks video pages and reads the duration', async () => {
    const t = setup(() =>
      html(
        '<head><meta property="og:title" content="How we pack"><meta property="og:type" content="video.other"><meta itemprop="duration" content="PT2M14S"><meta property="og:image" content="https://i.ytimg.com/a.jpg"></head>',
      ),
    );
    const p = await t.preview('https://www.youtube.com/watch?v=abc');
    expect(p.type === 'full' && p.video).toBe(true);
    expect(p.type === 'full' && p.durationSeconds).toBe(134);
  });

  it('never lets markup through as text', () => {
    expect(cleanText('<script>alert(1)</script>Hi &lt;img src=x onerror=1&gt;', 50)).toBe(
      'alert(1) Hi',
    );
    expect(decodeEntities('&#x1F600;&#65;&bogus;')).toBe('\u{1F600}A&bogus;');
    expect(parseDuration('PT1H2M3S')).toBe(3723);
    expect(parseDuration('45')).toBe(45);
    expect(parseDuration('soon')).toBeNull();
  });
});

describe('link-preview worker: login and shorteners', () => {
  it('detects a redirect to a login page without fetching it', async () => {
    const t = setup(() =>
      redirect('https://accounts.google.com/ServiceLogin?continue=https://drive.google.com/'),
    );
    const p = await t.preview('https://drive.google.com/file/d/1aX9/view');
    expect(p).toMatchObject({
      type: 'login',
      domain: 'drive.google.com',
      path: '/file/d/1aX9/view',
    });
    expect(t.calls).toHaveLength(1);
  });

  it('detects a redirect to a /login path', async () => {
    const t = setup(() => redirect('/login?next=/x'));
    expect((await t.preview('https://app.example.com/x')).type).toBe('login');
  });

  it.each([401, 403])('treats %i as sign-in needed', async (status) => {
    const t = setup(() => new Response('no', { status }));
    expect((await t.preview('https://example.com/private')).type).toBe('login');
  });

  it('resolves shorteners and reports viaShortener + finalDomain', async () => {
    const t = setup((url) =>
      url.startsWith('https://bit.ly')
        ? redirect('https://www.canva.com/design/DAF1/view')
        : html('<head><meta property="og:title" content="Diwali carousel v4"></head>'),
    );
    const p = await t.preview('https://bit.ly/3xYz');
    expect(p).toMatchObject({
      type: 'text',
      domain: 'bit.ly',
      viaShortener: 'bit.ly',
      finalDomain: 'canva.com',
      title: 'Diwali carousel v4',
    });
  });
});

describe('link-preview worker: cache', () => {
  it('strips tracking params, fragment and host case from the cache key', async () => {
    expect(
      normalizeUrl('https://EXAMPLE.com/a?utm_source=x&id=2&fbclid=1&gclid=2&igsh=3#frag'),
    ).toBe('https://example.com/a?id=2');
    const t = setup(() => html(OG_PAGE));
    await t.preview('https://example.com/a?utm_source=wa');
    await t.preview('https://Example.com/a?fbclid=zz#top');
    expect(t.calls).toHaveLength(1);
  });

  it('caches failures too (one fetch per URL)', async () => {
    const t = setup(() => new Response('x', { status: 500 }));
    await t.preview('https://example.com/down');
    await t.preview('https://example.com/down');
    expect(t.calls).toHaveLength(1);
  });
});

describe('link-preview worker: /image', () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

  function imageSetup(image: () => Response) {
    return setup((url) =>
      url.startsWith('https://cdn.example.com')
        ? image()
        : html(OG_PAGE.replace('/img/hero.jpg', 'https://cdn.example.com/hero.png')),
    );
  }

  it('refuses a page with no cached preview (no fetch: not an open proxy)', async () => {
    const t = imageSetup(() => new Response(PNG, { headers: { 'content-type': 'image/png' } }));
    const res = await t.call(
      `/image?url=${encodeURIComponent('https://cdn.example.com/hero.png')}`,
      false,
    );
    expect(res.status).toBe(404);
    expect(t.calls).toHaveLength(0);
  });

  it('serves the cached og:image with nosniff, CSP and a public cache header', async () => {
    const t = imageSetup(() => new Response(PNG, { headers: { 'content-type': 'image/png' } }));
    await t.preview('https://example.com/page');
    const res = await t.call(`/image?url=${encodeURIComponent('https://example.com/page')}`, false);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    expect(res.headers.get('cache-control')).toBe('public, max-age=86400');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
    expect(t.calls.map((c) => c.url)).toEqual([
      'https://example.com/page',
      'https://cdn.example.com/hero.png',
    ]);
  });

  it('refuses SVG', async () => {
    const t = imageSetup(
      () => new Response('<svg/>', { headers: { 'content-type': 'image/svg+xml' } }),
    );
    await t.preview('https://example.com/page');
    const res = await t.call(`/image?url=${encodeURIComponent('https://example.com/page')}`, false);
    expect(res.status).toBe(415);
  });

  it('aborts an image over 2 MiB while streaming', async () => {
    let pulled = 0;
    const t = imageSetup(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              pulled += 256 * 1024;
              controller.enqueue(new Uint8Array(256 * 1024));
            },
          }),
          { headers: { 'content-type': 'image/jpeg' } },
        ),
    );
    await t.preview('https://example.com/page');
    const res = await t.call(`/image?url=${encodeURIComponent('https://example.com/page')}`, false);
    expect(res.status).toBe(413);
    expect(pulled).toBeLessThan(4 * 1024 * 1024);
  });
});

describe('link-preview worker: source hygiene', () => {
  it('does not use HTML sinks', () => {
    const src = readFileSync(new URL('./link-preview.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/dangerouslySetInnerHTML|innerHTML/);
  });
});

describe('link-preview worker: memory and login edges', () => {
  it('keeps the in-memory layer under its byte budget', async () => {
    const layer = new MemoryLayer(null, 1000);
    for (let i = 0; i < 20; i += 1) {
      await layer.put(
        `k${i}`,
        new Response(new Uint8Array(200), { headers: { 'cache-control': 'max-age=60' } }),
      );
    }
    expect(layer.size()).toBeLessThanOrEqual(1000);
    // A body over a quarter of the budget is never held in memory.
    await layer.put(
      'big',
      new Response(new Uint8Array(600), { headers: { 'cache-control': 'max-age=60' } }),
    );
    expect(await layer.match('big')).toBeUndefined();
  });

  it('a redirect to an /account page is not a sign-in page', async () => {
    const t = setup((url) =>
      url.endsWith('/x')
        ? redirect('/account/settings')
        : html('<head><title>Settings</title></head>'),
    );
    expect((await t.preview('https://example.com/x')).type).toBe('text');
  });

  it('leaves a query without tracking params byte-for-byte', () => {
    expect(normalizeUrl('https://example.com/s?q=a%20b')).toBe('https://example.com/s?q=a%20b');
  });
});
