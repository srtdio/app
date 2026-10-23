import { beforeAll, describe, expect, it } from 'vitest';
import worker, {
  fileCacheKey,
  parseFilePath,
  serveFile,
  type AssetReadStore,
  type AssetVersionLocator,
  type FileCache,
  type FileRequest,
  type FileRouteDeps,
  type RenditionReader,
} from './asset-read';
import { deriveLinkSigningKey, issueLinkKey } from './file-links';

const VERSION = '0199aaaa-0000-7000-8000-000000000001';
const WORKSPACE = '0199bbbb-0000-7000-8000-000000000002';
const MEMBER = '11111111-1111-7111-8111-111111111111';
const OUTSIDER = '22222222-2222-7222-8222-222222222222';
const NOW = Date.UTC(2026, 9, 23, 8, 0, 0);
const ORIGIN = 'https://srtd.io';

let signingKey: CryptoKey;
beforeAll(async () => {
  signingKey = await deriveLinkSigningKey('service-role-secret');
});

async function keyFor(userId: string): Promise<string> {
  return (await issueLinkKey({ userId, nowMs: NOW, signingKey })).key;
}

function libraryVersion(overrides: Partial<AssetVersionLocator> = {}): AssetVersionLocator {
  return {
    workspaceId: WORKSPACE,
    bucket: 'assets-gbl',
    origin: 'library',
    kind: 'image',
    r2Key: 'images/a/v1-photo.jpg',
    mimeType: 'image/jpeg',
    filename: 'photo.jpg',
    displayName: 'Diwali post',
    ...overrides,
  };
}

interface Harness {
  deps: FileRouteDeps;
  members: Set<string>;
  chatReaders: Set<string>;
  cacheStore: Map<string, Response>;
  cacheReads: string[];
  fetched: { url: string; range: string | null }[];
  signed: { bucket: string; key: string }[];
  pending: Promise<unknown>[];
  setVersion(version: AssetVersionLocator | null): void;
  setRendition(key: string | null): void;
  setBucket(bucket: string): void;
}

function harness(): Harness {
  let version: AssetVersionLocator | null = libraryVersion();
  let renditionKey: string | null = 'images/a/v1-thumb.jpg';
  const members = new Set<string>([`${MEMBER}:${WORKSPACE}`]);
  const chatReaders = new Set<string>();
  const cacheStore = new Map<string, Response>();
  const cacheReads: string[] = [];
  const fetched: { url: string; range: string | null }[] = [];
  const signed: { bucket: string; key: string }[] = [];
  const pending: Promise<unknown>[] = [];

  const store: AssetReadStore = {
    findVersion: (id) => Promise.resolve(id === VERSION ? version : null),
    isActiveMember: ({ userId, workspaceId }) =>
      Promise.resolve(members.has(`${userId}:${workspaceId}`)),
    isChatAttachmentReadable: ({ userId, assetVersionId }) =>
      Promise.resolve(chatReaders.has(`${userId}:${assetVersionId}`)),
  };
  const renditions: RenditionReader = {
    findRendition: () =>
      Promise.resolve(
        renditionKey === null ? null : { r2Key: renditionKey, width: 320, height: 320 },
      ),
  };
  const cache: FileCache = {
    match: (key) => {
      cacheReads.push(key);
      const hit = cacheStore.get(key);
      return Promise.resolve(hit === undefined ? undefined : hit.clone());
    },
    put: async (key, response) => {
      const body = await response.arrayBuffer();
      cacheStore.set(
        key,
        new Response(body, { status: response.status, headers: response.headers }),
      );
    },
  };
  const deps: FileRouteDeps = {
    store,
    renditions,
    signer: {
      presignGetUrl: (input) => {
        signed.push({ bucket: input.bucket, key: input.key });
        return Promise.resolve(`https://r2.test/${input.bucket}/${input.key}`);
      },
    },
    fetchObject: (url, range) => {
      fetched.push({ url, range });
      if (range !== null) {
        return Promise.resolve(
          new Response('ab', {
            status: 206,
            headers: {
              'Content-Type': 'video/mp4',
              'Content-Length': '2',
              'Content-Range': 'bytes 0-1/10',
              'Accept-Ranges': 'bytes',
            },
          }),
        );
      }
      return Promise.resolve(
        new Response('image-bytes', {
          status: 200,
          headers: { 'Content-Type': 'image/jpeg', 'Content-Length': '11', ETag: '"e1"' },
        }),
      );
    },
    cache,
    signingKey,
    waitUntil: (work) => {
      pending.push(work);
    },
    nowMs: () => NOW,
  };
  return {
    deps,
    members,
    chatReaders,
    cacheStore,
    cacheReads,
    fetched,
    signed,
    pending,
    setVersion: (next) => {
      version = next;
    },
    setRendition: (next) => {
      renditionKey = next;
    },
    setBucket: (bucket) => {
      version = version === null ? null : { ...version, bucket };
    },
  };
}

