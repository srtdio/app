// Boundary coverage for the asset migration step. No database, no network, no
// real R2: buildAssetPlan is driven with a mock fetch + an in-test storage stub,
// and the pure helpers are asserted directly. Mirrors the offline style of the
// rest of the etl suite.

import { describe, expect, it } from 'vitest';

import {
  buildAssetPlan,
  type FetchResult,
  type MediaItem,
  type PlanContext,
} from '../../packages/etl/src/assets';
import {
  filenameFromUrl,
  linkLabel,
  mimeToKind,
  normalizeMediaPath,
  parseMediaUrls,
  sniffMime,
} from '../../packages/etl/src/transform';

const CTX: PlanContext = {
  workspaceId: '0190a000-0000-7000-8000-0000000000ws',
  operatorUserId: '0190a000-0000-7000-8000-0000000000op',
  bucket: 'assets-test',
  traceId: '0190a000-0000-7000-8000-0000000000tr',
};

// Minimal JPEG: the FF D8 FF magic plus padding so size_bytes > 0 and the sniffer
// classifies it as image/jpeg.
function jpeg(tag: number): Uint8Array {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, tag, tag, tag, tag]);
}

interface StoredObject {
  key: string;
  contentType: string;
  size: number;
}

// A StorageClient stand-in that records uploads. Structurally matches the
// interface buildAssetPlan expects, so no @srtdio/storage import is needed.
function storageStub() {
  const objects: StoredObject[] = [];
  const storage = {
    ensureBucket: (): Promise<void> => Promise.resolve(),
    putObject: (input: {
      bucket: string;
      key: string;
      body: Uint8Array;
      contentType: string;
      traceId: string;
    }): Promise<void> => {
      objects.push({ key: input.key, contentType: input.contentType, size: input.body.length });
      return Promise.resolve();
    },
  };
  return { storage, objects };
}

// A fetch stub keyed by URL, counting calls so dedup (which avoids re-fetching)
// is observable.
function fetchStub(map: Record<string, Uint8Array>) {
  const calls: string[] = [];
  const fetchBytes = (url: string): Promise<FetchResult> => {
    calls.push(url);
    const bytes = map[url];
    if (bytes === undefined) return Promise.resolve({ ok: false, status: 404 });
    return Promise.resolve({ ok: true, bytes });
  };
  return { fetchBytes, calls };
}

const fileItem = (url: string, position: number): MediaItem => ({
  type: 'file',
  url,
  entityType: 'post',
  entityId: '0190a000-0000-7000-8000-00000000post',
  position,
});

describe('parseMediaUrls (comment-attachment 4 shapes)', () => {
  it('A: native array of url strings', () => {
    expect(parseMediaUrls(['https://x.io/a.jpg', 'https://x.io/b.png'])).toEqual([
      'https://x.io/a.jpg',
      'https://x.io/b.png',
    ]);
  });
  it('A: drops non-http and empty entries', () => {
    expect(parseMediaUrls(['https://x.io/a.jpg', 'not-a-url', '', null])).toEqual([
      'https://x.io/a.jpg',
    ]);
  });
  it('B: object with urls array', () => {
    expect(parseMediaUrls({ type: 'images', urls: ['https://x.io/a.jpg'] })).toEqual([
      'https://x.io/a.jpg',
    ]);
  });
  it('B: object with null urls -> empty', () => {
    expect(parseMediaUrls({ type: 'image', urls: null })).toEqual([]);
  });
  it('C: double-encoded array (often empty)', () => {
    expect(parseMediaUrls('[]')).toEqual([]);
    expect(parseMediaUrls('["https://x.io/a.jpg"]')).toEqual(['https://x.io/a.jpg']);
  });
  it('D: double-encoded object', () => {
    expect(parseMediaUrls('{"type":"images","urls":["https://x.io/a.jpg"]}')).toEqual([
      'https://x.io/a.jpg',
    ]);
  });
  it('returns empty for null / garbage', () => {
    expect(parseMediaUrls(null)).toEqual([]);
    expect(parseMediaUrls('not json')).toEqual([]);
    expect(parseMediaUrls(42)).toEqual([]);
  });
});

