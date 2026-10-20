import { afterEach, beforeAll, describe, expect, it, vi, type MockInstance } from 'vitest';
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

import worker, {
  DAILY_CAP_BYTES,
  MAX_AUDIO_BYTES,
  parseAudioUrl,
  usageKey,
  type ChatTranscribeEnv,
  type UsageKv,
} from './chat-transcribe';

const USER = '33333333-3333-7333-8333-333333333333';
const SUPABASE_URL = 'https://test.supabase.co';
const KID = 'test-es256-key';
const ACCOUNT = '0123456789abcdef0123456789abcdef';
const R2_HOST = `${ACCOUNT}.r2.cloudflarestorage.com`;
const AUDIO_URL = `https://${R2_HOST}/assets-ws/voice/1.webm?X-Amz-Signature=secret-sig`;

/** A mock Workers AI binding whose run() returns the configured transcript. */
function aiReturning(text: unknown): ChatTranscribeEnv['AI'] {
  return { run: vi.fn(() => Promise.resolve({ text } as { text: string })) };
}

function makeEnv(ai: ChatTranscribeEnv['AI']): ChatTranscribeEnv {
  return { SUPABASE_URL, CLOUDFLARE_ACCOUNT_ID: ACCOUNT, AI: ai };
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

/** An in-memory KV namespace for the daily byte counter. */
function memoryKv(initial: Record<string, string> = {}): UsageKv & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    get: vi.fn((key: string) => Promise.resolve(data.get(key) ?? null)),
    put: vi.fn((key: string, value: string) => {
      data.set(key, value);
      return Promise.resolve();
    }),
  };
}

/** A JSON transcribe request carrying `body` (a { url } object by default). */
function transcribeRequest(
  token: string | null,
  body: unknown = { url: AUDIO_URL },
  contentType = 'application/json',
): Request {
  const headers = new Headers({ 'content-type': contentType });
  if (token !== null) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  return new Request('https://worker.test/', { method: 'POST', headers, body: raw });
}

/** Stub the global fetch the worker uses for R2 with a canned audio response. */
function upstream(
  bytes: BodyInit | null,
  init: { status?: number; contentType?: string; headers?: Record<string, string> } = {},
): MockInstance<typeof fetch> {
  const response = new Response(bytes, {
    status: init.status ?? 200,
    headers: { 'content-type': init.contentType ?? 'audio/webm', ...init.headers },
  });
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);
}

async function expectBadUrl(res: Response): Promise<void> {
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({ ok: false, reason: 'bad_url' });
}