function request(overrides: Partial<FileRequest> & { key: string | null }): FileRequest {
  return {
    origin: ORIGIN,
    assetVersionId: VERSION,
    kind: 'full',
    download: false,
    range: null,
    ...overrides,
  };
}

describe('parseFilePath', () => {
  it('reads the version id and kind', () => {
    expect(parseFilePath(`/f/${VERSION}/thumb`)).toEqual({
      assetVersionId: VERSION,
      kind: 'thumb',
    });
    expect(parseFilePath(`/f/${VERSION}/full`)).toEqual({ assetVersionId: VERSION, kind: 'full' });
  });

  it('refuses other paths, including the internal cache namespace', () => {
    expect(parseFilePath(`/f/__c/${VERSION}/full`)).toBeNull();
    expect(parseFilePath(`/f/${VERSION}/other`)).toBeNull();
    expect(parseFilePath('/f/not-a-uuid/full')).toBeNull();
    expect(parseFilePath(`/posts/${VERSION}`)).toBeNull();
  });
});

describe('fileCacheKey', () => {
  it('names the version and kind only, never a user or link key', async () => {
    const key = fileCacheKey(ORIGIN, VERSION, 'thumb');
    expect(key).toBe(`${ORIGIN}/f/__c/${VERSION}/thumb`);
    expect(key).not.toContain(MEMBER);
    expect(key).not.toContain(await keyFor(MEMBER));
  });
});

