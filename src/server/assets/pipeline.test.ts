import { describe, expect, it } from 'vitest';
import {
  THUMBNAIL_MAX_BYTES,
  THUMBNAIL_MAX_PAGE_COUNT,
  checkThumbnail,
  parsePageCount,
  runUploadPipeline,
  storeThumbnailRendition,
  type PipelineDeps,
} from './pipeline';
import {
  InMemoryAssetRepository,
  InMemoryRenditionStore,
  type NewRendition,
  type RenditionStore,
} from './repository';
import { NoOpScanner } from './virus-scan';
import type { AssetSummary, UploadInput } from './types';
import { InMemoryStorageClient, computeSha256, type PutObjectInput } from '@srtdio/storage';

const WORKSPACE = '11111111-1111-7111-8111-111111111111';
const USER = '33333333-3333-7333-8333-333333333333';
const TRACE = '0192f8a0-7d3e-7c4b-9a1f-2b3c4d5e6f70';

function deps(): PipelineDeps & {
  storage: InMemoryStorageClient;
  repository: InMemoryAssetRepository;
} {
  return {
    storage: new InMemoryStorageClient(),
    repository: new InMemoryAssetRepository(),
    scanner: new NoOpScanner(),
  };
}

function input(overrides: Partial<UploadInput> = {}): UploadInput {
  return {
    workspaceId: WORKSPACE,
    uploadedBy: USER,
    filename: 'photo.png',
    contentType: 'image/png',
    bytes: pngBytes(100, 50),
    traceId: TRACE,
    origin: 'library',
    ...overrides,
  };
}

/** A PNG whose IHDR declares the given size (magic bytes + dimensions). */
function pngBytes(width: number, height: number): Uint8Array {
  return Uint8Array.from([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    0x00,
    0x00,
    0x00,
    0x0d,
    0x49,
    0x48,
    0x44,
    0x52,
    (width >>> 24) & 0xff,
    (width >>> 16) & 0xff,
    (width >>> 8) & 0xff,
    width & 0xff,
    (height >>> 24) & 0xff,
    (height >>> 16) & 0xff,
    (height >>> 8) & 0xff,
    height & 0xff,
  ]);
}

/** A JPEG with an SOF0 frame header that survives EXIF stripping. */
function jpegBytes(width: number, height: number): Uint8Array {
  return Uint8Array.from([
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
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0xff,
    0xd9,
  ]);
}

