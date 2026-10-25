// Server totals for the Assets page: tab counts are HEAD count reads with the
// list's own filters (never derived from loaded rows), Select all reads every
// matching id in keyset pages of 1000, and a bulk delete runs in sequential
// batches that stop at the first failure. The PostgREST builder is faked, so
// every request the page would send is asserted without a database.

import { describe, expect, it } from 'vitest';
import type { Client, Result } from '@srtdio/rpc';
import {
  ASSET_ID_PAGE_SIZE,
  ASSET_TABS,
  BULK_BATCH_SIZE,
  BULK_DELETE_MAX,
  assetKeysetFilter,
  chunkIds,
  countAssetTabs,
  countAssetsInTab,
  deleteInBatches,
  listAssetIds,
  tabKinds,
  type BatchStepResult,
} from '@/lib/assets';
import { partialDeleteLabel, SELECT_ALL_FAILED } from '@/components/pages/assets/assets-nav';

type Call = [string, ...unknown[]];

interface FakeResponse {
  data?: unknown;
  error?: { message: string } | null;
  count?: number | null;
}

/**
 * A client whose every from() returns a fresh recording builder. `respond`
 * decides each request's answer from its recorded calls (sync or async).
 */
function fakeClient(
  respond: (calls: Call[], index: number) => FakeResponse | Promise<FakeResponse>,
) {
  const requests: Call[][] = [];
  const client = {
    from: (table: string) => {
      const calls: Call[] = [['from', table]];
      const index = requests.length;
      requests.push(calls);
      const b: Record<string, unknown> = {};
      for (const method of ['select', 'eq', 'is', 'in', 'or', 'order', 'limit']) {
        b[method] = (...args: unknown[]) => {
          calls.push([method, ...args]);
          return b;
        };
      }
      b.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve(respond(calls, index))
          .then((r) => ({ data: r.data ?? null, error: r.error ?? null, count: r.count ?? null }))
          .then(resolve, reject);
      return b;
    },
  } as unknown as Client;
  return { client, requests };
}

function callsOf(calls: Call[], method: string): unknown[][] {
  return calls.filter((c) => c[0] === method).map((c) => c.slice(1));
}

describe('tabKinds', () => {
  it('reads KIND_TAB backwards', () => {
    expect(tabKinds('media')).toEqual(['image', 'video', 'audio']);
    expect(tabKinds('docs')).toEqual(['document', 'presentation']);
    expect(tabKinds('pdf')).toEqual(['pdf']);
    expect(tabKinds('sheets')).toEqual(['spreadsheet']);
    expect(tabKinds('links')).toEqual(['link']);
  });
});

describe('countAssetsInTab (HEAD count, list filters)', () => {
  it('All counts assets with the list filters and head:true, no kind filter', async () => {
    const { client, requests } = fakeClient(() => ({ count: 1234 }));
    const result = await countAssetsInTab(client, 'w1', 'all');
    expect(result).toEqual({ ok: true, data: 1234 });
    expect(requests).toHaveLength(1);
    const calls = requests[0] ?? [];
    expect(calls[0]).toEqual(['from', 'assets']);
    expect(callsOf(calls, 'select')).toEqual([['id', { count: 'exact', head: true }]]);
    expect(callsOf(calls, 'eq')).toEqual([['workspace_id', 'w1']]);
    expect(callsOf(calls, 'is')).toEqual([['deleted_at', null]]);
    expect(callsOf(calls, 'in')).toEqual([]);
    // A count never pages or orders.
    expect(callsOf(calls, 'limit')).toEqual([]);
    expect(callsOf(calls, 'order')).toEqual([]);
  });

  it('a tab inner-joins the current version and filters its kind', async () => {
    const { client, requests } = fakeClient(() => ({ count: 7 }));
    const result = await countAssetsInTab(client, 'w1', 'media');
    expect(result).toEqual({ ok: true, data: 7 });
    const calls = requests[0] ?? [];
    const [select] = callsOf(calls, 'select');
    expect(select?.[0]).toBe(
      'id, current_version:asset_versions!assets_current_version_id_fkey!inner(kind)',
    );
    expect(select?.[1]).toEqual({ count: 'exact', head: true });
    expect(callsOf(calls, 'eq')).toEqual([['workspace_id', 'w1']]);
    expect(callsOf(calls, 'is')).toEqual([['deleted_at', null]]);
    expect(callsOf(calls, 'in')).toEqual([['current_version.kind', ['image', 'video', 'audio']]]);
  });

  it('a null count is 0; an error or a throw is { ok: false }', async () => {
    expect(await countAssetsInTab(fakeClient(() => ({ count: null })).client, 'w1', 'pdf')).toEqual(
      { ok: true, data: 0 },
    );
    const failed = await countAssetsInTab(
      fakeClient(() => ({ error: { message: 'boom' } })).client,
      'w1',
      'pdf',
    );
    expect(failed.ok).toBe(false);
    const thrown = await countAssetsInTab({} as unknown as Client, 'w1', 'all');
    expect(thrown.ok).toBe(false);
  });
});

