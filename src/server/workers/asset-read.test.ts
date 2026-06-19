import { beforeAll, describe, expect, it, vi } from 'vitest';
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

import worker, {
  authorizeAndSign,
  getSupabaseJwks,
  verifyCaller,
  type AssetReadEnv,
  type AssetReadStore,
  type AssetVersionLocator,
  type PresignedUrlSigner,
} from './asset-read';

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
  constructor(
    private readonly version: AssetVersionLocator | null,
    private readonly members: ReadonlySet<string>,
  ) {}
  findVersion(): Promise<AssetVersionLocator | null> {
    return Promise.resolve(this.version);
  }
  isActiveMember(input: { userId: string; workspaceId: string }): Promise<boolean> {
    return Promise.resolve(this.members.has(`${input.userId}:${input.workspaceId}`));
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