describe('normalizeMediaPath / filenameFromUrl / linkLabel', () => {
  it('collapses two hosts of the same bucket to one path', () => {
    const a = 'https://images.srtd.io/ws/abc/photo.jpg';
    const b = 'https://pub-deadbeef.r2.dev/ws/abc/photo.jpg';
    expect(normalizeMediaPath(a)).toBe('/ws/abc/photo.jpg');
    expect(normalizeMediaPath(a)).toBe(normalizeMediaPath(b));
  });
  it('derives the filename from the last path segment', () => {
    expect(filenameFromUrl('https://x.io/a/b/photo.jpg')).toBe('photo.jpg');
    expect(filenameFromUrl('https://x.io/')).toBe('file');
  });
  it('labels a link by host', () => {
    expect(linkLabel('https://drive.google.com/file/d/abc')).toBe('drive.google.com');
  });
});

describe('sniffMime + mimeToKind', () => {
  it('sniffs jpeg/png/gif/webp/pdf/mp4 by magic bytes', () => {
    expect(sniffMime(new Uint8Array([0xff, 0xd8, 0xff]), 'x')).toBe('image/jpeg');
    expect(sniffMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]), 'x')).toBe('image/png');
    expect(sniffMime(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0, 0]), 'x')).toBe('image/gif');
    expect(sniffMime(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]), 'x')).toBe('application/pdf');
    const mp4 = new Uint8Array([0, 0, 0, 0, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
    expect(sniffMime(mp4, 'x')).toBe('video/mp4');
  });
  it('falls back to the extension, else octet-stream', () => {
    expect(sniffMime(new Uint8Array([1, 2, 3]), 'clip.mov')).toBe('video/quicktime');
    expect(sniffMime(new Uint8Array([1, 2, 3]), 'mystery.bin')).toBe('application/octet-stream');
  });
  it('maps allowed mimes to kinds', () => {
    expect(mimeToKind('image/jpeg')).toBe('image');
    expect(mimeToKind('image/svg+xml')).toBe('image');
    expect(mimeToKind('video/mp4')).toBe('video');
    expect(mimeToKind('application/pdf')).toBe('pdf');
  });
});

describe('buildAssetPlan row shaping', () => {
  it('shapes a file version with bytes and a link version with external_url', async () => {
    const { storage } = storageStub();
    const { fetchBytes } = fetchStub({ 'https://x.io/a.jpg': jpeg(1) });
    const items: MediaItem[] = [
      fileItem('https://x.io/a.jpg', 0),
      {
        type: 'link',
        url: 'https://drive.google.com/d/abc',
        entityType: 'post',
        entityId: 'p',
        position: 1,
      },
    ];

    const plan = await buildAssetPlan(items, CTX, { storage, fetchBytes });

    expect(plan.assetRows).toHaveLength(2);
    expect(plan.versionRows).toHaveLength(2);
    expect(plan.attachmentRows).toHaveLength(2);

    const fileV = plan.versionRows.find((v) => v.kind !== 'link');
    const linkV = plan.versionRows.find((v) => v.kind === 'link');

    // non-link: bytes present, external_url null (kind_shape compliance).
    // Key layout groups by kind with a version-prefixed filename, no ws prefix.
    expect(fileV?.r2_key).toBe(`images/${fileV?.asset_id}/v1-a.jpg`);
    expect(fileV?.mime_type).toBe('image/jpeg');
    expect(fileV?.sha256).toBeTypeOf('string');
    expect(fileV?.size_bytes).toBe(8);
    expect(fileV?.external_url).toBeNull();

    // link: external_url present, bytes columns null (kind_shape compliance).
    expect(linkV?.external_url).toBe('https://drive.google.com/d/abc');
    expect(linkV?.size_bytes).toBeNull();
    expect(linkV?.r2_key).toBeNull();
    expect(linkV?.mime_type).toBeNull();
    expect(linkV?.sha256).toBeNull();

    expect(plan.summary).toMatchObject({ filesMigrated: 1, linksMigrated: 1, failed: 0 });
  });

  it('skips a non-http link, counted but not migrated', async () => {
    const { storage } = storageStub();
    const { fetchBytes } = fetchStub({});
    const items: MediaItem[] = [
      { type: 'link', url: 'see attached', entityType: 'post', entityId: 'p', position: 0 },
    ];

    const plan = await buildAssetPlan(items, CTX, { storage, fetchBytes });

    expect(plan.versionRows).toHaveLength(0);
    expect(plan.summary.skipped).toBe(1);
    expect(plan.summary.linksMigrated).toBe(0);
  });

  it('records a fetch failure and continues', async () => {
    const { storage } = storageStub();
    const { fetchBytes } = fetchStub({ 'https://x.io/ok.jpg': jpeg(2) });
    const items: MediaItem[] = [
      fileItem('https://x.io/missing.jpg', 0),
      fileItem('https://x.io/ok.jpg', 1),
    ];

    const plan = await buildAssetPlan(items, CTX, { storage, fetchBytes });

    expect(plan.summary.filesMigrated).toBe(1);
    expect(plan.summary.failed).toBe(1);
    expect(plan.failures[0]?.reason).toBe('fetch_failed_404');
  });

  it('rejects a disallowed mime via the isAllowedMime gate', async () => {
    const { storage, objects } = storageStub();
    const { fetchBytes } = fetchStub({ 'https://x.io/data.bin': new Uint8Array([1, 2, 3, 4]) });
    const plan = await buildAssetPlan([fileItem('https://x.io/data.bin', 0)], CTX, {
      storage,
      fetchBytes,
    });

    expect(objects).toHaveLength(0);
    expect(plan.versionRows).toHaveLength(0);
    expect(plan.summary.failed).toBe(1);
    expect(plan.failures[0]?.reason).toBe('mime_not_allowed');
  });
});