describe('runUploadPipeline image dimensions', () => {
  it('persists non-null width and height for a PNG upload', async () => {
    const d = deps();
    const res = await runUploadPipeline(d, input({ bytes: pngBytes(640, 480) }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const version = d.repository.versions[0];
    expect(version?.width).toBe(640);
    expect(version?.height).toBe(480);
  });

  it('probes the sanitized JPEG bytes (post EXIF-strip) for dimensions', async () => {
    const d = deps();
    const res = await runUploadPipeline(
      d,
      input({ filename: 'photo.jpg', contentType: 'image/jpeg', bytes: jpegBytes(800, 600) }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const version = d.repository.versions[0];
    expect(version?.width).toBe(800);
    expect(version?.height).toBe(600);
  });

  it('carries dimensions onto a new version of an existing asset', async () => {
    const d = deps();
    const first = await runUploadPipeline(d, input({ bytes: pngBytes(100, 100) }));
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = await runUploadPipeline(
      d,
      input({ bytes: pngBytes(200, 300), assetId: first.value.assetId }),
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    const version = d.repository.versions.find((v) => v.id === second.value.versionId);
    expect(version?.version_number).toBe(2);
    expect(version?.width).toBe(200);
    expect(version?.height).toBe(300);
  });

  it('completes the upload with null width and height when the probe fails', async () => {
    const d = deps();
    // A valid JPEG signature (FF D8 FF) with no SOF frame header: an APP0
    // segment then EOI. Passes the allowlist and magic-byte check, but the
    // dimension probe finds no frame and stores nulls without failing.
    const noFrame = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xd9]);
    const res = await runUploadPipeline(
      d,
      input({ filename: 'broken.jpg', contentType: 'image/jpeg', bytes: noFrame }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const version = d.repository.versions[0];
    expect(version).toBeDefined();
    expect(version?.width).toBeNull();
    expect(version?.height).toBeNull();
  });
});

describe('runUploadPipeline audio kind', () => {
  // Minimal leading bytes that pass the magic-byte check for each voice-note format.
  const cases: ReadonlyArray<{ contentType: string; filename: string; bytes: Uint8Array }> = [
    {
      contentType: 'audio/mp4',
      filename: 'note.m4a',
      // 4-byte box size, then the "ftyp" box type and an "M4A " brand.
      bytes: Uint8Array.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20]),
    },
    {
      contentType: 'audio/webm',
      filename: 'note.webm',
      bytes: Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01]),
    },
    {
      contentType: 'audio/mpeg',
      filename: 'note.mp3',
      bytes: Uint8Array.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
    },
  ];

  for (const c of cases) {
    it(`stores ${c.contentType} as kind 'audio' with null dimensions`, async () => {
      const d = deps();
      const res = await runUploadPipeline(
        d,
        input({ filename: c.filename, contentType: c.contentType, bytes: c.bytes }),
      );
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      const version = d.repository.versions[0];
      expect(version).toBeDefined();
      expect(version?.kind).toBe('audio');
      expect(version?.mime_type).toBe(c.contentType);
      expect(version?.width).toBeNull();
      expect(version?.height).toBeNull();
    });
  }
});

// ---------------------------------------------------------------------------
// Thumbnail rendition (sender-made JPEG for a pdf/video upload).
// ---------------------------------------------------------------------------

const ASSET = '55555555-5555-7555-8555-555555555555';
const VERSION = '66666666-6666-7666-8666-666666666666';

/**
 * A minimal baseline JPEG: SOI, an SOF0 segment declaring the given size with
 * three components, zero padding up to `padTo` bytes, then EOI.
 */
function jpeg(width: number, height: number, padTo = 0): Uint8Array {
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

function summary(overrides: Partial<AssetSummary> = {}): AssetSummary {
  return {
    assetId: ASSET,
    versionId: VERSION,
    versionNumber: 1,
    workspaceId: WORKSPACE,
    filename: 'brief.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 10,
    sha256: 'a'.repeat(64),
    r2Key: `pdf/${ASSET}/v1-brief.pdf`,
    reused: false,
    ...overrides,
  };
}

function thumbDeps(): {
  storage: InMemoryStorageClient;
  repository: InMemoryAssetRepository;
  renditions: InMemoryRenditionStore;
} {
  return {
    storage: new InMemoryStorageClient(),
    repository: new InMemoryAssetRepository(),
    renditions: new InMemoryRenditionStore(),
  };
}

function thumbInput(
  overrides: Partial<{
    summary: AssetSummary;
    bytes: Uint8Array;
    pageCountField: string | null;
  }> = {},
): { summary: AssetSummary; bytes: Uint8Array; pageCountField: string | null; traceId: string } {
  return {
    summary: summary(),
    bytes: jpeg(400, 566),
    pageCountField: '12',
    traceId: TRACE,
    ...overrides,
  };
}

describe('parsePageCount', () => {
  it('treats an absent field as null', () => {
    expect(parsePageCount(null)).toBeNull();
  });

  it('accepts a decimal 1..10000', () => {
    expect(parsePageCount('1')).toBe(1);
    expect(parsePageCount('42')).toBe(42);
    expect(parsePageCount('10000')).toBe(THUMBNAIL_MAX_PAGE_COUNT);
  });

  it('rejects zero, out of range, and non-decimal values', () => {
    for (const bad of [
      '0',
      '10001',
      '99999',
      '123456',
      '-1',
      '1.5',
      '1e3',
      'abc',
      '',
      ' 3',
      '0x10',
    ]) {
      expect(parsePageCount(bad)).toBe('invalid');
    }
  });
});

describe('checkThumbnail', () => {
  it('accepts a pdf parent with a valid jpeg and keeps the page count', () => {
    expect(checkThumbnail(thumbInput())).toEqual({
      ok: true,
      width: 400,
      height: 566,
      pageCount: 12,
    });
  });

  it('reads the frame size from the bytes, not from any client claim', () => {
    const result = checkThumbnail(thumbInput({ bytes: jpeg(123, 456) }));
    expect(result).toMatchObject({ ok: true, width: 123, height: 456 });
  });

  it('accepts a pdf parent whose mime carries parameters', () => {
    const result = checkThumbnail(
      thumbInput({ summary: summary({ mimeType: 'application/pdf; charset=binary' }) }),
    );
    expect(result.ok).toBe(true);
  });

  it('accepts a video parent and drops the page count', () => {
    for (const mimeType of ['video/mp4', 'video/quicktime']) {
      expect(checkThumbnail(thumbInput({ summary: summary({ mimeType }) }))).toEqual({
        ok: true,
        width: 400,
        height: 566,
        pageCount: null,
      });
    }
  });

  it('accepts a docx or xlsx parent (decision 154) and drops the page count', () => {
    for (const mimeType of [
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ]) {
      expect(checkThumbnail(thumbInput({ summary: summary({ mimeType }) }))).toEqual({
        ok: true,
        width: 400,
        height: 566,
        pageCount: null,
      });
      // The JPEG checks are unchanged for an office parent.
      expect(
        checkThumbnail(thumbInput({ summary: summary({ mimeType }), bytes: jpeg(600, 100) })),
      ).toEqual({ ok: false, reason: 'dimensions' });
    }
  });

  it('accepts a raster image parent (its list copy), with no page count', () => {
    for (const mimeType of ['image/png', 'image/jpeg', 'image/webp']) {
      expect(
        checkThumbnail(
          thumbInput({
            summary: summary({ mimeType }),
            bytes: jpeg(320, 400),
            pageCountField: '3',
          }),
        ),
      ).toEqual({ ok: true, width: 320, height: 400, pageCount: null });
    }
  });

  it('rejects an svg, pptx or audio parent', () => {
    for (const mimeType of [
      'image/svg+xml',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'audio/mp4',
    ]) {
      expect(checkThumbnail(thumbInput({ summary: summary({ mimeType }) }))).toEqual({
        ok: false,
        reason: 'parent_not_pdf_or_video',
      });
    }
  });

  it('rejects empty bytes and bytes over 300 KiB, accepts exactly 300 KiB', () => {
    expect(checkThumbnail(thumbInput({ bytes: new Uint8Array(0) }))).toEqual({
      ok: false,
      reason: 'size',
    });
    expect(checkThumbnail(thumbInput({ bytes: jpeg(100, 100, THUMBNAIL_MAX_BYTES + 1) }))).toEqual({
      ok: false,
      reason: 'size',
    });
    expect(checkThumbnail(thumbInput({ bytes: jpeg(100, 100, THUMBNAIL_MAX_BYTES) })).ok).toBe(
      true,
    );
    expect(THUMBNAIL_MAX_BYTES).toBe(300 * 1024);
  });

  it('rejects bytes that do not start FF D8 FF', () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(checkThumbnail(thumbInput({ bytes: png }))).toEqual({ ok: false, reason: 'not_jpeg' });
    const bad = jpeg(100, 100);
    bad[2] = 0x00;
    expect(checkThumbnail(thumbInput({ bytes: bad }))).toEqual({ ok: false, reason: 'not_jpeg' });
  });

  it('rejects a jpeg with no SOF frame', () => {
    const noFrame = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xd9]);
    expect(checkThumbnail(thumbInput({ bytes: noFrame }))).toEqual({
      ok: false,
      reason: 'no_frame',
    });
  });

  it('caps the frame at 580 x 1160', () => {
    expect(checkThumbnail(thumbInput({ bytes: jpeg(580, 1160) })).ok).toBe(true);
    expect(checkThumbnail(thumbInput({ bytes: jpeg(581, 100) }))).toEqual({
      ok: false,
      reason: 'dimensions',
    });
    expect(checkThumbnail(thumbInput({ bytes: jpeg(600, 100) }))).toEqual({
      ok: false,
      reason: 'dimensions',
    });
    expect(checkThumbnail(thumbInput({ bytes: jpeg(100, 1161) }))).toEqual({
      ok: false,
      reason: 'dimensions',
    });
  });

  it('accepts an absent page count and rejects an invalid one', () => {
    expect(checkThumbnail(thumbInput({ pageCountField: null }))).toMatchObject({
      ok: true,
      pageCount: null,
    });
    for (const bad of ['0', '10001', '2.5', 'many']) {
      expect(checkThumbnail(thumbInput({ pageCountField: bad }))).toEqual({
        ok: false,
        reason: 'page_count',
      });
    }
  });
});