describe('serveFile gate', () => {
  it('serves a member the file with private browser caching, CSP sandbox and noindex', async () => {
    const h = harness();
    const res = await serveFile(h.deps, request({ key: await keyFor(MEMBER) }));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('image-bytes');
    expect(res.headers.get('Cache-Control')).toBe('private, max-age=86400');
    expect(res.headers.get('Content-Type')).toBe('image/jpeg');
    expect(res.headers.get('Content-Disposition')).toBe('inline');
    expect(res.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Content-Security-Policy')).toContain('sandbox');
    expect(h.signed).toEqual([{ bucket: 'assets-gbl', key: 'images/a/v1-photo.jpg' }]);
  });

  it('answers 401 for a missing, tampered or expired key, before any lookup', async () => {
    const h = harness();
    expect((await serveFile(h.deps, request({ key: null }))).status).toBe(401);
    const good = await keyFor(MEMBER);
    expect((await serveFile(h.deps, request({ key: `${good}x` }))).status).toBe(401);
    const expired = await issueLinkKey({ userId: MEMBER, nowMs: NOW - 3 * 86_400_000, signingKey });
    expect((await serveFile(h.deps, request({ key: expired.key }))).status).toBe(401);
    expect(h.signed).toEqual([]);
  });

  it('refuses a non-member with 403 and never reads the cache or R2', async () => {
    const h = harness();
    const res = await serveFile(h.deps, request({ key: await keyFor(OUTSIDER) }));
    expect(res.status).toBe(403);
    expect(h.cacheReads).toEqual([]);
    expect(h.fetched).toEqual([]);
  });

  it('refuses a removed member on a cache hit: the gate runs before the cache', async () => {
    const h = harness();
    const key = await keyFor(MEMBER);
    await serveFile(h.deps, request({ key }));
    await Promise.all(h.pending);
    expect(h.cacheStore.size).toBe(1);

    h.members.delete(`${MEMBER}:${WORKSPACE}`);
    const res = await serveFile(h.deps, request({ key }));
    expect(res.status).toBe(403);
  });

  it('keeps the chat gate: only a chat reader gets a chat file, others get the same 403', async () => {
    const h = harness();
    h.setVersion(libraryVersion({ origin: 'chat' }));
    const memberKey = await keyFor(MEMBER);
    // A workspace member who is not in the chat is refused.
    expect((await serveFile(h.deps, request({ key: memberKey }))).status).toBe(403);
    h.chatReaders.add(`${MEMBER}:${VERSION}`);
    expect((await serveFile(h.deps, request({ key: memberKey }))).status).toBe(200);
  });

  it('answers 404 for an unknown version and for a link version', async () => {
    const h = harness();
    h.setVersion(null);
    expect((await serveFile(h.deps, request({ key: await keyFor(MEMBER) }))).status).toBe(404);
    h.setVersion(libraryVersion({ kind: 'link', r2Key: null }));
    expect((await serveFile(h.deps, request({ key: await keyFor(MEMBER) }))).status).toBe(404);
  });
});

describe('serveFile cache and bytes', () => {
  it('serves the second request from the edge cache without going to R2', async () => {
    const h = harness();
    const key = await keyFor(MEMBER);
    await serveFile(h.deps, request({ key }));
    await Promise.all(h.pending);
    expect(h.fetched).toHaveLength(1);
    const stored = h.cacheStore.get(fileCacheKey(ORIGIN, VERSION, 'full'));
    expect(stored?.headers.get('Cache-Control')).toBe('public, s-maxage=2592000');

    const again = await serveFile(h.deps, request({ key }));
    expect(again.status).toBe(200);
    expect(await again.text()).toBe('image-bytes');
    expect(again.headers.get('Cache-Control')).toBe('private, max-age=86400');
    expect(h.fetched).toHaveLength(1);
  });

  it('serves the small copy for thumb, and 404 when there is none', async () => {
    const h = harness();
    const key = await keyFor(MEMBER);
    const res = await serveFile(h.deps, request({ key, kind: 'thumb' }));
    expect(res.status).toBe(200);
    expect(h.signed.at(-1)).toEqual({ bucket: 'assets-gbl', key: 'images/a/v1-thumb.jpg' });

    h.setRendition(null);
    const none = await serveFile(h.deps, request({ key, kind: 'thumb' }));
    expect(none.status).toBe(404);
  });

  it('passes a Range request to R2 as a 206 and never caches it', async () => {
    const h = harness();
    const res = await serveFile(h.deps, request({ key: await keyFor(MEMBER), range: 'bytes=0-1' }));
    expect(res.status).toBe(206);
    expect(res.headers.get('Content-Range')).toBe('bytes 0-1/10');
    expect(h.fetched.at(-1)?.range).toBe('bytes=0-1');
    expect(h.cacheReads).toEqual([]);
    expect(h.pending).toEqual([]);
  });

  it('reads the bucket on every request, so a moved workspace is served from its new bucket', async () => {
    const h = harness();
    const key = await keyFor(MEMBER);
    await serveFile(h.deps, request({ key, range: 'bytes=0-1' }));
    h.setBucket('assets-gbl-apac');
    await serveFile(h.deps, request({ key, range: 'bytes=0-1' }));
    expect(h.signed.map((s) => s.bucket)).toEqual(['assets-gbl', 'assets-gbl-apac']);
  });

  it('sets attachment with the readable filename when dl=1', async () => {
    const h = harness();
    const res = await serveFile(h.deps, request({ key: await keyFor(MEMBER), download: true }));
    expect(res.headers.get('Content-Disposition')).toContain(
      'attachment; filename="Diwali post.jpg"',
    );
  });

  it('redirects an onboarding sample file to the site copy', async () => {
    const h = harness();
    h.setVersion(libraryVersion({ r2Key: 'induction-sample/look-1.jpg', bucket: null }));
    const res = await serveFile(h.deps, request({ key: await keyFor(MEMBER), kind: 'thumb' }));
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe(`${ORIGIN}/induction-sample/thumb/look-1.jpg`);
  });
});

describe('worker.fetch file routing', () => {
  const env = {
    CLOUDFLARE_ACCOUNT_ID: 'acct',
    CLOUDFLARE_R2_ACCESS_KEY_ID: 'key',
    CLOUDFLARE_R2_SECRET_ACCESS_KEY: 'secret',
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SECRET_KEY: 'service-role-secret',
    ALLOWED_ORIGINS: 'https://srtd.io',
  };

  it('answers 404 to an outside request for the internal cache namespace', async () => {
    const res = await worker.fetch(
      new Request(`https://srtd.io/f/__c/${VERSION}/full`, { method: 'GET' }),
      env,
    );
    expect(res.status).toBe(404);
    expect(res.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
  });

  it('answers 401 to a file request without a key, with CORS for an allowed origin only', async () => {
    const allowed = await worker.fetch(
      new Request(`https://srtd.io/f/${VERSION}/full`, {
        method: 'GET',
        headers: { Origin: 'https://srtd.io' },
      }),
      env,
    );
    expect(allowed.status).toBe(401);
    expect(allowed.headers.get('Access-Control-Allow-Origin')).toBe('https://srtd.io');

    const other = await worker.fetch(
      new Request(`https://srtd.io/f/${VERSION}/full`, {
        method: 'GET',
        headers: { Origin: 'https://evil.example' },
      }),
      env,
    );
    expect(other.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('requires a bearer token for /link-key', async () => {
    const res = await worker.fetch(
      new Request('https://worker.test/link-key', { method: 'POST' }),
      env,
    );
    expect(res.status).toBe(401);
  });
});
