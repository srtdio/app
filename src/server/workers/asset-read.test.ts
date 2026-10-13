import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';
import {
  SignJWT,
  createRemoteJWKSet,
  exportJWK,
  generateKeyPair,
  type JWK,
  type JWTVerifyGetKey,
  type KeyLike,
} from 'jose';

// jose's Node build resolves a remote JWKS via node:http (not global fetch), so
// it cannot be intercepted by stubbing fetch the way the Workers runtime would.
// We mock the remote-JWKS constructor to serve our local public key instead -
// the "fetch" of the published key set, mocked. ES256 signature verification
// itself stays real (jwtVerify and createLocalJWKSet are the genuine exports).
const mockedJwks = vi.hoisted(() => ({ keys: [] as JWK[] }));
vi.mock('jose', async (importOriginal) => {
  const actual = await importOriginal<typeof import('jose')>();
  return {
    ...actual,
    createRemoteJWKSet: () => actual.createLocalJWKSet(mockedJwks),
  };
});

// The worker builds its service-role stores with supabase-js internally. A fake
// client over an in-memory table set lets worker.fetch tests reach the read,
// rendition, and stream paths with no network. Only the query shapes the
// asset-read store and the rendition store use are modeled.
const db = vi.hoisted(() => ({
  /** The asset_versions row (with its embeds) found for `versionId`, or null. */
  versionId: '',
  version: null as Record<string, unknown> | null,
  /** `${userId}:${workspaceId}` active memberships. */
  members: new Set<string>(),
  /** `${userId}:${assetVersionId}` pairs chat_attachment_readable allows. */
  chatReaders: new Set<string>(),
  /** asset_renditions rows keyed by `${assetVersionId}:${role}`. */
  renditions: new Map<string, { r2_key: string; width: number | null; height: number | null }>(),
  /** Every table or rpc touched, in order. */
  calls: [] as string[],
}));
vi.mock('@supabase/supabase-js', () => {
  function lookup(table: string, filters: Record<string, unknown>): unknown {
    if (table === 'asset_versions') {
      return filters.id === db.versionId ? db.version : null;
    }
    if (table === 'workspace_members') {
      return db.members.has(`${String(filters.user_id)}:${String(filters.workspace_id)}`)
        ? { id: 'member-row' }
        : null;
    }
    if (table === 'asset_renditions') {
      return (
        db.renditions.get(`${String(filters.asset_version_id)}:${String(filters.role)}`) ?? null
      );
    }
    throw new Error(`unexpected table ${table}`);
  }
  function from(table: string): unknown {
    db.calls.push(table);
    const filters: Record<string, unknown> = {};
    const builder = {
      select: () => builder,
      limit: () => builder,
      eq: (column: string, value: unknown) => {
        filters[column] = value;
        return builder;
      },
      maybeSingle: () => Promise.resolve({ data: lookup(table, filters), error: null }),
    };
    return builder;
  }
  function rpc(name: string, args: { p_asset_version_id: string; p_user_id: string }): unknown {
    db.calls.push(`rpc:${name}`);
    return Promise.resolve({
      data: db.chatReaders.has(`${args.p_user_id}:${args.p_asset_version_id}`),
      error: null,
    });
  }
  return { createClient: () => ({ from, rpc }) };
});

import worker, {
  authorizeAndSign,
  authorizeAndSignRendition,
  authorizeAndStream,
  authorizeVersion,
  getSupabaseJwks,
  verifyCaller,
  type AssetReadEnv,
  type AssetReadStore,
  type AssetVersionLocator,
  type ObjectFetcher,
  type PresignedUrlSigner,
  type RenditionReader,
} from './asset-read';
import { R2StorageClient } from '@srtdio/storage';
import type { RenditionRef, RenditionRole } from '@/server/assets/repository';

const USER = '33333333-3333-7333-8333-333333333333';
const OTHER_USER = '44444444-4444-7444-8444-444444444444';
const WORKSPACE = '11111111-1111-7111-8111-111111111111';
const VERSION_ID = '55555555-5555-7555-8555-555555555555';
// Stored, permanent bucket name (workspaces.asset_bucket) and new key layout.
const BUCKET = 'assets-acme';
const R2_KEY = 'images/aaaa/v1-photo.jpg';

const SUPABASE_URL = 'https://test.supabase.co';
const JWKS_URL = `${SUPABASE_URL}/auth/v1/.well-known/jwks.json`;
const KID = 'test-es256-key';

// A local ES256 keypair stands in for the Supabase signing key. The public half
// is exported as a JWK and served by a mocked JWKS fetch; the private half signs
// test tokens. Generated once so every test agrees on the same key material.
let signingKey: KeyLike;
let publicJwk: JWK;

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
  signingKey = privateKey;
  publicJwk = { ...(await exportJWK(publicKey)), alg: 'ES256', use: 'sig', kid: KID };
  mockedJwks.keys = [publicJwk];
});

async function mintToken(sub: string, expSecondsFromNow = 3600): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: KID })
    .setSubject(sub)
    .setIssuedAt(nowSec)
    .setExpirationTime(nowSec + expSecondsFromNow)
    .sign(signingKey);
}

