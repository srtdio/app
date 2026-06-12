import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair, type JWK, type KeyLike } from 'jose';

// jose's Node build resolves a remote JWKS via node:http, so we mock the
// remote-JWKS constructor to serve a local public key instead. ES256 signature
// verification itself stays real. Mirrors asset-read.test.ts.
const mockedJwks = vi.hoisted(() => ({ keys: [] as JWK[] }));
vi.mock('jose', async (importOriginal) => {
  const actual = await importOriginal<typeof import('jose')>();
  return {
    ...actual,
    createRemoteJWKSet: () => actual.createLocalJWKSet(mockedJwks),
  };
});

// Shared mock state: who is a member, and the input the (mocked) pipeline saw.
const state = vi.hoisted(() => ({
  members: new Set<string>(),
  capturedInput: null as Record<string, unknown> | null,
}));

// Substitute the service-role membership store with an in-memory set; keep the
// real verifyCaller / getSupabaseJwks (which use the mocked JWKS).
vi.mock('./asset-read', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./asset-read')>();
  return {
    ...actual,
    createSupabaseAssetReadStore: () => ({
      findVersion: () => Promise.resolve(null),
      isActiveMember: ({ userId, workspaceId }: { userId: string; workspaceId: string }) =>
        Promise.resolve(state.members.has(`${userId}:${workspaceId}`)),
    }),
  };
});

// Replace only runUploadPipeline so we can assert the actor it receives without
// touching R2 or Supabase; everything else in the module stays real.
vi.mock('@/server/assets', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/assets')>();
  return {
    ...actual,
    runUploadPipeline: (_deps: unknown, input: Record<string, unknown>) => {
      state.capturedInput = input;
      return Promise.resolve({
        ok: true,
        value: {
          assetId: 'aaaa',
          versionId: 'vvvv',
          versionNumber: 1,
          workspaceId: input.workspaceId,
          filename: input.filename,
          mimeType: input.contentType,
          sizeBytes: 3,
          sha256: 'deadbeef',
          r2Key: 'documents/aaaa/v1-doc.pdf',
          reused: false,
        },
      });
    },
  };
});

import worker, { serializeError, type AssetUploadEnv } from './asset-upload';

const USER = '33333333-3333-7333-8333-333333333333';
const OTHER_USER = '44444444-4444-7444-8444-444444444444';
const WORKSPACE = '11111111-1111-7111-8111-111111111111';
const SUPABASE_URL = 'https://test.supabase.co';
const KID = 'test-es256-key';

const env: AssetUploadEnv = {
  CLOUDFLARE_ACCOUNT_ID: 'acct',
  CLOUDFLARE_R2_ACCESS_KEY_ID: 'akid',
  CLOUDFLARE_R2_SECRET_ACCESS_KEY: 'secret',
  SUPABASE_URL,
  SUPABASE_SECRET_KEY: 'service-role-key',
};

let signingKey: KeyLike;

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
  signingKey = privateKey;
  const publicJwk: JWK = { ...(await exportJWK(publicKey)), alg: 'ES256', use: 'sig', kid: KID };
  mockedJwks.keys = [publicJwk];
});

beforeEach(() => {
  state.members.clear();
  state.capturedInput = null;
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

function uploadRequest(token: string | null, fields: Record<string, string>): Request {
  const form = new FormData();
  form.set(
    'file',
    new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], 'doc.pdf', {
      type: 'application/pdf',
    }),
  );
  for (const [key, value] of Object.entries(fields)) {
    form.set(key, value);
  }
  const headers = new Headers();
  if (token !== null) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  return new Request('https://worker.test/', { method: 'POST', headers, body: form });
}

function readRequest(token: string | null, query: Record<string, string>): Request {
  const url = new URL('https://worker.test/');
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }
  const headers = new Headers();
  if (token !== null) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  return new Request(url, { method: 'GET', headers });
}

