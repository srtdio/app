import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair, type JWK, type KeyLike } from 'jose';

// jose's Node build resolves a remote JWKS via node:http, so we mock the
// remote-JWKS constructor to serve a local public key instead. ES256 signature
// verification itself stays real. Mirrors chat-token.test.ts.
const mockedJwks = vi.hoisted(() => ({ keys: [] as JWK[] }));
vi.mock('jose', async (importOriginal) => {
  const actual = await importOriginal<typeof import('jose')>();
  return {
    ...actual,
    createRemoteJWKSet: () => actual.createLocalJWKSet(mockedJwks),
  };
});

import worker, { type ChatTranscribeEnv } from './chat-transcribe';

const USER = '33333333-3333-7333-8333-333333333333';
const SUPABASE_URL = 'https://test.supabase.co';
const KID = 'test-es256-key';

/** A mock Workers AI binding whose run() returns the configured transcript. */
function aiReturning(text: unknown): ChatTranscribeEnv['AI'] {
  return { run: vi.fn(() => Promise.resolve({ text } as { text: string })) };
}

function makeEnv(ai: ChatTranscribeEnv['AI']): ChatTranscribeEnv {
  return { SUPABASE_URL, AI: ai };
}

let signingKey: KeyLike;

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
  signingKey = privateKey;
  const publicJwk: JWK = { ...(await exportJWK(publicKey)), alg: 'ES256', use: 'sig', kid: KID };
  mockedJwks.keys = [publicJwk];
});

afterEach(() => {
  vi.restoreAllMocks();
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

function audioRequest(token: string | null, body: BodyInit | null): Request {
  const headers = new Headers({ 'content-type': 'audio/webm' });
  if (token !== null) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  return new Request('https://worker.test/', { method: 'POST', headers, body });
}

describe('chat-transcribe worker.fetch', () => {
  it('returns { ok: true, transcript } from the AI text for a valid request', async () => {
    const token = await mintToken(USER);
    const ai = aiReturning('namaste, this is the note');
    const res = await worker.fetch(audioRequest(token, new Uint8Array([1, 2, 3, 4])), makeEnv(ai));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; transcript: string };
    expect(body.ok).toBe(true);
    expect(body.transcript).toBe('namaste, this is the note');
    expect(ai.run).toHaveBeenCalledOnce();
  });

  it('returns 401 when the bearer token is absent', async () => {
    const ai = aiReturning('should not run');
    const res = await worker.fetch(audioRequest(null, new Uint8Array([1, 2, 3])), makeEnv(ai));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(false);
    // An unauthenticated caller never reaches the AI binding.
    expect(ai.run).not.toHaveBeenCalled();
  });

  it('returns 401 for an invalid token', async () => {
    const ai = aiReturning('should not run');
    const res = await worker.fetch(audioRequest('not-a-real-jwt', new Uint8Array([9])), makeEnv(ai));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(false);
    expect(ai.run).not.toHaveBeenCalled();
  });

  it('returns 400 for an empty body', async () => {
    const token = await mintToken(USER);
    const ai = aiReturning('should not run');
    const res = await worker.fetch(audioRequest(token, null), makeEnv(ai));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(false);
    expect(ai.run).not.toHaveBeenCalled();
  });

  it('returns 500 when the AI binding throws', async () => {
    const token = await mintToken(USER);
    const ai: ChatTranscribeEnv['AI'] = {
      run: vi.fn(() => Promise.reject(new Error('inference unavailable'))),
    };
    const res = await worker.fetch(audioRequest(token, new Uint8Array([1, 2])), makeEnv(ai));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(false);
  });

  it('returns 405 for an unsupported verb', async () => {
    const ai = aiReturning('should not run');
    const res = await worker.fetch(new Request('https://worker.test/', { method: 'GET' }), makeEnv(ai));
    expect(res.status).toBe(405);
    expect(ai.run).not.toHaveBeenCalled();
  });
});
