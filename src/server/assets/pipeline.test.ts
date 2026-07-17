import { describe, expect, it } from 'vitest';
import { runUploadPipeline, type PipelineDeps } from './pipeline';
import { InMemoryAssetRepository } from './repository';
import { NoOpScanner } from './virus-scan';
import type { UploadInput } from './types';
import { InMemoryStorageClient } from '@srtdio/storage';

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
    ...overrides,
  };
}

/** A PNG whose IHDR declares the given size (magic bytes + dimensions). */
function pngBytes(width: number, height: number): Uint8Array {
  return Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d,
    0x49, 0x48, 0x44, 0x52,
    (width >>> 24) & 0xff, (width >>> 16) & 0xff, (width >>> 8) & 0xff, width & 0xff,
    (height >>> 24) & 0xff, (height >>> 16) & 0xff, (height >>> 8) & 0xff, height & 0xff,
  ]);
}

/** A JPEG with an SOF0 frame header that survives EXIF stripping. */
function jpegBytes(width: number, height: number): Uint8Array {
  return Uint8Array.from([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x11, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0xff, 0xd9,
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
    const noFrame = Uint8Array.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xd9,
    ]);
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
