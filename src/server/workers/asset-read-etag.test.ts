import { beforeAll, describe, expect, it } from 'vitest';
import {
  etagMatches,
  fileCacheKey,
  serveFile,
  type AssetReadStore,
  type AssetVersionLocator,
  type FileCache,
  type FileRequest,
  type FileRouteDeps,
} from './asset-read';
import { deriveLinkSigningKey, issueLinkKey } from './file-links';

const VERSION = '0199aaaa-0000-7000-8000-000000000001';
const WORKSPACE = '0199bbbb-0000-7000-8000-000000000002';
const MEMBER = '11111111-1111-7111-8111-111111111111';
const OUTSIDER = '22222222-2222-7222-8222-222222222222';
const NOW = Date.UTC(2026, 9, 26, 8, 0, 0);
const ORIGIN = 'https://srtd.io';
const ETAG = '"e1"';

let signingKey: CryptoKey;
beforeAll(async () => {
  signingKey = await deriveLinkSigningKey('service-role-secret');
});

async function keyFor(userId: string): Promise<string> {
  return (await issueLinkKey({ userId, nowMs: NOW, signingKey })).key;
}

const VERSION_ROW: AssetVersionLocator = {
  workspaceId: WORKSPACE,
  bucket: 'assets-gbl',
  origin: 'library',
  kind: 'image',
  r2Key: 'images/a/v1-photo.jpg',
  mimeType: 'image/jpeg',
  filename: 'photo.jpg',
  displayName: 'Diwali post',
};

interface Harness {
  deps: FileRouteDeps;
  /** Ordered log of what ran: the gate, then cache reads and R2 fetches. */
  events: string[];
  fetched: { range: string | null; ifNoneMatch: string | null }[];
  cacheStore: Map<string, Response>;
}

/**
 * A fake R2 that honours If-None-Match like the real one when `honours` is true,
 * and ignores it (always 200 with the ETag) when false.
 */
