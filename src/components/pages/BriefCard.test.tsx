import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { BriefCard, BriefStatusPill, briefCardTime } from '@/components/pages/BriefCard';
import { tagClass } from '@/components/ui/Tag';
import type { PresignCache } from '@/lib/asset-presign';
import type { BriefWithThumbnail } from '@srtdio/briefs';

// The card is rendered to static markup (node SSR, no DOM): useState initializers
// run (so a warm cache.peek hit shows the image) while effects do not, which is the
// lazy/off-screen state. reference_links is jsonb (Json | null); the tests feed the
// three real-world shapes through as unknown values, exactly as the read returns.

function makeBrief(overrides: Partial<BriefWithThumbnail>): BriefWithThumbnail {
  return {
    id: 'b1',
    workspace_id: 'w1',
    number: 1,
    title: 'Spring launch',
    objective: 'Tease the spring drop across feed and stories.',
    legacy_author_name: null,
    status: 'open',
    target_date: '2026-07-01',
    reference_links: null,
    mentions: null,
    format_requested: null,
    brand_requirements: null,
    closed_at: null,
    closed_by: null,
    created_by: 'u1',
    created_via: 'manual',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    deleted_at: null,
    row_version: 1,
    thumbnailAssetVersionId: null,
    ...overrides,
  };
}

function makeCache(peekUrl: string | null) {
  const peek = vi.fn(() =>
    peekUrl !== null ? { url: peekUrl, expiresAt: Date.now() + 3_600_000 } : null,
  );
  const resolve = vi.fn(async () => ({ url: 'resolved', expiresAt: Date.now() + 3_600_000 }));
  // Tiles paint the small copy only (never the full-size original).
  const peekThumbnail = vi.fn(() =>
    peekUrl !== null ? { url: peekUrl, expiresAt: Date.now() + 3_600_000 } : null,
  );
  return {
    cache: {
      peek,
      resolve,
      peekThumbnail,
      thumbnail: async () => null,
    } as unknown as PresignCache,
    peek,
    peekThumbnail,
    resolve,
  };
}

// A fixed clock two months before the default due day (1 Jul), so "Due 1 Jul"
// reads the same whatever day the suite runs.
const NOW = new Date('2026-05-01T12:00:00Z');

function render(
  brief: BriefWithThumbnail,
  cache: PresignCache,
  presignEnabled = true,
  now: Date = NOW,
): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <BriefCard
        brief={brief}
        cache={cache}
        presignEnabled={presignEnabled}
        href="/briefs/b1"
        timeZone="UTC"
        now={now}
      />
    </MemoryRouter>,
  );
}