class FakeStore implements AssetReadStore {
  readonly chatChecks: Array<{ userId: string; assetVersionId: string }> = [];
  memberChecks = 0;
  constructor(
    private readonly version: AssetVersionLocator | null,
    private readonly members: ReadonlySet<string>,
    /** `${userId}:${assetVersionId}` pairs chat_attachment_readable allows. */
    private readonly chatReaders: ReadonlySet<string> = new Set(),
    private readonly chatRpcError: Error | null = null,
  ) {}
  findVersion(): Promise<AssetVersionLocator | null> {
    return Promise.resolve(this.version);
  }
  isActiveMember(input: { userId: string; workspaceId: string }): Promise<boolean> {
    this.memberChecks += 1;
    return Promise.resolve(this.members.has(`${input.userId}:${input.workspaceId}`));
  }
  isChatAttachmentReadable(input: { userId: string; assetVersionId: string }): Promise<boolean> {
    this.chatChecks.push(input);
    if (this.chatRpcError !== null) return Promise.reject(this.chatRpcError);
    return Promise.resolve(this.chatReaders.has(`${input.userId}:${input.assetVersionId}`));
  }
}

class RecordingSigner implements PresignedUrlSigner {
  calls: Array<{ bucket: string; key: string; expiresInSeconds: number }> = [];
  presignGetUrl(input: { bucket: string; key: string; expiresInSeconds: number }): Promise<string> {
    this.calls.push(input);
    return Promise.resolve(`https://signed.example/${input.key}?sig=abc`);
  }
}

const located: AssetVersionLocator = {
  workspaceId: WORKSPACE,
  bucket: BUCKET,
  origin: 'library',
  kind: 'image',
  r2Key: R2_KEY,
};
const memberOfWorkspace = new Set<string>([`${USER}:${WORKSPACE}`]);

function bearerRequest(
  token: string | null,
  body: unknown = { asset_version_id: VERSION_ID },
): Request {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (token !== null) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  return new Request('https://worker.test/', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

/** A remote JWKS resolver bound to the mocked fetch endpoint. */
function remoteJwks(): JWTVerifyGetKey {
  return createRemoteJWKSet(new URL(JWKS_URL));
}

describe('verifyCaller', () => {
  it('rejects a missing Authorization header with 401', async () => {
    const result = await verifyCaller(bearerRequest(null), remoteJwks());
    expect(result).toEqual({
      ok: false,
      error: { code: 'unauthorized', message: expect.any(String) },
    });
  });

  it('rejects a malformed token with 401', async () => {
    const result = await verifyCaller(bearerRequest('not-a-real-jwt'), remoteJwks());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('unauthorized');
    }
  });

  it('rejects an expired token with 401', async () => {
    const token = await mintToken(USER, -10);
    const result = await verifyCaller(bearerRequest(token), remoteJwks());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('unauthorized');
    }
  });

  it('rejects an HS256-signed token with 401', async () => {
    // A symmetric token is the pre-migration shape: it must no longer verify.
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(USER)
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode('a-totally-different-secret-32-characters'));
    const result = await verifyCaller(bearerRequest(token), remoteJwks());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('unauthorized');
      expect(result.error.message).toBe('Invalid or expired token.');
    }
  });

  it('accepts a valid ES256 token served by the mocked JWKS and returns the sub claim', async () => {
    const token = await mintToken(USER);
    const result = await verifyCaller(bearerRequest(token), remoteJwks());
    expect(result).toEqual({ ok: true, value: USER });
  });

  it('builds the JWKS resolver from SUPABASE_URL and verifies against it', async () => {
    const token = await mintToken(USER);
    const result = await verifyCaller(bearerRequest(token), getSupabaseJwks({ SUPABASE_URL }));
    expect(result).toEqual({ ok: true, value: USER });
  });
});

describe('authorizeAndSign', () => {
  it('returns a url and expires_at for an active member', async () => {
    const signer = new RecordingSigner();
    const store = new FakeStore(located, memberOfWorkspace);
    const result = await authorizeAndSign(
      { store, signer },
      { userId: USER, assetVersionId: VERSION_ID },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.url).toContain('https://signed.example/');
      expect(Date.parse(result.value.expires_at)).toBeGreaterThan(Date.now());
    }
    // Bucket comes from the stored asset_bucket, key from the stored r2_key, 15 min TTL.
    expect(signer.calls).toEqual([{ bucket: BUCKET, key: R2_KEY, expiresInSeconds: 900 }]);
  });

  it('denies a caller who is not a member of the workspace with 403', async () => {
    const signer = new RecordingSigner();
    const store = new FakeStore(located, memberOfWorkspace);
    const result = await authorizeAndSign(
      { store, signer },
      { userId: OTHER_USER, assetVersionId: VERSION_ID },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('forbidden');
    }
    // The cross-tenant gate must run before anything is signed.
    expect(signer.calls).toHaveLength(0);
  });

  it('returns not_a_stored_file for a link version and never signs', async () => {
    const signer = new RecordingSigner();
    const link: AssetVersionLocator = {
      workspaceId: WORKSPACE,
      bucket: BUCKET,
      origin: 'library',
      kind: 'link',
      r2Key: null,
    };
    const store = new FakeStore(link, memberOfWorkspace);
    const result = await authorizeAndSign(
      { store, signer },
      { userId: USER, assetVersionId: VERSION_ID },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('not_a_stored_file');
    }
    // The signer is reached only by a stored file with a non-null r2_key.
    expect(signer.calls).toHaveLength(0);
  });

  it('returns 404 when the asset version does not exist', async () => {
    const signer = new RecordingSigner();
    const store = new FakeStore(null, memberOfWorkspace);
    const result = await authorizeAndSign(
      { store, signer },
      { userId: USER, assetVersionId: VERSION_ID },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('not_found');
    }
    expect(signer.calls).toHaveLength(0);
  });
});

