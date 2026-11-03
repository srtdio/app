// Assets search regression: listAssetsPage narrows on the server (filename
// or display_name ILIKE, escaped and quoted), ANDed with the keyset cursor in
// ONE or() argument; nothing under 2 characters; the search's cursor carries
// its query; a newer query aborts the read in flight (the shared runner).
import { describe, expect, it } from 'vitest';
import type { Client } from '@srtdio/rpc';
import { ASSETS_PAGE_SIZE, assetKeysetFilter, assetPageFilter, listAssetsPage } from '@/lib/assets';
import { andOrFilters, createServerSearchRunner } from '@/lib/search/server-search';

interface Read {
  calls: { method: string; args: unknown[] }[];
  signal?: AbortSignal;
}

/** A recording query builder per from(); every read answers `rows` (or never). */
function recordingClient(rows: unknown[] | 'pending' = []) {
  const reads: Read[] = [];
  const client = {
    from: () => {
      const read: Read = { calls: [] };
      reads.push(read);
      const b: Record<string, unknown> = {};
      for (const method of ['select', 'eq', 'is', 'or', 'order', 'limit']) {
        b[method] = (...args: unknown[]) => {
          read.calls.push({ method, args });
          return b;
        };
      }
      b.abortSignal = (signal: AbortSignal) => {
        read.signal = signal;
        return b;
      };
      b.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        (rows === 'pending'
          ? new Promise<never>(() => {})
          : Promise.resolve({ data: rows, error: null })
        ).then(resolve, reject);
      return b;
    },
  } as unknown as Client;
  return { client, reads };
}

const orOf = (read: Read | undefined): unknown[] =>
  (read?.calls ?? []).filter((c) => c.method === 'or').map((c) => c.args[0]);

const SEARCH = 'filename.ilike."%reel%",display_name.ilike."%reel%"';
const cursor = { uploadedAt: '2026-10-01T00:00:00+00:00', id: 'a9' };

function rawAsset(n: number) {
  return {
    id: `a${n}`,
    filename: `reel-${n}.png`,
    display_name: null,
    folder_path: '/',
    folder_id: null,
    tags: [],
    uploaded_at: new Date(Date.UTC(2026, 9, 1) - n * 1000).toISOString(),
    current_version_id: null,
    current_version: null,
    asset_attachments: [],
  };
}

describe('listAssetsPage server search', () => {
  it('a search alone is one or(): filename or display_name, quoted', async () => {
    const { client, reads } = recordingClient();
    await listAssetsPage(client, 'w1', undefined, ' reel ');
    expect(orOf(reads[0])).toEqual([SEARCH]);
  });

  it('cursor AND search: ONE or() argument, and(or(cursor),or(search))', async () => {
    const { client, reads } = recordingClient();
    await listAssetsPage(client, 'w1', cursor, 'reel');
    expect(orOf(reads[0])).toEqual([`and(or(${assetKeysetFilter(cursor)}),or(${SEARCH}))`]);
    expect(orOf(reads[0])).toEqual([andOrFilters(assetKeysetFilter(cursor), SEARCH)]);
    expect(assetPageFilter(cursor, 'reel')).toBe(orOf(reads[0])[0]);
  });

  it('escapes LIKE metacharacters and quoting in the value', () => {
    expect(assetPageFilter(undefined, '5%_"x')).toBe(
      'filename.ilike."%5\\\\%\\\\_\\"x%",display_name.ilike."%5\\\\%\\\\_\\"x%"',
    );
  });

  it('under 2 characters (and a plain Load more) adds no search filter', async () => {
    const one = recordingClient();
    await listAssetsPage(one.client, 'w1', undefined, 'r');
    expect(orOf(one.reads[0])).toEqual([]);
    const plain = recordingClient();
    await listAssetsPage(plain.client, 'w1', cursor);
    expect(orOf(plain.reads[0])).toEqual([assetKeysetFilter(cursor)]);
  });

  it("a search page's cursor carries its query; Load more continues that search", async () => {
    const rows = Array.from({ length: ASSETS_PAGE_SIZE + 1 }, (_, i) => rawAsset(i));
    const first = recordingClient(rows);
    const page = await listAssetsPage(first.client, 'w1', undefined, 'reel');
    if (!page.ok || page.data.next.done) throw new Error('expected a next page');
    const next = page.data.next.cursor;
    expect(next.query).toBe('reel');
    const second = recordingClient();
    await listAssetsPage(second.client, 'w1', next);
    expect(orOf(second.reads[0])).toEqual([assetPageFilter(next, 'reel')]);
  });

  it('the runner sends nothing under 2 characters and aborts a read when the query changes', () => {
    const { client, reads } = recordingClient('pending');
    const pending: Array<() => void> = [];
    const runner = createServerSearchRunner({
      fetch: (query, signal) => listAssetsPage(client, 'w1', undefined, query, signal),
      onChange: () => {},
      setTimer: (run) => pending.push(run),
      clearTimer: () => pending.splice(0),
    });
    const flush = (): void => pending.splice(0).forEach((run) => run());
    runner.setQuery('r');
    flush();
    expect(reads).toHaveLength(0);
    runner.setQuery('re');
    flush();
    expect(reads).toHaveLength(1);
    expect(orOf(reads[0])).toEqual(['filename.ilike."%re%",display_name.ilike."%re%"']);
    expect(reads[0]?.signal?.aborted).toBe(false);
    runner.setQuery('reel');
    expect(reads[0]?.signal?.aborted).toBe(true);
    flush();
    expect(orOf(reads[1])).toEqual([SEARCH]);
  });
});
