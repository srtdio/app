import { beforeAll, describe, expect, it } from 'vitest';
import {
  audioCopyFilename,
  authorizeAndSign,
  fileCacheKey,
  serveFile,
  type AssetReadStore,
  type AssetVersionLocator,
  type FileCache,
  type FileRequest,
  type FileRouteDeps,
  type ReadRenditionRole,
  type RenditionReader,
} from './asset-read';
import { deriveLinkSigningKey, issueLinkKey } from './file-links';

const VERSION = '0199aaaa-0000-7000-8000-000000000001';
const WORKSPACE = '0199bbbb-0000-7000-8000-000000000002';
const ASSET = '0199cccc-0000-7000-8000-000000000003';
const MEMBER = '11111111-1111-7111-8111-111111111111';
const NOW = Date.UTC(2026, 9, 28, 8, 0, 0);
const ORIGIN = 'https://srtd.io';
const BUCKET = 'srtdio-files';
const ORIGINAL_KEY = `ws/${WORKSPACE}/${ASSET}/${VERSION}/original`;
const COPY_KEY = `ws/${WORKSPACE}/${ASSET}/${VERSION}/compressed`;

let signingKey: CryptoKey;
beforeAll(async () => {
  signingKey = await deriveLinkSigningKey('service-role-secret');
});

function voiceVersion(overrides: Partial<AssetVersionLocator> = {}): AssetVersionLocator {
  return {
    workspaceId: WORKSPACE,
    bucket: BUCKET,
    origin: 'chat',
    kind: 'audio',
    r2Key: ORIGINAL_KEY,
    mimeType: 'audio/webm',
    filename: 'voice-note.webm',
    displayName: null,
    ...overrides,
  };
}

function harness(version: AssetVersionLocator, copyKey: string | null) {
  const finds: Array<{ id: string; role: ReadRenditionRole }> = [];
  const signed: string[] = [];
  const fetched: Array<{ url: string; range: string | null }> = [];
  const cacheReads: string[] = [];
  const cacheStore = new Map<string, Response>();
  const pending: Promise<unknown>[] = [];
  const store: AssetReadStore = {
    findVersion: (id) => Promise.resolve(id === VERSION ? version : null),
    isActiveMember: () => Promise.resolve(true),
    isChatAttachmentReadable: () => Promise.resolve(true),
  };
  const renditions: RenditionReader = {
    findRendition: (id, role) => {
      finds.push({ id, role });
      if (role === 'compressed' && copyKey !== null) {
        return Promise.resolve({ r2Key: copyKey, width: null, height: null });
      }
      return Promise.resolve(null);
    },
  };
  const cache: FileCache = {
    match: (key) => {
      cacheReads.push(key);
      return Promise.resolve(cacheStore.get(key)?.clone());
    },
    put: async (key, response) => {
      const body = await response.arrayBuffer();
      cacheStore.set(key, new Response(body, { status: 200, headers: response.headers }));
    },
  };
  const deps: FileRouteDeps = {
    store,
    renditions,
    signer: {
      presignGetUrl: (input) => {
        signed.push(input.key);
        return Promise.resolve(`https://r2.test/${input.bucket}/${input.key}`);
      },
    },
    fetchObject: (url, range) => {
      fetched.push({ url, range });
      if (range !== null) {
        return Promise.resolve(
          new Response('ab', {
            status: 206,
            headers: { 'Content-Length': '2', 'Content-Range': 'bytes 0-1/10' },
          }),
        );
      }
      return Promise.resolve(
        new Response('bytes', {
          status: 200,
          headers: { 'Content-Length': '5', ETag: '"e1"' },
        }),
      );
    },
    cache,
    signingKey,
    waitUntil: (work) => {
      pending.push(work);
    },
    nowMs: () => NOW,
  };
  return { deps, finds, signed, fetched, cacheReads, cacheStore, pending };
}

async function request(overrides: Partial<FileRequest> = {}): Promise<FileRequest> {
  const key = (await issueLinkKey({ userId: MEMBER, nowMs: NOW, signingKey })).key;
  return {
    origin: ORIGIN,
    assetVersionId: VERSION,
    kind: 'full',
    key,
    download: false,
    range: null,
    ...overrides,
  };
}

