import { beforeEach, describe, expect, it } from 'vitest';
import {
  InMemoryAssetRepository,
  MAX_FILE_SIZE_BYTES,
  NoOpScanner,
  getAssetSummary,
  hasExifSegment,
  runUploadPipeline,
  sanitizeSvg,
  type PipelineDeps,
  type UploadInput,
  type VirusScanner,
  type VirusScanResult,
} from '@/server/assets';
import { InMemoryStorageClient, assetBucketName } from '@srtdio/storage';
import { GPS_SENTINEL, makeJpeg, svgBytes } from './fixtures';

const WORKSPACE_A = '11111111-1111-7111-8111-111111111111';
const WORKSPACE_B = '22222222-2222-7222-8222-222222222222';
const USER = '33333333-3333-7333-8333-333333333333';
const TRACE = '0192f8a0-7d3e-7c4b-9a1f-2b3c4d5e6f70';

function deps(scanner: VirusScanner = new NoOpScanner()): PipelineDeps & {
  storage: InMemoryStorageClient;
  repository: InMemoryAssetRepository;
} {
  return {
    storage: new InMemoryStorageClient(),
    repository: new InMemoryAssetRepository(),
    scanner,
  };
}

function input(overrides: Partial<UploadInput> = {}): UploadInput {
  return {
    workspaceId: WORKSPACE_A,
    uploadedBy: USER,
    filename: 'photo.jpg',
    contentType: 'image/jpeg',
    bytes: makeJpeg(),
    traceId: TRACE,
    ...overrides,
  };
}

class RejectingScanner implements VirusScanner {
  scan(): Promise<VirusScanResult> {
    return Promise.resolve({ clean: false, reason: 'EICAR-Test-Signature' });
  }
}

