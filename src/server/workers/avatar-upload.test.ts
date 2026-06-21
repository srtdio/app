import { beforeAll, describe, expect, it, vi } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair, type JWK, type KeyLike } from 'jose';

// jose's Node build resolves a remote JWKS via node:http, so we mock the
// remote-JWKS constructor to serve a local public key instead. ES256 signature
// verification itself stays real. Mirrors asset-upload.test.ts.
const mockedJwks = vi.hoisted(() => ({ keys: [] as JWK[] }));
vi.mock('jose', async (importOriginal) => {
  const actual = await importOriginal<typeof import('jose')>();
  return {
    ...actual,
    createRemoteJWKSet: () => actual.createLocalJWKSet(mockedJwks),
  };
});

import worker, {
  handleAvatarUpload,
  MAX_AVATAR_BYTES,
  type AvatarUploadDeps,
  type AvatarUploadEnv,
} from './avatar-upload';
import { getSupabaseJwks, verifyCaller } from './asset-read';
import { computeSha256, type PutObjectInput } from '@srtdio/storage';

const USER = '33333333-3333-7333-8333-333333333333';
const OTHER_USER = '44444444-4444-7444-8444-444444444444';
const SUPABASE_URL = 'https://test.supabase.co';
const KID = 'test-es256-key';

const env: AvatarUploadEnv = {
  CLOUDFLARE_ACCOUNT_ID: 'acct',
  CLOUDFLARE_R2_ACCESS_KEY_ID: 'akid',
  CLOUDFLARE_R2_SECRET_ACCESS_KEY: 'secret',
  SUPABASE_URL,
  AVATAR_PUBLIC_BASE: 'https://cdn.srtd.io',
  AVATAR_BUCKET: 'user-avatars',
  ALLOWED_ORIGINS: 'https://srtd.io,https://srtdio-app.pages.dev',
};

// A real PNG signature (8-byte header) plus a little padding: a non-empty file
// whose leading bytes pass the magic-byte PNG check.
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);

let signingKey: KeyLike;
let pngSha: string;

/** Fake storage that records the single putObject call so the test can assert it. */
class FakeStorage {
  calls: PutObjectInput[] = [];
  putObject(input: PutObjectInput): Promise<void> {
    this.calls.push({ ...input, body: new Uint8Array(input.body) });
    return Promise.resolve();
  }
}

/** Production-shaped deps: a fake store plus the real verifyCaller/JWKS pair. */
function deps(storage: FakeStorage): AvatarUploadDeps {
  return {
    storage,
    verifyToken: (request) => verifyCaller(request, getSupabaseJwks(env)),
  };
}

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
  signingKey = privateKey;
  const publicJwk: JWK = { ...(await exportJWK(publicKey)), alg: 'ES256', use: 'sig', kid: KID };
  mockedJwks.keys = [publicJwk];
  pngSha = await computeSha256(PNG_BYTES);
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

/** Build a POST with the given file bytes (or no file part when null), plus extra fields. */
function uploadRequest(
  token: string | null,
  fileBytes: Uint8Array<ArrayBuffer> | null,
  extra: Record<string, string> = {},
): Request {
  const form = new FormData();
  if (fileBytes !== null) {
    form.set('file', new File([fileBytes], 'avatar.png', { type: 'image/png' }));
  }
  for (const [key, value] of Object.entries(extra)) {
    form.set(key, value);
  }
  const headers = new Headers();
  if (token !== null) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  return new Request('https://worker.test/', { method: 'POST', headers, body: form });
}