describe('BriefCard on ui/ListCard', () => {
  it('renders through ListCard (data-list-card) with the brief hooks kept', () => {
    const { cache } = makeCache(null);
    const out = render(makeBrief({}), cache);
    expect(out).toContain('data-list-card=""');
    expect(out).toContain('data-brief-card=""');
    expect(out).toContain('data-brief-card-link=""');
    // The old Card frame is gone.
    expect(out).not.toContain('data-card-title');
  });

  it('renders the small copy as the 72 picture when thumbnailAssetVersionId is present', () => {
    const { cache, peekThumbnail } = makeCache('https://cdn.example/thumb.jpg');
    const out = render(makeBrief({ thumbnailAssetVersionId: 'av1' }), cache);
    expect(out).toContain('<img');
    expect(out).toContain('https://cdn.example/thumb.jpg');
    expect(out).toContain('object-cover');
    expect(out).toContain('data-list-card-picture="image"');
    expect(peekThumbnail).toHaveBeenCalledWith('av1');
  });

  it('shows the brief icon picture, never the objective text, when there is no image', () => {
    const { cache } = makeCache(null);
    const out = render(
      makeBrief({
        thumbnailAssetVersionId: null,
        reference_links: ['not-a-url'] as unknown as BriefWithThumbnail['reference_links'],
        objective: 'Tease the spring drop',
      }),
      cache,
    );
    expect(out).not.toContain('<img');
    expect(out).not.toContain('italic');
    expect(out).toContain('data-brief-tile="icon"');
    expect(out).toContain('data-list-card-picture="icon"');
  });

  it('the list card carries no reference link: the card link is the only link', () => {
    const { cache } = makeCache(null);
    const out = render(
      makeBrief({
        thumbnailAssetVersionId: null,
        reference_links: [
          'https://www.figma.com/file/abc',
        ] as unknown as BriefWithThumbnail['reference_links'],
      }),
      cache,
    );
    expect(out.match(/<a /g) ?? []).toHaveLength(1);
    expect(out).not.toContain('figma.com');
  });

  it('keeps the card fields (title, status, due date)', () => {
    const { cache } = makeCache(null);
    const out = render(makeBrief({ status: 'open', target_date: '2026-07-01' }), cache);
    expect(out).toContain('Spring launch');
    expect(out).toContain('Open');
    expect(out).toContain('Due 1 Jul');
  });

  it('a brief with no due date shows when it was raised (formatAgo)', () => {
    const { cache } = makeCache(null);
    const out = render(
      makeBrief({ target_date: null, created_at: '2026-11-06T09:00:00Z' }),
      cache,
      true,
      new Date('2026-11-06T12:00:00Z'),
    );
    expect(out).toContain('data-brief-date=""');
    expect(out).toContain('>3h<');
    expect(out).not.toContain('data-list-card-time-bad');
  });

  it('an open brief past its due day reads "Overdue 2d" in the bad tone', () => {
    const { cache } = makeCache(null);
    const out = render(
      makeBrief({ status: 'open', target_date: '2026-07-01' }),
      cache,
      true,
      new Date('2026-07-03T12:00:00Z'),
    );
    expect(out).toContain('Overdue 2d');
    expect(out).toContain('data-list-card-time-bad=""');
    expect(out).toMatch(/data-list-card-time=""[^>]*class="[^"]*text-bad/);
  });

  it('a closed brief is never overdue: it keeps its due words, not the bad tone', () => {
    const { cache } = makeCache(null);
    const out = render(
      makeBrief({ status: 'closed', target_date: '2026-07-01' }),
      cache,
      true,
      new Date('2026-07-03T12:00:00Z'),
    );
    expect(out).toContain('Due 1 Jul');
    expect(out).not.toContain('Overdue');
    expect(out).not.toContain('data-list-card-time-bad');
  });

  it('upcoming due days read short: today, tomorrow, the weekday', () => {
    const now = new Date('2026-06-28T12:00:00Z');
    const at = (target_date: string) =>
      briefCardTime(
        { target_date, created_at: '2026-01-01T00:00:00Z', status: 'open' },
        'UTC',
        now,
      );
    expect(at('2026-06-28')).toEqual({ text: 'Due today', bad: false });
    expect(at('2026-06-29')).toEqual({ text: 'Due tomorrow', bad: false });
    expect(at('2026-07-01')).toEqual({ text: 'Due Wed', bad: false });
    expect(at('2026-06-27')).toEqual({ text: 'Overdue 1d', bad: true });
  });

  it('shows the Closed tag for a closed brief', () => {
    const { cache } = makeCache(null);
    const out = render(makeBrief({ status: 'closed' }), cache);
    expect(out).toContain('Closed');
  });

  it('Open and Closed are the one grey (neutral) Tag on line 3', () => {
    const { cache } = makeCache(null);
    for (const status of ['open', 'closed'] as const) {
      const out = render(makeBrief({ status }), cache);
      expect(out).toContain(`data-brief-status="${status}"`);
      expect(out).toContain(tagClass('neutral'));
      expect(out).not.toContain('bg-accent-soft');
      expect(out).not.toContain('M16.5 10.5V6.75');
    }
  });

  it('the due date renders mono with tabular figures', () => {
    const { cache } = makeCache(null);
    const out = render(makeBrief({ target_date: '2026-07-01' }), cache);
    expect(out).toMatch(/data-brief-due="" class="font-mono[^"]*tabular-nums[^"]*">Due 1 Jul</);
  });

  it('the title is one truncated heading line; the objective clamps to 2 lines', () => {
    const { cache } = makeCache(null);
    const out = render(makeBrief({}), cache);
    expect(out).toMatch(/data-list-card-title="" class="[^"]*truncate/);
    expect(out).toMatch(/data-list-card-preview="" class="[^"]*line-clamp-2[^"]*min-h-9/);
  });
});

// BriefStatusPill is the same grey tag wherever a brief shows its status
// (the detail page and the chat brief card), so Open and Closed read the same.
describe('BriefStatusPill', () => {
  it('is the neutral Tag for both statuses, carrying data-brief-status', () => {
    for (const status of ['open', 'closed'] as const) {
      const out = renderToStaticMarkup(<BriefStatusPill status={status} />);
      expect(out).toContain(`data-brief-status="${status}"`);
      expect(out).toContain(tagClass('neutral'));
      expect(out).not.toContain('bg-accent-soft');
      expect(out).toContain(status === 'open' ? 'Open' : 'Closed');
    }
  });
});

describe('BriefCard tap target', () => {
  it('the card link covers the whole card and is named by the title', () => {
    const { cache } = makeCache(null);
    const out = render(makeBrief({ title: 'Spring launch' }), cache);
    // The one link is the Card cover: the root's first child, inset-0 over the whole card.
    expect(out).toMatch(/^<div data-brief-card=""[^>]*><a /);
    const tag = /<a [^>]*>/.exec(out)?.[0] ?? '';
    expect(tag).toContain('aria-label="Spring launch"');
    expect(tag).toContain('data-brief-card-link=""');
    expect(tag).toMatch(/class="[^"]*absolute inset-0/);
    expect(tag).toContain('href="/briefs/b1"');
    expect(out.match(/<a /g) ?? []).toHaveLength(1);
    // The title is text inside the card, never a small link of its own.
    expect(out).not.toContain('after:absolute');
  });
});