describe('chat-transcribe worker.fetch', () => {
  it('fetches the presigned URL itself and returns { ok: true, transcript }', async () => {
    const token = await mintToken(USER);
    const r2 = upstream(new Uint8Array([1, 2, 3, 4]));
    const ai = aiReturning('namaste, this is the note');
    const res = await worker.fetch(transcribeRequest(token), makeEnv(ai));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, transcript: 'namaste, this is the note' });
    expect(ai.run).toHaveBeenCalledOnce();
    expect(r2).toHaveBeenCalledOnce();
    const [input, init] = r2.mock.calls[0] as [string, RequestInit];
    expect(input).toBe(AUDIO_URL);
    expect(init.method).toBe('GET');
    expect(init.redirect).toBe('manual');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(new Headers(init.headers).get('X-Trace-Id')).not.toBeNull();
  });

  it('returns 401 when the bearer token is absent, before any fetch', async () => {
    const r2 = upstream(new Uint8Array([1]));
    const ai = aiReturning('should not run');
    const res = await worker.fetch(transcribeRequest(null), makeEnv(ai));
    expect(res.status).toBe(401);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(false);
    expect(r2).not.toHaveBeenCalled();
    expect(ai.run).not.toHaveBeenCalled();
  });

  it('returns 401 for an invalid token', async () => {
    const r2 = upstream(new Uint8Array([1]));
    const ai = aiReturning('should not run');
    const res = await worker.fetch(transcribeRequest('not-a-real-jwt'), makeEnv(ai));
    expect(res.status).toBe(401);
    expect(r2).not.toHaveBeenCalled();
    expect(ai.run).not.toHaveBeenCalled();
  });

  it('returns 415 unless the request is application/json', async () => {
    const token = await mintToken(USER);
    const r2 = upstream(new Uint8Array([1]));
    const ai = aiReturning('should not run');
    for (const type of ['audio/webm', 'text/plain', 'application/octet-stream']) {
      const res = await worker.fetch(transcribeRequest(token, undefined, type), makeEnv(ai));
      expect(res.status).toBe(415);
    }
    const ok = await worker.fetch(
      transcribeRequest(token, undefined, 'application/json; charset=utf-8'),
      makeEnv(ai),
    );
    expect(ok.status).toBe(200);
    expect(r2).toHaveBeenCalledOnce();
  });

  it('returns 400 when the body is not { url: string }', async () => {
    const token = await mintToken(USER);
    const r2 = upstream(new Uint8Array([1]));
    const ai = aiReturning('should not run');
    for (const body of ['not json', '', 'null', '[]', { url: 42 }, { href: AUDIO_URL }]) {
      const res = await worker.fetch(transcribeRequest(token, body), makeEnv(ai));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ ok: false, code: 'bad_request' });
    }
    expect(r2).not.toHaveBeenCalled();
  });

  it.each([
    ['http', `http://${R2_HOST}/b/k`],
    ['another host', 'https://example.com/b/k'],
    ['a host that only ends with the R2 suffix', `https://evil${R2_HOST}/b/k`],
    ['another account', 'https://ffffffffffffffffffffffffffffffff.r2.cloudflarestorage.com/b/k'],
    ['a subdomain of the R2 host', `https://bucket.${R2_HOST}/b/k`],
    ['the R2 host as a subdomain of another', `https://${R2_HOST}.evil.com/b/k`],
    ['userinfo', `https://user:pass@${R2_HOST}/b/k`],
    ['userinfo pointing elsewhere', `https://${R2_HOST}@evil.com/b/k`],
    ['a username only', `https://user@${R2_HOST}/b/k`],
    ['an explicit port', `https://${R2_HOST}:8443/b/k`],
    ['an IPv4 literal', 'https://127.0.0.1/b/k'],
    ['an IPv6 literal', 'https://[::1]/b/k'],
    ['a non-URL', 'not a url'],
    ['a relative path', '/b/k'],
  ])('returns 400 bad_url for %s, without fetching', async (_label, url) => {
    const token = await mintToken(USER);
    const r2 = upstream(new Uint8Array([1]));
    const ai = aiReturning('should not run');
    await expectBadUrl(await worker.fetch(transcribeRequest(token, { url }), makeEnv(ai)));
    expect(r2).not.toHaveBeenCalled();
    expect(ai.run).not.toHaveBeenCalled();
  });

  it('matches the R2 host case-insensitively (URL parsing lowercases hosts)', () => {
    expect(parseAudioUrl(`https://${R2_HOST.toUpperCase()}/b/k`, ACCOUNT)).not.toBeNull();
    expect(parseAudioUrl(`https://${R2_HOST}:443/b/k`, ACCOUNT)).not.toBeNull();
  });

  it('returns 400 bad_url when the upstream redirects, and never follows it', async () => {
    const token = await mintToken(USER);
    const r2 = upstream(null, { status: 302, headers: { location: 'http://169.254.169.254/' } });
    const ai = aiReturning('should not run');
    await expectBadUrl(await worker.fetch(transcribeRequest(token), makeEnv(ai)));
    expect(r2).toHaveBeenCalledOnce();
    expect(ai.run).not.toHaveBeenCalled();
  });

  it('returns 400 when the upstream refuses (an expired signature)', async () => {
    const token = await mintToken(USER);
    upstream('denied', { status: 403, contentType: 'application/xml' });
    const ai = aiReturning('should not run');
    const res = await worker.fetch(transcribeRequest(token), makeEnv(ai));
    expect(res.status).toBe(400);
    expect(ai.run).not.toHaveBeenCalled();
  });

  it('returns 415 when the upstream content type is not audio/*', async () => {
    const token = await mintToken(USER);
    upstream(new Uint8Array([1, 2, 3]), { contentType: 'text/html' });
    const ai = aiReturning('should not run');
    const res = await worker.fetch(transcribeRequest(token), makeEnv(ai));
    expect(res.status).toBe(415);
    expect(ai.run).not.toHaveBeenCalled();
  });

  it('accepts any audio/* type with parameters (audio/webm;codecs=opus)', async () => {
    const token = await mintToken(USER);
    upstream(new Uint8Array([1]), { contentType: 'audio/webm;codecs=opus' });
    const res = await worker.fetch(transcribeRequest(token), makeEnv(aiReturning('ok')));
    expect(res.status).toBe(200);
  });

  it('returns 413 from the upstream Content-Length alone when it declares more than 8 MB', async () => {
    const token = await mintToken(USER);
    upstream(new Uint8Array([1, 2, 3]), {
      headers: { 'content-length': String(MAX_AUDIO_BYTES + 1) },
    });
    const ai = aiReturning('should not run');
    const res = await worker.fetch(transcribeRequest(token), makeEnv(ai));
    expect(res.status).toBe(413);
    expect(ai.run).not.toHaveBeenCalled();
  });

  it('returns 413 when the upstream body runs past 8 MB (no Content-Length)', async () => {
    const token = await mintToken(USER);
    const chunk = new Uint8Array(1024 * 1024);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += 1;
        controller.enqueue(chunk);
        if (sent > 9) controller.close();
      },
    });
    upstream(stream);
    const ai = aiReturning('should not run');
    const res = await worker.fetch(transcribeRequest(token), makeEnv(ai));
    expect(res.status).toBe(413);
    expect(ai.run).not.toHaveBeenCalled();
  });

  it('accepts audio of exactly 8 MB', async () => {
    const token = await mintToken(USER);
    upstream(new Uint8Array(MAX_AUDIO_BYTES));
    const res = await worker.fetch(transcribeRequest(token), makeEnv(aiReturning('long note')));
    expect(res.status).toBe(200);
  });

  it('returns 400 for empty upstream audio', async () => {
    const token = await mintToken(USER);
    upstream(new Uint8Array(0));
    const ai = aiReturning('should not run');
    const res = await worker.fetch(transcribeRequest(token), makeEnv(ai));
    expect(res.status).toBe(400);
    expect(ai.run).not.toHaveBeenCalled();
  });

  it('returns 500 when the upstream fetch fails, without logging the signed query', async () => {
    const token = await mintToken(USER);
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error(`boom ${AUDIO_URL}`));
    const log = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const res = await worker.fetch(transcribeRequest(token), makeEnv(aiReturning('x')));
    expect(res.status).toBe(500);
    const logged = [...log.mock.calls, ...err.mock.calls, ...logSpy.mock.calls]
      .flat()
      .map(String)
      .join('\n');
    expect(logged).not.toContain('secret-sig');
  });

  it('returns 500 when CLOUDFLARE_ACCOUNT_ID is not configured', async () => {
    const token = await mintToken(USER);
    const r2 = upstream(new Uint8Array([1]));
    const res = await worker.fetch(transcribeRequest(token), {
      ...makeEnv(aiReturning('x')),
      CLOUDFLARE_ACCOUNT_ID: '',
    });
    expect(res.status).toBe(500);
    expect(r2).not.toHaveBeenCalled();
  });

  it('returns 500 when the AI binding throws', async () => {
    const token = await mintToken(USER);
    upstream(new Uint8Array([1, 2]));
    const ai: ChatTranscribeEnv['AI'] = {
      run: vi.fn(() => Promise.reject(new Error('inference unavailable'))),
    };
    const res = await worker.fetch(transcribeRequest(token), makeEnv(ai));
    expect(res.status).toBe(500);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(false);
  });

  it('returns 405 for an unsupported verb', async () => {
    const ai = aiReturning('should not run');
    const res = await worker.fetch(
      new Request('https://worker.test/', { method: 'GET' }),
      makeEnv(ai),
    );
    expect(res.status).toBe(405);
    expect(ai.run).not.toHaveBeenCalled();
  });

  it('counts the fetched bytes against the UTC day in KV on an ok transcription', async () => {
    const token = await mintToken(USER);
    upstream(new Uint8Array(1_000));
    const kv = memoryKv();
    const res = await worker.fetch(transcribeRequest(token), {
      ...makeEnv(aiReturning('counted')),
      TRANSCRIBE_USAGE: kv,
    });
    expect(res.status).toBe(200);
    expect(kv.data.get(usageKey(new Date()))).toBe('1000');
  });

  it('returns 429 { ok: false, reason: daily_cap } once the day is over 240 MB', async () => {
    const token = await mintToken(USER);
    upstream(new Uint8Array(11));
    const kv = memoryKv({ [usageKey(new Date())]: String(DAILY_CAP_BYTES - 10) });
    const ai = aiReturning('should not run');
    const res = await worker.fetch(transcribeRequest(token), {
      ...makeEnv(ai),
      TRANSCRIBE_USAGE: kv,
    });
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ ok: false, reason: 'daily_cap' });
    expect(ai.run).not.toHaveBeenCalled();
    expect(kv.data.get(usageKey(new Date()))).toBe(String(DAILY_CAP_BYTES - 10));
  });

  it('does not reflect the retired v2.srtd.io origin', async () => {
    const token = await mintToken(USER);
    upstream(new Uint8Array([1]));
    const req = transcribeRequest(token);
    req.headers.set('Origin', 'https://v2.srtd.io');
    const res = await worker.fetch(req, makeEnv(aiReturning('ok')));
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('keys the counter by UTC day', () => {
    expect(usageKey(new Date('2026-09-30T23:59:59.000Z'))).toBe('usage:2026-09-30');
    expect(usageKey(new Date('2026-10-01T00:00:00.000Z'))).toBe('usage:2026-10-01');
  });
});