describe('asset-upload worker.fetch', () => {
  it('returns 401 when the bearer token is absent', async () => {
    const res = await worker.fetch(uploadRequest(null, { workspace_id: WORKSPACE }), env);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('unauthorized');
  });

  it('returns 401 for an invalid token', async () => {
    const res = await worker.fetch(
      uploadRequest('not-a-real-jwt', { workspace_id: WORKSPACE }),
      env,
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('unauthorized');
  });

  it('returns 403 when the caller is not a member of the workspace', async () => {
    const token = await mintToken(USER);
    // state.members intentionally empty.
    const res = await worker.fetch(uploadRequest(token, { workspace_id: WORKSPACE }), env);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('forbidden');
    // The non-member never reaches the pipeline.
    expect(state.capturedInput).toBeNull();
  });

  it('returns 405 for an unsupported verb', async () => {
    const res = await worker.fetch(new Request('https://worker.test/', { method: 'PUT' }), env);
    expect(res.status).toBe(405);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('method_not_allowed');
  });

  it('still returns 405 for DELETE after CORS handling is added', async () => {
    const res = await worker.fetch(new Request('https://worker.test/', { method: 'DELETE' }), env);
    expect(res.status).toBe(405);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('method_not_allowed');
  });

  it('answers OPTIONS preflight with 204 + CORS headers and no auth', async () => {
    const res = await worker.fetch(
      new Request('https://worker.test/', {
        method: 'OPTIONS',
        // No Authorization header: preflight must precede auth.
        headers: { Origin: 'https://srtd.io' },
      }),
      env,
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://srtd.io');
    const methods = res.headers.get('Access-Control-Allow-Methods') ?? '';
    expect(methods).toContain('POST');
    expect(methods).toContain('GET');
    expect(methods).toContain('OPTIONS');
    const allowHeaders = (res.headers.get('Access-Control-Allow-Headers') ?? '').toLowerCase();
    expect(allowHeaders).toContain('authorization');
    expect(allowHeaders).toContain('content-type');
    expect(res.headers.get('Access-Control-Max-Age')).toBe('86400');
  });

  it('falls back to the primary origin when OPTIONS Origin is not allowed', async () => {
    const res = await worker.fetch(
      new Request('https://worker.test/', {
        method: 'OPTIONS',
        headers: { Origin: 'https://evil.example' },
      }),
      env,
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://srtdio-app.pages.dev');
  });

  it('attaches CORS headers to the 401 error path for an allowed origin', async () => {
    const res = await worker.fetch(
      new Request('https://worker.test/', {
        method: 'POST',
        // No bearer token -> 401, but an allowed Origin must still be echoed.
        headers: { Origin: 'https://srtd.io' },
        body: new FormData(),
      }),
      env,
    );
    expect(res.status).toBe(401);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://srtd.io');
    expect(res.headers.get('Vary')).toBe('Origin');
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('unauthorized');
  });

  it('ignores uploaded_by in the form: the actor is the verified token sub', async () => {
    const token = await mintToken(USER);
    state.members.add(`${USER}:${WORKSPACE}`);
    const res = await worker.fetch(
      // A forged uploaded_by must not be honored.
      uploadRequest(token, { workspace_id: WORKSPACE, uploaded_by: OTHER_USER }),
      env,
    );
    expect(res.status).toBe(201);
    expect(state.capturedInput?.uploadedBy).toBe(USER);
    expect(state.capturedInput?.uploadedBy).not.toBe(OTHER_USER);
  });

  it('returns 400 (not 500) when asset_id is not a UUID on GET', async () => {
    const token = await mintToken(USER);
    state.members.add(`${USER}:${WORKSPACE}`);
    const res = await worker.fetch(
      readRequest(token, { workspace_id: WORKSPACE, asset_id: 'undefined' }),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('bad_request');
    expect(body.error.message).toBe('Invalid id format.');
  });

  it('returns 400 when workspace_id is malformed on POST', async () => {
    const token = await mintToken(USER);
    state.members.add(`${USER}:${WORKSPACE}`);
    const res = await worker.fetch(uploadRequest(token, { workspace_id: 'not-a-uuid' }), env);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('bad_request');
    expect(body.error.message).toBe('Invalid id format.');
    // Validation happens before the pipeline runs.
    expect(state.capturedInput).toBeNull();
  });
});

describe('serializeError', () => {
  it('serializes a plain PostgREST-style object into a string with code and message', () => {
    const out = serializeError({ code: '23505', message: 'duplicate key value', hint: null });
    expect(out).toContain('23505');
    expect(out).toContain('duplicate key value');
  });

  it('serializes an Error using its name and message', () => {
    const out = serializeError(new TypeError('boom'));
    expect(out).toContain('TypeError');
    expect(out).toContain('boom');
  });
});
