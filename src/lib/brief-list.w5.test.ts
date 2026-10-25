import { describe, expect, it } from 'vitest';
import type { Client } from '@srtdio/rpc';
import {
  BRIEF_FILTER_DEFAULT,
  BRIEF_LIST_PAGE_SIZE,
  briefKeysetFilter,
  briefListParams,
  listBriefsPage,
  mergeBriefPages,
  parseBriefFilter,
} from '@/lib/brief-list';

describe('parseBriefFilter (FT24, default Open)', () => {
  it('defaults to Open when the URL names no chip or an unknown one', () => {
    expect(BRIEF_FILTER_DEFAULT).toBe('open');
    expect(parseBriefFilter(null)).toBe('open');
    expect(parseBriefFilter('archived')).toBe('open');
  });

  it('reads all, open and closed', () => {
    expect(parseBriefFilter('all')).toBe('all');
    expect(parseBriefFilter('closed')).toBe('closed');
  });
});

describe('briefListParams', () => {
  it('writes status and q, leaving out the defaults, keeping other params', () => {
    const base = new URLSearchParams('keep=1');
    expect(briefListParams(base, 'closed', 'reel').toString()).toBe('keep=1&status=closed&q=reel');
    expect(briefListParams(new URLSearchParams('status=closed&q=x'), 'open', '').toString()).toBe(
      '',
    );
  });
});

// A recording client: every builder call is logged per table, and each awaited
// read of a table takes the next queued result for it.
type Call = { table: string; method: string; args: unknown[] };
function recordingClient(
  queue: Record<string, { data: unknown; error: { message: string } | null }[]>,
) {
  const calls: Call[] = [];
  const reads: string[] = [];
  const client = {
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      for (const method of ['select', 'eq', 'is', 'order', 'in', 'or', 'limit', 'like']) {
        b[method] = (...args: unknown[]) => {
          calls.push({ table, method, args });
          return b;
        };
      }
      b.then = (resolve: (v: unknown) => unknown) => {
        reads.push(table);
        const next = queue[table]?.shift() ?? { data: [], error: null };
        return Promise.resolve(next).then(resolve);
      };
      return b;
    },
  } as unknown as Client;
  return { client, calls, reads };
}

/** `count` brief rows, newest first, with distinct ids and created times. */
function briefRows(start: number, count: number) {
  return Array.from({ length: count }, (_, i) => {
    const n = start + i;
    return {
      id: `b${String(10000 - n).padStart(5, '0')}`,
      workspace_id: 'w1',
      title: `Brief ${n}`,
      status: 'open',
      created_at: new Date(Date.UTC(2026, 9, 1) - n * 1000).toISOString(),
      deleted_at: null,
    };
  });
}

