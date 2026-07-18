import { afterEach, describe, expect, it, vi } from 'vitest';

import worker, {
  isCrawler,
  renderBriefLinkCard,
  renderPostCard,
  renderShortLinkCard,
  serveOgImage,
  type ImageLocator,
  type OgPreviewEnv,
  type OgPreviewStore,
  type PostImage,
  type PresignedUrlSigner,
} from './og-preview';

const POST_ID = '11111111-1111-7111-8111-111111111111';
const OTHER_POST_ID = '22222222-2222-7222-8222-222222222222';
const VERSION_ID = '33333333-3333-7333-8333-333333333333';
const OTHER_VERSION_ID = '44444444-4444-7444-8444-444444444444';
const BUCKET = 'assets-acme';
const R2_KEY = 'images/aaaa/v1-photo.jpg';

const env: OgPreviewEnv = {
  CLOUDFLARE_ACCOUNT_ID: 'acct',
  CLOUDFLARE_R2_ACCESS_KEY_ID: 'akid',
  CLOUDFLARE_R2_SECRET_ACCESS_KEY: 'secret',
  SUPABASE_URL: 'https://test.supabase.co',
  SUPABASE_SECRET_KEY: 'service-role-key',
  PAGES_ORIGIN: 'https://srtdio-app.pages.dev',
};

/** A live post plus its optional first image and one bound image attachment. */
interface Fixture {
  postTitle: string | null;
  firstImage: PostImage | null;
  /** The pair the store considers bound (live post, live attachment, image). */
  bound: { postId: string; assetVersionId: string; locator: ImageLocator } | null;
  /** The ref the store resolves to a live post (uppercase key, entity number). */
  refTarget?: { key: string; number: number; postId: string; title: string } | null;
  /** The ref the store resolves to a live brief (uppercase key, entity number). */
  briefRefTarget?: { key: string; number: number; briefId: string; title: string } | null;
}

class FakeStore implements OgPreviewStore {
  constructor(private readonly fx: Fixture) {}
  findPostTitle(): Promise<string | null> {
    return Promise.resolve(this.fx.postTitle);
  }
  findPostByRef(ref: {
    key: string;
    number: number;
  }): Promise<{ postId: string; title: string } | null> {
    const t = this.fx.refTarget ?? null;
    if (t === null || t.key !== ref.key || t.number !== ref.number) {
      return Promise.resolve(null);
    }
    return Promise.resolve({ postId: t.postId, title: t.title });
  }
  findBriefByRef(ref: {
    key: string;
    number: number;
  }): Promise<{ briefId: string; title: string } | null> {
    const t = this.fx.briefRefTarget ?? null;
    if (t === null || t.key !== ref.key || t.number !== ref.number) {
      return Promise.resolve(null);
    }
    return Promise.resolve({ briefId: t.briefId, title: t.title });
  }
  findFirstPostImage(): Promise<PostImage | null> {
    return Promise.resolve(this.fx.firstImage);
  }
  findBoundImage(input: { postId: string; assetVersionId: string }): Promise<ImageLocator | null> {
    const b = this.fx.bound;
    if (b === null || b.postId !== input.postId || b.assetVersionId !== input.assetVersionId) {
      return Promise.resolve(null);
    }
    return Promise.resolve(b.locator);
  }
}