describe('avatar-upload handler', () => {
  it('stores a valid PNG and returns 200 with the userId/sha256 url and key', async () => {
    const token = await mintToken(USER);
    const storage = new FakeStorage();
    const res = await handleAvatarUpload(
      uploadRequest(token, PNG_BYTES),
      env,
      deps(storage),
      'trace-1',
      null,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { avatar_url: string };
    const expectedKey = `${USER}/${pngSha}.png`;
    expect(body.avatar_url).toBe(`https://cdn.srtd.io/${expectedKey}`);
    // The URL path equals the R2 key exactly.
    expect(new URL(body.avatar_url).pathname).toBe(`/${expectedKey}`);
    // putObject was called once with that key, the configured bucket, png type.
    expect(storage.calls).toHaveLength(1);
    expect(storage.calls[0]?.key).toBe(expectedKey);
    expect(storage.calls[0]?.bucket).toBe('user-avatars');
    expect(storage.calls[0]?.contentType).toBe('image/png');
  });

  it('derives userId from the token sub, never the request body', async () => {
    const token = await mintToken(USER);
    const storage = new FakeStorage();
    // Forged ids in the body must be ignored; only the verified sub wins.
    const res = await handleAvatarUpload(
      uploadRequest(token, PNG_BYTES, { user_id: OTHER_USER, userId: OTHER_USER }),
      env,
      deps(storage),
      'trace-2',
      null,
    );
    expect(res.status).toBe(200);
    expect(storage.calls[0]?.key.startsWith(`${USER}/`)).toBe(true);
    expect(storage.calls[0]?.key.startsWith(`${OTHER_USER}/`)).toBe(false);
  });

  it('returns 401 when the bearer token is absent', async () => {
    const storage = new FakeStorage();
    const res = await handleAvatarUpload(
      uploadRequest(null, PNG_BYTES),
      env,
      deps(storage),
      'trace-3',
      null,
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('unauthorized');
    expect(storage.calls).toHaveLength(0);
  });

  it('returns 401 for an invalid token', async () => {
    const storage = new FakeStorage();
    const res = await handleAvatarUpload(
      uploadRequest('not-a-real-jwt', PNG_BYTES),
      env,
      deps(storage),
      'trace-4',
      null,
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('unauthorized');
    expect(storage.calls).toHaveLength(0);
  });

  it('returns 415 for non-PNG bytes (a JPEG claimed as png)', async () => {
    const token = await mintToken(USER);
    const storage = new FakeStorage();
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    const res = await handleAvatarUpload(
      uploadRequest(token, jpeg),
      env,
      deps(storage),
      'trace-5',
      null,
    );
    expect(res.status).toBe(415);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('unsupported_format');
    expect(storage.calls).toHaveLength(0);
  });

  it('returns 400 for an empty file', async () => {
    const token = await mintToken(USER);
    const storage = new FakeStorage();
    const res = await handleAvatarUpload(
      uploadRequest(token, new Uint8Array(0)),
      env,
      deps(storage),
      'trace-6',
      null,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('empty_file');
    expect(storage.calls).toHaveLength(0);
  });

  it('returns 400 when the file part is missing', async () => {
    const token = await mintToken(USER);
    const storage = new FakeStorage();
    const res = await handleAvatarUpload(
      uploadRequest(token, null),
      env,
      deps(storage),
      'trace-7',
      null,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('missing_file');
    expect(storage.calls).toHaveLength(0);
  });

  it('returns 413 when the file exceeds MAX_AVATAR_BYTES', async () => {
    const token = await mintToken(USER);
    const storage = new FakeStorage();
    const oversize = new Uint8Array(MAX_AVATAR_BYTES + 1);
    oversize.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const res = await handleAvatarUpload(
      uploadRequest(token, oversize),
      env,
      deps(storage),
      'trace-8',
      null,
    );
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('too_large');
    expect(storage.calls).toHaveLength(0);
  });
});

describe('avatar-upload worker.fetch', () => {
  it('answers OPTIONS preflight with 204 + CORS headers and no auth', async () => {
    const res = await worker.fetch(
      new Request('https://worker.test/', {
        method: 'OPTIONS',
        headers: { Origin: 'https://srtd.io' },
      }),
      env,
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://srtd.io');
    const methods = res.headers.get('Access-Control-Allow-Methods') ?? '';
    expect(methods).toContain('POST');
    expect(methods).toContain('OPTIONS');
    const allowHeaders = (res.headers.get('Access-Control-Allow-Headers') ?? '').toLowerCase();
    expect(allowHeaders).toContain('authorization');
    expect(allowHeaders).toContain('content-type');
    expect(res.headers.get('Access-Control-Max-Age')).toBe('86400');
  });

  it('returns 405 for an unsupported verb', async () => {
    const res = await worker.fetch(new Request('https://worker.test/', { method: 'PUT' }), env);
    expect(res.status).toBe(405);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('method_not_allowed');
  });
});