describe('serveFile: old WebM voice notes', () => {
  it('serves the compressed copy as audio/mp4 under its own cache key', async () => {
    const h = harness(voiceVersion(), COPY_KEY);
    const res = await serveFile(h.deps, await request());
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('audio/mp4');
    expect(h.signed).toEqual([COPY_KEY]);
    expect(h.finds).toEqual([{ id: VERSION, role: 'compressed' }]);
    const copyCacheKey = fileCacheKey(ORIGIN, VERSION, 'full:compressed');
    expect(copyCacheKey).not.toBe(fileCacheKey(ORIGIN, VERSION, 'full'));
    expect(h.cacheReads).toEqual([copyCacheKey]);
    await Promise.all(h.pending);
    expect([...h.cacheStore.keys()]).toEqual([copyCacheKey]);
  });

  it('never returns a WebM cached before conversion', async () => {
    const h = harness(voiceVersion(), COPY_KEY);
    h.cacheStore.set(
      fileCacheKey(ORIGIN, VERSION, 'full'),
      new Response('old-webm', { status: 200, headers: { ETag: '"old"' } }),
    );
    const res = await serveFile(h.deps, await request());
    expect(await res.text()).toBe('bytes');
    expect(h.signed).toEqual([COPY_KEY]);
  });

  it('passes a Range request through to the copy', async () => {
    const h = harness(voiceVersion(), COPY_KEY);
    const res = await serveFile(h.deps, await request({ range: 'bytes=0-1' }));
    expect(res.status).toBe(206);
    expect(res.headers.get('Content-Range')).toBe('bytes 0-1/10');
    expect(res.headers.get('Content-Type')).toBe('audio/mp4');
    expect(h.fetched).toEqual([
      { url: `https://r2.test/${BUCKET}/${COPY_KEY}`, range: 'bytes=0-1' },
    ]);
    expect(h.cacheReads).toEqual([]);
  });

  it('downloads the copy with an .m4a name', async () => {
    const h = harness(voiceVersion(), COPY_KEY);
    const res = await serveFile(h.deps, await request({ download: true }));
    expect(res.headers.get('Content-Disposition')).toContain('filename="voice-note.m4a"');
    expect(audioCopyFilename(voiceVersion({ filename: 'note' }))).toBe('note.m4a');
  });

  it('serves the original exactly as before when there is no copy', async () => {
    const h = harness(voiceVersion(), null);
    const res = await serveFile(h.deps, await request());
    expect(res.headers.get('Content-Type')).toBe('audio/webm');
    expect(h.signed).toEqual([ORIGINAL_KEY]);
    expect(h.cacheReads).toEqual([fileCacheKey(ORIGIN, VERSION, 'full')]);
  });

  it('does no rendition lookup for an mp4 voice note or a photo', async () => {
    for (const version of [
      voiceVersion({ mimeType: 'audio/mp4' }),
      voiceVersion({ kind: 'image', mimeType: 'image/jpeg', origin: 'library' }),
    ]) {
      const h = harness(version, COPY_KEY);
      const res = await serveFile(h.deps, await request());
      expect(res.status).toBe(200);
      expect(h.finds).toEqual([]);
      expect(h.signed).toEqual([ORIGINAL_KEY]);
      expect(h.cacheReads).toEqual([fileCacheKey(ORIGIN, VERSION, 'full')]);
    }
  });

  it('looks up the copy only after the gate passes', async () => {
    const h = harness(voiceVersion(), COPY_KEY);
    h.deps.store.isChatAttachmentReadable = () => Promise.resolve(false);
    const res = await serveFile(h.deps, await request());
    expect(res.status).toBe(403);
    expect(h.finds).toEqual([]);
  });
});

describe('authorizeAndSign: old WebM voice notes', () => {
  const target = { userId: MEMBER, assetVersionId: VERSION };

  it('signs the copy when one exists, with an .m4a download name', async () => {
    const h = harness(voiceVersion(), COPY_KEY);
    const filenames: Array<string | undefined> = [];
    const signer = {
      presignGetUrl: (input: { key: string; downloadFilename?: string }) => {
        h.signed.push(input.key);
        filenames.push(input.downloadFilename);
        return Promise.resolve('https://signed');
      },
    };
    const inline = await authorizeAndSign(
      { store: h.deps.store, signer, renditions: h.deps.renditions },
      target,
    );
    const download = await authorizeAndSign(
      { store: h.deps.store, signer, renditions: h.deps.renditions },
      { ...target, disposition: 'attachment' },
    );
    expect(inline.ok && download.ok).toBe(true);
    expect(h.signed).toEqual([COPY_KEY, COPY_KEY]);
    expect(filenames).toEqual([undefined, 'voice-note.m4a']);
  });

  it('signs the original when there is no copy, and skips the read for other files', async () => {
    const none = harness(voiceVersion(), null);
    await authorizeAndSign(
      { store: none.deps.store, signer: none.deps.signer, renditions: none.deps.renditions },
      target,
    );
    expect(none.signed).toEqual([ORIGINAL_KEY]);

    const pdf = harness(voiceVersion({ kind: 'pdf', mimeType: 'application/pdf' }), COPY_KEY);
    await authorizeAndSign(
      { store: pdf.deps.store, signer: pdf.deps.signer, renditions: pdf.deps.renditions },
      target,
    );
    expect(pdf.finds).toEqual([]);
    expect(pdf.signed).toEqual([ORIGINAL_KEY]);
  });
});
