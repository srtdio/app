import { afterEach, describe, expect, it, vi } from 'vitest';

// Request counts for the Assets first paint: the list (with attachment counts)
// is ONE request, a nav press starts it, and the page's mount joins it instead
// of asking again. The kept list (every loaded page) outlives the page for a
// return paint; a reload marks it stale, so the next read asks the server anew.

type Call = { table: string; method: string; args: unknown[] };
const { calls, reads } = vi.hoisted(() => ({
  calls: [] as { table: string; method: string; args: unknown[] }[],
  reads: [] as string[],
}));

vi.mock('@/lib/supabase', () => {
  const from = (table: string) => {
    const b: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'is', 'order', 'in', 'or', 'limit', 'maybeSingle']) {
      b[method] = (...args: unknown[]) => {
        calls.push({ table, method, args } satisfies Call);
        return b;
      };
    }
    b.then = (resolve: (v: unknown) => unknown) => {
      reads.push(table);
      const data =
        table === 'assets'
          ? [
              {
                id: 'a',
                filename: 'a.png',
                display_name: null,
                folder_path: '/',
                folder_id: null,
                tags: [],
                uploaded_at: '2026-10-01T00:00:00Z',
                current_version_id: null,
                current_version: null,
                asset_attachments: [{ asset_id: 'a' }, { asset_id: 'a' }, { asset_id: 'a' }],
              },
            ]
          : table === 'workspace_members'
            ? { role: 'agency' }
            : [];
      return Promise.resolve({ data, error: null, count: 0 }).then(resolve);
    };
    return b;
  };
  return { supabase: { from } };
});

import { supabase } from '@/lib/supabase';
import {
  keptAssetsPage,
  listAssetsPage,
  prefetchAssetsData,
  primeAssetsPage,
  readAssetsFirstPage,
  staleAssetsReads,
  withKeptTail,
  type AssetListItem,
  type AssetPage,
} from '@/lib/assets';
import { resetSessionReads } from '@/lib/session-read';

afterEach(() => {
  calls.length = 0;
  reads.length = 0;
  resetSessionReads();
});

const listReads = (): number =>
  calls.filter((c) => c.table === 'assets' && c.method === 'limit').length;

describe('Assets first page requests', () => {
  it('the list including attachment counts is one request', async () => {
    const result = await listAssetsPage(supabase, 'w1');
    expect(reads.filter((t) => t === 'assets')).toHaveLength(1);
    expect(reads).not.toContain('asset_attachments');
    expect(result.ok && result.data.items[0]?.attachmentCount).toBe(3);
  });

  it('a nav press starts the list and the mount joins it: one list request total', async () => {
    await prefetchAssetsData({ userId: 'u1', workspaceId: 'w1' });
    const page = await readAssetsFirstPage(supabase, 'u1', 'w1');
    expect(page.ok).toBe(true);
    expect(listReads()).toBe(1);
    expect(reads).not.toContain('asset_attachments');
  });

  it('a reload marks the read stale: the kept list stays and the next read asks anew', async () => {
    await readAssetsFirstPage(supabase, 'u1', 'w1');
    staleAssetsReads('u1', 'w1');
    expect(keptAssetsPage('u1', 'w1')?.items.map((item) => item.id)).toEqual(['a']);
    await readAssetsFirstPage(supabase, 'u1', 'w1');
    expect(listReads()).toBe(2);
  });

  it('the list the page keeps (every loaded page, its own writes) is what a return paints', async () => {
    await readAssetsFirstPage(supabase, 'u1', 'w1');
    const first = keptAssetsPage('u1', 'w1');
    expect(first).toBeDefined();
    if (first === undefined) return;
    const older = { ...first.items[0]!, id: 'older', uploadedAt: '2026-09-01T00:00:00Z' };
    primeAssetsPage('u1', 'w1', { items: [...first.items, older], next: { done: true } });
    expect(keptAssetsPage('u1', 'w1')?.items.map((item) => item.id)).toEqual(['a', 'older']);
    // Kept as a fresh read: the mount's refresh joins it with no request.
    await readAssetsFirstPage(supabase, 'u1', 'w1');
    expect(listReads()).toBe(1);
  });

  it('never shares across users or workspaces', async () => {
    await readAssetsFirstPage(supabase, 'u1', 'w1');
    await readAssetsFirstPage(supabase, 'u2', 'w1');
    await readAssetsFirstPage(supabase, 'u1', 'w2');
    expect(listReads()).toBe(3);
  });
});

describe('withKeptTail', () => {
  const item = (id: string, uploadedAt: string): AssetListItem =>
    ({ id, uploadedAt }) as unknown as AssetListItem;
  const kept: AssetPage = {
    items: [item('k3', '2026-10-03'), item('k2', '2026-10-02'), item('k1', '2026-10-01')],
    next: { done: false, cursor: { uploadedAt: '2026-10-01', id: 'k1' } },
  };

  it('keeps the older pages the person loaded under a refreshed first page', () => {
    const fresh: AssetPage = {
      items: [item('n4', '2026-10-04'), item('k3', '2026-10-03')],
      next: { done: false, cursor: { uploadedAt: '2026-10-03', id: 'k3' } },
    };
    const out = withKeptTail(fresh, kept);
    expect(out.items.map((i) => i.id)).toEqual(['n4', 'k3', 'k2', 'k1']);
    expect(out.next).toEqual(kept.next);
  });

  it('a refreshed page that is the last, or no older kept rows, is taken as is', () => {
    const last: AssetPage = { items: [item('n4', '2026-10-04')], next: { done: true } };
    expect(withKeptTail(last, kept)).toBe(last);
    const fresh: AssetPage = {
      items: [item('k1', '2026-10-01')],
      next: { done: false, cursor: { uploadedAt: '2026-10-01', id: 'k1' } },
    };
    expect(withKeptTail(fresh, kept)).toBe(fresh);
  });
});