describe('authorizeAndSign chat-origin gate', () => {
  const chatLocated: AssetVersionLocator = { ...located, origin: 'chat' };
  const chatReader = new Set<string>([`${USER}:${VERSION_ID}`]);

  it('signs a chat file when chat_attachment_readable is true', async () => {
    const signer = new RecordingSigner();
    // The caller is not even a workspace member: chat membership alone decides.
    const store = new FakeStore(chatLocated, new Set(), chatReader);
    const result = await authorizeAndSign(
      { store, signer },
      { userId: USER, assetVersionId: VERSION_ID },
    );
    expect(result.ok).toBe(true);
    expect(store.chatChecks).toEqual([{ userId: USER, assetVersionId: VERSION_ID }]);
    expect(store.memberChecks).toBe(0);
    expect(signer.calls).toHaveLength(1);
  });

  it('denies a chat file when not readable, with the exact non-member error', async () => {
    const signer = new RecordingSigner();
    // A workspace member who is not in the chat is still denied.
    const chatStore = new FakeStore(chatLocated, memberOfWorkspace, chatReader);
    const denied = await authorizeAndSign(
      { store: chatStore, signer },
      { userId: OTHER_USER, assetVersionId: VERSION_ID },
    );
    const libraryDenied = await authorizeAndSign(
      { store: new FakeStore(located, memberOfWorkspace), signer },
      { userId: OTHER_USER, assetVersionId: VERSION_ID },
    );
    expect(denied.ok).toBe(false);
    expect(denied).toEqual(libraryDenied);
    expect(chatStore.memberChecks).toBe(0);
    expect(signer.calls).toHaveLength(0);
  });

  it('keeps the library gate unchanged: membership only, no chat RPC', async () => {
    const signer = new RecordingSigner();
    const store = new FakeStore(located, memberOfWorkspace, chatReader);
    const result = await authorizeAndSign(
      { store, signer },
      { userId: USER, assetVersionId: VERSION_ID },
    );
    expect(result.ok).toBe(true);
    expect(store.memberChecks).toBe(1);
    expect(store.chatChecks).toHaveLength(0);
  });

  it('propagates a chat RPC error (worker 5xx) and never signs', async () => {
    const signer = new RecordingSigner();
    const store = new FakeStore(chatLocated, memberOfWorkspace, chatReader, new Error('rpc down'));
    await expect(
      authorizeAndSign({ store, signer }, { userId: USER, assetVersionId: VERSION_ID }),
    ).rejects.toThrow('rpc down');
    expect(signer.calls).toHaveLength(0);
  });
});