class RecordingSigner implements PresignedUrlSigner {
  calls: Array<{ bucket: string; key: string; expiresInSeconds: number }> = [];
  presignGetUrl(input: { bucket: string; key: string; expiresInSeconds: number }): Promise<string> {
    this.calls.push(input);
    return Promise.resolve(`https://signed.example/${input.key}?sig=abc`);
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('isCrawler', () => {
  it('matches WhatsApp', () => {
    expect(isCrawler('WhatsApp/2.23.20.0')).toBe(true);
  });
  it('matches facebookexternalhit', () => {
    expect(
      isCrawler('facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)'),
    ).toBe(true);
  });
  it('does not match Chrome, Safari, or Googlebot', () => {
    expect(isCrawler('Mozilla/5.0 (Windows NT 10.0) Chrome/120.0')).toBe(false);
    expect(isCrawler('Mozilla/5.0 (Macintosh) Version/17.0 Safari/605.1')).toBe(false);
    expect(
      isCrawler('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'),
    ).toBe(false);
  });
  it('does not match an absent User-Agent', () => {
    expect(isCrawler(null)).toBe(false);
  });
});

describe('worker.fetch passthrough', () => {
  it('passes a human request through to PAGES_ORIGIN preserving path and query', async () => {
    const spy = vi.fn(() => Promise.resolve(new Response('spa', { status: 200 })));
    vi.stubGlobal('fetch', spy);
    const req = new Request('https://srtd.io/posts/abc?ref=x', {
      headers: { 'User-Agent': 'Mozilla/5.0 Chrome/120.0' },
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(
      'https://srtdio-app.pages.dev/posts/abc?ref=x',
      expect.objectContaining({ method: 'GET' }),
    );
  });
});

describe('worker.fetch diagnostic error surface', () => {
  // A human /posts/* request routes to passthrough, whose fetch we make throw.
  function throwingFetch(): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('boom from passthrough'))),
    );
  }

  it('returns a text/plain 500 with a non-empty body when route throws and x-og-debug: 1', async () => {
    throwingFetch();
    const req = new Request('https://srtd.io/posts/abc', {
      headers: { 'User-Agent': 'Mozilla/5.0 Chrome/120.0', 'x-og-debug': '1' },
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(500);
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    const body = await res.text();
    expect(body.length).toBeGreaterThan(0);
    expect(body).toContain('boom from passthrough');
  });

  it('returns an empty 500 when route throws without the x-og-debug header', async () => {
    throwingFetch();
    const req = new Request('https://srtd.io/posts/abc', {
      headers: { 'User-Agent': 'Mozilla/5.0 Chrome/120.0' },
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(500);
    expect(res.headers.get('content-type')).not.toBe('text/plain; charset=utf-8');
    const body = await res.text();
    expect(body).toBe('');
  });
});

describe('renderPostCard', () => {
  it('renders an escaped title, absolute og:image URL, noindex meta and header for a post with an image', async () => {
    const store = new FakeStore({
      postTitle: 'Launch day',
      firstImage: { assetVersionId: VERSION_ID, width: 1200, height: 630 },
      bound: null,
    });
    const res = await renderPostCard(POST_ID, store);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-robots-tag')).toBe('noindex');
    expect(res.headers.get('cache-control')).toBe('public, max-age=300');
    const html = await res.text();
    expect(html).toContain('<meta property="og:title" content="Launch day">');
    expect(html).toContain(
      `<meta property="og:image" content="https://srtd.io/og/p/${POST_ID}/${VERSION_ID}.jpg">`,
    );
    expect(html).toContain('<meta property="og:image:width" content="1200">');
    expect(html).toContain('<meta property="og:image:height" content="630">');
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image">');
    expect(html).toContain('<meta name="robots" content="noindex">');
    expect(html).toContain(`<meta property="og:url" content="https://srtd.io/posts/${POST_ID}">`);
  });

  it('omits og:image and uses twitter:card summary for a post without an image', async () => {
    const store = new FakeStore({ postTitle: 'No image', firstImage: null, bound: null });
    const res = await renderPostCard(POST_ID, store);
    const html = await res.text();
    expect(html).not.toContain('og:image');
    expect(html).toContain('<meta name="twitter:card" content="summary">');
    expect(html).toContain('<meta property="og:title" content="No image">');
  });

  it('escapes a title containing HTML metacharacters', async () => {
    const store = new FakeStore({
      postTitle: `<script>alert("x")&'`,
      firstImage: null,
      bound: null,
    });
    const res = await renderPostCard(POST_ID, store);
    const html = await res.text();
    expect(html).not.toContain('<script>alert');
    expect(html).toContain(
      '<meta property="og:title" content="&lt;script&gt;alert(&quot;x&quot;)&amp;&#39;">',
    );
  });

  it('serves the generic card for an unknown post with HTTP 200', async () => {
    const store = new FakeStore({ postTitle: null, firstImage: null, bound: null });
    const res = await renderPostCard(POST_ID, store);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<meta property="og:title" content="Sorted">');
    expect(html).toContain('<meta property="og:site_name" content="Sorted">');
    expect(html).not.toContain('og:url');
    expect(html).not.toContain('og:image');
  });

  it('serves the generic card for an invalid uuid without touching the store', async () => {
    const store = new FakeStore({ postTitle: 'never read', firstImage: null, bound: null });
    const res = await renderPostCard('not-a-uuid', store);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<meta property="og:title" content="Sorted">');
  });
});

describe('renderShortLinkCard', () => {
  it('renders a card whose og:url is the short link for a known ref', async () => {
    const store = new FakeStore({
      postTitle: 'never read via ref',
      firstImage: { assetVersionId: VERSION_ID, width: 1200, height: 630 },
      bound: null,
      refTarget: { key: 'GBL', number: 142, postId: POST_ID, title: 'Launch day' },
    });
    const res = await renderShortLinkCard('gbl-142', store);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<meta property="og:url" content="https://srtd.io/p/gbl-142">');
    expect(html).toContain('<meta property="og:title" content="Launch day">');
    expect(html).toContain(
      `<meta property="og:image" content="https://srtd.io/og/p/${POST_ID}/${VERSION_ID}.jpg">`,
    );
    // The short link never points a crawler at the /posts/:postId form.
    expect(html).not.toContain('/posts/');
  });

  it('serves the generic card for an unparseable ref without touching the store', async () => {
    const store = new FakeStore({
      postTitle: 'never read',
      firstImage: null,
      bound: null,
      refTarget: { key: 'GBL', number: 142, postId: POST_ID, title: 'Launch day' },
    });
    const res = await renderShortLinkCard('garbage', store);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<meta property="og:title" content="Sorted">');
    expect(html).not.toContain('og:url');
  });

  it('serves the generic card when the ref resolves to no live post', async () => {
    const store = new FakeStore({
      postTitle: null,
      firstImage: null,
      bound: null,
      refTarget: null,
    });
    const res = await renderShortLinkCard('gbl-142', store);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<meta property="og:title" content="Sorted">');
    expect(html).not.toContain('og:url');
  });
});

describe('renderBriefLinkCard', () => {
  const BRIEF_ID = '55555555-5555-7555-8555-555555555555';

  it('renders a title-only card whose og:url is the /b/ short link, with no og:image', async () => {
    const store = new FakeStore({
      postTitle: 'never read via ref',
      firstImage: { assetVersionId: VERSION_ID, width: 1200, height: 630 },
      bound: null,
      briefRefTarget: { key: 'GBL', number: 142, briefId: BRIEF_ID, title: 'Spring campaign' },
    });
    const res = await renderBriefLinkCard('gbl-142', store);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-robots-tag')).toBe('noindex');
    expect(res.headers.get('cache-control')).toBe('public, max-age=300');
    const html = await res.text();
    expect(html).toContain('<meta property="og:url" content="https://srtd.io/b/gbl-142">');
    expect(html).toContain('<meta property="og:title" content="Spring campaign">');
    expect(html).toContain('<meta property="og:site_name" content="Sorted">');
    expect(html).toContain('<meta property="og:type" content="article">');
    expect(html).toContain('<meta name="twitter:card" content="summary">');
    expect(html).toContain('<meta name="robots" content="noindex">');
    // Briefs never carry an OG image, and never point at the /posts/ or /p/ forms.
    expect(html).not.toContain('og:image');
    expect(html).not.toContain('/posts/');
    expect(html).not.toContain('/p/');
  });

  it('serves the generic card for an unparseable ref without touching the store', async () => {
    const store = new FakeStore({
      postTitle: 'never read',
      firstImage: null,
      bound: null,
      briefRefTarget: { key: 'GBL', number: 142, briefId: BRIEF_ID, title: 'Spring campaign' },
    });
    const res = await renderBriefLinkCard('garbage', store);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<meta property="og:title" content="Sorted">');
    expect(html).not.toContain('og:url');
    expect(html).not.toContain('og:image');
  });

  it('serves the generic card when the ref resolves to no live brief', async () => {
    const store = new FakeStore({
      postTitle: null,
      firstImage: null,
      bound: null,
      briefRefTarget: null,
    });
    const res = await renderBriefLinkCard('gbl-142', store);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<meta property="og:title" content="Sorted">');
    expect(html).not.toContain('og:url');
  });
});

describe('worker.fetch brief short-link routing', () => {
  it('passes a human /b/ request through to PAGES_ORIGIN', async () => {
    const spy = vi.fn(() => Promise.resolve(new Response('spa', { status: 200 })));
    vi.stubGlobal('fetch', spy);
    const req = new Request('https://srtd.io/b/gbl-142', {
      headers: { 'User-Agent': 'Mozilla/5.0 Chrome/120.0' },
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledWith(
      'https://srtdio-app.pages.dev/b/gbl-142',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('passes a deeper /b/ path through even for a crawler', async () => {
    const spy = vi.fn(() => Promise.resolve(new Response('spa', { status: 200 })));
    vi.stubGlobal('fetch', spy);
    const req = new Request('https://srtd.io/b/gbl-142/extra', {
      headers: { 'User-Agent': 'WhatsApp/2.23.20.0' },
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(
      'https://srtdio-app.pages.dev/b/gbl-142/extra',
      expect.objectContaining({ method: 'GET' }),
    );
  });
});

describe('worker.fetch short-link routing', () => {
  it('passes a human /p/ request through to PAGES_ORIGIN', async () => {
    const spy = vi.fn(() => Promise.resolve(new Response('spa', { status: 200 })));
    vi.stubGlobal('fetch', spy);
    const req = new Request('https://srtd.io/p/gbl-142', {
      headers: { 'User-Agent': 'Mozilla/5.0 Chrome/120.0' },
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledWith(
      'https://srtdio-app.pages.dev/p/gbl-142',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('passes a deeper /p/ path through even for a crawler', async () => {
    const spy = vi.fn(() => Promise.resolve(new Response('spa', { status: 200 })));
    vi.stubGlobal('fetch', spy);
    const req = new Request('https://srtd.io/p/gbl-142/extra', {
      headers: { 'User-Agent': 'WhatsApp/2.23.20.0' },
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(
      'https://srtdio-app.pages.dev/p/gbl-142/extra',
      expect.objectContaining({ method: 'GET' }),
    );
  });
});

describe('serveOgImage', () => {
  const okImage = () =>
    Promise.resolve(
      new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/jpeg' } }),
    );

  function boundFixture(): Fixture {
    return {
      postTitle: 'Launch day',
      firstImage: null,
      bound: {
        postId: POST_ID,
        assetVersionId: VERSION_ID,
        locator: { bucket: BUCKET, r2Key: R2_KEY },
      },
    };
  }

  it('returns the bytes with immutable cache headers on the happy path', async () => {
    const signer = new RecordingSigner();
    const res = await serveOgImage(POST_ID, VERSION_ID, {
      store: new FakeStore(boundFixture()),
      signer,
      fetchImage: okImage,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(res.headers.get('x-robots-tag')).toBe('noindex');
    expect(signer.calls).toEqual([{ bucket: BUCKET, key: R2_KEY, expiresInSeconds: 300 }]);
  });

  it('404s when the version id does not match the bound pair', async () => {
    const res = await serveOgImage(POST_ID, OTHER_VERSION_ID, {
      store: new FakeStore(boundFixture()),
      signer: new RecordingSigner(),
      fetchImage: okImage,
    });
    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toBe('public, max-age=60');
  });

  it('404s when the post id does not match the bound pair', async () => {
    const res = await serveOgImage(OTHER_POST_ID, VERSION_ID, {
      store: new FakeStore(boundFixture()),
      signer: new RecordingSigner(),
      fetchImage: okImage,
    });
    expect(res.status).toBe(404);
  });

  it('404s for a non-image or soft-deleted attachment (store returns no binding)', async () => {
    const res = await serveOgImage(POST_ID, VERSION_ID, {
      store: new FakeStore({ postTitle: 'Launch day', firstImage: null, bound: null }),
      signer: new RecordingSigner(),
      fetchImage: okImage,
    });
    expect(res.status).toBe(404);
  });

  it('404s and never signs for an invalid uuid', async () => {
    const signer = new RecordingSigner();
    const res = await serveOgImage('nope', VERSION_ID, {
      store: new FakeStore(boundFixture()),
      signer,
      fetchImage: okImage,
    });
    expect(res.status).toBe(404);
    expect(signer.calls).toHaveLength(0);
  });

  it('502s when the upstream image fetch is not ok', async () => {
    const res = await serveOgImage(POST_ID, VERSION_ID, {
      store: new FakeStore(boundFixture()),
      signer: new RecordingSigner(),
      fetchImage: () => Promise.resolve(new Response('boom', { status: 500 })),
    });
    expect(res.status).toBe(502);
  });
});

describe('deleted post refuses on both endpoints', () => {
  it('serves the generic card (no post url) when the post is deleted', async () => {
    // A deleted post is not live, so the store yields no title.
    const store = new FakeStore({ postTitle: null, firstImage: null, bound: null });
    const res = await renderPostCard(POST_ID, store);
    const html = await res.text();
    expect(html).not.toContain('og:url');
    expect(html).toContain('<meta property="og:title" content="Sorted">');
  });

  it('404s the image endpoint when the post is deleted', async () => {
    const store = new FakeStore({ postTitle: null, firstImage: null, bound: null });
    const res = await serveOgImage(POST_ID, VERSION_ID, {
      store,
      signer: new RecordingSigner(),
      fetchImage: okImageUnused,
    });
    expect(res.status).toBe(404);
  });
});

function okImageUnused(): Promise<Response> {
  return Promise.resolve(new Response(null, { status: 200 }));
}
