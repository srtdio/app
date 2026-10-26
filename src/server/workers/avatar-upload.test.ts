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
  CLEANUP_CHECK_DELAYS_MS,
  canManageGroupAsCaller,
  createCallerProfileStore,
  handleAvatarUpload,
  MAX_AVATAR_BYTES,
  ownAvatarKey,
  type AvatarUploadDeps,
  type AvatarUploadEnv,
  type ProfileAvatarStore,
  type SavedProfile,
} from './avatar-upload';
import { getSupabaseJwks, verifyCaller } from './asset-read';
import { computeSha256, type PutObjectInput } from '@srtdio/storage';
import { ole2, svg } from '../../../packages/storage/src/__fixtures__/files';

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

/** Fake storage that records putObject / deleteObject calls in order. */
class FakeStorage {
  calls: PutObjectInput[] = [];
  deletes: { bucket: string; key: string; traceId: string }[] = [];
  /** Shared ordered log across storage and profile fakes. */
  log: string[] = [];
  failPut = false;
  failDelete = false;
  putObject(input: PutObjectInput): Promise<void> {
    if (this.failPut) return Promise.reject(new Error('r2 put failed'));
    this.log.push(`put:${input.key}`);
    this.calls.push({ ...input, body: new Uint8Array(input.body) });
    return Promise.resolve();
  }
  deleteObject(bucket: string, key: string, traceId: string): Promise<void> {
    this.log.push(`delete:${key}`);
    this.deletes.push({ bucket, key, traceId });
    if (this.failDelete) return Promise.reject(new Error('r2 delete failed'));
    return Promise.resolve();
  }
}

/** A caller with no saved avatar: the default, so no cleanup ever runs. */
const NO_PROFILE: ProfileAvatarStore = {
  read: () => Promise.resolve(null),
};

/** Background work the handler schedules (ctx.waitUntil), awaited by tests. */
const pending: Promise<unknown>[] = [];
async function settle(): Promise<void> {
  while (pending.length > 0) await pending.shift();
}

/** A ctx stand-in for worker.fetch. */
const ctx = { waitUntil: (work: Promise<unknown>) => void pending.push(work) };

/** Production-shaped deps: a fake store plus the real verifyCaller/JWKS pair. */
function deps(storage: FakeStorage, profile: ProfileAvatarStore = NO_PROFILE): AvatarUploadDeps {
  return {
    storage,
    profile,
    verifyToken: (request) => verifyCaller(request, getSupabaseJwks(env)),
    canManageGroup: () => Promise.resolve(false),
    waitUntil: (work) => void pending.push(work),
    sleep: () => Promise.resolve(),
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
      ctx,
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

  it('reflects a PR preview origin and falls back to the primary origin otherwise', async () => {
    const preflight = (origin: string) =>
      worker.fetch(
        new Request('https://worker.test/', { method: 'OPTIONS', headers: { Origin: origin } }),
        env,
        ctx,
      );
    const preview = await preflight('https://pr-546.srtdio-app.pages.dev');
    expect(preview.headers.get('Access-Control-Allow-Origin')).toBe(
      'https://pr-546.srtdio-app.pages.dev',
    );
    const other = await preflight('https://pr-546.srtdio-app.pages.dev.evil.com');
    expect(other.headers.get('Access-Control-Allow-Origin')).not.toBe(
      'https://pr-546.srtdio-app.pages.dev.evil.com',
    );
  });

  it('returns 405 for an unsupported verb', async () => {
    const res = await worker.fetch(
      new Request('https://worker.test/', { method: 'PUT' }),
      env,
      ctx,
    );
    expect(res.status).toBe(405);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('method_not_allowed');
  });
});

