import { describe, expect, it, vi } from 'vitest';
import { ALLOWED_MIME_TYPES } from '@srtdio/storage';
import {
  MAX_UPLOAD_BYTES,
  UPLOAD_ACCEPT,
  addAssetLink,
  canRenameAssets,
  createFolderRequest,
  deleteFolderRequest,
  isValidLinkUrl,
  moveAssetsRequest,
  nextUploadNames,
  renameFolderRequest,
  linkErrorMessage,
  precheckFile,
  renameAsset,
  renameErrorMessage,
  runUploads,
  uploadAssetFile,
  uploadErrorMessage,
  type AddLinkConfig,
  type CreateFolderConfig,
  type DeleteFolderConfig,
  type MoveAssetsConfig,
  type QueueItem,
  type RenameFolderConfig,
  type RenameConfig,
  type UploadConfig,
  type UploadCompleteDetail,
  type UploadFetcher,
  type UploadOutcome,
  UPLOAD_COMPLETE_EVENT,
  xhrPost,
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

const baseConfig = (fetcher: UploadFetcher, filename = 'file.png'): UploadConfig => ({
  endpoint: 'https://upload.example.workers.dev',
  token: 'tok',
  workspaceId: 'ws-1',
  origin: 'library',
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
    expect(uploadErrorMessage('blocked_type')).toBe("This file type isn't allowed");
    expect(uploadErrorMessage('encrypted_file')).toBe("Password-protected files can't be shared");
    expect(uploadErrorMessage('embedded_content')).toBe(
      "This file contains embedded content that can't be checked.",
    );
    expect(uploadErrorMessage('archive_limits')).toBe('This file is too complex to check');
    expect(uploadErrorMessage('network')).toBe("Couldn't upload. Try again.");
    expect(uploadErrorMessage('internal_error')).toBe("Couldn't upload. Try again.");
  });

  it('never mentions the connection, network or offline in any upload copy', () => {
    const codes = [
      'file_too_large',
      'unsupported_mime',
      'mime_mismatch',
      'virus_detected',
      'blocked_type',
      'encrypted_file',
      'embedded_content',
      'archive_limits',
      'network',
      'internal_error',
    ];
    for (const code of codes) {
      expect(uploadErrorMessage(code)).not.toMatch(/connect|network|offline/i);
    }
  });
});

