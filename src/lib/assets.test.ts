import { describe, expect, it } from 'vitest';
import type { Client } from '@srtdio/rpc';
import {
  buildKindCounts,
  childFolders,
  countAttachments,
  deleteAssetsBatch,
  deriveKind,
  displayLabel,
  fetchFolders,
  fileExtension,
  filterAssets,
  folderBreadcrumb,
  folderChildCount,
  formatDimensions,
  humanizeSize,
  imageTileState,
  linkDomain,
  listAssets,
  mimeBadge,
  removeAssetsById,
  renameAssetInList,
  shapeAssets,
  sortAssets,
  visibleKinds,
  type AssetListItem,
  type FolderItem,
} from '@/lib/assets';

// A thenable query builder: every chained method returns itself, and awaiting it
// yields the configured { data, error }. Mirrors the subset of the PostgREST
// builder that listAssets touches.
function builder(result: { data: unknown; error: { message: string } | null }) {
  const b: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'is', 'order']) {
    b[method] = () => b;
  }
  b.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve);
  return b;
}

function makeClient(results: {
  assets: { data: unknown; error: { message: string } | null };
  attachments: { data: unknown; error: { message: string } | null };
}): Client {
  return {
    from: (table: string) => builder(table === 'assets' ? results.assets : results.attachments),
  } as unknown as Client;
}

function version(over: Partial<{ kind: string }> = {}) {
  return {
    id: 'v1',
    kind: 'image',
    mime_type: 'image/png',
    size_bytes: 2048,
    width: 100,
    height: 50,
    duration_ms: null,
    external_url: null,
    r2_key: 'images/a/v1.png',
    version_number: 1,
    ...over,
  };
}

function assetRow(id: string, kind: string, over: Record<string, unknown> = {}) {
  return {
    id,
    filename: `${id}.file`,
    display_name: null,
    folder_path: '/',
    folder_id: null,
    tags: [],
    uploaded_at: '2026-06-01T00:00:00Z',
    current_version_id: `ver-${id}`,
    current_version: { ...version({ kind }), id: `ver-${id}` },
    ...over,
  };
}

describe('deriveKind', () => {
  it('maps image and link, everything else to file', () => {
    expect(deriveKind('image')).toBe('image');
    expect(deriveKind('link')).toBe('link');
    expect(deriveKind('video')).toBe('file');
    expect(deriveKind(null)).toBe('file');
  });
});

describe('listAssets states', () => {
  it('returns an error result when the assets read fails', async () => {
    const client = makeClient({
      assets: { data: null, error: { message: 'boom' } },
      attachments: { data: [], error: null },
    });
    const result = await listAssets(client, 'ws-1');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toBe('boom');
  });

  it('returns an empty list when the workspace has no assets', async () => {
    const client = makeClient({
      assets: { data: [], error: null },
      attachments: { data: [], error: null },
    });
    const result = await listAssets(client, 'ws-1');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual([]);
  });

  it('shapes rows with kind and live attachment counts', async () => {
    const client = makeClient({
      assets: {
        data: [assetRow('a', 'image'), assetRow('b', 'link'), assetRow('c', 'application/pdf')],
        error: null,
      },
      attachments: { data: [{ asset_id: 'a' }, { asset_id: 'a' }, { asset_id: 'c' }], error: null },
    });
    const result = await listAssets(client, 'ws-1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const pick = (id: string): AssetListItem => {
      const found = result.data.find((i) => i.id === id);
      if (found === undefined) throw new Error(`missing ${id}`);
      return found;
    };
    expect(pick('a').kind).toBe('image');
    expect(pick('b').kind).toBe('link');
    expect(pick('c').kind).toBe('file');
    expect(pick('a').attachmentCount).toBe(2);
    expect(pick('b').attachmentCount).toBe(0);
    expect(pick('c').attachmentCount).toBe(1);
  });
});

describe('shapeAssets', () => {
  it('tolerates a missing current version (renders as a file)', () => {
    const items = shapeAssets(
      [{ ...assetRow('x', 'image'), current_version: null, current_version_id: null }],
      new Map(),
    );
    const item = items[0];
    expect(item).toBeDefined();
    if (item === undefined) return;
    expect(item.kind).toBe('file');
    expect(item.versionNumber).toBeNull();
    expect(item.currentVersionId).toBeNull();
  });

  it('maps folder_id to folderId, defaulting a root asset to null', () => {
    const items = shapeAssets(
      [assetRow('a', 'image', { folder_id: 'f-1' }), assetRow('b', 'image', { folder_id: null })],
      new Map(),
    );
    expect(items.map((i) => i.folderId)).toEqual(['f-1', null]);
  });
});