describe('avatar-upload group target', () => {
  const GROUP = '55555555-5555-7555-8555-555555555555';
  const WS = '66666666-6666-7666-8666-666666666666';

  function groupDeps(storage: FakeStorage, allowed: boolean): AvatarUploadDeps {
    return { ...deps(storage), canManageGroup: () => Promise.resolve(allowed) };
  }

  it('stores a group photo under groups/<group id>/ when the caller may manage it', async () => {
    const token = await mintToken(USER);
    const storage = new FakeStorage();
    const res = await handleAvatarUpload(
      uploadRequest(token, PNG_BYTES, { target_kind: 'group', target_id: GROUP }),
      env,
      groupDeps(storage, true),
      'trace-g1',
      null,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { avatar_url: string };
    expect(body.avatar_url).toBe(`https://cdn.srtd.io/groups/${GROUP}/${pngSha}.png`);
    expect(storage.calls[0]?.key).toBe(`groups/${GROUP}/${pngSha}.png`);
  });

  it('returns 403 and stores nothing when the caller may not manage the group', async () => {
    const token = await mintToken(USER);
    const storage = new FakeStorage();
    const res = await handleAvatarUpload(
      uploadRequest(token, PNG_BYTES, { target_kind: 'group', target_id: GROUP }),
      env,
      groupDeps(storage, false),
      'trace-g2',
      null,
    );
    expect(res.status).toBe(403);
    expect(storage.calls).toHaveLength(0);
  });

  it('returns 400 for an unknown target kind or a malformed group id', async () => {
    const token = await mintToken(USER);
    for (const extra of [
      { target_kind: 'workspace', target_id: GROUP },
      { target_kind: 'group', target_id: '../x' },
    ]) {
      const storage = new FakeStorage();
      const res = await handleAvatarUpload(
        uploadRequest(token, PNG_BYTES, extra),
        env,
        groupDeps(storage, true),
        'trace-g3',
        null,
      );
      expect(res.status).toBe(400);
      expect(storage.calls).toHaveLength(0);
    }
  });

  describe('canManageGroupAsCaller', () => {
    function callerRequest(apikey: string | null = 'sb_publishable_x'): Request {
      const headers = new Headers({ Authorization: 'Bearer caller-jwt' });
      if (apikey !== null) headers.set('apikey', apikey);
      return new Request('https://worker.test/', { method: 'POST', headers });
    }

    function fakeRest(groups: unknown[], members: unknown[]) {
      const urls: string[] = [];
      const auth: (string | null)[] = [];
      const fetcher = (input: string, init: RequestInit): Promise<Response> => {
        urls.push(input);
        auth.push(new Headers(init.headers).get('Authorization'));
        const rows = input.includes('/groups?') ? groups : members;
        return Promise.resolve(new Response(JSON.stringify(rows), { status: 200 }));
      };
      return { fetcher, urls, auth };
    }

    it('allows the creator, forwarding the caller JWT (runs as auth.uid())', async () => {
      const rest = fakeRest([{ workspace_id: WS, created_by: USER }], []);
      const ok = await canManageGroupAsCaller(callerRequest(), GROUP, USER, env, rest.fetcher);
      expect(ok).toBe(true);
      expect(rest.auth[0]).toBe('Bearer caller-jwt');
    });

    it('allows a workspace owner or admin who is not the creator', async () => {
      const rest = fakeRest([{ workspace_id: WS, created_by: OTHER_USER }], [{ role: 'admin' }]);
      expect(await canManageGroupAsCaller(callerRequest(), GROUP, USER, env, rest.fetcher)).toBe(
        true,
      );
      expect(rest.urls[1]).toContain(`user_id=eq.${USER}`);
    });

    it('denies a plain member, a hidden group, and a missing apikey', async () => {
      const member = fakeRest([{ workspace_id: WS, created_by: OTHER_USER }], [{ role: 'agency' }]);
      expect(await canManageGroupAsCaller(callerRequest(), GROUP, USER, env, member.fetcher)).toBe(
        false,
      );
      const hidden = fakeRest([], []);
      expect(await canManageGroupAsCaller(callerRequest(), GROUP, USER, env, hidden.fetcher)).toBe(
        false,
      );
      const creator = fakeRest([{ workspace_id: WS, created_by: USER }], []);
      expect(
        await canManageGroupAsCaller(callerRequest(null), GROUP, USER, env, creator.fetcher),
      ).toBe(false);
    });
  });
});

describe('avatar-upload refuses SVG and OLE2 on every target', () => {
  const GROUP = '55555555-5555-7555-8555-555555555555';
  const refused: ReadonlyArray<[string, Uint8Array<ArrayBuffer>]> = [
    ['an SVG', new Uint8Array(svg())],
    ['a legacy OLE2 Office file', new Uint8Array(ole2())],
  ];

  for (const [label, bytes] of refused) {
    for (const extra of [{}, { target_kind: 'group', target_id: GROUP }]) {
      const target = 'target_kind' in extra ? 'group photo' : 'avatar';
      it(`returns 415 for ${label} as a ${target} and stores nothing`, async () => {
        const token = await mintToken(USER);
        const storage = new FakeStorage();
        const res = await handleAvatarUpload(
          uploadRequest(token, bytes, extra),
          env,
          { ...deps(storage), canManageGroup: () => Promise.resolve(true) },
          'trace-svg',
          null,
        );
        expect(res.status).toBe(415);
        const body = (await res.json()) as { error: { code: string; message: string } };
        expect(body.error.code).toBe('unsupported_format');
        expect(body.error.message).not.toMatch(/connect|network|offline/i);
        expect(storage.calls).toHaveLength(0);
      });
    }
  }
});

describe('avatar-upload deletes the previous avatar only after the one save', () => {
  const OLD_SHA = 'a'.repeat(64);
  const oldKey = `${USER}/${OLD_SHA}.png`;
  const oldUrl = `https://cdn.srtd.io/${oldKey}`;
  const newKey = (): string => `${USER}/${pngSha}.png`;
  const newUrl = (): string => `https://cdn.srtd.io/${newKey()}`;

  /**
   * A read-only profile fake: the first read (before the PUT) returns `before`;
   * later reads return what the frontend's save left, from `after` in turn.
   * Reads log into the storage's shared log so order is visible.
   */
  function profileFake(
    storage: FakeStorage,
    before: SavedProfile | null,
    after: (SavedProfile | null)[] = [],
  ): ProfileAvatarStore {
    let reads = 0;
    return {
      read: () => {
        storage.log.push('read');
        reads += 1;
        if (reads === 1) return Promise.resolve(before);
        return Promise.resolve(after[Math.min(reads - 2, after.length - 1)] ?? before);
      },
    };
  }

  async function upload(storage: FakeStorage, profile: ProfileAvatarStore, trace: string) {
    const token = await mintToken(USER);
    const res = await handleAvatarUpload(
      uploadRequest(token, PNG_BYTES),
      env,
      deps(storage, profile),
      trace,
      null,
    );
    return res;
  }

  it('answers first, then deletes the old object once the profile shows the new url', async () => {
    const storage = new FakeStorage();
    const profile = profileFake(storage, { displayName: 'Asha', avatarUrl: oldUrl }, [
      { displayName: 'Asha', avatarUrl: oldUrl },
      { displayName: 'Asha', avatarUrl: newUrl() },
    ]);
    const res = await upload(storage, profile, 'trace-r1');
    expect(res.status).toBe(200);
    // Nothing deleted before the response; the cleanup runs after it.
    expect(storage.deletes).toHaveLength(0);
    await settle();
    expect(storage.log).toEqual(['read', `put:${newKey()}`, 'read', 'read', `delete:${oldKey}`]);
    expect(storage.deletes).toEqual([{ bucket: 'user-avatars', key: oldKey, traceId: 'trace-r1' }]);
  });

  it('never writes the profile: the store has no save, so one save per change', () => {
    const storage = new FakeStorage();
    const profile = profileFake(storage, null);
    expect(Object.keys(profile)).toEqual(['read']);
  });

  it('keeps the old object when the new url never shows up on the profile', async () => {
    const storage = new FakeStorage();
    const profile = profileFake(storage, { displayName: 'Asha', avatarUrl: oldUrl }, [
      { displayName: 'Asha', avatarUrl: oldUrl },
    ]);
    const res = await upload(storage, profile, 'trace-r2');
    expect(res.status).toBe(200);
    await settle();
    expect(storage.log.filter((e) => e === 'read')).toHaveLength(
      1 + CLEANUP_CHECK_DELAYS_MS.length,
    );
    expect(storage.deletes).toHaveLength(0);
  });

  it('keeps the old object when the later profile reads fail', async () => {
    const storage = new FakeStorage();
    const profile = profileFake(storage, { displayName: 'Asha', avatarUrl: oldUrl }, [null]);
    await upload(storage, profile, 'trace-r2b');
    await settle();
    expect(storage.deletes).toHaveLength(0);
  });

  it('still returns success when deleting the old object fails', async () => {
    const storage = new FakeStorage();
    storage.failDelete = true;
    const profile = profileFake(storage, { displayName: 'Asha', avatarUrl: oldUrl }, [
      { displayName: 'Asha', avatarUrl: newUrl() },
    ]);
    const res = await upload(storage, profile, 'trace-r3');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { avatar_url: string };
    expect(body.avatar_url).toBe(newUrl());
    await expect(settle()).resolves.toBeUndefined();
    expect(storage.deletes).toHaveLength(1);
  });

  it('schedules nothing when there is no previous avatar', async () => {
    for (const before of [null, { displayName: 'Asha', avatarUrl: null }]) {
      const storage = new FakeStorage();
      const res = await upload(storage, profileFake(storage, before), 'trace-r4');
      expect(res.status).toBe(200);
      expect(pending).toHaveLength(0);
      expect(storage.deletes).toHaveLength(0);
    }
  });

  it('deletes nothing when the new object fails to store', async () => {
    const token = await mintToken(USER);
    const storage = new FakeStorage();
    storage.failPut = true;
    const profile = profileFake(storage, { displayName: 'Asha', avatarUrl: oldUrl }, [
      { displayName: 'Asha', avatarUrl: newUrl() },
    ]);
    await expect(
      handleAvatarUpload(uploadRequest(token, PNG_BYTES), env, deps(storage, profile), 't', null),
    ).rejects.toThrow('r2 put failed');
    await settle();
    expect(storage.deletes).toHaveLength(0);
  });

  it('deletes nothing when re-uploading the same bytes (old key equals new key)', async () => {
    const storage = new FakeStorage();
    const profile = profileFake(storage, { displayName: 'Asha', avatarUrl: newUrl() });
    const res = await upload(storage, profile, 'trace-r6');
    expect(res.status).toBe(200);
    expect(pending).toHaveLength(0);
    expect(storage.deletes).toHaveLength(0);
  });

  it("never deletes another user's object, a group photo, or a foreign URL", async () => {
    for (const avatarUrl of [
      `https://cdn.srtd.io/${OTHER_USER}/${OLD_SHA}.png`,
      `https://cdn.srtd.io/groups/${USER}/${OLD_SHA}.png`,
      `https://evil.test/${USER}/${OLD_SHA}.png`,
      `https://cdn.srtd.io/${USER}/../${OTHER_USER}/${OLD_SHA}.png`,
    ]) {
      const storage = new FakeStorage();
      const profile = profileFake(storage, { displayName: 'Asha', avatarUrl }, [
        { displayName: 'Asha', avatarUrl: newUrl() },
      ]);
      const res = await upload(storage, profile, 'trace-r7');
      expect(res.status).toBe(200);
      await settle();
      expect(storage.deletes).toHaveLength(0);
    }
  });

  it('never reads the profile or deletes anything for a group photo', async () => {
    const token = await mintToken(USER);
    const storage = new FakeStorage();
    const profile = profileFake(storage, { displayName: 'Asha', avatarUrl: oldUrl });
    const res = await handleAvatarUpload(
      uploadRequest(token, PNG_BYTES, {
        target_kind: 'group',
        target_id: '55555555-5555-7555-8555-555555555555',
      }),
      env,
      { ...deps(storage, profile), canManageGroup: () => Promise.resolve(true) },
      'trace-r8',
      null,
    );
    expect(res.status).toBe(200);
    await settle();
    expect(storage.log.includes('read')).toBe(false);
    expect(storage.deletes).toHaveLength(0);
  });

  describe('ownAvatarKey', () => {
    it("returns the key only for this user's own avatar on the public base", () => {
      expect(ownAvatarKey(oldUrl, 'https://cdn.srtd.io/', USER)).toBe(oldKey);
      expect(ownAvatarKey(oldUrl, 'https://cdn.srtd.io', OTHER_USER)).toBeNull();
      expect(ownAvatarKey(null, 'https://cdn.srtd.io', USER)).toBeNull();
      expect(ownAvatarKey('', 'https://cdn.srtd.io', USER)).toBeNull();
      expect(ownAvatarKey(`${oldUrl}?x=1`, 'https://cdn.srtd.io', USER)).toBeNull();
    });
  });

  describe('createCallerProfileStore', () => {
    function callerRequest(apikey: string | null): Request {
      const headers = new Headers({ Authorization: 'Bearer caller-jwt' });
      if (apikey !== null) headers.set('apikey', apikey);
      return new Request('https://worker.test/', { method: 'POST', headers });
    }

    it('reads as the caller with the configured publishable key and never writes', async () => {
      const seen: { url: string; init: RequestInit }[] = [];
      const fetcher = (url: string, init: RequestInit): Promise<Response> => {
        seen.push({ url, init });
        return Promise.resolve(
          new Response(JSON.stringify([{ display_name: 'Asha', avatar_url: oldUrl }]), {
            status: 200,
          }),
        );
      };
      const store = createCallerProfileStore(
        { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_x' },
        fetcher,
      );
      expect(await store.read(callerRequest(null), USER)).toEqual({
        displayName: 'Asha',
        avatarUrl: oldUrl,
      });
      expect(seen).toHaveLength(1);
      expect(seen[0]?.url).toContain(`/rest/v1/users?select=display_name,avatar_url&id=eq.${USER}`);
      expect(seen[0]?.init.method).toBe('GET');
      const readHeaders = new Headers(seen[0]?.init.headers);
      expect(readHeaders.get('Authorization')).toBe('Bearer caller-jwt');
      expect(readHeaders.get('apikey')).toBe('sb_publishable_x');
    });

    it('does nothing without an apikey, and reads a failed response as null', async () => {
      let calls = 0;
      const fetcher = (): Promise<Response> => {
        calls += 1;
        return Promise.resolve(new Response('{}', { status: 400 }));
      };
      const store = createCallerProfileStore({ SUPABASE_URL }, fetcher);
      expect(await store.read(callerRequest(null), USER)).toBeNull();
      expect(calls).toBe(0);
      expect(await store.read(callerRequest('sb_publishable_x'), USER)).toBeNull();
      expect(calls).toBe(1);
    });
  });
});
