import { afterEach, describe, expect, it, vi } from 'vitest';

// Request counts for the Briefs first paint: the rows are one request, the
// thumbnails read is chained on them (one IN read), and a nav press starts both
// plus the counts, which the page's mount then joins instead of asking again.

const { reads } = vi.hoisted(() => ({ reads: [] as string[] }));

vi.mock('@/lib/supabase', () => {
  const from = (table: string) => {
    const b: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'is', 'order', 'in', 'or', 'limit', 'like', 'ilike']) {
      b[method] = () => b;
    }
    b.then = (resolve: (v: unknown) => unknown) => {
      reads.push(table);
      const data =
        table === 'briefs'
          ? [{ id: 'b1', workspace_id: 'w1', created_at: '2026-10-01T00:00:00Z' }]
          : [
              {
                entity_id: 'b1',
                asset_version_id: 'v1',
                asset_versions: { mime_type: 'image/png' },
              },
            ];
      return Promise.resolve({ data, error: null, count: 1 }).then(resolve);
    };
    return b;
  };
  return { supabase: { from } };
});

import { supabase } from '@/lib/supabase';
import {
  dropBriefsReads,
  prefetchBriefsData,
  readBriefCounts,
  readBriefsFirstPage,
} from '@/lib/brief-list-shared';
import { resetSessionReads } from '@/lib/session-read';

afterEach(() => {
  reads.length = 0;
  resetSessionReads();
});

const rowsReads = (): number => reads.filter((t) => t === 'briefs').length;

describe('Briefs first page requests', () => {
  it('rows are one request; the thumbnails are one more, chained, never awaited for the rows', async () => {
    const page = await readBriefsFirstPage(supabase, 'u1', 'w1');
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    expect(page.data.items.map((b) => b.thumbnailAssetVersionId)).toEqual([null]);
    const thumbs = await page.data.thumbs;
    expect(thumbs.ok && thumbs.data.get('b1')).toBe('v1');
    expect(reads.filter((t) => t === 'asset_attachments')).toHaveLength(1);
  });

  it('a nav press starts the rows and the counts; the mount joins both', async () => {
    await prefetchBriefsData({ userId: 'u1', workspaceId: 'w1' });
    const [page] = await Promise.all([
      readBriefsFirstPage(supabase, 'u1', 'w1'),
      readBriefCounts(supabase, 'u1', 'w1', ''),
    ]);
    if (page.ok) await page.data.thumbs;
    // The press's requests only: one rows read plus three HEAD counts (one per
    // chip) on briefs, and one thumbnails read. The mount added none.
    expect(rowsReads()).toBe(4);
    expect(reads.filter((t) => t === 'asset_attachments')).toHaveLength(1);
  });

  it('after the page leaves (drop), the next visit reads anew', async () => {
    await readBriefsFirstPage(supabase, 'u1', 'w1');
    dropBriefsReads('u1', 'w1');
    await readBriefsFirstPage(supabase, 'u1', 'w1');
    expect(rowsReads()).toBe(2);
  });
});