describe('storeThumbnailRendition', () => {
  it('puts the jpeg at {kindFolder}/{asset}/v{n}-thumb.jpg and inserts one row', async () => {
    const d = thumbDeps();
    const bytes = jpeg(400, 566);
    const outcome = await storeThumbnailRendition(d, thumbInput({ bytes }));
    expect(outcome).toEqual({ stored: true, width: 400, height: 566, pageCount: 12 });

    const key = `pdf/${ASSET}/v1-thumb.jpg`;
    const object = d.storage.get('assets-test-ws', key);
    expect(object?.contentType).toBe('image/jpeg');
    expect(object?.body).toEqual(bytes);
    expect(d.storage.objects.size).toBe(1);

    expect(d.renditions.rows).toHaveLength(1);
    const row = d.renditions.rows[0];
    expect(row).toMatchObject({
      assetVersionId: VERSION,
      workspaceId: WORKSPACE,
      role: 'thumbnail',
      r2Key: key,
      mimeType: 'image/jpeg',
      sizeBytes: bytes.byteLength,
      width: 400,
      height: 566,
    });
    expect(row?.sha256).toBe(await computeSha256(bytes));
    expect(row?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('writes into the workspace bucket resolved from the repository', async () => {
    const d = thumbDeps();
    d.repository.assetBuckets.set(WORKSPACE, 'assets-acme');
    await storeThumbnailRendition(d, thumbInput());
    expect(d.storage.get('assets-acme', `pdf/${ASSET}/v1-thumb.jpg`)).toBeDefined();
    expect(d.storage.get('assets-test-ws', `pdf/${ASSET}/v1-thumb.jpg`)).toBeUndefined();
  });

  it('keys a docx or xlsx thumbnail next to its file and drops the page count', async () => {
    const cases = [
      ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docs'],
      ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'spreadsheet'],
    ] as const;
    for (const [mimeType, folder] of cases) {
      const d = thumbDeps();
      const outcome = await storeThumbnailRendition(
        d,
        thumbInput({ summary: summary({ mimeType, r2Key: `${folder}/${ASSET}/v1-a` }) }),
      );
      expect(outcome).toEqual({ stored: true, width: 400, height: 566 });
      expect(d.storage.get('assets-test-ws', `${folder}/${ASSET}/v1-thumb.jpg`)).toBeDefined();
    }
  });

  it('a pptx parent writes nothing', async () => {
    const d = thumbDeps();
    const mimeType = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    const outcome = await storeThumbnailRendition(
      d,
      thumbInput({ summary: summary({ mimeType }) }),
    );
    expect(outcome).toEqual({ stored: false, reason: 'parent_not_pdf_or_video' });
    expect(d.renditions.rows).toHaveLength(0);
  });

  it('omits pageCount when the field is absent', async () => {
    const d = thumbDeps();
    const outcome = await storeThumbnailRendition(d, thumbInput({ pageCountField: null }));
    expect(outcome).toEqual({ stored: true, width: 400, height: 566 });
    expect('pageCount' in outcome).toBe(false);
  });

  it('keys a video thumbnail under videos/ and drops the page count', async () => {
    const d = thumbDeps();
    const outcome = await storeThumbnailRendition(
      d,
      thumbInput({
        summary: summary({
          mimeType: 'video/mp4',
          versionNumber: 2,
          r2Key: `videos/${ASSET}/v2-clip.mp4`,
        }),
        pageCountField: '7',
      }),
    );
    expect(outcome).toEqual({ stored: true, width: 400, height: 566 });
    expect(d.storage.get('assets-test-ws', `videos/${ASSET}/v2-thumb.jpg`)).toBeDefined();
    expect(d.renditions.rows[0]?.r2Key).toBe(`videos/${ASSET}/v2-thumb.jpg`);
  });

  it('ignores an invalid thumbnail without writing anything', async () => {
    const cases: ReadonlyArray<[string, ReturnType<typeof thumbInput>]> = [
      ['parent_not_pdf_or_video', thumbInput({ summary: summary({ mimeType: 'image/svg+xml' }) })],
      ['size', thumbInput({ bytes: jpeg(100, 100, THUMBNAIL_MAX_BYTES + 1) })],
      ['not_jpeg', thumbInput({ bytes: Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d]) })],
      ['dimensions', thumbInput({ bytes: jpeg(600, 100) })],
      ['page_count', thumbInput({ pageCountField: '0' })],
    ];
    for (const [reason, inputValue] of cases) {
      const d = thumbDeps();
      const outcome = await storeThumbnailRendition(d, inputValue);
      expect(outcome).toEqual({ stored: false, reason });
      expect(d.storage.objects.size).toBe(0);
      expect(d.renditions.rows).toHaveLength(0);
    }
  });

  it('dedups: an existing rendition returns its size without a put or a second row', async () => {
    const d = thumbDeps();
    await storeThumbnailRendition(d, thumbInput({ bytes: jpeg(300, 424) }));
    d.storage.objects.clear();

    const outcome = await storeThumbnailRendition(
      d,
      thumbInput({ summary: summary({ reused: true }), bytes: jpeg(500, 700) }),
    );
    expect(outcome).toEqual({ stored: true, width: 300, height: 424, pageCount: 12 });
    expect(d.renditions.rows).toHaveLength(1);
    expect(d.storage.objects.size).toBe(0);
  });

  it('reports an existing rendition without a size as not stored', async () => {
    const d = thumbDeps();
    const renditions: RenditionStore = {
      findRendition: () =>
        Promise.resolve({ r2Key: `pdf/${ASSET}/v1-thumb.jpg`, width: null, height: null }),
      insertRendition: () => Promise.reject(new Error('must not insert')),
    };
    const outcome = await storeThumbnailRendition({ ...d, renditions }, thumbInput());
    expect(outcome).toEqual({ stored: false, reason: 'existing_without_size' });
    expect(d.storage.objects.size).toBe(0);
  });

  it('never overwrites an uploaded file whose key collides with the thumbnail key', async () => {
    const d = thumbDeps();
    const outcome = await storeThumbnailRendition(
      d,
      thumbInput({
        summary: summary({ filename: 'thumb.jpg', r2Key: `pdf/${ASSET}/v1-thumb.jpg` }),
      }),
    );
    expect(outcome).toEqual({ stored: false, reason: 'key_collision' });
    expect(d.storage.objects.size).toBe(0);
    expect(d.renditions.rows).toHaveLength(0);
  });

  it('puts the R2 object before inserting the row', async () => {
    const order: string[] = [];
    class LoggingStorage extends InMemoryStorageClient {
      override putObject(input: PutObjectInput): Promise<void> {
        order.push('put');
        return super.putObject(input);
      }
    }
    class LoggingRenditions extends InMemoryRenditionStore {
      override insertRendition(rendition: NewRendition): Promise<boolean> {
        order.push('insert');
        return super.insertRendition(rendition);
      }
    }
    const outcome = await storeThumbnailRendition(
      {
        storage: new LoggingStorage(),
        repository: new InMemoryAssetRepository(),
        renditions: new LoggingRenditions(),
      },
      thumbInput(),
    );
    expect(outcome.stored).toBe(true);
    expect(order).toEqual(['put', 'insert']);
  });

  it('throws on an insert fault, leaving the already-put object as an orphan', async () => {
    const d = thumbDeps();
    d.renditions.failInsert = new Error('db down');
    await expect(storeThumbnailRendition(d, thumbInput())).rejects.toThrow('db down');
    expect(d.storage.get('assets-test-ws', `pdf/${ASSET}/v1-thumb.jpg`)).toBeDefined();
    expect(d.renditions.rows).toHaveLength(0);
  });

  it('throws on a put fault and never inserts a row', async () => {
    const d = thumbDeps();
    class FailingStorage extends InMemoryStorageClient {
      override putObject(): Promise<void> {
        return Promise.reject(new Error('r2 down'));
      }
    }
    await expect(
      storeThumbnailRendition({ ...d, storage: new FailingStorage() }, thumbInput()),
    ).rejects.toThrow('r2 down');
    expect(d.renditions.rows).toHaveLength(0);
  });

  it('reports the winner when a concurrent upload won the insert', async () => {
    let finds = 0;
    const racing: RenditionStore = {
      findRendition: () => {
        finds += 1;
        return Promise.resolve(
          finds === 1 ? null : { r2Key: `pdf/${ASSET}/v1-thumb.jpg`, width: 200, height: 283 },
        );
      },
      insertRendition: () => Promise.resolve(false),
    };
    const d = thumbDeps();
    const outcome = await storeThumbnailRendition({ ...d, renditions: racing }, thumbInput());
    expect(outcome).toEqual({ stored: true, width: 200, height: 283, pageCount: 12 });
    expect(finds).toBe(2);
  });

  it('reports a lost insert with no readable winner as a conflict', async () => {
    const racing: RenditionStore = {
      findRendition: () => Promise.resolve(null),
      insertRendition: () => Promise.resolve(false),
    };
    const d = thumbDeps();
    const outcome = await storeThumbnailRendition({ ...d, renditions: racing }, thumbInput());
    expect(outcome).toEqual({ stored: false, reason: 'conflict' });
  });
});