describe('buildAssetPlan dedup', () => {
  it('sha-dedups identical bytes across two hosts: one version, two attachments', async () => {
    const { storage, objects } = storageStub();
    // Same bytes, different host AND path -> path dedup misses, sha dedup hits.
    const { fetchBytes, calls } = fetchStub({
      'https://images.srtd.io/a/photo.jpg': jpeg(9),
      'https://pub-x.r2.dev/b/photo.jpg': jpeg(9),
    });
    const items: MediaItem[] = [
      fileItem('https://images.srtd.io/a/photo.jpg', 0),
      fileItem('https://pub-x.r2.dev/b/photo.jpg', 1),
    ];

    const plan = await buildAssetPlan(items, CTX, { storage, fetchBytes });

    expect(plan.assetRows).toHaveLength(1);
    expect(plan.versionRows).toHaveLength(1);
    expect(plan.attachmentRows).toHaveLength(2);
    expect(objects).toHaveLength(1); // uploaded once
    expect(calls).toHaveLength(2); // fetched both (sha is post-fetch)
    expect(plan.summary).toMatchObject({ filesMigrated: 1, deduped: 1 });
  });

  it('path-dedups the same url without re-fetching', async () => {
    const { storage } = storageStub();
    const { fetchBytes, calls } = fetchStub({ 'https://x.io/a.jpg': jpeg(3) });
    const items: MediaItem[] = [
      fileItem('https://x.io/a.jpg', 0),
      fileItem('https://x.io/a.jpg', 1),
    ];

    const plan = await buildAssetPlan(items, CTX, { storage, fetchBytes });

    expect(plan.versionRows).toHaveLength(1);
    expect(plan.attachmentRows).toHaveLength(2);
    expect(calls).toHaveLength(1); // second occurrence skipped the fetch
    expect(plan.summary.deduped).toBe(1);
  });

  it('attaches the deduped asset to the second entity at its own position', async () => {
    const { storage } = storageStub();
    const { fetchBytes } = fetchStub({ 'https://x.io/a.jpg': jpeg(4) });
    const items: MediaItem[] = [
      fileItem('https://x.io/a.jpg', 0),
      fileItem('https://x.io/a.jpg', 3),
    ];

    const plan = await buildAssetPlan(items, CTX, { storage, fetchBytes });
    const positions = plan.attachmentRows.map((r) => r.position).sort();
    expect(positions).toEqual([0, 3]);
    // both attachments point at the single version
    const versionId = plan.versionRows[0]?.id;
    expect(plan.attachmentRows.every((r) => r.asset_version_id === versionId)).toBe(true);
  });
});