describe('uploadAssetFile', () => {
  it.each(['library', 'chat'] as const)('sends the %s origin as a form field', async (origin) => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(jsonResponse(201, { asset: { assetId: 'a-1', reused: false } }));
    await uploadAssetFile(fakeFile('logo.png', 'image/png', 10), {
      ...baseConfig(fetcher, 'logo.png'),
      origin,
    });
    const [, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect((init.body as FormData).get('origin')).toBe(origin);
  });

  it('requires origin at the type level', () => {
    const fetcher = vi.fn();
    // @ts-expect-error origin is required: no caller may forget it.
    const missing: UploadConfig = {
      endpoint: 'https://upload.example.workers.dev',
      token: 'tok',
      workspaceId: 'ws-1',
      filename: 'logo.png',
      fetcher,
    };
    // @ts-expect-error only 'library' | 'chat' are valid origins.
    const invalid: UploadConfig = { ...baseConfig(fetcher), origin: 'assets' };
    expect(missing).toBeDefined();
    expect(invalid).toBeDefined();
  });

  it('posts multipart {file, workspace_id} under the original filename and returns the asset', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(jsonResponse(201, { asset: { assetId: 'a-1', reused: false } }));
    const file = fakeFile('logo.png', 'image/png', 10);

    const out = await uploadAssetFile(file, baseConfig(fetcher, 'logo.png'));

    expect(out).toEqual({ ok: true, reused: false, assetId: 'a-1' });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://upload.example.workers.dev');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    const body = init.body as FormData;
    expect(body.get('workspace_id')).toBe('ws-1');
    expect(body.get('file')).toBeInstanceOf(File);
    // The part keeps the original device name (assets.filename), never a typed name.
    expect((body.get('file') as File).name).toBe('logo.png');
  });

  it('includes display_name when provided and omits it when not', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(jsonResponse(201, { asset: { assetId: 'a-1', reused: false } }));
    const file = fakeFile('logo.png', 'image/png', 10);

    await uploadAssetFile(file, { ...baseConfig(fetcher), displayName: 'Summer Trip 3' });
    let body = (fetcher.mock.calls[0] as [string, RequestInit])[1].body as FormData;
    expect(body.get('display_name')).toBe('Summer Trip 3');

    fetcher.mockClear();
    await uploadAssetFile(file, { ...baseConfig(fetcher), displayName: '   ' });
    body = (fetcher.mock.calls[0] as [string, RequestInit])[1].body as FormData;
    expect(body.has('display_name')).toBe(false);

    fetcher.mockClear();
    await uploadAssetFile(file, baseConfig(fetcher));
    body = (fetcher.mock.calls[0] as [string, RequestInit])[1].body as FormData;
    expect(body.has('display_name')).toBe(false);
  });

  it('includes folder_id when provided and omits it when not', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(jsonResponse(201, { asset: { assetId: 'a-1', reused: false } }));
    const file = fakeFile('logo.png', 'image/png', 10);

    await uploadAssetFile(file, { ...baseConfig(fetcher), folderId: 'f-1' });
    let body = (fetcher.mock.calls[0] as [string, RequestInit])[1].body as FormData;
    expect(body.get('folder_id')).toBe('f-1');

    fetcher.mockClear();
    await uploadAssetFile(file, { ...baseConfig(fetcher), folderId: null });
    body = (fetcher.mock.calls[0] as [string, RequestInit])[1].body as FormData;
    expect(body.has('folder_id')).toBe(false);
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
    expect(out).toEqual({ ok: false, message: "Couldn't upload. Try again." });
  });
  it('announces a successful upload for its workspace, and only a successful one', async () => {
    const target = new EventTarget();
    vi.stubGlobal('window', target);
    const seen: string[] = [];
    target.addEventListener(UPLOAD_COMPLETE_EVENT, (event) => {
      seen.push((event as CustomEvent<UploadCompleteDetail>).detail.workspaceId);
    });
    try {
      const ok = vi
        .fn()
        .mockResolvedValue(jsonResponse(201, { asset: { assetId: 'a-1', reused: false } }));
      await uploadAssetFile(fakeFile('a.png', 'image/png', 1), baseConfig(ok));
      expect(seen).toEqual(['ws-1']);
      const failed = vi
        .fn()
        .mockResolvedValue(jsonResponse(413, { error: { code: 'file_too_large', message: 'x' } }));
      await uploadAssetFile(fakeFile('a.png', 'image/png', 1), baseConfig(failed));
      expect(seen).toEqual(['ws-1']);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('runUploads success path clears the queue', () => {
  it('uploads every file and reports every file succeeded', async () => {
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

describe('runUploads in parallel (cap 3)', () => {
  const items = (count: number): QueueItem[] =>
    Array.from({ length: count }, (_, i) => ({
      id: `f${i + 1}`,
      file: fakeFile(`f${i + 1}.png`, 'image/png', 1),
      filename: `f${i + 1}.png`,
    }));

  it('never has more than 3 files in flight, and starts each next one as a slot frees', async () => {
    const waiting = new Map<string, (outcome: UploadOutcome) => void>();
    let inFlight = 0;
    let peak = 0;
    const started: string[] = [];
    const run = runUploads(
      items(6),
      (item) =>
        new Promise<UploadOutcome>((resolve) => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          waiting.set(item.id, (outcome) => {
            inFlight -= 1;
            resolve(outcome);
          });
        }),
      { onStart: (id) => started.push(id) },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toEqual(['f1', 'f2', 'f3']);

    const ok: UploadOutcome = { ok: true, reused: false, assetId: 'a' };
    for (const id of ['f2', 'f1', 'f3', 'f4', 'f5', 'f6']) {
      waiting.get(id)?.(ok);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(inFlight).toBeLessThanOrEqual(3);
    }
    const result = await run;
    expect(peak).toBe(3);
    expect(started).toEqual(['f1', 'f2', 'f3', 'f4', 'f5', 'f6']);
    // Listed in queue order, not finish order.
    expect(result.succeeded).toEqual(['f1', 'f2', 'f3', 'f4', 'f5', 'f6']);
  });

  it('one failing file never stops the others and is marked failed with its copy', async () => {
    const results: [string, boolean][] = [];
    const result = await runUploads(
      items(5),
      async (item) => {
        if (item.id === 'f2') return { ok: false, message: 'This file was blocked for safety' };
        if (item.id === 'f4') throw new Error('unexpected');
        return { ok: true, reused: false, assetId: item.id };
      },
      { onResult: (id, outcome) => results.push([id, outcome.ok]) },
    );
    expect(result.succeeded).toEqual(['f1', 'f3', 'f5']);
    expect(result.failed).toEqual([
      { id: 'f2', message: 'This file was blocked for safety' },
      // A thrown upload is a failure with the generic retry copy, never a crash.
      { id: 'f4', message: "Couldn't upload. Try again." },
    ]);
    expect(new Map(results)).toEqual(
      new Map([
        ['f1', true],
        ['f2', false],
        ['f3', true],
        ['f4', false],
        ['f5', true],
      ]),
    );
  });

  it('runs one at a time when asked for a cap of 1', async () => {
    let inFlight = 0;
    let peak = 0;
    await runUploads(
      items(4),
      async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 0));
        inFlight -= 1;
        return { ok: true, reused: false, assetId: 'a' };
      },
      undefined,
      1,
    );
    expect(peak).toBe(1);
  });
});

describe('nextUploadNames', () => {
  it('numbers from 1 when no sibling matches the base', () => {
    expect(nextUploadNames('Trip', [], 3)).toEqual(['Trip 1', 'Trip 2', 'Trip 3']);
  });

  it('continues past the highest existing number, never the count', () => {
    // Max existing is 3, so a batch of 2 starts at 4 (a gap at 2 is not reused).
    expect(nextUploadNames('Trip', ['Trip 1', 'Trip 3'], 2)).toEqual(['Trip 4', 'Trip 5']);
  });

  it('matches the base case-insensitively', () => {
    expect(nextUploadNames('Trip', ['trip 2', 'TRIP 5'], 1)).toEqual(['Trip 6']);
  });

  it('treats a regex-metacharacter base literally', () => {
    // 'A.B' must not match 'AXB 9'; only the literal 'A.B 2' counts.
    expect(nextUploadNames('A.B', ['A.B 2', 'AXB 9'], 1)).toEqual(['A.B 3']);
  });
});

const linkConfig = (fetcher: AddLinkConfig['fetcher']): AddLinkConfig => ({
  endpoint: 'https://upload.example.workers.dev',
  token: 'tok',
  workspaceId: 'ws-1',
  url: 'https://sorted.example.com/post',
  name: 'Launch post',
  fetcher,
});

describe('isValidLinkUrl gates a link before any network call', () => {
  it('accepts full http(s) links and trims surrounding whitespace', () => {
    expect(isValidLinkUrl('https://example.com')).toBe(true);
    expect(isValidLinkUrl('http://example.com/a?b=c')).toBe(true);
    expect(isValidLinkUrl('  https://example.com  ')).toBe(true);
  });

  it('rejects bare hosts, non-web schemes, and empties', () => {
    expect(isValidLinkUrl('example.com')).toBe(false);
    expect(isValidLinkUrl('ftp://example.com')).toBe(false);
    expect(isValidLinkUrl('javascript:alert(1)')).toBe(false);
    expect(isValidLinkUrl('https://')).toBe(false);
    expect(isValidLinkUrl('')).toBe(false);
  });

  it('a bad url never reaches the network (the submit gate)', async () => {
    const fetcher = vi.fn();
    const url = 'not a url';
    if (isValidLinkUrl(url)) {
      await addAssetLink({ ...linkConfig(fetcher), url });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('linkErrorMessage maps worker codes to plain English', () => {
  it('maps known codes and falls back for the rest', () => {
    expect(linkErrorMessage('invalid_url')).toBe('Enter a full link starting with https://');
    expect(linkErrorMessage('name_required')).toBe('The link needs a name');
    expect(linkErrorMessage('network')).toBe("Couldn't add the link. Try again.");
    expect(linkErrorMessage('whatever')).toBe("Couldn't add the link. Try again.");
  });
});

describe('addAssetLink', () => {
  it('posts {workspace_id, url, name} to /links with a Bearer token', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse(201, { asset: { id: 'a-9' } }));

    const out = await addAssetLink(linkConfig(fetcher));

    expect(out).toEqual({ ok: true, assetId: 'a-9' });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://upload.example.workers.dev/links');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(JSON.parse(init.body as string)).toEqual({
      workspace_id: 'ws-1',
      url: 'https://sorted.example.com/post',
      name: 'Launch post',
    });
  });

  it('maps a worker error status to its message', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(jsonResponse(400, { error: { code: 'invalid_url' } }));
    const out = await addAssetLink(linkConfig(fetcher));
    expect(out).toEqual({ ok: false, message: 'Enter a full link starting with https://' });
  });

  it('maps a transport failure to the link retry message', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('offline'));
    const out = await addAssetLink(linkConfig(fetcher));
    expect(out).toEqual({
      ok: false,
      message: "Couldn't add the link. Try again.",
    });
  });
});

const folderConfig = (
  fetcher: CreateFolderConfig['fetcher'],
  parentId: string | null = null,
): CreateFolderConfig => ({
  endpoint: 'https://upload.example.workers.dev',
  token: 'tok',
  workspaceId: 'ws-1',
  name: 'Campaigns',
  parentId,
  fetcher,
});

describe('createFolderRequest', () => {
  it('posts {workspace_id, name, parent_id} to /folders and returns the folder', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(201, { folder: { id: 'f-1', name: 'Campaigns', parent_id: null } }),
      );

    const out = await createFolderRequest(folderConfig(fetcher));

    expect(out).toEqual({ ok: true, folder: { id: 'f-1', name: 'Campaigns', parentId: null } });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://upload.example.workers.dev/folders');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(JSON.parse(init.body as string)).toEqual({
      workspace_id: 'ws-1',
      name: 'Campaigns',
      parent_id: null,
    });
  });

  it('returns the auto-numbered name the server resolved, under a parent', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(201, { folder: { id: 'f-2', name: 'Campaigns 2', parent_id: 'f-1' } }),
      );
    const out = await createFolderRequest(folderConfig(fetcher, 'f-1'));
    expect(out).toEqual({
      ok: true,
      folder: { id: 'f-2', name: 'Campaigns 2', parentId: 'f-1' },
    });
    const [, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string).parent_id).toBe('f-1');
  });

  it('maps a non-OK status to the retry message', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(jsonResponse(500, { error: { code: 'internal_error' } }));
    const out = await createFolderRequest(folderConfig(fetcher));
    expect(out).toEqual({
      ok: false,
      message: "Couldn't create the folder. Try again.",
    });
  });

  it('maps a transport failure to the retry message', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('offline'));
    const out = await createFolderRequest(folderConfig(fetcher));
    expect(out).toEqual({
      ok: false,
      message: "Couldn't create the folder. Try again.",
    });
  });
});