describe('displayLabel', () => {
  it('prefers display_name when present, else falls back to filename', () => {
    expect(displayLabel({ displayName: 'Spring Launch', filename: 'IMG_2931.jpg' })).toBe(
      'Spring Launch',
    );
    expect(displayLabel({ displayName: null, filename: 'IMG_2931.jpg' })).toBe('IMG_2931.jpg');
    // A blank/whitespace display name is treated as absent.
    expect(displayLabel({ displayName: '   ', filename: 'IMG_2931.jpg' })).toBe('IMG_2931.jpg');
  });
});

describe('visibleKinds', () => {
  it('lists kinds with assets in chip order and hides zero-count kinds', () => {
    expect(visibleKinds({ all: 3, image: 2, link: 0, file: 1 })).toEqual(['image', 'file']);
    expect(visibleKinds({ all: 0, image: 0, link: 0, file: 0 })).toEqual([]);
  });
});

describe('sortAssets', () => {
  const items: AssetListItem[] = [
    {
      ...base('a'),
      kind: 'link',
      displayName: null,
      filename: 'zeta',
      sizeBytes: 10,
      uploadedAt: '2026-01-03T00:00:00Z',
    },
    {
      ...base('b'),
      kind: 'image',
      displayName: 'Alpha',
      filename: 'b.png',
      sizeBytes: 500,
      uploadedAt: '2026-01-01T00:00:00Z',
    },
    {
      ...base('c'),
      kind: 'file',
      displayName: null,
      filename: 'middle.pdf',
      sizeBytes: 100,
      uploadedAt: '2026-01-02T00:00:00Z',
    },
  ];

  it('recent = uploaded_at desc', () => {
    expect(sortAssets(items, 'recent').map((i) => i.id)).toEqual(['a', 'c', 'b']);
  });

  it('name = display label, caseless', () => {
    // Alpha (b), middle.pdf (c), zeta (a)
    expect(sortAssets(items, 'name').map((i) => i.id)).toEqual(['b', 'c', 'a']);
  });

  it('size = size_bytes desc', () => {
    expect(sortAssets(items, 'size').map((i) => i.id)).toEqual(['b', 'c', 'a']);
  });

  it('type = kind (chip order) then name', () => {
    // image (b), link (a), file (c)
    expect(sortAssets(items, 'type').map((i) => i.id)).toEqual(['b', 'a', 'c']);
  });

  it('does not mutate the input', () => {
    const order = items.map((i) => i.id);
    sortAssets(items, 'name');
    expect(items.map((i) => i.id)).toEqual(order);
  });
});

describe('imageTileState', () => {
  it('falls back on a presign-or-load error', () => {
    expect(
      imageTileState({ enabled: true, hasVersion: true, url: 'https://x/y', failed: true }),
    ).toBe('fallback');
  });

  it('falls back when presigning is disabled or there is no stored version', () => {
    expect(imageTileState({ enabled: false, hasVersion: true, url: null, failed: false })).toBe(
      'fallback',
    );
    expect(imageTileState({ enabled: true, hasVersion: false, url: null, failed: false })).toBe(
      'fallback',
    );
  });

  it('shows the image once a URL resolves, and a shimmer while presigning', () => {
    expect(
      imageTileState({ enabled: true, hasVersion: true, url: 'https://x/y', failed: false }),
    ).toBe('image');
    expect(imageTileState({ enabled: true, hasVersion: true, url: null, failed: false })).toBe(
      'shimmer',
    );
  });
});

describe('kind filtering and counts', () => {
  const items: AssetListItem[] = [
    { ...base('1'), kind: 'image', filename: 'logo.png' },
    { ...base('2'), kind: 'image', filename: 'hero.jpg' },
    { ...base('3'), kind: 'link', filename: 'drive folder' },
    { ...base('4'), kind: 'file', filename: 'brief.pdf' },
  ];

  it('counts each kind generically plus the all total', () => {
    expect(buildKindCounts(items)).toEqual({ all: 4, image: 2, link: 1, file: 1 });
  });

  it('filters by kind', () => {
    expect(filterAssets(items, 'image', '').map((i) => i.id)).toEqual(['1', '2']);
    expect(filterAssets(items, 'link', '').map((i) => i.id)).toEqual(['3']);
  });

  it('filters by filename search case-insensitively, ignoring kind=all', () => {
    expect(filterAssets(items, 'all', 'HERO').map((i) => i.id)).toEqual(['2']);
    expect(filterAssets(items, 'image', 'pdf')).toEqual([]);
  });

  it('matches the display name when present, not just the filename', () => {
    const named: AssetListItem[] = [
      { ...base('1'), filename: 'IMG_0001.jpg', displayName: 'Summer Campaign' },
      { ...base('2'), filename: 'summer.png', displayName: null },
    ];
    // "campaign" matches the display name of 1; "IMG" matches the raw filename fallback of 2 only if it has no display name.
    expect(filterAssets(named, 'all', 'campaign').map((i) => i.id)).toEqual(['1']);
    expect(filterAssets(named, 'all', 'img_0001').map((i) => i.id)).toEqual([]);
  });
});

