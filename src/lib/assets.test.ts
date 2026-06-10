import { describe, expect, it } from 'vitest';
import type { Client } from '@srtdio/rpc';
import {
  breadcrumbSegments,
  buildKindCounts,
  countAttachments,
  deriveKind,
  displayLabel,
  fileExtension,
  filterAssets,
  formatDimensions,
  humanizeSize,
  imageTileState,
  linkDomain,
  listAssets,
  mimeBadge,
  shapeAssets,
  sortAssets,
  subfolders,
  visibleKinds,
  type AssetListItem,
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

describe('folder helpers', () => {
  const items: AssetListItem[] = [
    { ...base('1'), folderPath: '/' },
    { ...base('2'), folderPath: '/brand' },
    { ...base('3'), folderPath: '/brand/logos' },
    { ...base('4'), folderPath: '/campaigns' },
  ];

  it('derives immediate subfolders of the current folder', () => {
    expect(subfolders(items, '/')).toEqual(['brand', 'campaigns']);
    expect(subfolders(items, '/brand')).toEqual(['logos']);
  });

  it('builds cumulative breadcrumb segments', () => {
    expect(breadcrumbSegments('/brand/logos/')).toEqual([
      { name: 'brand', path: '/brand/' },
      { name: 'logos', path: '/brand/logos/' },
    ]);
    expect(breadcrumbSegments('/')).toEqual([]);
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