const moveConfig = (
  fetcher: MoveAssetsConfig['fetcher'],
  targetFolderId: string | null = 'f-1',
): MoveAssetsConfig => ({
  endpoint: 'https://upload.example.workers.dev',
  token: 'tok',
  workspaceId: 'ws-1',
  assetIds: ['a-1', 'a-2'],
  targetFolderId,
  fetcher,
});

describe('moveAssetsRequest', () => {
  it('posts {workspace_id, asset_ids, target_folder_id} to /folders/move and returns moved', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse(200, { moved: 2 }));

    const out = await moveAssetsRequest(moveConfig(fetcher));

    expect(out).toEqual({ ok: true, moved: 2 });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://upload.example.workers.dev/folders/move');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(JSON.parse(init.body as string)).toEqual({
      workspace_id: 'ws-1',
      asset_ids: ['a-1', 'a-2'],
      target_folder_id: 'f-1',
    });
  });

  it('moves to the root with a null target and defaults moved to 0 when absent', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse(200, {}));
    const out = await moveAssetsRequest(moveConfig(fetcher, null));
    expect(out).toEqual({ ok: true, moved: 0 });
    const [, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string).target_folder_id).toBeNull();
  });

  it('maps a non-OK status to the move retry message', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(jsonResponse(500, { error: { code: 'internal_error' } }));
    const out = await moveAssetsRequest(moveConfig(fetcher));
    expect(out).toEqual({
      ok: false,
      message: "Couldn't move the files. Try again.",
    });
  });

  it('maps a thrown fetcher to the move retry message', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('offline'));
    const out = await moveAssetsRequest(moveConfig(fetcher));
    expect(out).toEqual({
      ok: false,
      message: "Couldn't move the files. Try again.",
    });
  });
});

const renameConfig = (fetcher: RenameConfig['fetcher']): RenameConfig => ({
  endpoint: 'https://upload.example.workers.dev/',
  token: 'tok',
  workspaceId: 'ws-1',
  assetId: 'a-1',
  name: 'New name',
  fetcher,
});