describe('storeThumbnailRendition page count', () => {
  async function seeded(kind: 'pdf' | 'video', pageCount: number | null = null) {
    const d = thumbDeps();
    await d.repository.insertVersion({
      id: VERSION,
      assetId: ASSET,
      workspaceId: WORKSPACE,
      versionNumber: 1,
      kind,
      r2Key: `${kind}/${ASSET}/v1-a`,
      mimeType: kind === 'pdf' ? 'application/pdf' : 'video/mp4',
      sha256: 'a'.repeat(64),
      sizeBytes: 10,
      uploadedBy: USER,
    });
    const row = d.repository.versions[0];
    if (row !== undefined) row.page_count = pageCount;
    return d;
  }

  it('writes page_count on a pdf version', async () => {
    const d = await seeded('pdf');
    await storeThumbnailRendition(d, thumbInput());
    expect(d.repository.versions[0]?.page_count).toBe(12);
  });

  it('never writes page_count for a non-pdf version', async () => {
    const d = await seeded('video');
    const video = summary({ mimeType: 'video/mp4', r2Key: `videos/${ASSET}/v1-a.mp4` });
    await storeThumbnailRendition(d, thumbInput({ summary: video, pageCountField: '7' }));
    expect(d.repository.versions[0]?.page_count).toBeNull();
  });

  it('a dedup fills a null page_count once and never overwrites it', async () => {
    const d = await seeded('pdf');
    const reused = summary({ reused: true });
    await storeThumbnailRendition(d, thumbInput({ summary: reused, pageCountField: '5' }));
    expect(d.repository.versions[0]?.page_count).toBe(5);
    await storeThumbnailRendition(d, thumbInput({ summary: reused, pageCountField: '9' }));
    expect(d.repository.versions[0]?.page_count).toBe(5);
  });

  it('a page count fault never fails the thumbnail', async () => {
    const d = await seeded('pdf');
    d.repository.setVersionPageCount = () => Promise.reject(new Error('db down'));
    const outcome = await storeThumbnailRendition(d, thumbInput());
    expect(outcome).toEqual({ stored: true, width: 400, height: 566, pageCount: 12 });
  });
});
