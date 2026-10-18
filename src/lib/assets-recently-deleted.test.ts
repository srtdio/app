import { describe, expect, it, vi } from 'vitest';
import type { Client } from '@srtdio/rpc';
import {
  assetInUseMessage,
  daysLeft,
  deletedBytes,
  emptyConfirmMessage,
  findAssetsInUse,
  formatMegabytes,
  freesLine,
  goneInLine,
  isAssetInUseError,
  listDeletedAssets,
  openParentLabel,
  purgeAssets,
  resolveAssetParents,
  type PurgeConfig,
} from '@/lib/assets';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-17T12:00:00Z');

function iso(msAgo: number): string {
  return new Date(NOW - msAgo).toISOString();
}

describe('daysLeft', () => {
  it('is 31 on the day of the delete', () => {
    expect(daysLeft(iso(0), NOW)).toBe(31);
    expect(daysLeft(iso(DAY - 1), NOW)).toBe(31);
  });

  it('drops one per whole day elapsed', () => {
    expect(daysLeft(iso(DAY), NOW)).toBe(30);
    expect(daysLeft(iso(30 * DAY + 5), NOW)).toBe(1);
    expect(daysLeft(iso(31 * DAY), NOW)).toBe(0);
  });

  it('never goes below 0', () => {
    expect(daysLeft(iso(45 * DAY), NOW)).toBe(0);
  });
});

describe('Recently deleted copy', () => {
  it('formats a row detail line with size and days left', () => {
    expect(goneInLine(2 * 1024 * 1024, 12)).toBe('2 MB · gone in 12 days');
    expect(goneInLine(512, 1)).toBe('512 B · gone in 1 day');
    expect(goneInLine(null, 0)).toBe('- · gone in 0 days');
  });

  it('formats the Empty now hint in MB', () => {
    expect(formatMegabytes(0)).toBe('0');
    expect(formatMegabytes(1.25 * 1024 * 1024)).toBe('1.3');
    expect(formatMegabytes(42.4 * 1024 * 1024)).toBe('42');
    expect(freesLine(3 * 1024 * 1024)).toBe('Frees 3 MB right away.');
  });

  it('formats the Empty confirm body with a file plural', () => {
    expect(emptyConfirmMessage(1)).toBe(
      "1 file deleted for good. Nothing is saved, and this can't be undone.",
    );
    expect(emptyConfirmMessage(3)).toBe(
      "3 files deleted for good. Nothing is saved, and this can't be undone.",
    );
  });

  it('sums sizes, treating unknown as 0', () => {
    expect(
      deletedBytes([
        { id: 'a', name: 'a', deletedAt: iso(0), sizeBytes: 10 },
        { id: 'b', name: 'b', deletedAt: iso(0), sizeBytes: null },
        { id: 'c', name: 'c', deletedAt: iso(0), sizeBytes: 5 },
      ]),
    ).toBe(15);
  });
});

describe('in-use copy', () => {
  it('names one file, or the first and how many more', () => {
    expect(assetInUseMessage('hero.png', 0)).toBe(
      'hero.png is part of a post. Delete the post first, then the file.',
    );
    expect(assetInUseMessage('hero.png', 1)).toBe(
      'hero.png and 1 more are part of a post. Delete the post first, then the file.',
    );
    expect(assetInUseMessage('hero.png', 3)).toBe(
      'hero.png and 3 more are part of a post. Delete the post first, then the file.',
    );
  });

  it('labels the open button by parent kind', () => {
    expect(openParentLabel('post')).toBe('Open post');
    expect(openParentLabel('brief')).toBe('Open brief');
    expect(openParentLabel('comment')).toBe('Open comment');
  });

  it('recognises the asset_in_use raise only', () => {
    expect(isAssetInUseError({ message: 'asset_in_use' })).toBe(true);
    expect(isAssetInUseError({ message: 'workspace_member_only' })).toBe(false);
  });
});

describe('resolveAssetParents', () => {
  const rows = [
    { asset_id: 'a1', entity_type: 'post', entity_id: 'p-dead' },
    { asset_id: 'a1', entity_type: 'brief', entity_id: 'b1' },
    { asset_id: 'a2', entity_type: 'comment', entity_id: 'c1' },
    { asset_id: 'a3', entity_type: 'post', entity_id: 'p1' },
  ];
  const comments = new Map([['c1', { id: 'c1', entity_type: 'post', entity_id: 'p9' }]]);

  it('skips dead parents, keeps input order, and links comments to their entity', () => {
    const out = resolveAssetParents(
      ['a3', 'a1', 'a2', 'a4'],
      rows,
      new Set(['p1']),
      new Set(['b1']),
      comments,
    );
    expect(out).toEqual([
      { assetId: 'a3', parent: { kind: 'post', href: '/posts/p1' } },
      { assetId: 'a1', parent: { kind: 'brief', href: '/briefs/b1' } },
      { assetId: 'a2', parent: { kind: 'comment', href: '/posts/p9?comment=c1' } },
    ]);
  });
});

