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

// Shared mock state: who is a member, the input the (mocked) pipeline saw, and a
// per-test in-memory repository the link/rename routes write through.
const state = vi.hoisted(() => ({
  members: new Set<string>(),
  capturedInput: null as Record<string, unknown> | null,
  repo: null as unknown as InMemoryAssetRepository,
  /** When set, POST runs the real pipeline over in-memory storage and this repo. */
  realPipeline: false,
  /** Per-test storage and rendition store the (real) thumbnail step writes to. */
  thumbStorage: null as unknown as InMemoryStorageClient,
  renditions: null as unknown as InMemoryRenditionStore,
  /** Activity rows the (in-memory) store received, and the members it reports. */
  /** Stands in for every R2StorageClient the worker builds. */
  r2: null as unknown as InMemoryMultipartStorage,
}));

// GET /usage and the storage cap: the service-role store (workspace_bytes_used
// RPC) is a per-test stand-in; the threshold, cap and exemption logic stays real.
const usageState = vi.hoisted(() => ({
  bytes: 0 as number | null,
  exempt: false,
  /** Cap or usage reads (one per checkWorkspaceCap / resolveWorkspaceUsage). */
  reads: 0,
}));
vi.mock('./asset-upload-usage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./asset-upload-usage')>();
  return {
    ...actual,
    createSupabaseUsageStore: () => ({
      workspace: () => {
        usageState.reads += 1;
        return Promise.resolve({ ownerUserId: 'owner' });
      },
      isExemptOwner: () => Promise.resolve(usageState.exempt),
      bytesUsed: () => Promise.resolve(usageState.bytes),
    }),
  };
});

