import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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

// Shared mock state: who is an active member of which workspace.
const state = vi.hoisted(() => ({ members: new Set<string>() }));

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

import worker, { serializeError, type ChatTokenEnv } from './chat-token';
import { toAgoraUsername } from './agora-identity';

const USER = '33333333-3333-7333-8333-333333333333';
const WORKSPACE = '11111111-1111-7111-8111-111111111111';
const SUPABASE_URL = 'https://test.supabase.co';
const KID = 'test-es256-key';

// Dummy, non-secret Agora credentials: agora-token signs locally, so any string
// yields a verifiable token shape without touching a real certificate.
const env: ChatTokenEnv = {
  AGORA_APP_ID: 'a'.repeat(32),
  AGORA_APP_CERTIFICATE: 'b'.repeat(32),
  AGORA_CHAT_APP_KEY: 'org#app',
  AGORA_CHAT_REST_URL: 'https://chat.example/org/app',
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
});

afterEach(() => {
  vi.unstubAllGlobals();
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

function tokenRequest(token: string | null, body: unknown): Request {
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

/** Stub the outbound Agora register call with the given response. */
function stubAgora(response: Response): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(() => Promise.resolve(response));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('chat-token worker.fetch', () => {
  it('returns 401 when the bearer token is absent', async () => {
    const res = await worker.fetch(tokenRequest(null, { workspace_id: WORKSPACE }), env);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('unauthorized');
  });

  it('returns 401 for an invalid token', async () => {
    const res = await worker.fetch(
      tokenRequest('not-a-real-jwt', { workspace_id: WORKSPACE }),
      env,
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('unauthorized');
  });

  it('returns 400 when workspace_id is malformed', async () => {
    const token = await mintToken(USER);
    state.members.add(`${USER}:${WORKSPACE}`);
    const res = await worker.fetch(tokenRequest(token, { workspace_id: 'not-a-uuid' }), env);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('bad_request');
    expect(body.error.message).toBe('Invalid workspace_id.');
  });

  it('returns 403 when the caller is not a member of the workspace', async () => {
    const token = await mintToken(USER);
    const fetchMock = stubAgora(new Response(null, { status: 200 }));
    // state.members intentionally empty.
    const res = await worker.fetch(tokenRequest(token, { workspace_id: WORKSPACE }), env);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('forbidden');
    // A non-member never reaches the Agora register call.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('mints a 24h token for a member and derives the Agora username from the JWT sub', async () => {
    const token = await mintToken(USER);
    state.members.add(`${USER}:${WORKSPACE}`);
    stubAgora(new Response(JSON.stringify({ entities: [{ username: USER }] }), { status: 200 }));

    const before = Date.now();
    const res = await worker.fetch(tokenRequest(token, { workspace_id: WORKSPACE }), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      token: string;
      expires_at: string;
      agora_username: string;
      app_key: string;
    };
    expect(body.token).not.toBe('');
    // Agora rejects UUID-shaped names, so the username is the derived form.
    expect(body.agora_username).toBe(toAgoraUsername(USER));
    expect(body.agora_username).not.toBe(USER);
    expect(body.app_key).toBe(env.AGORA_CHAT_APP_KEY);

    // expires_at is ~24h ahead of now.
    const ttlMs = new Date(body.expires_at).getTime() - before;
    expect(ttlMs).toBeGreaterThan(86_400_000 - 5_000);
    expect(ttlMs).toBeLessThan(86_400_000 + 5_000);
  });

  it('treats an Agora "already exists" register response as success', async () => {
    const token = await mintToken(USER);
    state.members.add(`${USER}:${WORKSPACE}`);
    stubAgora(
      new Response(
        JSON.stringify({
          error: 'duplicate_unique_property_exists',
          error_description: `username '${USER}' already exists`,
        }),
        { status: 400 },
      ),
    );

    const res = await worker.fetch(tokenRequest(token, { workspace_id: WORKSPACE }), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agora_username: string };
    expect(body.agora_username).toBe(toAgoraUsername(USER));
  });

  it('returns 500 when the Agora register call fails for another reason', async () => {
    const token = await mintToken(USER);
    state.members.add(`${USER}:${WORKSPACE}`);
    stubAgora(new Response('upstream down', { status: 503 }));

    const res = await worker.fetch(tokenRequest(token, { workspace_id: WORKSPACE }), env);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('internal_error');
  });

  it('returns 405 for an unsupported verb', async () => {
    const res = await worker.fetch(new Request('https://worker.test/', { method: 'GET' }), env);
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
        headers: { Origin: 'https://srtd.io', 'content-type': 'application/json' },
        body: JSON.stringify({ workspace_id: WORKSPACE }),
      }),
      env,
    );
    expect(res.status).toBe(401);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://srtd.io');
    expect(res.headers.get('Vary')).toBe('Origin');
  });
});

describe('serializeError', () => {
  it('serializes a plain Agora-style object into a string with code and message', () => {
    const out = serializeError({ code: 'duplicate_unique_property_exists', message: 'exists' });
    expect(out).toContain('duplicate_unique_property_exists');
    expect(out).toContain('exists');
  });

  it('serializes an Error using its name and message', () => {
    const out = serializeError(new TypeError('boom'));
    expect(out).toContain('TypeError');
    expect(out).toContain('boom');
  });
});