describe('module startup safety', () => {
  it('imports without performing any network I/O at eval', async () => {
    vi.resetModules();
    const fetchSpy = vi.fn(() => Promise.reject(new Error('no fetch at import')));
    vi.stubGlobal('fetch', fetchSpy);
    await import('./asset-read');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('worker.fetch', () => {
  const env: AssetReadEnv = {
    CLOUDFLARE_ACCOUNT_ID: 'acct',
    CLOUDFLARE_R2_ACCESS_KEY_ID: 'akid',
    CLOUDFLARE_R2_SECRET_ACCESS_KEY: 'secret',
    SUPABASE_URL,
    SUPABASE_SECRET_KEY: 'service-role-key',
  };

  it('returns 401 when the bearer token is absent', async () => {
    const res = await worker.fetch(bearerRequest(null), env);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('unauthorized');
  });

  it('returns 400 for a non-POST method', async () => {
    const res = await worker.fetch(new Request('https://worker.test/', { method: 'GET' }), env);
    expect(res.status).toBe(400);
  });
});

describe('worker.fetch CORS', () => {
  const ALLOWED_ORIGIN = 'https://srtd.io';
  const OTHER_ALLOWED_ORIGIN = 'https://srtd.io';
  const DISALLOWED_ORIGIN = 'https://evil.example';

  // No ALLOWED_ORIGINS set: the code falls back to the known site origins.
  const env: AssetReadEnv = {
    CLOUDFLARE_ACCOUNT_ID: 'acct',
    CLOUDFLARE_R2_ACCESS_KEY_ID: 'akid',
    CLOUDFLARE_R2_SECRET_ACCESS_KEY: 'secret',
    SUPABASE_URL,
    SUPABASE_SECRET_KEY: 'service-role-key',
  };

  function preflight(origin: string | null): Request {
    const headers = new Headers({
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'authorization, content-type, x-trace-id',
    });
    if (origin !== null) {
      headers.set('Origin', origin);
    }
    return new Request('https://worker.test/', { method: 'OPTIONS', headers });
  }

  function postWith(token: string | null, origin: string | null, body?: unknown): Request {
    const req = bearerRequest(token, body);
    if (origin !== null) {
      req.headers.set('Origin', origin);
    }
    return req;
  }

  it('answers an OPTIONS preflight from an allowed origin with 204 and CORS headers', async () => {
    const res = await worker.fetch(preflight(ALLOWED_ORIGIN), env);
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ALLOWED_ORIGIN);
    expect(res.headers.get('Access-Control-Allow-Methods')).toBe('POST, OPTIONS');
    expect(res.headers.get('Access-Control-Allow-Headers')).toBe(
      'authorization, content-type, x-trace-id',
    );
    expect(res.headers.get('Access-Control-Max-Age')).toBe('86400');
    expect(res.headers.get('Vary')).toBe('Origin');
  });

  it('never reflects a wildcard or a disallowed origin on preflight', async () => {
    const res = await worker.fetch(preflight(DISALLOWED_ORIGIN), env);
    expect(res.status).toBe(204);
    const acao = res.headers.get('Access-Control-Allow-Origin');
    expect(acao).not.toBe('*');
    expect(acao).not.toBe(DISALLOWED_ORIGIN);
    // Falls back to the primary site origin so the browser simply blocks.
    expect(acao).toBe(ALLOWED_ORIGIN);
  });

  it('carries ACAO on a successful POST response for an allowed origin', async () => {
    const token = await mintToken(USER);
    const res = await worker.fetch(postWith(token, OTHER_ALLOWED_ORIGIN, { bad: true }), env);
    // 400 (bad body) still exercises the fail() path with CORS applied; the
    // ES256 token verified against the mocked JWKS before the body was read.
    expect(res.status).toBe(400);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(OTHER_ALLOWED_ORIGIN);
    expect(res.headers.get('Vary')).toBe('Origin');
  });

  it('carries ACAO on an error POST response for an allowed origin', async () => {
    const res = await worker.fetch(postWith(null, ALLOWED_ORIGIN), env);
    expect(res.status).toBe(401);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ALLOWED_ORIGIN);
    expect(res.headers.get('Vary')).toBe('Origin');
  });

  it('omits ACAO on a POST response for a disallowed origin', async () => {
    const res = await worker.fetch(postWith(null, DISALLOWED_ORIGIN), env);
    expect(res.status).toBe(401);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Thumbnail rendition and PDF stream modes.
// ---------------------------------------------------------------------------

const THUMB_KEY = 'pdf/aaaa/v1-thumb.jpg';
const PDF_KEY = 'pdf/aaaa/v1-brief.pdf';

const pdfLocated: AssetVersionLocator = {
  workspaceId: WORKSPACE,
  bucket: BUCKET,
  origin: 'library',
  kind: 'pdf',
  r2Key: PDF_KEY,
  mimeType: 'application/pdf',
  filename: 'brief.pdf',
};
const chatPdfLocated: AssetVersionLocator = { ...pdfLocated, origin: 'chat' };
const chatReaderOfVersion = new Set<string>([`${USER}:${VERSION_ID}`]);

class FakeRenditions implements RenditionReader {
  readonly finds: Array<{ assetVersionId: string; role: RenditionRole }> = [];
  constructor(private readonly rendition: RenditionRef | null) {}
  findRendition(assetVersionId: string, role: RenditionRole): Promise<RenditionRef | null> {
    this.finds.push({ assetVersionId, role });
    return Promise.resolve(this.rendition);
  }
}

const thumbRendition: RenditionRef = { r2Key: THUMB_KEY, width: 400, height: 566 };

/** A one-chunk upstream body the test can identify by reference. */
function upstreamResponse(status: number, headers: Record<string, string> = {}): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('%PDF-1.7'));
      controller.close();
    },
  });
  return new Response(stream, { status, headers });
}

class RecordingFetcher {
  readonly calls: Array<{ url: string; range: string | null }> = [];
  constructor(private readonly respond: () => Response) {}
  readonly fetchObject: ObjectFetcher = (url, range) => {
    this.calls.push({ url, range });
    return Promise.resolve(this.respond());
  };
}

describe('authorizeVersion', () => {
  it('returns the located version with its bucket and key for a member', async () => {
    const result = await authorizeVersion(new FakeStore(pdfLocated, memberOfWorkspace), {
      userId: USER,
      assetVersionId: VERSION_ID,
    });
    expect(result).toEqual({
      ok: true,
      value: { version: pdfLocated, bucket: BUCKET, r2Key: PDF_KEY },
    });
  });

  it('denies a non-member and a chat non-reader with the same forbidden error', async () => {
    const library = await authorizeVersion(new FakeStore(pdfLocated, memberOfWorkspace), {
      userId: OTHER_USER,
      assetVersionId: VERSION_ID,
    });
    const chat = await authorizeVersion(
      new FakeStore(chatPdfLocated, memberOfWorkspace, chatReaderOfVersion),
      { userId: OTHER_USER, assetVersionId: VERSION_ID },
    );
    expect(library).toEqual({
      ok: false,
      error: { code: 'forbidden', message: 'Not a member of this workspace.' },
    });
    expect(chat).toEqual(library);
  });

  it('returns not_found for an unknown version', async () => {
    const result = await authorizeVersion(new FakeStore(null, memberOfWorkspace), {
      userId: USER,
      assetVersionId: VERSION_ID,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('not_found');
  });
});

describe('authorizeAndSignRendition', () => {
  it('signs the rendition key inline for 900 s for a readable version', async () => {
    const signer = new RecordingSigner();
    const renditions = new FakeRenditions(thumbRendition);
    const before = Date.now();
    const result = await authorizeAndSignRendition(
      { store: new FakeStore(pdfLocated, memberOfWorkspace), signer, renditions },
      { userId: USER, assetVersionId: VERSION_ID },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.url).toBe(`https://signed.example/${THUMB_KEY}?sig=abc`);
    const expiresIn = Date.parse(result.value.expires_at) - before;
    expect(expiresIn).toBeGreaterThanOrEqual(899_000);
    expect(expiresIn).toBeLessThanOrEqual(901_000);
    // Exactly bucket, rendition key, and TTL: no downloadFilename, so inline.
    expect(signer.calls).toEqual([{ bucket: BUCKET, key: THUMB_KEY, expiresInSeconds: 900 }]);
    expect(renditions.finds).toEqual([{ assetVersionId: VERSION_ID, role: 'thumbnail' }]);
  });

  it('denies a library non-member before reading the rendition or signing', async () => {
    const signer = new RecordingSigner();
    const renditions = new FakeRenditions(thumbRendition);
    const store = new FakeStore(pdfLocated, memberOfWorkspace);
    const result = await authorizeAndSignRendition(
      { store, signer, renditions },
      { userId: OTHER_USER, assetVersionId: VERSION_ID },
    );
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error).toEqual({ code: 'forbidden', message: expect.any(String) });
    expect(store.memberChecks).toBe(1);
    expect(renditions.finds).toHaveLength(0);
    expect(signer.calls).toHaveLength(0);
  });

  it('denies a chat file when chat_attachment_readable is false, never signing', async () => {
    const signer = new RecordingSigner();
    const renditions = new FakeRenditions(thumbRendition);
    // A workspace member who is not in the chat.
    const store = new FakeStore(chatPdfLocated, memberOfWorkspace, chatReaderOfVersion);
    const result = await authorizeAndSignRendition(
      { store, signer, renditions },
      { userId: OTHER_USER, assetVersionId: VERSION_ID },
    );
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error).toEqual({ code: 'forbidden', message: expect.any(String) });
    expect(store.chatChecks).toEqual([{ userId: OTHER_USER, assetVersionId: VERSION_ID }]);
    expect(store.memberChecks).toBe(0);
    expect(signer.calls).toHaveLength(0);
  });

  it('signs a chat file for a chat reader', async () => {
    const signer = new RecordingSigner();
    const store = new FakeStore(chatPdfLocated, new Set(), chatReaderOfVersion);
    const result = await authorizeAndSignRendition(
      { store, signer, renditions: new FakeRenditions(thumbRendition) },
      { userId: USER, assetVersionId: VERSION_ID },
    );
    expect(result.ok).toBe(true);
    expect(signer.calls).toEqual([{ bucket: BUCKET, key: THUMB_KEY, expiresInSeconds: 900 }]);
  });

  it("returns 'no_rendition' when the version has no thumbnail", async () => {
    const signer = new RecordingSigner();
    const result = await authorizeAndSignRendition(
      {
        store: new FakeStore(pdfLocated, memberOfWorkspace),
        signer,
        renditions: new FakeRenditions(null),
      },
      { userId: USER, assetVersionId: VERSION_ID },
    );
    expect(result).toEqual({ ok: false, error: 'no_rendition' });
    expect(signer.calls).toHaveLength(0);
  });

  it('returns not_found for an unknown version before looking for a rendition', async () => {
    const renditions = new FakeRenditions(thumbRendition);
    const result = await authorizeAndSignRendition(
      { store: new FakeStore(null, memberOfWorkspace), signer: new RecordingSigner(), renditions },
      { userId: USER, assetVersionId: VERSION_ID },
    );
    expect(result.ok).toBe(false);
    if (!result.ok && result.error !== 'no_rendition') expect(result.error.code).toBe('not_found');
    expect(renditions.finds).toHaveLength(0);
  });
});

describe('authorizeAndStream', () => {
  it('pipes the upstream PDF body through without reading it', async () => {
    const signer = new RecordingSigner();
    let upstream: Response | null = null;
    const fetcher = new RecordingFetcher(() => {
      upstream = upstreamResponse(200, { 'Content-Length': '8', 'Accept-Ranges': 'bytes' });
      return upstream;
    });
    const result = await authorizeAndStream(
      {
        store: new FakeStore(pdfLocated, memberOfWorkspace),
        signer,
        fetchObject: fetcher.fetchObject,
      },
      { userId: USER, assetVersionId: VERSION_ID, range: null },
    );
    expect(result.ok).toBe(true);
    if (!result.ok || upstream === null) return;
    const response = result.value;
    const upstreamBody = (upstream as Response).body;
    expect(response.status).toBe(200);
    // The same stream object: never buffered or re-wrapped by this Worker.
    expect(response.body).toBe(upstreamBody);
    expect((upstream as Response).bodyUsed).toBe(false);
    expect(response.headers.get('Content-Type')).toBe('application/pdf');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('Content-Length')).toBe('8');
    expect(response.headers.get('Accept-Ranges')).toBe('bytes');
    expect(await response.text()).toBe('%PDF-1.7');

    // The upstream URL is the version's own key, signed for 900 s, inline.
    expect(signer.calls).toEqual([{ bucket: BUCKET, key: PDF_KEY, expiresInSeconds: 900 }]);
    expect(fetcher.calls).toEqual([
      { url: `https://signed.example/${PDF_KEY}?sig=abc`, range: null },
    ]);
  });

  it('passes a Range request through and a 206 with Content-Range back', async () => {
    const fetcher = new RecordingFetcher(() =>
      upstreamResponse(206, { 'Content-Range': 'bytes 0-7/1000', 'Content-Length': '8' }),
    );
    const result = await authorizeAndStream(
      {
        store: new FakeStore(pdfLocated, memberOfWorkspace),
        signer: new RecordingSigner(),
        fetchObject: fetcher.fetchObject,
      },
      { userId: USER, assetVersionId: VERSION_ID, range: 'bytes=0-7' },
    );
    expect(fetcher.calls[0]?.range).toBe('bytes=0-7');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe(206);
    expect(result.value.headers.get('Content-Range')).toBe('bytes 0-7/1000');
    expect(result.value.headers.get('Content-Type')).toBe('application/pdf');
  });

  it('pins Content-Type to application/pdf whatever the upstream says', async () => {
    const fetcher = new RecordingFetcher(() =>
      upstreamResponse(200, { 'Content-Type': 'text/html' }),
    );
    const result = await authorizeAndStream(
      {
        store: new FakeStore(pdfLocated, memberOfWorkspace),
        signer: new RecordingSigner(),
        fetchObject: fetcher.fetchObject,
      },
      { userId: USER, assetVersionId: VERSION_ID, range: null },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.headers.get('Content-Type')).toBe('application/pdf');
  });

  it('streams a Word or Excel version with its own mime pinned (nosniff, no-store)', async () => {
    const cases: Array<[string, string]> = [
      ['document', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
      ['spreadsheet', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ];
    for (const [kind, mimeType] of cases) {
      const fetcher = new RecordingFetcher(() =>
        upstreamResponse(200, { 'Content-Type': 'text/html' }),
      );
      const result = await authorizeAndStream(
        {
          store: new FakeStore({ ...pdfLocated, kind, mimeType }, memberOfWorkspace),
          signer: new RecordingSigner(),
          fetchObject: fetcher.fetchObject,
        },
        { userId: USER, assetVersionId: VERSION_ID, range: null },
      );
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.value.headers.get('Content-Type')).toBe(mimeType);
      expect(result.value.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(result.value.headers.get('Cache-Control')).toBe('private, no-store');
    }
  });

  it('returns 400 bad_request for a non-PDF version without signing or fetching', async () => {
    const pptx = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    const docxMime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    const cases: AssetVersionLocator[] = [
      { ...located, mimeType: 'image/jpeg' },
      { ...pdfLocated, kind: 'document' },
      { ...pdfLocated, mimeType: 'image/png' },
      // PowerPoint has no in-app preview yet.
      { ...pdfLocated, kind: 'presentation', mimeType: pptx },
      // Kind and mime must agree.
      { ...pdfLocated, kind: 'spreadsheet', mimeType: docxMime },
    ];
    for (const version of cases) {
      const signer = new RecordingSigner();
      const fetcher = new RecordingFetcher(() => upstreamResponse(200));
      const result = await authorizeAndStream(
        {
          store: new FakeStore(version, memberOfWorkspace),
          signer,
          fetchObject: fetcher.fetchObject,
        },
        { userId: USER, assetVersionId: VERSION_ID, range: null },
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('bad_request');
      expect(signer.calls).toHaveLength(0);
      expect(fetcher.calls).toHaveLength(0);
    }
  });

  it('maps an upstream 416 to bad_request and throws on another upstream failure', async () => {
    const deps = (status: number) => ({
      store: new FakeStore(pdfLocated, memberOfWorkspace),
      signer: new RecordingSigner(),
      fetchObject: new RecordingFetcher(() => upstreamResponse(status)).fetchObject,
    });
    const unsatisfiable = await authorizeAndStream(deps(416), {
      userId: USER,
      assetVersionId: VERSION_ID,
      range: 'bytes=5000-',
    });
    expect(unsatisfiable.ok).toBe(false);
    if (!unsatisfiable.ok) expect(unsatisfiable.error.code).toBe('bad_request');
    await expect(
      authorizeAndStream(deps(500), { userId: USER, assetVersionId: VERSION_ID, range: null }),
    ).rejects.toThrow('500');
  });
});

describe('thumbnail and stream gate on the parent version', () => {
  type Mode = 'thumbnail' | 'stream';
  const modes: Mode[] = ['thumbnail', 'stream'];

  async function run(mode: Mode, store: FakeStore, signer: RecordingSigner, userId: string) {
    const fetcher = new RecordingFetcher(() => upstreamResponse(200));
    const renditions = new FakeRenditions(thumbRendition);
    const target = { userId, assetVersionId: VERSION_ID };
    const result =
      mode === 'thumbnail'
        ? await authorizeAndSignRendition({ store, signer, renditions }, target)
        : await authorizeAndStream(
            { store, signer, fetchObject: fetcher.fetchObject },
            { ...target, range: null },
          );
    return { result, fetcher, renditions };
  }

  for (const mode of modes) {
    it(`${mode}: library gate is isActiveMember on the parent workspace, before signing`, async () => {
      const signer = new RecordingSigner();
      const store = new FakeStore(pdfLocated, memberOfWorkspace, chatReaderOfVersion);
      const denied = await run(mode, store, signer, OTHER_USER);
      expect(denied.result.ok).toBe(false);
      expect(store.memberChecks).toBe(1);
      expect(store.chatChecks).toHaveLength(0);
      expect(signer.calls).toHaveLength(0);
      expect(denied.fetcher.calls).toHaveLength(0);
      expect(denied.renditions.finds).toHaveLength(0);

      const allowed = await run(mode, store, signer, USER);
      expect(allowed.result.ok).toBe(true);
      expect(signer.calls).toHaveLength(1);
    });

    it(`${mode}: chat gate is isChatAttachmentReadable on the parent version, before signing`, async () => {
      const signer = new RecordingSigner();
      const store = new FakeStore(chatPdfLocated, memberOfWorkspace, chatReaderOfVersion);
      const denied = await run(mode, store, signer, OTHER_USER);
      expect(denied.result.ok).toBe(false);
      expect(store.chatChecks).toEqual([{ userId: OTHER_USER, assetVersionId: VERSION_ID }]);
      expect(store.memberChecks).toBe(0);
      expect(signer.calls).toHaveLength(0);
      expect(denied.fetcher.calls).toHaveLength(0);

      const allowed = await run(mode, store, signer, USER);
      expect(allowed.result.ok).toBe(true);
      expect(store.memberChecks).toBe(0);
      expect(signer.calls).toHaveLength(1);
    });
  }
});

describe('worker.fetch thumbnail and stream modes', () => {
  const env: AssetReadEnv = {
    CLOUDFLARE_ACCOUNT_ID: 'acct',
    CLOUDFLARE_R2_ACCESS_KEY_ID: 'akid',
    CLOUDFLARE_R2_SECRET_ACCESS_KEY: 'secret',
    SUPABASE_URL,
    SUPABASE_SECRET_KEY: 'service-role-key',
  };

  function versionRow(origin: 'library' | 'chat', kind: string, r2Key: string, mime: string) {
    return {
      workspace_id: WORKSPACE,
      kind,
      r2_key: r2Key,
      mime_type: mime,
      workspaces: { asset_bucket: BUCKET },
      assets: { filename: 'brief.pdf', display_name: null, origin },
    };
  }

  let presign: MockInstance<R2StorageClient['presignGetUrl']>;

  beforeEach(() => {
    db.versionId = VERSION_ID;
    db.version = versionRow('library', 'pdf', PDF_KEY, 'application/pdf');
    db.members = new Set([`${USER}:${WORKSPACE}`]);
    db.chatReaders = new Set();
    db.renditions = new Map([
      [`${VERSION_ID}:thumbnail`, { r2_key: THUMB_KEY, width: 400, height: 566 }],
    ]);
    db.calls = [];
    presign = vi.spyOn(R2StorageClient.prototype, 'presignGetUrl');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function post(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
    const req = bearerRequest(await mintToken(USER), body);
    for (const [name, value] of Object.entries(headers)) req.headers.set(name, value);
    return worker.fetch(req, env);
  }

  it('answers a body without the new fields exactly as before', async () => {
    const res = await post({ asset_version_id: VERSION_ID });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['expires_at', 'url']);
    expect(String(body.url)).toContain(`/${BUCKET}/pdf/aaaa/v1-brief.pdf?`);
    expect(String(body.url)).not.toContain('response-content-disposition');
    expect(presign).toHaveBeenCalledTimes(1);
    expect(presign).toHaveBeenCalledWith({ bucket: BUCKET, key: PDF_KEY, expiresInSeconds: 900 });
    // No rendition lookup on a plain read.
    expect(db.calls).not.toContain('asset_renditions');
  });

  it('keeps disposition attachment unchanged (download filename added)', async () => {
    const res = await post({ asset_version_id: VERSION_ID, disposition: 'attachment' });
    expect(res.status).toBe(200);
    expect(presign).toHaveBeenCalledWith({
      bucket: BUCKET,
      key: PDF_KEY,
      expiresInSeconds: 900,
      downloadFilename: 'brief.pdf',
    });
  });

  it("rendition 'thumbnail' signs the rendition key inline (200)", async () => {
    const res = await post({ asset_version_id: VERSION_ID, rendition: 'thumbnail' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['expires_at', 'url']);
    expect(String(body.url)).toContain(`/${BUCKET}/pdf/aaaa/v1-thumb.jpg?`);
    expect(String(body.url)).not.toContain('response-content-disposition');
    expect(presign).toHaveBeenCalledWith({ bucket: BUCKET, key: THUMB_KEY, expiresInSeconds: 900 });
  });

  it("rendition 'thumbnail' answers 404 no_rendition when there is none", async () => {
    db.renditions = new Map();
    const res = await post({ asset_version_id: VERSION_ID, rendition: 'thumbnail' });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'no_rendition' });
    expect(presign).not.toHaveBeenCalled();
  });

  it("rendition 'thumbnail' answers 403 for a library non-member", async () => {
    db.members = new Set();
    const res = await post({ asset_version_id: VERSION_ID, rendition: 'thumbnail' });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('forbidden');
    expect(presign).not.toHaveBeenCalled();
    expect(db.calls).not.toContain('asset_renditions');
  });

  it("rendition 'thumbnail' answers 403 for a chat file the caller cannot read", async () => {
    db.version = versionRow('chat', 'pdf', PDF_KEY, 'application/pdf');
    const res = await post({ asset_version_id: VERSION_ID, rendition: 'thumbnail' });
    expect(res.status).toBe(403);
    expect(db.calls).toContain('rpc:chat_attachment_readable');
    expect(db.calls).not.toContain('workspace_members');
    expect(presign).not.toHaveBeenCalled();
  });

  it('stream pipes the PDF with Range passed through and 206 passed back', async () => {
    const upstream = upstreamResponse(206, {
      'Content-Range': 'bytes 0-7/1000',
      'Content-Length': '8',
    });
    const fetchSpy = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      () => Promise.resolve(upstream),
    );
    vi.stubGlobal('fetch', fetchSpy);
    const res = await post(
      { asset_version_id: VERSION_ID, stream: true },
      { Range: 'bytes=0-7', Origin: 'https://srtd.io' },
    );
    expect(res.status).toBe(206);
    expect(res.body).toBe(upstream.body);
    expect(res.headers.get('Content-Type')).toBe('application/pdf');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(res.headers.get('Content-Range')).toBe('bytes 0-7/1000');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://srtd.io');
    expect(res.headers.get('Access-Control-Expose-Headers')).toContain('Content-Range');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] ?? [];
    expect(String(url)).toContain(`/${BUCKET}/pdf/aaaa/v1-brief.pdf?`);
    expect(new Headers(init?.headers).get('Range')).toBe('bytes=0-7');
    expect(await res.text()).toBe('%PDF-1.7');
  });

  it('stream answers 403 for a non-member without fetching', async () => {
    db.members = new Set();
    const fetchSpy = vi.fn(() => Promise.resolve(upstreamResponse(200)));
    vi.stubGlobal('fetch', fetchSpy);
    const res = await post({ asset_version_id: VERSION_ID, stream: true });
    expect(res.status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(presign).not.toHaveBeenCalled();
  });

  it('stream answers 400 for a non-PDF version without fetching', async () => {
    db.version = versionRow('library', 'image', R2_KEY, 'image/jpeg');
    const fetchSpy = vi.fn(() => Promise.resolve(upstreamResponse(200)));
    vi.stubGlobal('fetch', fetchSpy);
    const res = await post({ asset_version_id: VERSION_ID, stream: true });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('bad_request');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  const badBodies: ReadonlyArray<[string, Record<string, unknown>]> = [
    ['an unknown rendition', { rendition: 'full' }],
    ['a non-string rendition', { rendition: true }],
    ['a non-boolean stream', { stream: 'yes' }],
    ['a numeric stream', { stream: 1 }],
    ['rendition and stream together', { rendition: 'thumbnail', stream: true }],
    ['rendition with disposition', { rendition: 'thumbnail', disposition: 'inline' }],
    ['stream with disposition', { stream: true, disposition: 'attachment' }],
  ];
  for (const [label, extra] of badBodies) {
    it(`answers 400 for ${label} before any lookup`, async () => {
      const res = await post({ asset_version_id: VERSION_ID, ...extra });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('bad_request');
      expect(db.calls).toEqual([]);
      expect(presign).not.toHaveBeenCalled();
    });
  }
});