// Every R2 client the worker builds is the per-test in-memory multipart store.
vi.mock('@srtdio/storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@srtdio/storage')>();
  return {
    ...actual,
    R2StorageClient: class {
      constructor() {
        return state.r2;
      }
    },
  };
});

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
// Keep runUploadPipeline mocked (no R2/Supabase); keep createLinkAsset and
// renameAsset real, but point the service-role repository factory at a per-test
// in-memory repo so the link/rename routes exercise the real pipeline functions
// without a network.
vi.mock('@/server/assets', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/assets')>();
  return {
    ...actual,
    createSupabaseAssetRepository: () => state.repo,
    createSupabaseRenditionStore: () => state.renditions,
    // The real thumbnail step over in-memory storage, the test repo, and the
    // per-test rendition store (the worker's R2 client is never used).
    storeThumbnailRendition: (_deps: unknown, input: ThumbnailInput) =>
      actual.storeThumbnailRendition(
        { storage: state.thumbStorage, repository: state.repo, renditions: state.renditions },
        input,
      ),
    runUploadPipeline: async (_deps: unknown, input: Record<string, unknown>) => {
      state.capturedInput = input;
      if (state.realPipeline) {
        const { InMemoryStorageClient } = await import('@srtdio/storage');
        return actual.runUploadPipeline(
          {
            storage: new InMemoryStorageClient(),
            repository: state.repo,
            scanner: new actual.NoOpScanner(),
          },
          input as unknown as UploadInput,
        );
      }
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
import {
  InMemoryAssetRepository,
  InMemoryRenditionStore,
  type ThumbnailInput,
  type UploadInput,
} from '@/server/assets';
import { InMemoryMultipartStorage, InMemoryStorageClient } from '@srtdio/storage';
import { CAP_BYTES } from './asset-upload-usage';
import { WORKSPACE_FULL_BODY } from './asset-upload-purge-contracts';
import {
  MIME,
  buildZip,
  encryptedPdf,
  jpeg,
  mp4,
  office,
  ole2,
  pdf,
  png,
  relationships,
  svg,
} from '../../../packages/storage/src/__fixtures__/files';

const USER = '33333333-3333-7333-8333-333333333333';
const OTHER_USER = '44444444-4444-7444-8444-444444444444';
const WORKSPACE = '11111111-1111-7111-8111-111111111111';
const OTHER_WORKSPACE = '22222222-2222-7222-8222-222222222222';
const ASSET = '55555555-5555-7555-8555-555555555555';
const OTHER_ASSET = '77777777-7777-7777-8777-777777777777';
const FOLDER = '88888888-8888-7888-8888-888888888888';
const SUPABASE_URL = 'https://test.supabase.co';
const KID = 'test-es256-key';

const env: AssetUploadEnv = {
  CLOUDFLARE_ACCOUNT_ID: 'acct',
  CLOUDFLARE_R2_ACCESS_KEY_ID: 'akid',
  CLOUDFLARE_R2_SECRET_ACCESS_KEY: 'secret',
  SUPABASE_URL,
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
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
  state.repo = new InMemoryAssetRepository();
  state.realPipeline = false;
  state.thumbStorage = new InMemoryStorageClient();
  state.renditions = new InMemoryRenditionStore();
  state.r2 = new InMemoryMultipartStorage();
  usageState.bytes = 0;
  usageState.exempt = false;
  usageState.reads = 0;
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

function jsonPost(path: string, token: string | null, body: unknown): Request {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (token !== null) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  return new Request(`https://worker.test${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

/** Seed an asset (optionally with a stored-file version) into the test repo. */
async function seedAsset(assetId: string, withVersion: boolean): Promise<void> {
  await state.repo.insertAsset({
    id: assetId,
    workspaceId: WORKSPACE,
    filename: 'original.png',
    uploadedBy: USER,
  });
  if (withVersion) {
    const versionId = '66666666-6666-7666-8666-666666666666';
    await state.repo.insertVersion({
      id: versionId,
      assetId,
      workspaceId: WORKSPACE,
      versionNumber: 1,
      kind: 'image',
      r2Key: `images/${assetId}/v1-original.png`,
      mimeType: 'image/png',
      sha256: 'a'.repeat(64),
      sizeBytes: 10,
      uploadedBy: USER,
    });
    await state.repo.setCurrentVersion(assetId, versionId);
  }
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
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://srtd.io');
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

  it('returns 400 for a folder_id in another workspace (tenant isolation)', async () => {
    const token = await mintToken(USER);
    state.members.add(`${USER}:${WORKSPACE}`);
    const now = new Date().toISOString();
    // A real folder, but owned by a different workspace: not a valid destination.
    state.repo.folders.set(FOLDER, {
      id: FOLDER,
      workspace_id: OTHER_WORKSPACE,
      name: 'Foreign',
      parent_id: null,
      created_by: USER,
      created_at: now,
      updated_at: now,
      deleted_at: null,
    });
    const res = await worker.fetch(
      uploadRequest(token, { workspace_id: WORKSPACE, folder_id: FOLDER }),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('bad_request');
    expect(body.error.message).toBe('Folder not found in this workspace.');
    // A cross-tenant folder never reaches the pipeline.
    expect(state.capturedInput).toBeNull();
  });

  it('threads a valid folder_id and display_name into the pipeline', async () => {
    const token = await mintToken(USER);
    state.members.add(`${USER}:${WORKSPACE}`);
    const now = new Date().toISOString();
    state.repo.folders.set(FOLDER, {
      id: FOLDER,
      workspace_id: WORKSPACE,
      name: 'Campaigns',
      parent_id: null,
      created_by: USER,
      created_at: now,
      updated_at: now,
      deleted_at: null,
    });
    const res = await worker.fetch(
      uploadRequest(token, {
        workspace_id: WORKSPACE,
        folder_id: FOLDER,
        display_name: 'My picture',
      }),
      env,
    );
    expect(res.status).toBe(201);
    expect(state.capturedInput?.folderId).toBe(FOLDER);
    expect(state.capturedInput?.displayName).toBe('My picture');
    // filename always stays the original upload name.
    expect(state.capturedInput?.filename).toBe('doc.pdf');
  });
});

describe('asset-upload origin field', () => {
  async function post(fields: Record<string, string>): Promise<Response> {
    const token = await mintToken(USER);
    state.members.add(`${USER}:${WORKSPACE}`);
    return worker.fetch(uploadRequest(token, { workspace_id: WORKSPACE, ...fields }), env);
  }

  it("defaults a missing origin to 'library'", async () => {
    const res = await post({});
    expect(res.status).toBe(201);
    expect(state.capturedInput?.origin).toBe('library');
  });

  it("passes origin 'library' through when sent explicitly", async () => {
    const res = await post({ origin: 'library' });
    expect(res.status).toBe(201);
    expect(state.capturedInput?.origin).toBe('library');
  });

  it("stores origin 'chat' through the pipeline", async () => {
    const res = await post({ origin: 'chat' });
    expect(res.status).toBe(201);
    expect(state.capturedInput?.origin).toBe('chat');
  });

  it('rejects any other origin with 400 before the pipeline runs', async () => {
    for (const origin of ['', 'Chat', 'assets', 'post']) {
      state.capturedInput = null;
      const res = await post({ origin });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('bad_request');
      expect(state.capturedInput).toBeNull();
    }
  });

  it("rejects origin 'chat' with an asset_id with 400", async () => {
    const res = await post({ origin: 'chat', asset_id: ASSET });
    expect(res.status).toBe(400);
    expect(state.capturedInput).toBeNull();
  });

  it("rejects origin 'chat' with a folder_id with 400", async () => {
    const now = new Date().toISOString();
    state.repo.folders.set(FOLDER, {
      id: FOLDER,
      workspace_id: WORKSPACE,
      name: 'Campaigns',
      parent_id: null,
      created_by: USER,
      created_at: now,
      updated_at: now,
      deleted_at: null,
    });
    const res = await post({ origin: 'chat', folder_id: FOLDER });
    expect(res.status).toBe(400);
    expect(state.capturedInput).toBeNull();
  });
});

describe('POST /links', () => {
  const URL_VAL = 'https://example.com/asset';

  it('creates a link asset and returns 201 with the link shape', async () => {
    const token = await mintToken(USER);
    state.members.add(`${USER}:${WORKSPACE}`);
    const res = await worker.fetch(
      jsonPost('/links', token, { workspace_id: WORKSPACE, url: URL_VAL, name: 'My link' }),
      env,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      asset: { externalUrl: string; filename: string; currentVersionId: string };
    };
    expect(body.asset.externalUrl).toBe(URL_VAL);
    expect(body.asset.filename).toBe('My link');
    expect(body.asset.currentVersionId).not.toBeNull();

    // The persisted version carries the link shape; byte columns stay null.
    expect(state.repo.versions).toHaveLength(1);
    const version = state.repo.versions[0];
    expect(version?.kind).toBe('link');
    expect(version?.external_url).toBe(URL_VAL);
    expect(version?.r2_key).toBeNull();
    expect(version?.sha256).toBeNull();
    expect(version?.size_bytes).toBeNull();

    // Audit: asset.create with the authenticated actor.
    expect(state.repo.audits).toHaveLength(1);
    expect(state.repo.audits[0]?.action).toBe('asset.create');
    expect(state.repo.audits[0]?.actorUserId).toBe(USER);
  });

  it('returns 400 for a non-http url', async () => {
    const token = await mintToken(USER);
    state.members.add(`${USER}:${WORKSPACE}`);
    const res = await worker.fetch(
      jsonPost('/links', token, { workspace_id: WORKSPACE, url: 'ftp://nope', name: 'x' }),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('bad_request');
    expect(state.repo.versions).toHaveLength(0);
  });

  it('returns 400 when name is missing', async () => {
    const token = await mintToken(USER);
    state.members.add(`${USER}:${WORKSPACE}`);
    const res = await worker.fetch(
      jsonPost('/links', token, { workspace_id: WORKSPACE, url: URL_VAL }),
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('bad_request');
  });

  it('returns 401 when the bearer token is absent', async () => {
    const res = await worker.fetch(
      jsonPost('/links', null, { workspace_id: WORKSPACE, url: URL_VAL, name: 'x' }),
      env,
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('unauthorized');
  });

  it('returns 403 when the caller is not a member', async () => {
    const token = await mintToken(USER);
    // state.members intentionally empty.
    const res = await worker.fetch(
      jsonPost('/links', token, { workspace_id: WORKSPACE, url: URL_VAL, name: 'x' }),
      env,
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('forbidden');
    expect(state.repo.versions).toHaveLength(0);
  });
});

describe('POST /rename', () => {
  it('renames the asset and returns 200, leaving version rows untouched', async () => {
    const token = await mintToken(USER);
    state.repo.memberships.set(`${USER}:${WORKSPACE}`, 'admin');
    await seedAsset(ASSET, true);
    const versionsBefore = state.repo.versions.length;
    const r2KeyBefore = state.repo.versions[0]?.r2_key;

    const res = await worker.fetch(
      jsonPost('/rename', token, { workspace_id: WORKSPACE, asset_id: ASSET, name: 'Renamed' }),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { asset: { filename: string; displayName: string } };
    // Rename writes display_name; filename (and its extension/type glyph) is intact.
    expect(body.asset.displayName).toBe('Renamed');
    expect(body.asset.filename).toBe('original.png');
    expect(state.repo.assets.get(ASSET)?.display_name).toBe('Renamed');
    expect(state.repo.assets.get(ASSET)?.filename).toBe('original.png');

    // Versions are immutable: none added, r2_key unchanged.
    expect(state.repo.versions).toHaveLength(versionsBefore);
    expect(state.repo.versions[0]?.r2_key).toBe(r2KeyBefore);

    const rename = state.repo.audits.find((a) => a.action === 'asset.rename');
    expect(rename?.actorUserId).toBe(USER);
  });

  it('returns 200 for an agency-role caller', async () => {
    const token = await mintToken(USER);
    state.repo.memberships.set(`${USER}:${WORKSPACE}`, 'agency');
    await seedAsset(ASSET, false);
    const res = await worker.fetch(
      jsonPost('/rename', token, { workspace_id: WORKSPACE, asset_id: ASSET, name: 'Renamed' }),
      env,
    );
    expect(res.status).toBe(200);
  });

  it('returns 403 for a client-role caller', async () => {
    const token = await mintToken(USER);
    state.repo.memberships.set(`${USER}:${WORKSPACE}`, 'client');
    await seedAsset(ASSET, false);
    const res = await worker.fetch(
      jsonPost('/rename', token, { workspace_id: WORKSPACE, asset_id: ASSET, name: 'Renamed' }),
      env,
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('forbidden');
    // A denied rename never touches the asset.
    expect(state.repo.assets.get(ASSET)?.filename).toBe('original.png');
  });

  it('returns 404 for an unknown asset', async () => {
    const token = await mintToken(USER);
    state.repo.memberships.set(`${USER}:${WORKSPACE}`, 'owner');
    // No asset seeded.
    const res = await worker.fetch(
      jsonPost('/rename', token, { workspace_id: WORKSPACE, asset_id: ASSET, name: 'Renamed' }),
      env,
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('not_found');
  });
});

/** Read the JSON body of a folder route response with a loose shape. */
async function folderBody(res: Response): Promise<{
  folder?: { id: string; name: string; parentId: string | null };
  error?: { code: string; message: string };
  ok?: boolean;
  moved?: number;
}> {
  return (await res.json()) as {
    folder?: { id: string; name: string; parentId: string | null };
    error?: { code: string; message: string };
    ok?: boolean;
    moved?: number;
  };
}

/** Create a folder via the API and return its id. Caller must be an active member. */
async function createFolder(token: string, name: string, parentId: string | null): Promise<string> {
  const res = await worker.fetch(
    jsonPost('/folders', token, { workspace_id: WORKSPACE, name, parent_id: parentId }),
    env,
  );
  expect(res.status).toBe(201);
  const body = await folderBody(res);
  return body.folder?.id ?? '';
}

describe('POST /folders (create)', () => {
  it('creates a root folder and returns 201 with the folder shape', async () => {
    const token = await mintToken(USER);
    state.members.add(`${USER}:${WORKSPACE}`);
    const res = await worker.fetch(
      jsonPost('/folders', token, { workspace_id: WORKSPACE, name: 'Campaigns', parent_id: null }),
      env,
    );
    expect(res.status).toBe(201);
    const body = await folderBody(res);
    expect(body.folder?.name).toBe('Campaigns');
    expect(body.folder?.parentId).toBeNull();
    expect(state.repo.folders.size).toBe(1);

    const audit = state.repo.audits.find((a) => a.action === 'folder.create');
    expect(audit?.actorUserId).toBe(USER);
  });

  it('auto-numbers a duplicate active name desktop-style instead of 409', async () => {
    const token = await mintToken(USER);
    state.members.add(`${USER}:${WORKSPACE}`);
    await createFolder(token, 'Campaigns', null);

    // Second create with the same name resolves to "Campaigns 2".
    const second = await worker.fetch(
      jsonPost('/folders', token, { workspace_id: WORKSPACE, name: 'Campaigns', parent_id: null }),
      env,
    );
    expect(second.status).toBe(201);
    expect((await folderBody(second)).folder?.name).toBe('Campaigns 2');

    // A third resolves to "Campaigns 3".
    const third = await worker.fetch(
      jsonPost('/folders', token, { workspace_id: WORKSPACE, name: 'Campaigns', parent_id: null }),
      env,
    );
    expect(third.status).toBe(201);
    expect((await folderBody(third)).folder?.name).toBe('Campaigns 3');

    expect(state.repo.folders.size).toBe(3);
  });

  it('auto-numbers case-insensitively, preserving the typed casing', async () => {
    const token = await mintToken(USER);
    state.members.add(`${USER}:${WORKSPACE}`);
    await createFolder(token, 'Campaigns', null);

    const res = await worker.fetch(
      // Differs only in case from the existing folder.
      jsonPost('/folders', token, { workspace_id: WORKSPACE, name: 'campaigns', parent_id: null }),
      env,
    );
    expect(res.status).toBe(201);
    expect((await folderBody(res)).folder?.name).toBe('campaigns 2');
  });

  it('scopes auto-numbering per parent: the same base name is bare under each parent', async () => {
    const token = await mintToken(USER);
    state.members.add(`${USER}:${WORKSPACE}`);
    const parentA = await createFolder(token, 'Parent A', null);
    const parentB = await createFolder(token, 'Parent B', null);

    const underA = await worker.fetch(
      jsonPost('/folders', token, { workspace_id: WORKSPACE, name: 'Shared', parent_id: parentA }),
      env,
    );
    expect(underA.status).toBe(201);
    expect((await folderBody(underA)).folder?.name).toBe('Shared');

    // Different parent: no collision, so the bare base name is kept (no suffix).
    const underB = await worker.fetch(
      jsonPost('/folders', token, { workspace_id: WORKSPACE, name: 'Shared', parent_id: parentB }),
      env,
    );
    expect(underB.status).toBe(201);
    expect((await folderBody(underB)).folder?.name).toBe('Shared');
  });

  it('rejects a parent folder in another workspace with 400', async () => {
    const token = await mintToken(USER);
    state.members.add(`${USER}:${WORKSPACE}`);
    const now = new Date().toISOString();
    // A real folder, but owned by a different workspace: must not be a valid parent.
    state.repo.folders.set(FOLDER, {
      id: FOLDER,
      workspace_id: OTHER_WORKSPACE,
      name: 'Foreign',
      parent_id: null,
      created_by: USER,
      created_at: now,
      updated_at: now,
      deleted_at: null,
    });
    const res = await worker.fetch(
      jsonPost('/folders', token, { workspace_id: WORKSPACE, name: 'Child', parent_id: FOLDER }),
      env,
    );
    expect(res.status).toBe(400);
    const body = await folderBody(res);
    expect(body.error?.code).toBe('bad_request');
    // Only the seeded foreign folder exists; nothing was created in WORKSPACE.
    expect(state.repo.folders.size).toBe(1);
  });

  it('returns 403 when the caller is not a member', async () => {
    const token = await mintToken(USER);
    // state.members intentionally empty.
    const res = await worker.fetch(
      jsonPost('/folders', token, { workspace_id: WORKSPACE, name: 'Campaigns', parent_id: null }),
      env,
    );
    expect(res.status).toBe(403);
    const body = await folderBody(res);
    expect(body.error?.code).toBe('forbidden');
    expect(state.repo.folders.size).toBe(0);
  });

  it('allows a client-role active member to create', async () => {
    const token = await mintToken(USER);
    // Any active member may create; role is not consulted on this route.
    state.members.add(`${USER}:${WORKSPACE}`);
    state.repo.memberships.set(`${USER}:${WORKSPACE}`, 'client');
    const res = await worker.fetch(
      jsonPost('/folders', token, { workspace_id: WORKSPACE, name: 'Drafts', parent_id: null }),
      env,
    );
    expect(res.status).toBe(201);
  });
});

describe('POST /folders/rename', () => {
  it('renames a folder and returns 200 for an admin', async () => {
    const token = await mintToken(USER);
    state.members.add(`${USER}:${WORKSPACE}`);
    state.repo.memberships.set(`${USER}:${WORKSPACE}`, 'admin');
    const folderId = await createFolder(token, 'Old', null);

    const res = await worker.fetch(
      jsonPost('/folders/rename', token, {
        workspace_id: WORKSPACE,
        folder_id: folderId,
        name: 'New',
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = await folderBody(res);
    expect(body.folder?.name).toBe('New');
    expect(state.repo.folders.get(folderId)?.name).toBe('New');
    expect(state.repo.audits.some((a) => a.action === 'folder.rename')).toBe(true);
  });

  it('returns 409 when the new name collides with a sibling', async () => {
    const token = await mintToken(USER);
    state.members.add(`${USER}:${WORKSPACE}`);
    state.repo.memberships.set(`${USER}:${WORKSPACE}`, 'admin');
    await createFolder(token, 'Taken', null);
    const folderId = await createFolder(token, 'Free', null);

    const res = await worker.fetch(
      jsonPost('/folders/rename', token, {
        workspace_id: WORKSPACE,
        folder_id: folderId,
        name: 'Taken',
      }),
      env,
    );
    expect(res.status).toBe(409);
    const body = await folderBody(res);
    expect(body.error?.code).toBe('folder_name_taken');
  });

  it('returns 403 for a client-role caller', async () => {
    const token = await mintToken(USER);
    state.members.add(`${USER}:${WORKSPACE}`);
    state.repo.memberships.set(`${USER}:${WORKSPACE}`, 'client');
    const folderId = await createFolder(token, 'Old', null);

    const res = await worker.fetch(
      jsonPost('/folders/rename', token, {
        workspace_id: WORKSPACE,
        folder_id: folderId,
        name: 'New',
      }),
      env,
    );
    expect(res.status).toBe(403);
    const body = await folderBody(res);
    expect(body.error?.code).toBe('forbidden');
    expect(state.repo.folders.get(folderId)?.name).toBe('Old');
  });

  it('returns 403 when the caller is not a member', async () => {
    const token = await mintToken(USER);
    // No membership row.
    const res = await worker.fetch(
      jsonPost('/folders/rename', token, {
        workspace_id: WORKSPACE,
        folder_id: FOLDER,
        name: 'New',
      }),
      env,
    );
    expect(res.status).toBe(403);
    const body = await folderBody(res);
    expect(body.error?.code).toBe('forbidden');
  });

  it('returns 404 for an unknown folder', async () => {
    const token = await mintToken(USER);
    state.repo.memberships.set(`${USER}:${WORKSPACE}`, 'owner');
    const res = await worker.fetch(
      jsonPost('/folders/rename', token, {
        workspace_id: WORKSPACE,
        folder_id: FOLDER,
        name: 'New',
      }),
      env,
    );
    expect(res.status).toBe(404);
    const body = await folderBody(res);
    expect(body.error?.code).toBe('not_found');
  });
});

describe('POST /folders/delete', () => {
  it('reparents child folders and detaches assets, then soft-deletes', async () => {
    const token = await mintToken(USER);
    state.members.add(`${USER}:${WORKSPACE}`);
    state.repo.memberships.set(`${USER}:${WORKSPACE}`, 'admin');
    const parentId = await createFolder(token, 'Parent', null);
    const childId = await createFolder(token, 'Child', parentId);
    // An asset filed under the parent folder.
    await seedAsset(ASSET, false);
    const seeded = state.repo.assets.get(ASSET);
    expect(seeded).toBeDefined();
    state.repo.assets.set(ASSET, { ...seeded!, folder_id: parentId });

    const res = await worker.fetch(
      jsonPost('/folders/delete', token, { workspace_id: WORKSPACE, folder_id: parentId }),
      env,
    );
    expect(res.status).toBe(200);
    const body = await folderBody(res);
    expect(body.ok).toBe(true);

    // Child reparented to root, asset detached, parent tombstoned.
    expect(state.repo.folders.get(childId)?.parent_id).toBeNull();
    expect(state.repo.assets.get(ASSET)?.folder_id).toBeNull();
    expect(state.repo.folders.get(parentId)?.deleted_at).not.toBeNull();
    expect(state.repo.audits.some((a) => a.action === 'folder.delete')).toBe(true);
  });

  it('returns 403 for a client-role caller', async () => {
    const token = await mintToken(USER);
    state.members.add(`${USER}:${WORKSPACE}`);
    state.repo.memberships.set(`${USER}:${WORKSPACE}`, 'client');
    const folderId = await createFolder(token, 'Keep', null);

    const res = await worker.fetch(
      jsonPost('/folders/delete', token, { workspace_id: WORKSPACE, folder_id: folderId }),
      env,
    );
    expect(res.status).toBe(403);
    expect(state.repo.folders.get(folderId)?.deleted_at).toBeNull();
  });

  it('returns 403 when the caller is not a member', async () => {
    const token = await mintToken(USER);
    const res = await worker.fetch(
      jsonPost('/folders/delete', token, { workspace_id: WORKSPACE, folder_id: FOLDER }),
      env,
    );
    expect(res.status).toBe(403);
    const body = await folderBody(res);
    expect(body.error?.code).toBe('forbidden');
  });
});

describe('POST /folders/move', () => {
  it('moves only in-workspace assets and returns the moved count', async () => {
    const token = await mintToken(USER);
    state.members.add(`${USER}:${WORKSPACE}`);
    const targetId = await createFolder(token, 'Target', null);
    // One asset in WORKSPACE, one in another workspace sharing the same request.
    await seedAsset(ASSET, false);
    await state.repo.insertAsset({
      id: OTHER_ASSET,
      workspaceId: OTHER_WORKSPACE,
      filename: 'foreign.png',
      uploadedBy: USER,
    });

    const res = await worker.fetch(
      jsonPost('/folders/move', token, {
        workspace_id: WORKSPACE,
        asset_ids: [ASSET, OTHER_ASSET],
        target_folder_id: targetId,
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = await folderBody(res);
    expect(body.moved).toBe(1);
    expect(state.repo.assets.get(ASSET)?.folder_id).toBe(targetId);
    // The out-of-workspace asset is untouched.
    expect(state.repo.assets.get(OTHER_ASSET)?.folder_id).toBeNull();
    expect(state.repo.audits.some((a) => a.action === 'folder.move')).toBe(true);
  });

  it('allows a client-role active member to move', async () => {
    const token = await mintToken(USER);
    state.members.add(`${USER}:${WORKSPACE}`);
    state.repo.memberships.set(`${USER}:${WORKSPACE}`, 'client');
    await seedAsset(ASSET, false);
    const res = await worker.fetch(
      jsonPost('/folders/move', token, {
        workspace_id: WORKSPACE,
        asset_ids: [ASSET],
        target_folder_id: null,
      }),
      env,
    );
    expect(res.status).toBe(200);
    const body = await folderBody(res);
    expect(body.moved).toBe(1);
  });

  it('returns 403 when the caller is not a member', async () => {
    const token = await mintToken(USER);
    const res = await worker.fetch(
      jsonPost('/folders/move', token, {
        workspace_id: WORKSPACE,
        asset_ids: [ASSET],
        target_folder_id: null,
      }),
      env,
    );
    expect(res.status).toBe(403);
    const body = await folderBody(res);
    expect(body.error?.code).toBe('forbidden');
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

describe('asset-upload file-safety refusals (real pipeline)', () => {
  function fileRequest(
    token: string,
    name: string,
    type: string,
    bytes: Uint8Array,
    origin: 'library' | 'chat',
  ): Request {
    const form = new FormData();
    form.set('file', new File([new Uint8Array(bytes)], name, { type }));
    form.set('workspace_id', WORKSPACE);
    form.set('origin', origin);
    return new Request('https://worker.test/', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
  }

  const docxWithVba = () => office('docx', { extra: [{ name: 'word/vbaProject.bin', data: 'x' }] });
  const docxWithOle = () =>
    office('docx', { extra: [{ name: 'word/embeddings/oleObject1.bin', data: 'x' }] });
  const zipEncrypted = () =>
    office('docx', { extra: [{ name: 'word/x.xml', data: 'x', encrypted: true }] });

  const refusals: ReadonlyArray<[string, string, string, () => Uint8Array, number, string]> = [
    [
      'zip renamed .docx',
      'a.docx',
      MIME.docx,
      () => buildZip([{ name: 'a', data: 'a' }]),
      415,
      'mime_mismatch',
    ],
    [
      'docm renamed .docx',
      'a.docx',
      MIME.docx,
      () => office('docx', { macroContentType: true }),
      415,
      'blocked_type',
    ],
    ['docx with vbaProject.bin', 'a.docx', MIME.docx, docxWithVba, 415, 'blocked_type'],
    ['docx with oleObject1.bin', 'a.docx', MIME.docx, docxWithOle, 422, 'embedded_content'],
    ['legacy .doc', 'a.doc', 'application/msword', () => ole2(), 415, 'blocked_type'],
    ['svg', 'a.svg', 'image/svg+xml', () => svg(), 415, 'blocked_type'],
    ['invoice.pdf.exe', 'invoice.pdf.exe', MIME.pdf, () => pdf(), 415, 'blocked_type'],
    ['extension/MIME mismatch', 'a.png', MIME.pdf, () => pdf(), 415, 'mime_mismatch'],
    ['signature mismatch', 'a.pdf', MIME.pdf, () => png(), 415, 'mime_mismatch'],
    [
      'ratio bomb',
      'a.xlsx',
      MIME.xlsx,
      () => office('xlsx', { mainBody: new Uint8Array(20 * 1024 * 1024) }),
      422,
      'archive_limits',
    ],
    ['encrypted pdf', 'a.pdf', MIME.pdf, () => pdf({ encrypted: true }), 422, 'encrypted_file'],
    [
      'password-protected docx (OLE2 bytes)',
      'a.docx',
      MIME.docx,
      () => ole2({ encryptedPackage: true }),
      422,
      'encrypted_file',
    ],
    [
      'remote attachedTemplate docx',
      'a.docx',
      MIME.docx,
      () =>
        office('docx', {
          extra: [
            {
              name: 'word/_rels/settings.xml.rels',
              data: relationships([
                { type: 'attachedTemplate', target: 'http://example.test/t.dotm', external: true },
              ]),
            },
          ],
        }),
      422,
      'external_content',
    ],
    [
      'pdf needing a password to open (AES-256)',
      'a.pdf',
      MIME.pdf,
      () => encryptedPdf({ revision: 6, userPassword: 'secret' }),
      422,
      'encrypted_file',
    ],
    ['encrypted zip entry', 'a.docx', MIME.docx, zipEncrypted, 422, 'encrypted_file'],
  ];

  for (const origin of ['library', 'chat'] as const) {
    for (const [label, name, type, bytes, status, code] of refusals) {
      it(`${origin}: refuses ${label} with a permanent ${status}`, async () => {
        state.realPipeline = true;
        const token = await mintToken(USER);
        state.members.add(`${USER}:${WORKSPACE}`);
        const res = await worker.fetch(fileRequest(token, name, type, bytes(), origin), env);
        expect(res.status).toBe(status);
        const body = (await res.json()) as { error: { code: string; message: string } };
        expect(body.error.code).toBe(code);
        expect(body.error.message).not.toMatch(/connect|network|offline/i);
        expect(state.repo.versions).toHaveLength(0);
      });
    }
  }

  const allowed: ReadonlyArray<[string, string, () => Uint8Array]> = [
    ['a.docx', MIME.docx, () => office('docx')],
    ['a.xlsx', MIME.xlsx, () => office('xlsx')],
    ['a.pptx', MIME.pptx, () => office('pptx')],
    ['a.pdf', MIME.pdf, () => pdf()],
    ['a.mp4', MIME.mp4, () => mp4()],
    ['a.png', MIME.png, () => png()],
    ['locked-no-print.pdf', MIME.pdf, () => encryptedPdf({ revision: 4, userPassword: '' })],
    ['a.jpg', MIME.jpeg, () => jpeg()],
    ['a.gif', 'image/gif', () => Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])],
    [
      'a.webp',
      'image/webp',
      () => Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]),
    ],
    [
      'a.mov',
      'video/quicktime',
      () => Uint8Array.from([0, 0, 0, 0x14, 0x66, 0x74, 0x79, 0x70, 0x71, 0x74]),
    ],
    ['voice-note.webm', 'audio/webm', () => Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x01])],
    ['voice-note.m4a', 'audio/mp4', () => mp4()],
    ['voice-note.mp3', 'audio/mpeg', () => Uint8Array.from([0x49, 0x44, 0x33, 0x03, 0x00])],
  ];
  for (const [name, type, bytes] of allowed) {
    it(`still stores an allowed ${name}`, async () => {
      state.realPipeline = true;
      const token = await mintToken(USER);
      state.members.add(`${USER}:${WORKSPACE}`);
      const res = await worker.fetch(fileRequest(token, name, type, bytes(), 'library'), env);
      expect(res.status).toBe(201);
      expect(state.repo.versions).toHaveLength(1);
    });
  }
});

describe('asset-upload thumbnail part', () => {
  /** SOI, an SOF0 frame of the given size (3 components), zero padding, EOI. */
  function jpegThumb(width: number, height: number, padTo = 0): Uint8Array {
    const head = [
      0xff,
      0xd8,
      0xff,
      0xc0,
      0x00,
      0x11,
      0x08,
      (height >> 8) & 0xff,
      height & 0xff,
      (width >> 8) & 0xff,
      width & 0xff,
      0x03,
      0x01,
      0x22,
      0x00,
      0x02,
      0x11,
      0x01,
      0x03,
      0x11,
      0x01,
    ];
    const total = Math.max(padTo, head.length + 2);
    const out = new Uint8Array(total);
    out.set(head, 0);
    out.set([0xff, 0xd9], total - 2);
    return out;
  }

  interface ThumbRequestOptions {
    name?: string;
    type?: string;
    bytes?: Uint8Array;
    thumbnail?: Uint8Array | string;
    pageCount?: string;
  }

  async function postWithThumb(options: ThumbRequestOptions = {}): Promise<Response> {
    const token = await mintToken(USER);
    state.members.add(`${USER}:${WORKSPACE}`);
    const form = new FormData();
    form.set(
      'file',
      new File([new Uint8Array(options.bytes ?? pdf())], options.name ?? 'doc.pdf', {
        type: options.type ?? MIME.pdf,
      }),
    );
    form.set('workspace_id', WORKSPACE);
    if (typeof options.thumbnail === 'string') {
      form.set('thumbnail', options.thumbnail);
    } else if (options.thumbnail !== undefined) {
      form.set(
        'thumbnail',
        new Blob([new Uint8Array(options.thumbnail)], { type: 'image/jpeg' }),
        'thumb.jpg',
      );
    }
    if (options.pageCount !== undefined) {
      form.set('thumbnail_page_count', options.pageCount);
    }
    return worker.fetch(
      new Request('https://worker.test/', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      }),
      env,
    );
  }

  interface UploadBody {
    asset: { versionId: string; assetId: string };
    thumbnail?: { width: number; height: number; page_count?: number };
  }

  it('stores a valid jpeg for a pdf upload and returns its size and page count', async () => {
    const thumb = jpegThumb(400, 566);
    const res = await postWithThumb({ thumbnail: thumb, pageCount: '12' });
    expect(res.status).toBe(201);
    const body = (await res.json()) as UploadBody;
    expect(body.thumbnail).toEqual({ width: 400, height: 566, page_count: 12 });

    expect(state.renditions.rows).toHaveLength(1);
    expect(state.renditions.rows[0]).toMatchObject({
      assetVersionId: 'vvvv',
      workspaceId: WORKSPACE,
      role: 'thumbnail',
      r2Key: 'pdf/aaaa/v1-thumb.jpg',
      width: 400,
      height: 566,
    });
    const object = state.thumbStorage.get('assets-test-ws', 'pdf/aaaa/v1-thumb.jpg');
    expect(object?.contentType).toBe('image/jpeg');
    expect(object?.body).toEqual(thumb);
  });

  it('omits page_count when the field is absent', async () => {
    const res = await postWithThumb({ thumbnail: jpegThumb(300, 300) });
    expect(res.status).toBe(201);
    const body = (await res.json()) as UploadBody;
    expect(body.thumbnail).toEqual({ width: 300, height: 300 });
  });

  it('answers exactly as before when there is no thumbnail part', async () => {
    const res = await postWithThumb();
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(['asset']);
    expect(state.renditions.rows).toHaveLength(0);
    expect(state.thumbStorage.objects.size).toBe(0);
  });

  const ignored: ReadonlyArray<[string, ThumbRequestOptions]> = [
    ['bad magic bytes', { thumbnail: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]) }],
    ['a part over 300 KiB', { thumbnail: jpegThumb(100, 100, 300 * 1024 + 1) }],
    ['a frame wider than 580', { thumbnail: jpegThumb(600, 100) }],
    ['a frame taller than 1160', { thumbnail: jpegThumb(100, 1200) }],
    ['an invalid page count', { thumbnail: jpegThumb(100, 100), pageCount: '0' }],
    ['a text field instead of a file', { thumbnail: 'not-a-file' }],
  ];
  for (const [label, options] of ignored) {
    it(`ignores ${label}: 201, no thumbnail field, no row`, async () => {
      const res = await postWithThumb(options);
      expect(res.status).toBe(201);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).not.toHaveProperty('thumbnail');
      expect(body).toHaveProperty('asset');
      expect(state.renditions.rows).toHaveLength(0);
      expect(state.thumbStorage.objects.size).toBe(0);
    });
  }

  it("stores an image's small list copy as its thumbnail rendition, no page count", async () => {
    const res = await postWithThumb({
      name: 'a.png',
      type: MIME.png,
      bytes: png(),
      thumbnail: jpegThumb(320, 400),
      pageCount: '3',
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as UploadBody;
    expect(body.thumbnail).toEqual({ width: 320, height: 400 });
    expect(state.renditions.rows).toHaveLength(1);
  });

  it('dedups a reused upload: existing rendition, no second row or put, 200', async () => {
    state.realPipeline = true;
    const first = await postWithThumb({ thumbnail: jpegThumb(400, 566), pageCount: '3' });
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as UploadBody;
    expect(firstBody.thumbnail).toEqual({ width: 400, height: 566, page_count: 3 });
    expect(state.renditions.rows).toHaveLength(1);
    state.thumbStorage.objects.clear();

    // Same bytes again: the pipeline reuses the version, which already has a thumbnail.
    const second = await postWithThumb({ thumbnail: jpegThumb(200, 200), pageCount: '3' });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as UploadBody;
    expect(secondBody.asset.versionId).toBe(firstBody.asset.versionId);
    expect(secondBody.thumbnail).toEqual({ width: 400, height: 566, page_count: 3 });
    expect(state.renditions.rows).toHaveLength(1);
    expect(state.thumbStorage.objects.size).toBe(0);
  });

  it('a reused upload sent without a thumbnail part still reports the stored one', async () => {
    state.realPipeline = true;
    const first = await postWithThumb({ thumbnail: jpegThumb(400, 566), pageCount: '3' });
    const firstBody = (await first.json()) as UploadBody;
    const again = await postWithThumb();
    expect(again.status).toBe(200);
    const body = (await again.json()) as UploadBody;
    expect(body.asset.versionId).toBe(firstBody.asset.versionId);
    expect(body.thumbnail).toEqual({ width: 400, height: 566 });
    expect(state.renditions.rows).toHaveLength(1);
  });

  it('still answers 201 with no thumbnail field when the rendition insert fails', async () => {
    state.renditions.failInsert = new Error('insert failed');
    const res = await postWithThumb({ thumbnail: jpegThumb(400, 566), pageCount: '2' });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty('thumbnail');
    expect(body).toHaveProperty('asset');
    expect(state.renditions.rows).toHaveLength(0);
  });
});

describe('resumable (multipart) upload routes', () => {
  const PART = 8 * 1024 * 1024;

  function partRequest(token: string, query: Record<string, string>, body: Uint8Array): Request {
    const url = new URL('https://worker.test/multipart/part');
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    return new Request(url, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}` },
      body: new Blob([body as Uint8Array<ArrayBuffer>]),
    });
  }

  async function create(token: string, size: number): Promise<{ key: string; upload_id: string }> {
    const res = await worker.fetch(
      jsonPost('/multipart/create', token, {
        workspace_id: WORKSPACE,
        size,
        content_type: 'application/pdf',
      }),
      env,
    );
    expect(res.status).toBe(201);
    return (await res.json()) as { key: string; upload_id: string };
  }

  it('creates an upload under the caller staging prefix with 8 MB parts', async () => {
    state.members.add(`${USER}:${WORKSPACE}`);
    const token = await mintToken(USER);
    const res = await worker.fetch(
      jsonPost('/multipart/create', token, {
        workspace_id: WORKSPACE,
        size: PART * 2 + 5,
        content_type: 'application/pdf',
      }),
      env,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { key: string; part_size: number; part_count: number };
    expect(body.key.startsWith(`_uploads/${USER}/`)).toBe(true);
    expect(body.part_size).toBe(PART);
    expect(body.part_count).toBe(3);
  });

  it('keeps the 100 MB cap and the type allowlist at create', async () => {
    state.members.add(`${USER}:${WORKSPACE}`);
    const token = await mintToken(USER);
    const big = await worker.fetch(
      jsonPost('/multipart/create', token, {
        workspace_id: WORKSPACE,
        size: 100 * 1024 * 1024 + 1,
        content_type: 'application/pdf',
      }),
      env,
    );
    expect(big.status).toBe(413);
    const exe = await worker.fetch(
      jsonPost('/multipart/create', token, {
        workspace_id: WORKSPACE,
        size: 10,
        content_type: 'application/x-msdownload',
      }),
      env,
    );
    expect(exe.status).toBe(415);
  });

  it('refuses a non-member', async () => {
    const token = await mintToken(USER);
    const res = await worker.fetch(
      jsonPost('/multipart/create', token, {
        workspace_id: WORKSPACE,
        size: 10,
        content_type: 'application/pdf',
      }),
      env,
    );
    expect(res.status).toBe(403);
  });

  it("refuses another user's staging key", async () => {
    state.members.add(`${USER}:${WORKSPACE}`);
    state.members.add(`${OTHER_USER}:${WORKSPACE}`);
    const created = await create(await mintToken(USER), 10);
    const res = await worker.fetch(
      partRequest(
        await mintToken(OTHER_USER),
        {
          workspace_id: WORKSPACE,
          key: created.key,
          upload_id: created.upload_id,
          part_number: '1',
        },
        new Uint8Array(10),
      ),
      env,
    );
    expect(res.status).toBe(403);
  });

  it('lists finished parts, completes through the pipeline, and drops the staging object', async () => {
    state.members.add(`${USER}:${WORKSPACE}`);
    const token = await mintToken(USER);
    const created = await create(token, PART + 4);
    const query = { workspace_id: WORKSPACE, key: created.key, upload_id: created.upload_id };
    const first = await worker.fetch(
      partRequest(token, { ...query, part_number: '1' }, new Uint8Array(PART)),
      env,
    );
    expect(first.status).toBe(200);

    const listUrl = new URL('https://worker.test/multipart/parts');
    for (const [key, value] of Object.entries(query)) listUrl.searchParams.set(key, value);
    const listed = await worker.fetch(
      new Request(listUrl, { headers: { Authorization: `Bearer ${token}` } }),
      env,
    );
    expect(((await listed.json()) as { parts: unknown[] }).parts).toEqual([
      { part_number: 1, size: PART },
    ]);

    await worker.fetch(
      partRequest(token, { ...query, part_number: '2' }, new Uint8Array([1, 2, 3, 4])),
      env,
    );
    const form = new FormData();
    form.set('workspace_id', WORKSPACE);
    form.set('key', created.key);
    form.set('upload_id', created.upload_id);
    form.set('filename', 'big.pdf');
    form.set('content_type', 'application/pdf');
    const done = await worker.fetch(
      new Request('https://worker.test/multipart/complete', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      }),
      env,
    );
    expect(done.status).toBe(201);
    expect(state.capturedInput).toMatchObject({
      filename: 'big.pdf',
      contentType: 'application/pdf',
      uploadedBy: USER,
    });
    expect((state.capturedInput?.bytes as Uint8Array).byteLength).toBe(PART + 4);
    expect(state.r2.objects.size).toBe(0);
  });

  it('refuses a complete with a short middle part', async () => {
    state.members.add(`${USER}:${WORKSPACE}`);
    const token = await mintToken(USER);
    const created = await create(token, PART * 2);
    const query = { workspace_id: WORKSPACE, key: created.key, upload_id: created.upload_id };
    await worker.fetch(partRequest(token, { ...query, part_number: '1' }, new Uint8Array(10)), env);
    await worker.fetch(partRequest(token, { ...query, part_number: '2' }, new Uint8Array(10)), env);
    const form = new FormData();
    form.set('workspace_id', WORKSPACE);
    form.set('key', created.key);
    form.set('upload_id', created.upload_id);
    form.set('filename', 'big.pdf');
    form.set('content_type', 'application/pdf');
    const res = await worker.fetch(
      new Request('https://worker.test/multipart/complete', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      }),
      env,
    );
    expect(res.status).toBe(400);
    expect(state.capturedInput).toBeNull();
  });

  it('aborts an upload', async () => {
    state.members.add(`${USER}:${WORKSPACE}`);
    const token = await mintToken(USER);
    const created = await create(token, 10);
    const res = await worker.fetch(
      jsonPost('/multipart/abort', token, {
        workspace_id: WORKSPACE,
        key: created.key,
        upload_id: created.upload_id,
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(state.r2.uploads.size).toBe(0);
  });
});

describe('asset-upload GET /usage', () => {
  const MB = 1024 * 1024;

  function usageRequest(token: string | null, workspaceId: string): Request {
    const headers = new Headers();
    if (token !== null) headers.set('Authorization', `Bearer ${token}`);
    return new Request(`https://worker.test/usage?workspace_id=${workspaceId}`, {
      method: 'GET',
      headers,
    });
  }

  it('requires a verified caller', async () => {
    const res = await worker.fetch(usageRequest(null, WORKSPACE), env);
    expect(res.status).toBe(401);
  });

  it('rejects a malformed workspace id', async () => {
    const token = await mintToken(USER);
    const res = await worker.fetch(usageRequest(token, 'nope'), env);
    expect(res.status).toBe(400);
  });

  it('refuses a caller who is not an active member', async () => {
    const token = await mintToken(USER);
    const res = await worker.fetch(usageRequest(token, WORKSPACE), env);
    expect(res.status).toBe(403);
  });

  it('refuses a member of one workspace asking for another workspace', async () => {
    state.members.add(`${USER}:${WORKSPACE}`);
    const token = await mintToken(USER);
    const res = await worker.fetch(usageRequest(token, OTHER_WORKSPACE), env);
    expect(res.status).toBe(403);
  });

  it('returns usage with warn at 800 MB for a member', async () => {
    state.members.add(`${USER}:${WORKSPACE}`);
    usageState.bytes = 800 * MB;
    const token = await mintToken(USER);
    const res = await worker.fetch(usageRequest(token, WORKSPACE), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      usedBytes: 800 * MB,
      warnAtBytes: 800 * MB,
      warn: true,
      exempt: false,
    });
  });

  it('never warns when the owner is exempt', async () => {
    state.members.add(`${USER}:${WORKSPACE}`);
    usageState.bytes = 900 * MB;
    usageState.exempt = true;
    const token = await mintToken(USER);
    const body = (await (await worker.fetch(usageRequest(token, WORKSPACE), env)).json()) as {
      warn: boolean;
      exempt: boolean;
    };
    expect(body).toMatchObject({ warn: false, exempt: true });
  });

  it('answers 503 usage_unavailable when the usage read fails', async () => {
    state.members.add(`${USER}:${WORKSPACE}`);
    usageState.bytes = null;
    const token = await mintToken(USER);
    const res = await worker.fetch(usageRequest(token, WORKSPACE), env);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string }; usedBytes?: unknown };
    expect(body.error.code).toBe('usage_unavailable');
    expect(body.usedBytes).toBeUndefined();
  });
});