describe('canRenameAssets gates the edit affordance by role', () => {
  it('is true for owner/admin/agency and false for client or unknown', () => {
    expect(canRenameAssets('owner')).toBe(true);
    expect(canRenameAssets('admin')).toBe(true);
    expect(canRenameAssets('agency')).toBe(true);
    expect(canRenameAssets('client')).toBe(false);
    expect(canRenameAssets(null)).toBe(false);
  });
});

describe('renameErrorMessage', () => {
  it('maps a 403 to the agency-only line and everything else to retry', () => {
    expect(renameErrorMessage(403)).toBe('Only creators and admins can rename files.');
    expect(renameErrorMessage(0)).toBe("Couldn't rename this file. Try again.");
    expect(renameErrorMessage(500)).toBe("Couldn't rename this file. Try again.");
  });
});

describe('renameAsset', () => {
  it('posts {workspace_id, asset_id, name} to /rename and succeeds on 200', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse(200, { asset: { id: 'a-1' } }));

    const out = await renameAsset(renameConfig(fetcher));

    expect(out).toEqual({ ok: true });
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://upload.example.workers.dev/rename');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(JSON.parse(init.body as string)).toEqual({
      workspace_id: 'ws-1',
      asset_id: 'a-1',
      name: 'New name',
    });
  });

  it('maps a 403 to the agency-only message', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse(403, { error: { code: 'forbidden' } }));
    const out = await renameAsset(renameConfig(fetcher));
    expect(out).toEqual({ ok: false, message: 'Only creators and admins can rename files.' });
  });

  it('maps a transport failure to the rename retry message', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('offline'));
    const out = await renameAsset(renameConfig(fetcher));
    expect(out).toEqual({
      ok: false,
      message: "Couldn't rename this file. Try again.",
    });
  });
});

const renameFolderConfig = (fetcher: RenameFolderConfig['fetcher']): RenameFolderConfig => ({
  endpoint: 'https://upload.example.workers.dev',
  token: 'tok',
  workspaceId: 'ws-1',
  folderId: 'f-1',
  name: 'Campaigns',
  fetcher,
});

describe('renameFolderRequest', () => {
  it('posts {workspace_id, folder_id, name} to /folders/rename and returns the folder', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(200, { folder: { id: 'f-1', name: 'Campaigns', parent_id: null } }),
      );

    const out = await renameFolderRequest(renameFolderConfig(fetcher));

    expect(out).toEqual({ ok: true, folder: { id: 'f-1', name: 'Campaigns', parentId: null } });
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://upload.example.workers.dev/folders/rename');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(JSON.parse(init.body as string)).toEqual({
      workspace_id: 'ws-1',
      folder_id: 'f-1',
      name: 'Campaigns',
    });
  });

  it('surfaces a folder_name_taken collision inline (nameTaken:true)', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(jsonResponse(409, { error: { code: 'folder_name_taken' } }));
    const out = await renameFolderRequest(renameFolderConfig(fetcher));
    expect(out).toEqual({
      ok: false,
      nameTaken: true,
      message: 'A folder with this name already exists here',
    });
  });

  it('maps a 403 to the agency-only message with nameTaken:false', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse(403, { error: { code: 'forbidden' } }));
    const out = await renameFolderRequest(renameFolderConfig(fetcher));
    expect(out).toEqual({
      ok: false,
      nameTaken: false,
      message: 'Only creators and admins can rename folders.',
    });
  });

  it('maps a transport failure to the generic retry message', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('offline'));
    const out = await renameFolderRequest(renameFolderConfig(fetcher));
    expect(out).toEqual({
      ok: false,
      nameTaken: false,
      message: "Couldn't rename the folder. Try again.",
    });
  });
});

const deleteFolderConfig = (fetcher: DeleteFolderConfig['fetcher']): DeleteFolderConfig => ({
  endpoint: 'https://upload.example.workers.dev',
  token: 'tok',
  workspaceId: 'ws-1',
  folderId: 'f-1',
  fetcher,
});

describe('deleteFolderRequest', () => {
  it('posts {workspace_id, folder_id} to /folders/delete and succeeds on 200', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }));

    const out = await deleteFolderRequest(deleteFolderConfig(fetcher));

    expect(out).toEqual({ ok: true });
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://upload.example.workers.dev/folders/delete');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(JSON.parse(init.body as string)).toEqual({ workspace_id: 'ws-1', folder_id: 'f-1' });
  });

  it('maps a 403 to the agency-only delete message', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse(403, { error: { code: 'forbidden' } }));
    const out = await deleteFolderRequest(deleteFolderConfig(fetcher));
    expect(out).toEqual({ ok: false, message: 'Only creators and admins can delete folders.' });
  });

  it('maps a transport failure to the generic retry message', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('offline'));
    const out = await deleteFolderRequest(deleteFolderConfig(fetcher));
    expect(out).toEqual({
      ok: false,
      message: "Couldn't delete the folder. Try again.",
    });
  });
});

/** A minimal XMLHttpRequest double: emits `ticks`, then answers `status`/`body` (or errors). */
function fakeXhr(opts: {
  status?: number;
  body?: unknown;
  ticks?: [number, number][];
  transportError?: boolean;
}) {
  const request = {
    method: '',
    url: '',
    headers: {} as Record<string, string>,
    sent: null as unknown,
    status: 0,
    responseText: '',
    upload: { onprogress: null as ((event: ProgressEvent) => void) | null },
    onload: null as (() => void) | null,
    onerror: null as (() => void) | null,
    onabort: null as (() => void) | null,
    ontimeout: null as (() => void) | null,
    open(method: string, url: string) {
      request.method = method;
      request.url = url;
    },
    setRequestHeader(name: string, value: string) {
      request.headers[name] = value;
    },
    send(body: unknown) {
      request.sent = body;
      for (const [loaded, total] of opts.ticks ?? []) {
        request.upload.onprogress?.({ lengthComputable: true, loaded, total } as ProgressEvent);
      }
      if (opts.transportError === true) {
        request.onerror?.();
        return;
      }
      request.status = opts.status ?? 201;
      request.responseText = opts.body === undefined ? '' : JSON.stringify(opts.body);
      request.onload?.();
    },
  };
  return request;
}

