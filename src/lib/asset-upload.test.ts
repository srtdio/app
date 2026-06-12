import { describe, expect, it, vi } from 'vitest';
import { ALLOWED_MIME_TYPES } from '@srtdio/storage';
import {
  MAX_UPLOAD_BYTES,
  UPLOAD_ACCEPT,
  allNamed,
  precheckFile,
  runUploads,
  uploadAssetFile,
  uploadErrorMessage,
  uploadFilename,
  type QueueItem,
  type UploadConfig,
} from '@/lib/asset-upload';

/** A File of an arbitrary reported size without allocating the bytes. */
function fakeFile(name: string, type: string, size: number): File {
  const file = new File(['x'], name, { type });
  Object.defineProperty(file, 'size', { value: size });
  return file;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

const baseConfig = (fetcher: UploadConfig['fetcher'], filename = 'file.png'): UploadConfig => ({
  endpoint: 'https://upload.example.workers.dev',
  token: 'tok',
  workspaceId: 'ws-1',
  filename,
  fetcher,
});

describe('UPLOAD_ACCEPT', () => {
  it('is derived from the one shared allowlist, not duplicated', () => {
    expect(UPLOAD_ACCEPT).toBe(ALLOWED_MIME_TYPES.join(','));
  });
});

describe('precheckFile gates before any network call', () => {
  it('rejects oversize files and never calls fetch', async () => {
    const fetcher = vi.fn();
    const big = fakeFile('big.png', 'image/png', MAX_UPLOAD_BYTES + 1);

    const check = precheckFile(big);
    if (check.ok) {
      await uploadAssetFile(big, baseConfig(fetcher));
    }

    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.message).toBe('Files up to 100MB only');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects disallowed MIME types and never calls fetch', async () => {
    const fetcher = vi.fn();
    const exe = fakeFile('tool.exe', 'application/x-msdownload', 100);

    const check = precheckFile(exe);
    if (check.ok) {
      await uploadAssetFile(exe, baseConfig(fetcher));
    }

    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.message).toBe("This file type isn't supported");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('accepts an allowed file at exactly the size limit', () => {
    const ok = fakeFile('logo.png', 'image/png', MAX_UPLOAD_BYTES);
    expect(precheckFile(ok)).toEqual({ ok: true });
  });
});

describe('uploadErrorMessage maps worker codes to plain English', () => {
  it('maps every known code and falls back for the rest', () => {
    expect(uploadErrorMessage('file_too_large')).toBe('Files up to 100MB only');
    expect(uploadErrorMessage('unsupported_mime')).toBe("This file type isn't supported");
    expect(uploadErrorMessage('mime_mismatch')).toBe("File contents don't match the file type");
    expect(uploadErrorMessage('virus_detected')).toBe('This file was blocked for safety');
    expect(uploadErrorMessage('network')).toBe('Upload failed. Check your connection and retry');
    expect(uploadErrorMessage('internal_error')).toBe(
      'Upload failed. Check your connection and retry',
    );
  });
});

describe('uploadAssetFile', () => {
  it('posts multipart {file, workspace_id} with a Bearer token and returns the asset', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(jsonResponse(201, { asset: { assetId: 'a-1', reused: false } }));
    const file = fakeFile('logo.png', 'image/png', 10);

    const out = await uploadAssetFile(file, baseConfig(fetcher, 'My Logo.png'));

    expect(out).toEqual({ ok: true, reused: false, assetId: 'a-1' });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://upload.example.workers.dev');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    const body = init.body as FormData;
    expect(body.get('workspace_id')).toBe('ws-1');
    expect(body.get('file')).toBeInstanceOf(File);
    expect((body.get('file') as File).name).toBe('My Logo.png');
  });

  it('treats a reused (200) response as success', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { asset: { assetId: 'a-2', reused: true } }));
    const out = await uploadAssetFile(fakeFile('a.png', 'image/png', 1), baseConfig(fetcher));
    expect(out).toEqual({ ok: true, reused: true, assetId: 'a-2' });
  });

  it('maps a worker error status to its message', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(jsonResponse(413, { error: { code: 'file_too_large', message: 'x' } }));
    const out = await uploadAssetFile(fakeFile('a.png', 'image/png', 1), baseConfig(fetcher));
    expect(out).toEqual({ ok: false, message: 'Files up to 100MB only' });
  });

  it('maps a transport failure to the retry message', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('offline'));
    const out = await uploadAssetFile(fakeFile('a.png', 'image/png', 1), baseConfig(fetcher));
    expect(out).toEqual({ ok: false, message: 'Upload failed. Check your connection and retry' });
  });
});

describe('runUploads success path clears the queue', () => {
  it('uploads sequentially and reports every file succeeded', async () => {
    const fetcher = vi
      .fn()
      .mockImplementation(async () =>
        jsonResponse(201, { asset: { assetId: 'a', reused: false } }),
      );
    const items: QueueItem[] = [
      { id: '1', file: fakeFile('one.png', 'image/png', 1), filename: 'one.png' },
      { id: '2', file: fakeFile('two.png', 'image/png', 1), filename: 'two.png' },
    ];

    const result = await runUploads(items, (item) =>
      uploadAssetFile(item.file, baseConfig(fetcher, item.filename)),
    );

    expect(result.succeeded).toEqual(['1', '2']);
    expect(result.failed).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    // Queue would be cleared: nothing remains failed.
    expect(result.failed).toHaveLength(0);
  });

  it('continues past a failure so the rest of the queue still uploads', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(415, { error: { code: 'unsupported_mime' } }))
      .mockResolvedValueOnce(jsonResponse(201, { asset: { assetId: 'b', reused: false } }));
    const items: QueueItem[] = [
      { id: '1', file: fakeFile('one.png', 'image/png', 1), filename: 'one.png' },
      { id: '2', file: fakeFile('two.png', 'image/png', 1), filename: 'two.png' },
    ];

    const result = await runUploads(items, (item) =>
      uploadAssetFile(item.file, baseConfig(fetcher, item.filename)),
    );

    expect(result.succeeded).toEqual(['2']);
    expect(result.failed).toEqual([{ id: '1', message: "This file type isn't supported" }]);
  });
});

describe('mandatory display-name gate', () => {
  it('blocks submit until every file has a non-empty name', () => {
    expect(allNamed(['Logo', 'Banner'])).toBe(true);
    expect(allNamed(['Logo', '   '])).toBe(false);
    expect(allNamed([])).toBe(false);
  });
});

describe('uploadFilename', () => {
  it('appends the original extension when the display name lacks it', () => {
    expect(uploadFilename('My Logo', 'logo.png')).toBe('My Logo.png');
    expect(uploadFilename('keep.png', 'logo.png')).toBe('keep.png');
    expect(uploadFilename('noext', 'data')).toBe('noext');
  });
});
