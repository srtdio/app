import { afterEach, describe, expect, it, vi } from 'vitest';

// Request counts for the Assets first paint: the list (with attachment counts)
// is ONE request, a nav press starts it, and the page's mount joins it instead
// of asking again. Leaving the page drops the shared read, so a later visit
// reads the server anew.

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
  dropAssetsReads,
  listAssetsPage,
  prefetchAssetsData,
  readAssetsFirstPage,
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

  it('after the page leaves (drop), the next visit reads anew', async () => {
    await readAssetsFirstPage(supabase, 'u1', 'w1');
    dropAssetsReads('u1', 'w1');
    await readAssetsFirstPage(supabase, 'u1', 'w1');
    expect(listReads()).toBe(2);
  });

  it('never shares across users or workspaces', async () => {
    await readAssetsFirstPage(supabase, 'u1', 'w1');
    await readAssetsFirstPage(supabase, 'u2', 'w1');
    await readAssetsFirstPage(supabase, 'u1', 'w2');
    expect(listReads()).toBe(3);
  });
});