describe('countAssetTabs (parallel)', () => {
  it('sends one count per tab, all before any answers, and maps them by tab', async () => {
    const release: Array<() => void> = [];
    const { client, requests } = fakeClient(
      (calls) =>
        new Promise<FakeResponse>((resolve) => {
          const kind = callsOf(calls, 'in')[0]?.[1] as string[] | undefined;
          const n = kind === undefined ? 100 : kind.length;
          release.push(() => resolve({ count: n }));
        }),
    );
    const pending = countAssetTabs(client, 'w1');
    // Let the builders' then() run without answering any request yet.
    await new Promise((r) => setTimeout(r, 0));
    expect(requests).toHaveLength(ASSET_TABS.length);
    expect(release).toHaveLength(ASSET_TABS.length);
    for (const go of release) go();
    const result = await pending;
    expect(result).toEqual({
      ok: true,
      data: { all: 100, media: 3, pdf: 1, docs: 2, sheets: 1, links: 1 },
    });
    // Every request carries the list's filters.
    for (const calls of requests) {
      expect(callsOf(calls, 'eq')).toEqual([['workspace_id', 'w1']]);
      expect(callsOf(calls, 'is')).toEqual([['deleted_at', null]]);
      expect(callsOf(calls, 'select')[0]?.[1]).toEqual({ count: 'exact', head: true });
    }
  });

  it('one failed count fails the read (never a mix of fresh and stale)', async () => {
    const { client } = fakeClient((_calls, index) =>
      index === 2 ? { error: { message: 'boom' } } : { count: 1 },
    );
    const result = await countAssetTabs(client, 'w1');
    expect(result.ok).toBe(false);
  });
});

/** Ids in (uploaded_at desc, id desc) order, all sharing one instant (a tie across pages). */
function rowsFor(total: number): Array<{ id: string; uploaded_at: string }> {
  return Array.from({ length: total }, (_, i) => ({
    id: `id-${String(total - i).padStart(5, '0')}`,
    uploaded_at: '2026-10-01T00:00:00+00:00',
  }));
}

describe('listAssetIds (Select all, keyset pages of 1000)', () => {
  it('pages in 1000s on (uploaded_at, id) until a short page', async () => {
    const all = rowsFor(2500);
    const { client, requests } = fakeClient((_calls, index) => ({
      data: all.slice(index * ASSET_ID_PAGE_SIZE, (index + 1) * ASSET_ID_PAGE_SIZE),
    }));
    const result = await listAssetIds(client, 'w1', 'all');
    expect(result.ok && result.data).toEqual(all.map((row) => row.id));
    expect(ASSET_ID_PAGE_SIZE).toBe(1000);
    expect(requests).toHaveLength(3);
    for (const calls of requests) {
      expect(callsOf(calls, 'select')).toEqual([['id, uploaded_at']]);
      expect(callsOf(calls, 'eq')).toEqual([['workspace_id', 'w1']]);
      expect(callsOf(calls, 'is')).toEqual([['deleted_at', null]]);
      expect(callsOf(calls, 'order')).toEqual([
        ['uploaded_at', { ascending: false }],
        ['id', { ascending: false }],
      ]);
      expect(callsOf(calls, 'limit')).toEqual([[1000]]);
    }
    expect(callsOf(requests[0] ?? [], 'or')).toEqual([]);
    const lastOfFirst = all[999];
    const lastOfSecond = all[1999];
    expect(callsOf(requests[1] ?? [], 'or')).toEqual([
      [
        assetKeysetFilter({
          uploadedAt: lastOfFirst?.uploaded_at ?? '',
          id: lastOfFirst?.id ?? '',
        }),
      ],
    ]);
    expect(callsOf(requests[2] ?? [], 'or')).toEqual([
      [
        assetKeysetFilter({
          uploadedAt: lastOfSecond?.uploaded_at ?? '',
          id: lastOfSecond?.id ?? '',
        }),
      ],
    ]);
  });

  it('an exact multiple of 1000 ends on an empty page', async () => {
    const all = rowsFor(1000);
    const { client, requests } = fakeClient((_calls, index) => ({
      data: index === 0 ? all : [],
    }));
    const result = await listAssetIds(client, 'w1', 'all');
    expect(result.ok && result.data.length).toBe(1000);
    expect(requests).toHaveLength(2);
  });

  it('a tab adds the inner-joined kind filter to every page', async () => {
    const { client, requests } = fakeClient(() => ({ data: rowsFor(3) }));
    const result = await listAssetIds(client, 'w1', 'docs');
    expect(result.ok && result.data).toHaveLength(3);
    const calls = requests[0] ?? [];
    expect(callsOf(calls, 'select')[0]?.[0]).toBe(
      'id, uploaded_at, current_version:asset_versions!assets_current_version_id_fkey!inner(kind)',
    );
    expect(callsOf(calls, 'in')).toEqual([['current_version.kind', ['document', 'presentation']]]);
  });

  it('a failed page fails the whole read', async () => {
    const { client } = fakeClient((_calls, index) =>
      index === 0 ? { data: rowsFor(1000) } : { error: { message: 'boom' } },
    );
    const result = await listAssetIds(client, 'w1', 'all');
    expect(result.ok).toBe(false);
  });
});

