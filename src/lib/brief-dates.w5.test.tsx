// W5 FB8: briefs.target_date is a date-only column. "2026-10-08" must read
// 8 Oct for a viewer west of UTC: the string's own parts are formatted, never
// new Date(value) in the browser zone (which lands on 7 Oct in Los Angeles).
// The zone is pinned before any Date work in this file.
process.env.TZ = 'America/Los_Angeles';

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { formatDate } from '@/lib/time';
import { BriefCard, briefDueLabel } from '@/components/pages/BriefCard';
import { briefDueDateLabel } from '@/components/pages/BriefDetailPage';
import type { PresignCache } from '@/lib/asset-presign';
import type { BriefWithThumbnail } from '@srtdio/briefs';

const cache = { peek: () => null, resolve: async () => null } as unknown as PresignCache;
const NOW = new Date('2026-10-23T12:00:00Z');

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

  it('formats "2026-10-08" as 8 Oct, the year only outside now', () => {
    expect(formatDate('2026-10-08', NOW)).toBe('8 Oct');
    expect(formatDate('2026-10-08', new Date('2027-03-01T12:00:00Z'))).toBe(
      '8 Oct 2026',
    );
  });

  it('the card reads "Due 8 Oct"', () => {
    expect(briefDueLabel('2026-10-08', NOW)).toBe('Due 8 Oct');
    const out = renderToStaticMarkup(
      <MemoryRouter>
        <BriefCard brief={brief('2026-10-08')} cache={cache} presignEnabled href="/briefs/b1" />
      </MemoryRouter>,
    );
    expect(out).toContain('Due 8 Oct');
    expect(out).not.toContain('7 Oct');
  });

  it('the detail page reads "8 Oct", and "Not set" with no date', () => {
    expect(briefDueDateLabel('2026-10-08', NOW)).toBe('8 Oct');
    expect(briefDueDateLabel(null, NOW)).toBe('Not set');
  });

  it('month and year edges never roll over', () => {
    expect(briefDueDateLabel('2026-01-01', NOW)).toBe('1 Jan');
    expect(briefDueDateLabel('2026-12-31', NOW)).toBe('31 Dec');
  });

  it('a value that is not a civil date is returned unchanged', () => {
    expect(briefDueDateLabel('soon', NOW)).toBe('soon');
    expect(briefDueDateLabel('2026-13-01', NOW)).toBe('2026-13-01');
  });
});