describe('fetchFolders', () => {
  function folderClient(result: { data: unknown; error: { message: string } | null }): Client {
    return { from: () => builder(result) } as unknown as Client;
  }

  it('shapes parent_id to parentId on success', async () => {
    const client = folderClient({
      data: [
        { id: 'f-1', name: 'Brand', parent_id: null },
        { id: 'f-2', name: 'Logos', parent_id: 'f-1' },
      ],
      error: null,
    });
    const result = await fetchFolders(client, 'ws-1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual([
      { id: 'f-1', name: 'Brand', parentId: null },
      { id: 'f-2', name: 'Logos', parentId: 'f-1' },
    ]);
  });

  it('returns an error result when the read fails', async () => {
    const client = folderClient({ data: null, error: { message: 'boom' } });
    const result = await fetchFolders(client, 'ws-1');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toBe('boom');
  });
});

describe('folder helpers', () => {
  const folders: FolderItem[] = [
    { id: 'f-brand', name: 'Brand', parentId: null },
    { id: 'f-camp', name: 'campaigns', parentId: null },
    { id: 'f-logos', name: 'Logos', parentId: 'f-brand' },
  ];

  it('lists immediate child folders, sorted by name case-insensitively', () => {
    // 'Brand' and 'campaigns' both sit at the root; caseless sort keeps B before c.
    expect(childFolders(folders, null).map((f) => f.id)).toEqual(['f-brand', 'f-camp']);
    expect(childFolders(folders, 'f-brand').map((f) => f.id)).toEqual(['f-logos']);
    expect(childFolders(folders, 'f-logos')).toEqual([]);
  });

  it('builds the root -> current breadcrumb, and is empty for root or an unknown id', () => {
    expect(folderBreadcrumb(folders, 'f-logos')).toEqual([
      { id: 'f-brand', name: 'Brand' },
      { id: 'f-logos', name: 'Logos' },
    ]);
    expect(folderBreadcrumb(folders, null)).toEqual([]);
    expect(folderBreadcrumb(folders, 'missing')).toEqual([]);
  });

  it('stops a cyclic parent chain instead of looping forever', () => {
    const cyclic: FolderItem[] = [
      { id: 'a', name: 'A', parentId: 'b' },
      { id: 'b', name: 'B', parentId: 'a' },
    ];
    expect(folderBreadcrumb(cyclic, 'a')).toEqual([
      { id: 'b', name: 'B' },
      { id: 'a', name: 'A' },
    ]);
  });

  it('counts child folders plus assets directly inside a folder', () => {
    const items: AssetListItem[] = [
      { ...base('1'), folderId: 'f-brand' },
      { ...base('2'), folderId: 'f-brand' },
      { ...base('3'), folderId: null },
    ];
    // f-brand has one child folder (f-logos) and two assets.
    expect(folderChildCount(folders, items, 'f-brand')).toBe(3);
    expect(folderChildCount(folders, items, 'f-camp')).toBe(0);
  });
});

describe('formatters', () => {
  it('humanizes sizes and placeholders missing ones', () => {
    expect(humanizeSize(null)).toBe('-');
    expect(humanizeSize(512)).toBe('512 B');
    expect(humanizeSize(2048)).toBe('2 KB');
    expect(humanizeSize(1_500_000)).toBe('1.4 MB');
  });

  it('extracts uppercase extensions', () => {
    expect(fileExtension('brief.final.pdf')).toBe('PDF');
    expect(fileExtension('noext')).toBe('');
  });

  it('builds a short MIME badge', () => {
    expect(mimeBadge('image/png')).toBe('PNG');
    expect(mimeBadge('image/svg+xml')).toBe('SVG');
    expect(mimeBadge(null)).toBe('FILE');
  });

  it('extracts link domains', () => {
    expect(linkDomain('https://www.figma.com/file/abc')).toBe('figma.com');
    expect(linkDomain(null)).toBe('');
  });

  it('formats dimensions with a placeholder for nulls', () => {
    expect(formatDimensions(800, 600)).toBe('800 x 600');
    expect(formatDimensions(null, 600)).toBe('-');
  });

  it('counts attachments per asset id', () => {
    expect(countAttachments([{ asset_id: 'a' }, { asset_id: 'a' }, { asset_id: 'b' }])).toEqual(
      new Map([
        ['a', 2],
        ['b', 1],
      ]),
    );
  });
});