describe('chunkIds', () => {
  it('splits in order, last batch short', () => {
    expect(chunkIds(['a', 'b', 'c', 'd', 'e'], 2)).toEqual([['a', 'b'], ['c', 'd'], ['e']]);
    expect(chunkIds([], 200)).toEqual([]);
    expect(chunkIds(['a'], 0)).toEqual([['a']]);
  });
});

function ids(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `a${i}`);
}

describe('deleteInBatches (sequential, stop on first error)', () => {
  it('batches at the server cap: min(500, BULK_DELETE_MAX)', () => {
    expect(BULK_BATCH_SIZE).toBe(Math.min(500, BULK_DELETE_MAX));
    expect(BULK_BATCH_SIZE).toBe(200);
  });

  it('runs every batch one at a time and gathers what was deleted and kept', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const seen: string[][] = [];
    const outcome = await deleteInBatches(ids(450), BULK_BATCH_SIZE, async (batch) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      seen.push(batch);
      await new Promise((r) => setTimeout(r, 0));
      inFlight -= 1;
      const [first, ...rest] = batch;
      return { ok: true, data: { deleted: rest, kept: first === undefined ? [] : [first] } };
    });
    expect(seen.map((b) => b.length)).toEqual([200, 200, 50]);
    expect(seen.flat()).toEqual(ids(450));
    expect(maxInFlight).toBe(1);
    expect(outcome.failure).toBeNull();
    expect(outcome.deleted).toHaveLength(447);
    expect(outcome.kept).toEqual(['a0', 'a200', 'a400']);
    expect(outcome.notDeleted).toEqual([]);
  });

  it('stops at the first failed batch and reports how many succeeded', async () => {
    let calls = 0;
    const outcome = await deleteInBatches(
      ids(650),
      BULK_BATCH_SIZE,
      async (batch): Promise<Result<BatchStepResult>> => {
        calls += 1;
        if (calls === 2) return { ok: false, error: { code: 'unknown', message: 'boom' } };
        return { ok: true, data: { deleted: batch, kept: [] } };
      },
    );
    expect(calls).toBe(2);
    expect(outcome.deleted).toEqual(ids(200));
    expect(outcome.failure?.error.message).toBe('boom');
    expect(outcome.failure?.batch).toEqual(ids(400).slice(200));
    expect(outcome.notDeleted).toEqual(ids(650).slice(200));
    expect(partialDeleteLabel(650 - outcome.deleted.length, outcome.deleted.length)).toBe(
      "Couldn't delete 450 files. 200 deleted.",
    );
  });

  it('a throwing step counts as a failure, never a rejection', async () => {
    const outcome = await deleteInBatches(ids(3), 2, () => Promise.reject(new Error('x')));
    expect(outcome.deleted).toEqual([]);
    expect(outcome.failure).not.toBeNull();
    expect(outcome.notDeleted).toEqual(ids(3));
  });

  it('no ids, no calls', async () => {
    let calls = 0;
    const outcome = await deleteInBatches([], BULK_BATCH_SIZE, async () => {
      calls += 1;
      return { ok: true, data: { deleted: [], kept: [] } };
    });
    expect(calls).toBe(0);
    expect(outcome).toEqual({ deleted: [], kept: [], failure: null, notDeleted: [] });
  });
});

describe('copy', () => {
  it('partial delete and Select all failure follow "Couldn\'t {action}. {reason}"', () => {
    expect(partialDeleteLabel(1, 3)).toBe("Couldn't delete 1 file. 3 deleted.");
    expect(partialDeleteLabel(5, 200)).toBe("Couldn't delete 5 files. 200 deleted.");
    expect(SELECT_ALL_FAILED).toBe("Couldn't select all files. Try again.");
  });
});