function xhrConfig(request: ReturnType<typeof fakeXhr>, onProgress?: (f: number) => void) {
  return {
    endpoint: 'https://upload.example.workers.dev',
    token: 'tok',
    workspaceId: 'ws-1',
    origin: 'library' as const,
    filename: 'logo.png',
    xhr: {
      traceId: 'trace-1',
      createRequest: () => request as unknown as XMLHttpRequest,
      ...(onProgress !== undefined ? { onProgress } : {}),
    },
  };
}

describe('uploadAssetFile over XMLHttpRequest (progress)', () => {
  it('POSTs the same multipart body and headers, reports progress, and resolves the same shape', async () => {
    const request = fakeXhr({
      status: 201,
      body: { asset: { assetId: 'a-1', versionId: 'v-1', reused: false } },
      ticks: [
        [0, 10],
        [5, 10],
        [10, 10],
      ],
    });
    const progress: number[] = [];
    const file = fakeFile('logo.png', 'image/png', 10);
    const out = await uploadAssetFile(
      file,
      xhrConfig(request, (f) => progress.push(f)),
    );

    expect(out).toEqual({ ok: true, reused: false, assetId: 'a-1', assetVersionId: 'v-1' });
    expect(progress).toEqual([0, 0.5, 1]);
    expect(request.method).toBe('POST');
    expect(request.url).toBe('https://upload.example.workers.dev');
    expect(request.headers).toEqual({ Authorization: 'Bearer tok', 'X-Trace-Id': 'trace-1' });
    const form = request.sent as FormData;
    expect(form.get('workspace_id')).toBe('ws-1');
    expect((form.get('file') as File).name).toBe('logo.png');
  });

  it('maps bytes sent to a fraction that only moves forward', async () => {
    const request = fakeXhr({
      status: 201,
      body: { asset: { assetId: 'a-1', versionId: 'v-1', reused: false } },
      ticks: [
        [0, 400],
        [100, 400],
        [50, 400],
        [100, 400],
        [300, 400],
        [400, 400],
      ],
    });
    const progress: number[] = [];
    await uploadAssetFile(
      fakeFile('logo.png', 'image/png', 400),
      xhrConfig(request, (f) => progress.push(f)),
    );
    expect(progress).toEqual([0, 0.25, 0.75, 1]);
  });

  it('a reused (200) response is success with reused: true', async () => {
    const request = fakeXhr({
      status: 200,
      body: { asset: { assetId: 'a-1', versionId: 'v-1', reused: true } },
    });
    const out = await uploadAssetFile(fakeFile('a.png', 'image/png', 1), xhrConfig(request));
    expect(out).toEqual({ ok: true, reused: true, assetId: 'a-1', assetVersionId: 'v-1' });
  });

  it('an error status fails with the mapped worker copy', async () => {
    const request = fakeXhr({ status: 422, body: { error: { code: 'virus_detected' } } });
    const out = await uploadAssetFile(fakeFile('a.png', 'image/png', 1), xhrConfig(request));
    expect(out).toEqual({ ok: false, message: uploadErrorMessage('virus_detected') });
  });

  it('an error status with no JSON body, or a transport error, fails as network; never throws', async () => {
    const bare = fakeXhr({ status: 500 });
    expect(await uploadAssetFile(fakeFile('a.png', 'image/png', 1), xhrConfig(bare))).toEqual({
      ok: false,
      message: uploadErrorMessage('network'),
    });
    const offline = fakeXhr({ transportError: true });
    expect(await uploadAssetFile(fakeFile('a.png', 'image/png', 1), xhrConfig(offline))).toEqual({
      ok: false,
      message: uploadErrorMessage('network'),
    });
  });
});

describe('xhrPost honours an AbortSignal (cancelled chat send)', () => {
  /** A request that never answers until aborted; abort() fires onabort like a browser. */
  function hangingXhr() {
    const request = {
      aborted: 0,
      sent: false,
      status: 0,
      responseText: '',
      upload: { onprogress: null as ((event: ProgressEvent) => void) | null },
      onload: null as (() => void) | null,
      onerror: null as (() => void) | null,
      onabort: null as (() => void) | null,
      ontimeout: null as (() => void) | null,
      open() {},
      setRequestHeader() {},
      send() {
        request.sent = true;
      },
      abort() {
        request.aborted += 1;
        request.onabort?.();
      },
    };
    return request;
  }

  it('aborting the signal aborts the in-flight request and rejects', async () => {
    const request = hangingXhr();
    const controller = new AbortController();
    const pending = xhrPost('https://u', {}, new FormData(), {
      traceId: 't',
      signal: controller.signal,
      createRequest: () => request as unknown as XMLHttpRequest,
    });
    expect(request.sent).toBe(true);
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(request.aborted).toBe(1);
  });

  it('an already-aborted signal never opens a request', async () => {
    const request = hangingXhr();
    const controller = new AbortController();
    controller.abort();
    await expect(
      xhrPost('https://u', {}, new FormData(), {
        traceId: 't',
        signal: controller.signal,
        createRequest: () => request as unknown as XMLHttpRequest,
      }),
    ).rejects.toThrow();
    expect(request.sent).toBe(false);
  });

  it('a finished request stops listening (a later abort is a no-op)', async () => {
    const request = fakeXhr({
      status: 201,
      body: { asset: { assetId: 'a-1', versionId: 'v-1', reused: false } },
    });
    const controller = new AbortController();
    const abort = vi.fn();
    (request as unknown as { abort: () => void }).abort = abort;
    await xhrPost('https://u', {}, new FormData(), {
      traceId: 't',
      signal: controller.signal,
      createRequest: () => request as unknown as XMLHttpRequest,
    });
    controller.abort();
    expect(abort).not.toHaveBeenCalled();
  });
});