// A thenable query builder: every chained method returns itself and records its
// call; awaiting it yields the configured result.
function builder(result: unknown, calls: string[] = []) {
  const b: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'is', 'not', 'in', 'order']) {
    b[method] = (...args: unknown[]) => {
      calls.push(`${method}:${JSON.stringify(args)}`);
      return b;
    };
  }
  b.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve);
  return b;
}

describe('listDeletedAssets', () => {
  it('reads once and sums every version size per asset', async () => {
    const calls: string[] = [];
    const from = vi.fn(() =>
      builder(
        {
          data: [
            {
              id: 'a1',
              filename: 'raw.png',
              display_name: 'Hero',
              deleted_at: iso(DAY),
              versions: [{ size_bytes: 2048 }, { size_bytes: 1024 }, { size_bytes: null }],
            },
            {
              id: 'a2',
              filename: 'doc.pdf',
              display_name: null,
              deleted_at: iso(0),
              versions: [{ size_bytes: null }],
            },
          ],
          error: null,
        },
        calls,
      ),
    );
    const result = await listDeletedAssets({ from } as unknown as Client, 'ws-1');
    expect(from).toHaveBeenCalledTimes(1);
    expect(calls).toContain('not:["deleted_at","is",null]');
    expect(calls.find((c) => c.startsWith('select:'))).toContain(
      'versions:asset_versions!asset_versions_asset_id_fkey(size_bytes)',
    );
    expect(result).toEqual({
      ok: true,
      data: [
        { id: 'a1', name: 'Hero', deletedAt: iso(DAY), sizeBytes: 3072 },
        { id: 'a2', name: 'doc.pdf', deletedAt: iso(0), sizeBytes: null },
      ],
    });
  });

  it('returns an error result when the read fails', async () => {
    const client = { from: () => builder({ data: null, error: { message: 'boom' } }) };
    const result = await listDeletedAssets(client as unknown as Client, 'ws-1');
    expect(result.ok).toBe(false);
  });
});

describe('findAssetsInUse', () => {
  it('does one read per table, never per asset', async () => {
    const tables: string[] = [];
    const client = {
      from: (table: string) => {
        tables.push(table);
        if (table === 'asset_attachments') {
          return builder({
            data: [
              { asset_id: 'a1', entity_type: 'post', entity_id: 'p1' },
              { asset_id: 'a2', entity_type: 'post', entity_id: 'p2' },
            ],
            error: null,
          });
        }
        return builder({ data: [{ id: 'p2' }], error: null });
      },
    } as unknown as Client;
    const result = await findAssetsInUse(client, ['a1', 'a2']);
    expect(tables).toEqual(['asset_attachments', 'posts']);
    expect(result).toEqual({
      ok: true,
      data: [{ assetId: 'a2', parent: { kind: 'post', href: '/posts/p2' } }],
    });
  });
});

describe('purgeAssets', () => {
  function config(fetcher: PurgeConfig['fetcher'], assetIds?: string[]): PurgeConfig {
    return {
      endpoint: 'https://up.example/',
      token: 'tok',
      workspaceId: 'ws-1',
      assetIds,
      fetcher,
    };
  }

  it('POSTs /purge with the bearer and maps a 200 to ok', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(JSON.stringify({ requested: 1, removed: 1, freedBytes: 900 }), {
          status: 200,
        }),
    );
    const result = await purgeAssets(config(fetcher, ['a1']));
    expect(result).toEqual({ ok: true, data: { requested: 1, removed: 1, freedBytes: 900 } });
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://up.example/purge');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(JSON.parse(init.body as string)).toEqual({ workspace_id: 'ws-1', asset_ids: ['a1'] });
  });

  it('omits asset_ids for Empty now', async () => {
    const fetcher = vi.fn(
      async () => new Response(JSON.stringify({ requested: 3, removed: 3, freedBytes: 1 })),
    );
    await purgeAssets(config(fetcher));
    const [, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ workspace_id: 'ws-1' });
  });

  it('carries the worker error code on a non-OK status', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { code: 'owner_only', message: 'x' } }), {
          status: 403,
        }),
    );
    const result = await purgeAssets(config(fetcher));
    expect(result).toEqual({ ok: false, error: { code: 'unknown', message: 'owner_only' } });
  });

  it('falls back to http_<status> when the body has no code', async () => {
    const fetcher = vi.fn(async () => new Response('nope', { status: 500 }));
    const result = await purgeAssets(config(fetcher));
    expect(result).toEqual({ ok: false, error: { code: 'unknown', message: 'http_500' } });
  });

  it('maps a transport failure and a malformed 200', async () => {
    const thrown = await purgeAssets(
      config(async () => {
        throw new Error('offline');
      }),
    );
    expect(thrown).toEqual({ ok: false, error: { code: 'unknown', message: 'network' } });
    const bad = await purgeAssets(config(async () => new Response(JSON.stringify({ removed: 1 }))));
    expect(bad).toEqual({ ok: false, error: { code: 'unknown', message: 'bad_response' } });
  });
});
