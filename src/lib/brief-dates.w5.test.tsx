// W5 FB8: briefs.target_date is a date-only column. "2026-10-08" must read
// Oct 8 for a viewer west of UTC: the string's own parts are formatted, never
// new Date(value) in the browser zone (which lands on Oct 7 in Los Angeles).
// The zone is pinned before any Date work in this file.
process.env.TZ = 'America/Los_Angeles';

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { formatCivilDay } from '@/lib/brief-groups';
import { BriefCard, briefDueLabel } from '@/components/pages/BriefCard';
import { briefDueDateLabel } from '@/components/pages/BriefDetailPage';
import type { PresignCache } from '@/lib/asset-presign';
import type { BriefWithThumbnail } from '@srtdio/briefs';

const cache = { peek: () => null, resolve: async () => null } as unknown as PresignCache;

function brief(targetDate: string | null): BriefWithThumbnail {
  return {
    id: 'b1',
    workspace_id: 'w1',
    number: 4,
    title: 'Festive drop',
    objective: 'Launch it',
    legacy_author_name: null,
    status: 'open',
    target_date: targetDate,
    reference_links: null,
    mentions: null,
    format_requested: null,
    brand_requirements: null,
    closed_at: null,
    closed_by: null,
    created_by: 'u1',
    created_via: 'manual',
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-01T00:00:00Z',
    deleted_at: null,
    row_version: 1,
    thumbnailAssetVersionId: null,
  };
}

describe('brief target dates in America/Los_Angeles', () => {
  it('the browser zone really is west of UTC here (the old bug would show Oct 7)', () => {
    expect(new Date('2026-10-08').getDate()).toBe(7);
  });

  it('formats "2026-10-08" as Oct 8, with and without the year', () => {
    expect(formatCivilDay('2026-10-08')).toBe('Oct 8');
    expect(formatCivilDay('2026-10-08', true)).toBe('Oct 8, 2026');
  });

  it('the card reads "Due Oct 8"', () => {
    expect(briefDueLabel('2026-10-08')).toBe('Due Oct 8');
    const out = renderToStaticMarkup(
      <MemoryRouter>
        <BriefCard brief={brief('2026-10-08')} cache={cache} presignEnabled href="/briefs/b1" />
      </MemoryRouter>,
    );
    expect(out).toContain('Due Oct 8');
    expect(out).not.toContain('Oct 7');
  });

  it('the detail page reads "Oct 8, 2026", and "Not set" with no date', () => {
    expect(briefDueDateLabel('2026-10-08')).toBe('Oct 8, 2026');
    expect(briefDueDateLabel(null)).toBe('Not set');
  });

  it('month and year edges never roll over', () => {
    expect(formatCivilDay('2026-01-01', true)).toBe('Jan 1, 2026');
    expect(formatCivilDay('2026-12-31', true)).toBe('Dec 31, 2026');
  });

  it('a value that is not a civil date is returned unchanged', () => {
    expect(formatCivilDay('soon')).toBe('soon');
    expect(formatCivilDay('2026-13-01')).toBe('2026-13-01');
  });
});