/** A minimal AssetListItem for filter/folder fixtures. */
function base(id: string): AssetListItem {
  return {
    id,
    filename: `${id}.png`,
    displayName: null,
    folderPath: '/',
    folderId: null,
    tags: [],
    uploadedAt: '2026-06-01T00:00:00Z',
    currentVersionId: `v-${id}`,
    rawKind: 'image',
    kind: 'image',
    mimeType: 'image/png',
    sizeBytes: 1024,
    width: 10,
    height: 10,
    durationMs: null,
    externalUrl: null,
    r2Key: `images/${id}.png`,
    versionNumber: 1,
    attachmentCount: 0,
  };
}

describe('removeAssetsById (optimistic remove + rollback)', () => {
  it('removes only the listed ids, preserving order of the rest', () => {
    const items = [base('a'), base('b'), base('c')];
    expect(removeAssetsById(items, ['b']).map((i) => i.id)).toEqual(['a', 'c']);
    expect(removeAssetsById(items, new Set(['a', 'c'])).map((i) => i.id)).toEqual(['b']);
  });

  it('is a no-op for unknown ids and returns a new array', () => {
    const items = [base('a'), base('b')];
    const out = removeAssetsById(items, ['zzz']);
    expect(out.map((i) => i.id)).toEqual(['a', 'b']);
    expect(out).not.toBe(items);
  });

  it('round-trips a single optimistic delete: remove then restore the snapshot', () => {
    const snapshot = [base('a'), base('b'), base('c')];
    const optimistic = removeAssetsById(snapshot, ['b']);
    expect(optimistic.map((i) => i.id)).toEqual(['a', 'c']);
    // On failure the caller restores the untouched snapshot reference.
    expect(snapshot.map((i) => i.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('renameAssetInList', () => {
  it('replaces the matching asset display name, leaving other items untouched', () => {
    const items = [
      { ...base('a'), displayName: 'Old' },
      { ...base('b'), displayName: 'Keep' },
    ];
    const out = renameAssetInList(items, 'a', 'New');
    expect(out.map((i) => i.displayName)).toEqual(['New', 'Keep']);
  });

  it('returns a new array reference', () => {
    const items = [base('a'), base('b')];
    const out = renameAssetInList(items, 'a', 'New');
    expect(out).not.toBe(items);
  });

  it('returns the list unchanged when no asset matches the id', () => {
    const items = [base('a'), base('b')];
    const out = renameAssetInList(items, 'zzz', 'New');
    expect(out.map((i) => i.displayName)).toEqual([null, null]);
  });
});

describe('deleteAssetsBatch (bounded concurrency)', () => {
  it('partitions successes from failures and never aborts the batch', async () => {
    const run = (id: string) =>
      Promise.resolve(
        id === 'b'
          ? ({
              ok: false,
              error: { code: 'workspace_member_only', message: 'workspace_member_only' },
            } as const)
          : ({ ok: true, data: undefined } as const),
      );
    const outcome = await deleteAssetsBatch(['a', 'b', 'c'], 6, run);
    expect(outcome.succeeded.sort()).toEqual(['a', 'c']);
    expect(outcome.failed).toEqual([{ id: 'b', message: 'workspace_member_only' }]);
  });

  it('captures a thrown/rejected run as a failure rather than throwing', async () => {
    const run = (id: string) =>
      id === 'x'
        ? Promise.reject(new Error('boom'))
        : Promise.resolve({ ok: true, data: undefined } as const);
    const outcome = await deleteAssetsBatch(['x', 'y'], 6, run);
    expect(outcome.succeeded).toEqual(['y']);
    expect(outcome.failed).toEqual([{ id: 'x', message: 'boom' }]);
  });

  it('never exceeds the concurrency limit while still processing every id', async () => {
    let active = 0;
    let peak = 0;
    const run = async (): Promise<{ ok: true; data: undefined }> => {
      active += 1;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active -= 1;
      return { ok: true, data: undefined };
    };
    const ids = Array.from({ length: 20 }, (_, i) => `id-${i}`);
    const outcome = await deleteAssetsBatch(ids, 3, run);
    expect(outcome.succeeded).toHaveLength(20);
    expect(outcome.failed).toHaveLength(0);
    expect(peak).toBeLessThanOrEqual(3);
  });
});