describe('runUploadPipeline', () => {
  let d: ReturnType<typeof deps>;
  beforeEach(() => {
    d = deps();
  });

  it('uploads a jpeg: stable sha, asset + version 1, current_version_id, r2_key', async () => {
    const first = await runUploadPipeline(d, input());
    const second = await runUploadPipeline(deps(), input());

    expect(first.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    // Deterministic content hash across independent runs.
    expect(first.value.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first.value.sha256).toBe(second.value.sha256);

    expect(d.repository.assets.size).toBe(1);
    expect(d.repository.versions).toHaveLength(1);
    expect(first.value.versionNumber).toBe(1);

    const asset = d.repository.assets.get(first.value.assetId);
    expect(asset?.current_version_id).toBe(first.value.versionId);

    expect(first.value.r2Key).toBe(`${WORKSPACE_A}/${first.value.assetId}/1/photo.jpg`);
    expect(d.storage.get(assetBucketName(WORKSPACE_A), first.value.r2Key)).toBeDefined();
  });

  it('re-upload of identical content reuses the asset and adds no version', async () => {
    const first = await runUploadPipeline(d, input());
    const again = await runUploadPipeline(d, input());

    expect(first.ok && again.ok).toBe(true);
    if (!first.ok || !again.ok) return;

    expect(again.value.reused).toBe(true);
    expect(again.value.assetId).toBe(first.value.assetId);
    expect(again.value.versionId).toBe(first.value.versionId);
    expect(d.repository.assets.size).toBe(1);
    expect(d.repository.versions).toHaveLength(1);
  });

  it('edited copy (new sha, same asset_id) appends version N+1 and advances current', async () => {
    const first = await runUploadPipeline(d, input());
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const edited = await runUploadPipeline(
      d,
      input({
        bytes: makeJpeg({ scan: new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd]) }),
        assetId: first.value.assetId,
      }),
    );
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;

    expect(edited.value.assetId).toBe(first.value.assetId);
    expect(edited.value.sha256).not.toBe(first.value.sha256);
    expect(edited.value.versionNumber).toBe(2);
    expect(d.repository.versions).toHaveLength(2);

    const asset = d.repository.assets.get(first.value.assetId);
    expect(asset?.current_version_id).toBe(edited.value.versionId);
  });

  it('rejects a MIME type outside the allowlist', async () => {
    const res = await runUploadPipeline(
      d,
      input({ contentType: 'application/zip', filename: 'a.zip' }),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('unsupported_mime');
    expect(d.repository.versions).toHaveLength(0);
  });

  it('rejects a file larger than 100 MB', async () => {
    const res = await runUploadPipeline(
      d,
      input({ bytes: new Uint8Array(MAX_FILE_SIZE_BYTES + 1) }),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('file_too_large');
  });

  it('sanitizes an SVG with an embedded <script> before storing it', async () => {
    const res = await runUploadPipeline(
      d,
      input({ contentType: 'image/svg+xml', filename: 'logo.svg', bytes: svgBytes() }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const stored = d.storage.get(assetBucketName(WORKSPACE_A), res.value.r2Key);
    const text = new TextDecoder().decode(stored?.body ?? new Uint8Array());
    expect(text).not.toMatch(/<script/i);
    expect(text).not.toMatch(/onload=/i);
    expect(text).not.toMatch(/javascript:/i);
    expect(text).not.toMatch(/http:\/\/evil/i);
  });

  it('strips EXIF GPS data from a stored jpeg', async () => {
    const withGps = makeJpeg({ gps: true });
    expect(hasExifSegment(withGps)).toBe(true);

    const res = await runUploadPipeline(d, input({ bytes: withGps }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const stored = d.storage.get(assetBucketName(WORKSPACE_A), res.value.r2Key);
    const body = stored?.body ?? new Uint8Array();
    expect(hasExifSegment(body)).toBe(false);
    expect(new TextDecoder().decode(body)).not.toContain(GPS_SENTINEL);
  });

  it('rejects an upload when the scanner reports not clean', async () => {
    const dd = deps(new RejectingScanner());
    const res = await runUploadPipeline(dd, input());
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('virus_detected');
    expect(res.error.reason).toBe('EICAR-Test-Signature');
    expect(dd.repository.versions).toHaveLength(0);
    expect(dd.storage.objects.size).toBe(0);
  });

  it('writes an audit row carrying the trace_id on create', async () => {
    const res = await runUploadPipeline(d, input());
    expect(res.ok).toBe(true);
    expect(d.repository.audits).toHaveLength(1);
    expect(d.repository.audits[0]?.traceId).toBe(TRACE);
    expect(d.repository.audits[0]?.action).toBe('asset.create');
  });

  it('rejects an unknown or cross-tenant target asset_id', async () => {
    const res = await runUploadPipeline(
      d,
      input({ assetId: '44444444-4444-7444-8444-444444444444' }),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('not_found');
  });
});

describe('cross-tenant read isolation', () => {
  it('user B cannot read user A r2_keys via the read path', async () => {
    const d = deps();
    const created = await runUploadPipeline(d, input());
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const ownRead = await getAssetSummary(d.repository, {
      workspaceId: WORKSPACE_A,
      assetId: created.value.assetId,
    });
    expect(ownRead.ok).toBe(true);
    if (ownRead.ok) {
      expect(ownRead.value.r2Key).toBe(created.value.r2Key);
    }

    const crossRead = await getAssetSummary(d.repository, {
      workspaceId: WORKSPACE_B,
      assetId: created.value.assetId,
    });
    expect(crossRead.ok).toBe(false);
    if (!crossRead.ok) {
      expect(crossRead.error.code).toBe('not_found');
    }
  });
});

describe('sanitizeSvg', () => {
  it('removes script, handlers, javascript: and external href', () => {
    const out = sanitizeSvg(
      '<svg><script>x()</script><g onclick="y()" href="https://evil/x"/><a href="javascript:1"/></svg>',
    );
    expect(out).not.toMatch(/<script/i);
    expect(out).not.toMatch(/onclick/i);
    expect(out).not.toMatch(/javascript:/i);
    expect(out).not.toMatch(/https:\/\/evil/i);
  });
});
