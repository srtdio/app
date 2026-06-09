import { describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';
import worker, {
  authorizeAndSign,
  verifyCaller,
  type AssetReadEnv,
  type AssetReadStore,
  type AssetVersionLocator,
  type PresignedUrlSigner,
} from './asset-read';

const JWT_SECRET = 'test-secret-with-at-least-32-characters-long-xx';
const SECRET_BYTES = new TextEncoder().encode(JWT_SECRET);

const USER = '33333333-3333-7333-8333-333333333333';
const OTHER_USER = '44444444-4444-7444-8444-444444444444';
const WORKSPACE = '11111111-1111-7111-8111-111111111111';
const VERSION_ID = '55555555-5555-7555-8555-555555555555';
const R2_KEY = `${WORKSPACE}/aaaa/1/photo.jpg`;

async function mintToken(sub: string, expSecondsFromNow = 3600): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(sub)
    .setIssuedAt(nowSec)
    .setExpirationTime(nowSec + expSecondsFromNow)
    .sign(SECRET_BYTES);
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

const located: AssetVersionLocator = { workspaceId: WORKSPACE, r2Key: R2_KEY };
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

describe('verifyCaller', () => {
  it('rejects a missing Authorization header with 401', async () => {
    const result = await verifyCaller(bearerRequest(null), JWT_SECRET);
    expect(result).toEqual({
      ok: false,
      error: { code: 'unauthorized', message: expect.any(String) },
    });
  });

  it('rejects a malformed token with 401', async () => {
    const result = await verifyCaller(bearerRequest('not-a-real-jwt'), JWT_SECRET);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('unauthorized');
    }
  });

  it('rejects an expired token with 401', async () => {
    const token = await mintToken(USER, -10);
    const result = await verifyCaller(bearerRequest(token), JWT_SECRET);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('unauthorized');
    }
  });

  it('rejects a token signed with the wrong secret with 401', async () => {
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(USER)
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode('a-totally-different-secret-32-characters'));
    const result = await verifyCaller(bearerRequest(token), JWT_SECRET);
    expect(result.ok).toBe(false);
  });

  it('accepts a valid token and returns the sub claim', async () => {
    const token = await mintToken(USER);
    const result = await verifyCaller(bearerRequest(token), JWT_SECRET);
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
    // Bucket + key are resolved from the workspace and stored r2_key, 15 min TTL.
    expect(signer.calls).toEqual([
      { bucket: `assets-${WORKSPACE}`, key: R2_KEY, expiresInSeconds: 900 },
    ]);
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

describe('worker.fetch', () => {
  const env: AssetReadEnv = {
    CLOUDFLARE_ACCOUNT_ID: 'acct',
    CLOUDFLARE_R2_ACCESS_KEY_ID: 'akid',
    CLOUDFLARE_R2_SECRET_ACCESS_KEY: 'secret',
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_SECRET_KEY: 'service-role-key',
    SUPABASE_JWT_SECRET: JWT_SECRET,
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