describe('uploadAssetFile: sender-side thumbnail (pdf, video, docx, xlsx, image list copy)', () => {
  const okBody = { asset: { assetId: 'a-1', versionId: 'v-1', reused: false } };
  const thumbBlob = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: 'image/jpeg' });
  const THUMB_URL = 'https://upload.example.workers.dev/thumbnail';

  /**
   * A worker double: the direct POST answers `upload`, POST /thumbnail answers
   * `thumbnail` (a fresh Response per call; a function may throw or hang).
   */
  function routedFetcher(
    opts: {
      upload?: () => Promise<Response>;
      thumbnail?: (init: RequestInit) => Promise<Response>;
    } = {},
  ) {
    return vi.fn(async (input: string, init: RequestInit): Promise<Response> => {
      if (input === THUMB_URL) {
        return opts.thumbnail !== undefined
          ? opts.thumbnail(init)
          : jsonResponse(200, { thumbnail: { width: 580, height: 751 } });
      }
      return opts.upload !== undefined ? opts.upload() : jsonResponse(201, okBody);
    });
  }

  type Recorded = { mock: { calls: unknown[][] } };

  function uploadForm(fetcher: Recorded): FormData {
    const [, init] = fetcher.mock.calls[0] as [string, RequestInit];
    return init.body as FormData;
  }

  function thumbnailCall(fetcher: Recorded): [string, RequestInit] | undefined {
    return (fetcher.mock.calls as [string, RequestInit][]).find(([url]) => url === THUMB_URL);
  }

  function deferred<T>() {
    let resolve: (value: T) => void = () => undefined;
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  it('a pdf sends the original without the thumbnail, then posts it with its page count', async () => {
    const fetcher = routedFetcher({
      thumbnail: async () =>
        jsonResponse(200, { thumbnail: { width: 580, height: 751, page_count: 12 } }),
    });
    const makeThumbnail = vi.fn(async () => ({
      ok: true as const,
      blob: thumbBlob,
      width: 580,
      height: 751,
      pageCount: 12,
    }));
    const onThumbnail = vi.fn();
    const outcome = await uploadAssetFile(fakeFile('deck.pdf', 'application/pdf', 10), {
      ...baseConfig(fetcher, 'deck.pdf'),
      makeThumbnail,
      onThumbnail,
    });

    const original = uploadForm(fetcher);
    expect((fetcher.mock.calls[0] as [string, RequestInit])[0]).toBe(
      'https://upload.example.workers.dev',
    );
    expect((original.get('file') as File).name).toBe('deck.pdf');
    expect(original.get('thumbnail')).toBeNull();
    expect(original.get('thumbnail_page_count')).toBeNull();
    // The outcome is the stored original alone: the thumbnail never rides on it.
    expect(outcome).toEqual({ ok: true, reused: false, assetId: 'a-1', assetVersionId: 'v-1' });

    await vi.waitFor(() => expect(onThumbnail).toHaveBeenCalledTimes(1));
    expect(onThumbnail).toHaveBeenCalledWith({ width: 580, height: 751, pageCount: 12 });
    const call = thumbnailCall(fetcher);
    expect(call).toBeDefined();
    const [, init] = call as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    const form = init.body as FormData;
    expect(form.get('workspace_id')).toBe('ws-1');
    expect(form.get('asset_version_id')).toBe('v-1');
    expect(form.get('thumbnail')).toBeInstanceOf(Blob);
    expect((form.get('thumbnail') as File).name).toBe('thumbnail.jpg');
    expect(form.get('thumbnail_page_count')).toBe('12');
    expect(form.get('file')).toBeNull();
  });

  it('resolves once the original is stored, even while the thumbnail is never made', async () => {
    const fetcher = routedFetcher();
    // A deferred thumbnail that is never resolved: the outcome must not wait on it.
    const pending = deferred<{ ok: true; blob: Blob; width: number; height: number }>();
    const makeThumbnail = vi.fn(() => pending.promise);
    const outcome = await uploadAssetFile(fakeFile('clip.mp4', 'video/mp4', 10), {
      ...baseConfig(fetcher, 'clip.mp4'),
      makeThumbnail,
    });
    expect(makeThumbnail).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ ok: true, reused: false, assetId: 'a-1', assetVersionId: 'v-1' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(thumbnailCall(fetcher)).toBeUndefined();
  });

  it('a thumbnail made after the outcome is still posted later', async () => {
    const fetcher = routedFetcher();
    const pending = deferred<{ ok: true; blob: Blob; width: number; height: number }>();
    const onThumbnail = vi.fn();
    const outcome = await uploadAssetFile(fakeFile('clip.mp4', 'video/mp4', 10), {
      ...baseConfig(fetcher, 'clip.mp4'),
      makeThumbnail: () => pending.promise,
      onThumbnail,
    });
    // Done before the thumbnail exists.
    expect(outcome).toEqual({ ok: true, reused: false, assetId: 'a-1', assetVersionId: 'v-1' });
    expect(uploadForm(fetcher).get('file')).toBeInstanceOf(File);
    expect(uploadForm(fetcher).get('thumbnail')).toBeNull();
    expect(thumbnailCall(fetcher)).toBeUndefined();

    pending.resolve({ ok: true, blob: thumbBlob, width: 580, height: 326 });
    await vi.waitFor(() => expect(thumbnailCall(fetcher)).toBeDefined());
    const form = (thumbnailCall(fetcher) as [string, RequestInit])[1].body as FormData;
    expect(form.get('asset_version_id')).toBe('v-1');
    expect(form.get('thumbnail_page_count')).toBeNull();
    await vi.waitFor(() => expect(onThumbnail).toHaveBeenCalledWith({ width: 580, height: 751 }));
  });

  it('posts the thumbnail only after the original is stored', async () => {
    const stored = deferred<Response>();
    const fetcher = routedFetcher({ upload: () => stored.promise });
    const upload = uploadAssetFile(fakeFile('deck.pdf', 'application/pdf', 10), {
      ...baseConfig(fetcher, 'deck.pdf'),
      makeThumbnail: async () => ({ ok: true as const, blob: thumbBlob, width: 10, height: 10 }),
    });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    // The thumbnail is ready, but there is no version to attach it to yet.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetcher).toHaveBeenCalledTimes(1);
    stored.resolve(jsonResponse(201, okBody));
    await upload;
    await vi.waitFor(() => expect(thumbnailCall(fetcher)).toBeDefined());
  });

  it('an image posts its small list copy, no page count', async () => {
    const fetcher = routedFetcher();
    const makeThumbnail = vi.fn().mockResolvedValue({
      ok: true,
      blob: new Blob(['x'], { type: 'image/jpeg' }),
      width: 320,
      height: 400,
    });
    await uploadAssetFile(fakeFile('post.jpg', 'image/jpeg', 10), {
      ...baseConfig(fetcher, 'post.jpg'),
      makeThumbnail,
    });
    expect(makeThumbnail).toHaveBeenCalledTimes(1);
    expect(uploadForm(fetcher).get('thumbnail')).toBeNull();
    await vi.waitFor(() => expect(thumbnailCall(fetcher)).toBeDefined());
    const form = (thumbnailCall(fetcher) as [string, RequestInit])[1].body as FormData;
    expect(form.get('thumbnail')).toBeInstanceOf(Blob);
    expect(form.get('thumbnail_page_count')).toBeNull();
  });

  it.each([
    ['svg', 'logo.svg', 'image/svg+xml'],
    ['audio', 'note.webm', 'audio/webm'],
    [
      'pptx',
      'deck.pptx',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    ],
  ])('%s never makes or sends a thumbnail', async (_label, name, type) => {
    const fetcher = routedFetcher();
    const makeThumbnail = vi.fn();
    await uploadAssetFile(fakeFile(name, type, 10), {
      ...baseConfig(fetcher, name),
      makeThumbnail,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(makeThumbnail).not.toHaveBeenCalled();
    expect(uploadForm(fetcher).get('thumbnail')).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      'docx',
      'brief.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ],
    ['xlsx', 'plan.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ])('a %s posts its thumbnail with no page count', async (_label, name, type) => {
    const fetcher = routedFetcher();
    const makeThumbnail = vi.fn(async () => ({
      ok: true as const,
      blob: thumbBlob,
      width: 580,
      height: 754,
    }));
    await uploadAssetFile(fakeFile(name, type, 10), {
      ...baseConfig(fetcher, name),
      makeThumbnail,
    });
    expect(makeThumbnail).toHaveBeenCalledTimes(1);
    expect(uploadForm(fetcher).get('thumbnail')).toBeNull();
    await vi.waitFor(() => expect(thumbnailCall(fetcher)).toBeDefined());
    const form = (thumbnailCall(fetcher) as [string, RequestInit])[1].body as FormData;
    expect(form.get('thumbnail')).toBeInstanceOf(Blob);
    expect(form.get('thumbnail_page_count')).toBeNull();
  });

  it.each([
    ['NoThumbnail', async () => ({ ok: false as const, reason: 'failed' as const })],
    [
      'a throwing maker',
      async () => {
        throw new Error('boom');
      },
    ],
  ])('%s still uploads the file and posts no thumbnail', async (_label, maker) => {
    const fetcher = routedFetcher();
    const outcome = await uploadAssetFile(fakeFile('deck.pdf', 'application/pdf', 10), {
      ...baseConfig(fetcher, 'deck.pdf'),
      makeThumbnail: maker,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(outcome).toEqual({ ok: true, reused: false, assetId: 'a-1', assetVersionId: 'v-1' });
    expect(uploadForm(fetcher).get('thumbnail')).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a refused post', async () => jsonResponse(422, { error: { code: 'invalid_image' } })],
    ['a server fault', async () => jsonResponse(500, { error: { code: 'internal_error' } })],
    [
      'a transport failure',
      async (): Promise<Response> => {
        throw new TypeError('Failed to fetch');
      },
    ],
  ])('%s on /thumbnail leaves the upload ok, without a thumbnail', async (_label, reply) => {
    const fetcher = routedFetcher({ thumbnail: reply });
    const onThumbnail = vi.fn();
    const outcome = await uploadAssetFile(fakeFile('deck.pdf', 'application/pdf', 10), {
      ...baseConfig(fetcher, 'deck.pdf'),
      makeThumbnail: async () => ({ ok: true as const, blob: thumbBlob, width: 10, height: 10 }),
      onThumbnail,
    });
    await vi.waitFor(() => expect(thumbnailCall(fetcher)).toBeDefined());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(outcome).toEqual({ ok: true, reused: false, assetId: 'a-1', assetVersionId: 'v-1' });
    expect(onThumbnail).not.toHaveBeenCalled();
  });

  it('a failed original never posts a thumbnail', async () => {
    const fetcher = routedFetcher({
      upload: async () => jsonResponse(422, { error: { code: 'virus_detected' } }),
    });
    const outcome = await uploadAssetFile(fakeFile('deck.pdf', 'application/pdf', 10), {
      ...baseConfig(fetcher, 'deck.pdf'),
      makeThumbnail: async () => ({ ok: true as const, blob: thumbBlob, width: 10, height: 10 }),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(outcome).toEqual({ ok: false, message: uploadErrorMessage('virus_detected') });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('a reply that already carries the stored thumbnail posts none', async () => {
    const fetcher = routedFetcher({
      upload: async () =>
        jsonResponse(200, {
          asset: { assetId: 'a-1', versionId: 'v-1', reused: true },
          thumbnail: { width: 400, height: 566 },
        }),
    });
    const outcome = await uploadAssetFile(fakeFile('deck.pdf', 'application/pdf', 10), {
      ...baseConfig(fetcher, 'deck.pdf'),
      makeThumbnail: async () => ({ ok: true as const, blob: thumbBlob, width: 10, height: 10 }),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({ ok: true, thumbnail: { width: 400, height: 566 } });
  });

  it('posts the thumbnail over XHR with the same Bearer and X-Trace-Id', async () => {
    const requests: { url: string; headers: Record<string, string>; sent: unknown }[] = [];
    const createRequest = (): XMLHttpRequest => {
      const request = fakeXhr({ status: 201, body: okBody });
      const tracked = { url: '', headers: request.headers, sent: null as unknown };
      requests.push(tracked);
      const open = request.open.bind(request);
      request.open = (method: string, url: string) => {
        tracked.url = url;
        open(method, url);
      };
      const sendBody = request.send.bind(request);
      request.send = (body: unknown) => {
        tracked.sent = body;
        if (tracked.url === THUMB_URL) {
          request.status = 200;
          request.responseText = JSON.stringify({ thumbnail: { width: 580, height: 326 } });
          request.onload?.();
          return;
        }
        sendBody(body);
      };
      return request as unknown as XMLHttpRequest;
    };
    const onThumbnail = vi.fn();
    const outcome = await uploadAssetFile(fakeFile('clip.mp4', 'video/mp4', 10), {
      endpoint: 'https://upload.example.workers.dev',
      token: 'tok',
      workspaceId: 'ws-1',
      origin: 'chat',
      filename: 'clip.mp4',
      makeThumbnail: async () => ({ ok: true as const, blob: thumbBlob, width: 580, height: 326 }),
      onThumbnail,
      xhr: { traceId: 'trace-1', createRequest },
    });
    expect(outcome).toEqual({ ok: true, reused: false, assetId: 'a-1', assetVersionId: 'v-1' });
    await vi.waitFor(() => expect(onThumbnail).toHaveBeenCalledWith({ width: 580, height: 326 }));
    expect(requests.map((r) => r.url)).toEqual(['https://upload.example.workers.dev', THUMB_URL]);
    expect(requests[1]?.headers).toEqual({ Authorization: 'Bearer tok', 'X-Trace-Id': 'trace-1' });
    expect((requests[1]?.sent as FormData).get('asset_version_id')).toBe('v-1');
  });

  it('a maker that hangs never holds the original or the outcome', async () => {
    vi.useFakeTimers();
    try {
      const fetcher = routedFetcher();
      const pending = uploadAssetFile(fakeFile('deck.pdf', 'application/pdf', 10), {
        ...baseConfig(fetcher, 'deck.pdf'),
        makeThumbnail: () => new Promise(() => undefined),
      });
      // No timer advanced: the outcome does not wait for the thumbnail cap.
      const outcome = await pending;
      expect(outcome).toEqual({ ok: true, reused: false, assetId: 'a-1', assetVersionId: 'v-1' });
      expect(fetcher).toHaveBeenCalledTimes(1);
      // Past the cap the hung thumbnail is dropped: nothing is posted.
      await vi.advanceTimersByTimeAsync(4_000);
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a thumbnail that lands after the outcome announces the upload again', async () => {
    const target = new EventTarget();
    vi.stubGlobal('window', target);
    const seen: string[] = [];
    target.addEventListener(UPLOAD_COMPLETE_EVENT, (event) => {
      seen.push((event as CustomEvent<UploadCompleteDetail>).detail.workspaceId);
    });
    try {
      const late = deferred<Response>();
      const fetcher = routedFetcher({ thumbnail: () => late.promise });
      const outcome = await uploadAssetFile(fakeFile('deck.pdf', 'application/pdf', 10), {
        ...baseConfig(fetcher, 'deck.pdf'),
        makeThumbnail: async () => ({ ok: true as const, blob: thumbBlob, width: 10, height: 10 }),
      });
      expect(outcome).toEqual({ ok: true, reused: false, assetId: 'a-1', assetVersionId: 'v-1' });
      expect(seen).toEqual(['ws-1']);
      await vi.waitFor(() => expect(thumbnailCall(fetcher)).toBeDefined());
      late.resolve(jsonResponse(200, { thumbnail: { width: 10, height: 10 } }));
      await vi.waitFor(() => expect(seen).toEqual(['ws-1', 'ws-1']));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('reads the stored thumbnail off the response; malformed is ignored', async () => {
    const stored = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(201, { ...okBody, thumbnail: { width: 580, height: 751, page_count: 3 } }),
      );
    const noThumb = async () => ({ ok: false as const, reason: 'failed' as const });
    expect(
      await uploadAssetFile(fakeFile('deck.pdf', 'application/pdf', 10), {
        ...baseConfig(stored, 'deck.pdf'),
        makeThumbnail: noThumb,
      }),
    ).toEqual({
      ok: true,
      reused: false,
      assetId: 'a-1',
      assetVersionId: 'v-1',
      thumbnail: { width: 580, height: 751, pageCount: 3 },
    });
    const malformed = vi
      .fn()
      .mockResolvedValue(jsonResponse(201, { ...okBody, thumbnail: { width: -1, height: 'x' } }));
    const outcome = await uploadAssetFile(fakeFile('deck.pdf', 'application/pdf', 10), {
      ...baseConfig(malformed, 'deck.pdf'),
      makeThumbnail: noThumb,
    });
    expect(outcome.ok && outcome.thumbnail).toBe(undefined);
  });
});