describe('workspace storage cap (413 workspace_full)', () => {
  // uploadRequest's file part is 4 bytes.
  const FILE_BYTES = 4;

  function complete(
    token: string,
    created: { key: string; upload_id: string },
    extra: Record<string, string> = {},
  ): Request {
    const form = new FormData();
    for (const [name, value] of Object.entries(extra)) form.set(name, value);
    form.set('workspace_id', WORKSPACE);
    form.set('key', created.key);
    form.set('upload_id', created.upload_id);
    form.set('filename', 'doc.pdf');
    form.set('content_type', 'application/pdf');
    return new Request('https://worker.test/multipart/complete', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
  }

  function createRequest(token: string, size: number): Request {
    return jsonPost('/multipart/create', token, {
      workspace_id: WORKSPACE,
      size,
      content_type: 'application/pdf',
    });
  }

  /** Create a resumable upload with one 4 byte part already stored. */
  async function staged(token: string): Promise<{ key: string; upload_id: string }> {
    const res = await worker.fetch(createRequest(token, FILE_BYTES), env);
    expect(res.status).toBe(201);
    const created = (await res.json()) as { key: string; upload_id: string };
    const url = new URL('https://worker.test/multipart/part');
    url.searchParams.set('workspace_id', WORKSPACE);
    url.searchParams.set('key', created.key);
    url.searchParams.set('upload_id', created.upload_id);
    url.searchParams.set('part_number', '1');
    const part = await worker.fetch(
      new Request(url, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}` },
        body: new Blob([new Uint8Array(FILE_BYTES)]),
      }),
      env,
    );
    expect(part.status).toBe(200);
    return created;
  }

  async function memberToken(): Promise<string> {
    state.members.add(`${USER}:${WORKSPACE}`);
    return mintToken(USER);
  }

  describe('direct POST', () => {
    it('stores a file under the cap', async () => {
      const token = await memberToken();
      usageState.bytes = 100;
      const res = await worker.fetch(uploadRequest(token, { workspace_id: WORKSPACE }), env);
      expect(res.status).toBe(201);
    });

    it('stores a file that lands exactly on the cap', async () => {
      const token = await memberToken();
      usageState.bytes = CAP_BYTES - FILE_BYTES;
      const res = await worker.fetch(uploadRequest(token, { workspace_id: WORKSPACE }), env);
      expect(res.status).toBe(201);
    });

    it('refuses a file over the cap before the pipeline runs', async () => {
      const token = await memberToken();
      usageState.bytes = CAP_BYTES - FILE_BYTES + 1;
      const res = await worker.fetch(uploadRequest(token, { workspace_id: WORKSPACE }), env);
      expect(res.status).toBe(413);
      expect(await res.json()).toEqual(WORKSPACE_FULL_BODY);
      expect(state.capturedInput).toBeNull();
    });

    it('counts the thumbnail part toward the cap', async () => {
      const token = await memberToken();
      const thumb = new Blob([new Uint8Array(10)], { type: 'image/jpeg' });
      const withThumb = (): Request => {
        const form = new FormData();
        form.set('file', new File([new Uint8Array(FILE_BYTES)], 'doc.pdf', { type: MIME.pdf }));
        form.set('workspace_id', WORKSPACE);
        form.set('thumbnail', thumb, 'thumb.jpg');
        return new Request('https://worker.test/', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          body: form,
        });
      };
      usageState.bytes = CAP_BYTES - FILE_BYTES - 10 + 1;
      const over = await worker.fetch(withThumb(), env);
      expect(over.status).toBe(413);
      expect(await over.json()).toEqual(WORKSPACE_FULL_BODY);
      expect(state.capturedInput).toBeNull();

      // File plus thumbnail exactly on the cap is not refused by the cap.
      usageState.bytes = CAP_BYTES - FILE_BYTES - 10;
      expect((await worker.fetch(withThumb(), env)).status).not.toBe(413);
    });

    it('caps a chat upload the same way', async () => {
      const token = await memberToken();
      usageState.bytes = CAP_BYTES;
      const res = await worker.fetch(
        uploadRequest(token, { workspace_id: WORKSPACE, origin: 'chat' }),
        env,
      );
      expect(res.status).toBe(413);
      expect(state.capturedInput).toBeNull();
    });

    it('never caps an exempt owner', async () => {
      const token = await memberToken();
      usageState.bytes = CAP_BYTES;
      usageState.exempt = true;
      const res = await worker.fetch(uploadRequest(token, { workspace_id: WORKSPACE }), env);
      expect(res.status).toBe(201);
    });

    it('fails closed with 503 when usage cannot be read', async () => {
      const token = await memberToken();
      usageState.bytes = null;
      const res = await worker.fetch(uploadRequest(token, { workspace_id: WORKSPACE }), env);
      expect(res.status).toBe(503);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
        'usage_unavailable',
      );
      expect(state.capturedInput).toBeNull();
    });
  });

  describe('POST /multipart/create', () => {
    it('starts an upload under or exactly at the cap', async () => {
      const token = await memberToken();
      usageState.bytes = CAP_BYTES - 10;
      expect((await worker.fetch(createRequest(token, 9), env)).status).toBe(201);
      expect((await worker.fetch(createRequest(token, 10), env)).status).toBe(201);
    });

    it('refuses an upload over the cap and starts nothing in R2', async () => {
      const token = await memberToken();
      usageState.bytes = CAP_BYTES - 10;
      const res = await worker.fetch(createRequest(token, 11), env);
      expect(res.status).toBe(413);
      expect(await res.json()).toEqual(WORKSPACE_FULL_BODY);
      expect(state.r2.uploads.size).toBe(0);
    });

    it('never caps an exempt owner', async () => {
      const token = await memberToken();
      usageState.bytes = CAP_BYTES;
      usageState.exempt = true;
      expect((await worker.fetch(createRequest(token, 11), env)).status).toBe(201);
    });
  });

  describe('POST /multipart/complete', () => {
    it('completes an upload under the cap', async () => {
      const token = await memberToken();
      const created = await staged(token);
      usageState.bytes = 100;
      expect((await worker.fetch(complete(token, created), env)).status).toBe(201);
    });

    it('completes an upload that lands exactly on the cap', async () => {
      const token = await memberToken();
      const created = await staged(token);
      usageState.bytes = CAP_BYTES - FILE_BYTES;
      expect((await worker.fetch(complete(token, created), env)).status).toBe(201);
    });

    it('refuses on the real size, aborts the upload and removes the staging', async () => {
      const token = await memberToken();
      const created = await staged(token);
      // Usage grew after create (another upload landed).
      usageState.bytes = CAP_BYTES - FILE_BYTES + 1;
      const res = await worker.fetch(complete(token, created), env);
      expect(res.status).toBe(413);
      expect(await res.json()).toEqual(WORKSPACE_FULL_BODY);
      expect(state.capturedInput).toBeNull();
      expect(state.r2.uploads.size).toBe(0);
      expect(state.r2.objects.size).toBe(0);
    });

    it('removes an already-assembled staging object when a retried complete is refused', async () => {
      const token = await memberToken();
      const created = await staged(token);
      const [upload] = [...state.r2.uploads.values()];
      await state.r2.completeMultipartUpload({
        bucket: upload!.bucket,
        key: created.key,
        uploadId: created.upload_id,
        parts: [{ partNumber: 1, etag: 'e' }],
      });
      expect(state.r2.objects.size).toBe(1);
      usageState.bytes = CAP_BYTES;
      const res = await worker.fetch(complete(token, created), env);
      expect(res.status).toBe(413);
      expect(state.capturedInput).toBeNull();
      expect(state.r2.objects.size).toBe(0);
    });

    it('never caps an exempt owner', async () => {
      const token = await memberToken();
      const created = await staged(token);
      usageState.bytes = CAP_BYTES;
      usageState.exempt = true;
      expect((await worker.fetch(complete(token, created), env)).status).toBe(201);
    });
  });

  describe('chat origin and gate order', () => {
    it('caps a resumable chat upload at complete, and removes its staging', async () => {
      const token = await memberToken();
      const created = await staged(token);
      usageState.bytes = CAP_BYTES - FILE_BYTES + 1;
      const res = await worker.fetch(complete(token, created, { origin: 'chat' }), env);
      expect(res.status).toBe(413);
      expect(await res.json()).toEqual(WORKSPACE_FULL_BODY);
      expect(state.capturedInput).toBeNull();
      expect(state.r2.uploads.size).toBe(0);
      expect(state.r2.objects.size).toBe(0);
    });

    it('lets an exempt owner finish a resumable chat upload over the cap', async () => {
      const token = await memberToken();
      const created = await staged(token);
      usageState.bytes = CAP_BYTES * 2;
      usageState.exempt = true;
      const res = await worker.fetch(complete(token, created, { origin: 'chat' }), env);
      expect(res.status).toBe(201);
      expect(state.capturedInput).toMatchObject({ origin: 'chat' });
    });

    it('lets an exempt owner post a direct chat upload over the cap', async () => {
      const token = await memberToken();
      usageState.bytes = CAP_BYTES * 2;
      usageState.exempt = true;
      const res = await worker.fetch(
        uploadRequest(token, { workspace_id: WORKSPACE, origin: 'chat' }),
        env,
      );
      expect(res.status).toBe(201);
      expect(state.capturedInput).toMatchObject({ origin: 'chat' });
    });

    it('checks membership before the cap: a non-member gets 403 and no usage read', async () => {
      const token = await mintToken(USER);
      usageState.bytes = CAP_BYTES;
      const direct = await worker.fetch(uploadRequest(token, { workspace_id: WORKSPACE }), env);
      expect(direct.status).toBe(403);
      const create = await worker.fetch(createRequest(token, FILE_BYTES), env);
      expect(create.status).toBe(403);
      expect(usageState.reads).toBe(0);
      expect(state.r2.uploads.size).toBe(0);
    });

    it('fails closed at create and at complete when usage cannot be read', async () => {
      const token = await memberToken();
      const created = await staged(token);
      usageState.bytes = null;
      const create = await worker.fetch(createRequest(token, FILE_BYTES), env);
      expect(create.status).toBe(503);
      const done = await worker.fetch(complete(token, created), env);
      expect(done.status).toBe(503);
      expect(((await done.json()) as { error: { code: string } }).error.code).toBe(
        'usage_unavailable',
      );
      expect(state.capturedInput).toBeNull();
    });

    it('reads usage once per direct POST, before the pipeline', async () => {
      const token = await memberToken();
      const res = await worker.fetch(uploadRequest(token, { workspace_id: WORKSPACE }), env);
      expect(res.status).toBe(201);
      expect(usageState.reads).toBe(1);
    });
  });
});

describe('asset-upload purge routing', () => {
  it.each(['/purge', '/purge-chat'])(
    'routes POST %s to the purge handler (its own body rules)',
    async (path) => {
      const token = await mintToken(USER);
      const res = await worker.fetch(jsonPost(path, token, { workspace_id: 'x' }), env);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: { code: 'bad_request', message: 'Invalid workspace_id.' },
      });
      expect(state.capturedInput).toBeNull();
    },
  );

  it.each(['/purge', '/purge-chat'])('POST %s is 401 without a bearer', async (path) => {
    const res = await worker.fetch(jsonPost(path, null, { workspace_id: WORKSPACE }), env);
    expect(res.status).toBe(401);
  });
});