describe('listBriefsPage keyset paging', () => {
  it('reads one row past the page, ordered created_at desc then id desc, and hands back a cursor', async () => {
    const rows = briefRows(0, BRIEF_LIST_PAGE_SIZE + 1);
    const { client, calls, reads } = recordingClient({
      briefs: [{ data: rows, error: null }],
      asset_attachments: [{ data: [], error: null }],
    });
    const result = await listBriefsPage(client, 'w1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.items).toHaveLength(BRIEF_LIST_PAGE_SIZE);
    const last = rows[BRIEF_LIST_PAGE_SIZE - 1];
    expect(result.data.next).toEqual({
      done: false,
      cursor: { createdAt: last?.created_at, id: last?.id },
    });
    const briefCalls = calls.filter((c) => c.table === 'briefs');
    expect(briefCalls.filter((c) => c.method === 'eq').map((c) => c.args)).toEqual([
      ['workspace_id', 'w1'],
    ]);
    expect(briefCalls.filter((c) => c.method === 'order').map((c) => c.args)).toEqual([
      ['created_at', { ascending: false }],
      ['id', { ascending: false }],
    ]);
    expect(briefCalls.find((c) => c.method === 'limit')?.args).toEqual([
      BRIEF_LIST_PAGE_SIZE + 1,
    ]);
    expect(briefCalls.some((c) => c.method === 'or')).toBe(false);
    // Two requests per page: the briefs read, then ONE thumbnails IN read.
    expect(reads).toEqual(['briefs', 'asset_attachments']);
    const inCalls = calls.filter((c) => c.table === 'asset_attachments' && c.method === 'in');
    expect(inCalls).toHaveLength(1);
    expect(inCalls[0]?.args).toEqual([
      'entity_id',
      rows.slice(0, BRIEF_LIST_PAGE_SIZE).map((row) => row.id),
    ]);
  });

  it('the second page filters strictly after the last row (created_at, id) with .or', async () => {
    const cursor = { createdAt: '2026-09-30T23:58:20.123456+00:00', id: 'b09900' };
    const { client, calls } = recordingClient({
      briefs: [{ data: briefRows(200, 2), error: null }],
      asset_attachments: [{ data: [], error: null }],
    });
    const result = await listBriefsPage(client, 'w1', cursor);
    const or = calls.find((c) => c.table === 'briefs' && c.method === 'or');
    expect(or?.args).toEqual([
      'created_at.lt."2026-09-30T23:58:20.123456+00:00",' +
        'and(created_at.eq."2026-09-30T23:58:20.123456+00:00",id.lt."b09900")',
    ]);
    expect(or?.args[0]).toBe(briefKeysetFilter(cursor));
    // A short page is the last page.
    expect(result.ok && result.data.next).toEqual({ done: true });
  });

  it('page one then page two merge with no duplicates', async () => {
    const first = briefRows(0, BRIEF_LIST_PAGE_SIZE + 1);
    const repeated = first[BRIEF_LIST_PAGE_SIZE - 1];
    const second = [
      ...(repeated !== undefined ? [repeated] : []),
      ...briefRows(BRIEF_LIST_PAGE_SIZE, 3),
    ];
    const { client } = recordingClient({
      briefs: [
        { data: first, error: null },
        { data: second, error: null },
      ],
      asset_attachments: [
        { data: [], error: null },
        { data: [], error: null },
      ],
    });
    const one = await listBriefsPage(client, 'w1');
    if (!one.ok || one.data.next.done) throw new Error('expected another page');
    const two = await listBriefsPage(client, 'w1', one.data.next.cursor);
    if (!two.ok) throw new Error('page two failed');
    const merged = mergeBriefPages(one.data.items, two.data.items);
    const ids = merged.map((brief) => brief.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(merged).toHaveLength(BRIEF_LIST_PAGE_SIZE + 3);
  });

  it('maps each brief to its first image from the one thumbnails read', async () => {
    const rows = briefRows(0, 2);
    const { client } = recordingClient({
      briefs: [{ data: rows, error: null }],
      asset_attachments: [
        {
          data: [
            {
              entity_id: rows[0]?.id,
              asset_version_id: 'v1',
              asset_versions: { mime_type: 'image/png' },
            },
            {
              entity_id: rows[0]?.id,
              asset_version_id: 'v2',
              asset_versions: { mime_type: 'image/png' },
            },
          ],
          error: null,
        },
      ],
    });
    const result = await listBriefsPage(client, 'w1');
    expect(result.ok && result.data.items.map((b) => b.thumbnailAssetVersionId)).toEqual([
      'v1',
      null,
    ]);
  });

  it('skips the thumbnails read for an empty page, and fails when a read fails', async () => {
    const empty = recordingClient({ briefs: [{ data: [], error: null }] });
    expect(await listBriefsPage(empty.client, 'w1')).toEqual({
      ok: true,
      data: { items: [], next: { done: true } },
    });
    expect(empty.reads).toEqual(['briefs']);

    const failed = recordingClient({ briefs: [{ data: null, error: { message: 'boom' } }] });
    expect(await listBriefsPage(failed.client, 'w1')).toEqual({
      ok: false,
      error: { code: 'unknown', message: 'boom' },
    });
  });
});

describe('mergeBriefPages', () => {
  it('appends new ids, keeps existing order and drops repeats', () => {
    const merged = mergeBriefPages([{ id: 'a' }, { id: 'b' }], [{ id: 'b' }, { id: 'c' }]);
    expect(merged.map((row) => row.id)).toEqual(['a', 'b', 'c']);
  });
});