function harness(options: { honours: boolean } = { honours: true }): Harness {
  const events: string[] = [];
  const fetched: { range: string | null; ifNoneMatch: string | null }[] = [];
  const cacheStore = new Map<string, Response>();
  const store: AssetReadStore = {
    findVersion: (id) => Promise.resolve(id === VERSION ? VERSION_ROW : null),
    isActiveMember: ({ userId }) => {
      events.push('gate');
      return Promise.resolve(userId === MEMBER);
    },
    isChatAttachmentReadable: () => Promise.resolve(false),
  };
  const cache: FileCache = {
    match: (key) => {
      events.push('cache');
      const hit = cacheStore.get(key);
      return Promise.resolve(hit === undefined ? undefined : hit.clone());
    },
    put: async (key, response) => {
      const body = await response.arrayBuffer();
      cacheStore.set(key, new Response(body, { status: 200, headers: response.headers }));
    },
  };
  const deps: FileRouteDeps = {
    store,
    renditions: { findRendition: () => Promise.resolve(null) },
    signer: { presignGetUrl: (input) => Promise.resolve(`https://r2.test/${input.key}`) },
    fetchObject: (_url, range, ifNoneMatch) => {
      events.push('r2');
      fetched.push({ range, ifNoneMatch: ifNoneMatch ?? null });
      if (options.honours && etagMatches(ifNoneMatch, ETAG)) {
        return Promise.resolve(new Response(null, { status: 304, headers: { ETag: ETAG } }));
      }
      return Promise.resolve(
        new Response('image-bytes', {
          status: 200,
          headers: { 'Content-Type': 'image/jpeg', 'Content-Length': '11', ETag: ETAG },
        }),
      );
    },
    cache,
    signingKey,
    waitUntil: () => undefined,
    nowMs: () => NOW,
  };
  return { deps, events, fetched, cacheStore };
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

describe('etagMatches', () => {
  it('matches strong, weak, listed and wildcard validators', () => {
    expect(etagMatches('"e1"', '"e1"')).toBe(true);
    expect(etagMatches('W/"e1"', '"e1"')).toBe(true);
    expect(etagMatches('"x", "e1"', '"e1"')).toBe(true);
    expect(etagMatches('*', '"e1"')).toBe(true);
  });

  it('does not match a different, empty or absent validator', () => {
    expect(etagMatches('"e2"', '"e1"')).toBe(false);
    expect(etagMatches('', '"e1"')).toBe(false);
    expect(etagMatches(null, '"e1"')).toBe(false);
    expect(etagMatches(undefined, '"e1"')).toBe(false);
    expect(etagMatches('"e1"', null)).toBe(false);
  });
});

describe('serveFile If-None-Match', () => {
  it('returns 304 with the ETag and cache headers after the membership check', async () => {
    const h = harness();
    const res = await serveFile(h.deps, request({ key: await keyFor(MEMBER), ifNoneMatch: ETAG }));
    expect(res.status).toBe(304);
    expect(res.headers.get('ETag')).toBe(ETAG);
    expect(res.headers.get('Cache-Control')).toBe('private, max-age=86400');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.body).toBeNull();
    // The gate ran first, then R2 got the validator.
    expect(h.events.indexOf('gate')).toBeGreaterThanOrEqual(0);
    expect(h.events.indexOf('gate')).toBeLessThan(h.events.indexOf('r2'));
    expect(h.fetched).toEqual([{ range: null, ifNoneMatch: ETAG }]);
  });

  it('still denies a non-member who sends a matching If-None-Match, without touching R2', async () => {
    const h = harness();
    const res = await serveFile(
      h.deps,
      request({ key: await keyFor(OUTSIDER), ifNoneMatch: ETAG }),
    );
    expect(res.status).toBe(403);
    expect(res.headers.get('ETag')).toBeNull();
    expect(h.events).toEqual(['gate']);
    expect(h.fetched).toHaveLength(0);
  });

  it('still requires a link key before any validator is considered', async () => {
    const h = harness();
    const res = await serveFile(h.deps, request({ key: null, ifNoneMatch: ETAG }));
    expect(res.status).toBe(401);
    expect(h.events).toHaveLength(0);
  });

  it('returns 200 with the body when the validator does not match', async () => {
    const h = harness();
    const res = await serveFile(
      h.deps,
      request({ key: await keyFor(MEMBER), ifNoneMatch: '"stale"' }),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('image-bytes');
    expect(res.headers.get('ETag')).toBe(ETAG);
  });

  it('returns 200 when no validator is sent', async () => {
    const h = harness();
    const res = await serveFile(h.deps, request({ key: await keyFor(MEMBER) }));
    expect(res.status).toBe(200);
    expect(h.fetched).toEqual([{ range: null, ifNoneMatch: null }]);
  });

  it('returns 304 when R2 ignores the validator but sends the same ETag', async () => {
    const h = harness({ honours: false });
    const res = await serveFile(h.deps, request({ key: await keyFor(MEMBER), ifNoneMatch: ETAG }));
    expect(res.status).toBe(304);
    expect(res.headers.get('ETag')).toBe(ETAG);
    expect(res.body).toBeNull();
  });

  it('answers 304 from the edge copy after the gate, without fetching R2', async () => {
    const h = harness();
    h.cacheStore.set(
      fileCacheKey(ORIGIN, VERSION, 'full'),
      new Response('image-bytes', {
        status: 200,
        headers: { 'Content-Type': 'image/jpeg', 'Content-Length': '11', ETag: ETAG },
      }),
    );
    const res = await serveFile(h.deps, request({ key: await keyFor(MEMBER), ifNoneMatch: ETAG }));
    expect(res.status).toBe(304);
    expect(res.headers.get('ETag')).toBe(ETAG);
    expect(h.events).toEqual(['gate', 'cache']);
    expect(h.fetched).toHaveLength(0);
  });
});
