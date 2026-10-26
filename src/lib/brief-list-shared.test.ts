import { afterEach, describe, expect, it, vi } from 'vitest';

// Request counts for the Briefs first paint: the rows are one request, the
// thumbnails read is chained on them (one IN read), and a nav press starts both
// plus the counts, which the page's mount then joins instead of asking again.
// The list the page painted is kept for a return paint; a reload marks the
// reads stale and never drops them.

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
import type { BriefWithThumbnail } from '@srtdio/briefs';
import {
  keptBriefCounts,
  keptBriefsList,
  prefetchBriefsData,
  primeBriefsList,
  readBriefCounts,
  readBriefsFirstPage,
  staleBriefsReads,
  withKeptBriefsTail,
  type KeptBriefs,
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

  it('a reload marks the reads stale: the kept list and counts stay, the next read asks anew', async () => {
    await readBriefsFirstPage(supabase, 'u1', 'w1');
    await readBriefCounts(supabase, 'u1', 'w1', '');
    primeBriefsList('u1', 'w1', { items: [], next: { done: true } });
    staleBriefsReads('u1', 'w1');
    expect(keptBriefsList('u1', 'w1')).toEqual({ items: [], next: { done: true } });
    expect(keptBriefCounts('u1', 'w1')).toBeDefined();
    const before = rowsReads();
    await readBriefsFirstPage(supabase, 'u1', 'w1');
    expect(rowsReads()).toBe(before + 1);
  });

  it('the kept list is the one the page painted, per user and workspace', () => {
    const list: KeptBriefs = { items: [brief('b1', '2026-10-01')], next: { done: true } };
    primeBriefsList('u1', 'w1', list);
    expect(keptBriefsList('u1', 'w1')).toEqual(list);
    expect(keptBriefsList('u2', 'w1')).toBeUndefined();
    expect(keptBriefsList('u1', 'w2')).toBeUndefined();
  });
});

function brief(id: string, createdAt: string): BriefWithThumbnail {
  return { id, created_at: createdAt } as unknown as BriefWithThumbnail;
}

describe('withKeptBriefsTail', () => {
  const kept: KeptBriefs = {
    items: [brief('k3', '2026-10-03'), brief('k2', '2026-10-02'), brief('k1', '2026-10-01')],
    next: { done: false, cursor: { createdAt: '2026-10-01', id: 'k1' } },
  };

  it('keeps the older pages the person loaded under a refreshed first page', () => {
    const fresh: KeptBriefs = {
      items: [brief('n4', '2026-10-04'), brief('k3', '2026-10-03')],
      next: { done: false, cursor: { createdAt: '2026-10-03', id: 'k3' } },
    };
    const out = withKeptBriefsTail(fresh, kept);
    expect(out.items.map((b) => b.id)).toEqual(['n4', 'k3', 'k2', 'k1']);
    expect(out.next).toEqual(kept.next);
  });

  it('a refreshed page that is the last is taken as is', () => {
    const last: KeptBriefs = { items: [brief('n4', '2026-10-04')], next: { done: true } };
    expect(withKeptBriefsTail(last, kept)).toBe(last);
  });
});
