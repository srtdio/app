import { describe, expect, it } from 'vitest';
import { filterBriefsByStatus } from '@/lib/brief-list';
import { BRIEF_STATUS } from '@/components/pages/BriefCard';
import type { Brief } from '@srtdio/briefs';

function brief(over: Partial<Brief>): Brief {
  return {
    id: 'b',
    workspace_id: 'w',
    number: 1,
    title: 'Untitled',
    objective: 'o',
    legacy_author_name: null,
    status: BRIEF_STATUS.open,
    created_via: 'manual',
    created_by: 'u',
    brand_requirements: null,
    format_requested: null,
    reference_links: null,
    target_date: null,
    closed_at: null,
    closed_by: null,
    deleted_at: null,
    row_version: 1,
    created_at: '2026-01-01',
    updated_at: '2026-01-01',
    ...over,
  };
}

describe('filterBriefsByStatus', () => {
  const open = brief({ id: 'o', status: BRIEF_STATUS.open });
  const closed = brief({ id: 'c', status: BRIEF_STATUS.closed });

  it('returns every brief for the All filter', () => {
    expect(filterBriefsByStatus([open, closed], 'all').map((b) => b.id)).toEqual(['o', 'c']);
  });

  it('keeps only open briefs', () => {
    expect(filterBriefsByStatus([open, closed], BRIEF_STATUS.open).map((b) => b.id)).toEqual(['o']);
  });

  it('keeps only closed briefs', () => {
    expect(filterBriefsByStatus([open, closed], BRIEF_STATUS.closed).map((b) => b.id)).toEqual([
      'c',
    ]);
  });
});
