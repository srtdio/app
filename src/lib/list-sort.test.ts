import { describe, expect, it } from 'vitest';
import {
  filterByFields,
  filterByTitle,
  filterByWindow,
  sortByDate,
  sortPosts,
  type DateSortable,
  type PostSortable,
} from '@/lib/list-sort';

interface Row extends DateSortable {
  id: string;
  title: string;
}

function row(over: Partial<Row>): Row {
  return { id: 'r', title: 'Untitled', created_at: '2026-01-01', target_date: null, ...over };
}

interface PostRow extends PostSortable {
  caption: string | null;
  platform: string;
}

function post(over: Partial<PostRow>): PostRow {
  return {
    id: 'p',
    title: 'Untitled',
    caption: null,
    platform: 'instagram',
    created_at: '2026-01-01',
    updated_at: '2026-01-01',
    target_date: null,
    ...over,
  };
}

describe('sortByDate', () => {
  const a = row({ id: 'a', created_at: '2026-01-01', target_date: '2026-03-01' });
  const b = row({ id: 'b', created_at: '2026-02-01', target_date: null });
  const c = row({ id: 'c', created_at: '2026-03-01', target_date: '2026-02-01' });

  it('orders newest first by created_at descending', () => {
    expect(sortByDate([a, b, c], 'newest').map((r) => r.id)).toEqual(['c', 'b', 'a']);
  });

  it('orders oldest first by created_at ascending', () => {
    expect(sortByDate([c, b, a], 'oldest').map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('orders by target_date ascending with nulls last', () => {
    expect(sortByDate([a, b, c], 'target').map((r) => r.id)).toEqual(['c', 'a', 'b']);
  });

  it('does not mutate the input array', () => {
    const input = [a, b, c];
    sortByDate(input, 'newest');
    expect(input.map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('filterByTitle', () => {
  const items = [row({ id: 'a', title: 'Launch teaser' }), row({ id: 'b', title: 'Recap reel' })];

  it('matches case-insensitively on a trimmed substring', () => {
    expect(filterByTitle(items, '  TEASER ').map((r) => r.id)).toEqual(['a']);
  });

  it('returns the full list for an empty or whitespace query', () => {
    expect(filterByTitle(items, '')).toHaveLength(2);
    expect(filterByTitle(items, '   ')).toHaveLength(2);
  });

  it('returns nothing when no title matches', () => {
    expect(filterByTitle(items, 'zzz')).toHaveLength(0);
  });

  // Briefs keeps the title-only path: widening the post search (filterByFields)
  // must not silently add post fields here.
  it('matches on title alone, ignoring other fields the caller does not pass', () => {
    const briefs = [
      { id: 'a', title: 'Launch', caption: 'teaser', created_at: '2026-01-01', target_date: null },
      { id: 'b', title: 'Recap', caption: 'launch', created_at: '2026-01-01', target_date: null },
    ];
    // "launch" appears in b's caption but filterByTitle only sees the title.
    expect(filterByTitle(briefs, 'launch').map((r) => r.id)).toEqual(['a']);
  });
});

describe('sortPosts', () => {
  const a = post({ id: 'a', created_at: '2026-01-01', updated_at: '2026-05-01', title: 'banana' });
  const b = post({
    id: 'b',
    created_at: '2026-02-01',
    updated_at: '2026-04-01',
    title: 'Apple',
    target_date: null,
  });
  const c = post({
    id: 'c',
    created_at: '2026-03-01',
    updated_at: '2026-06-01',
    title: 'cherry',
    target_date: '2026-02-01',
  });
  const items = [a, b, c];

  it('Recently updated: updated_at descending', () => {
    expect(sortPosts(items, 'updated').map((p) => p.id)).toEqual(['c', 'a', 'b']);
  });

  it('Target date: ascending with nulls last', () => {
    const withTargets = [
      post({ id: 'x', target_date: '2026-03-01' }),
      post({ id: 'y', target_date: null }),
      post({ id: 'z', target_date: '2026-02-01' }),
    ];
    expect(sortPosts(withTargets, 'target').map((p) => p.id)).toEqual(['z', 'x', 'y']);
  });

  it('breaks ties deterministically by id for equal keys', () => {
    const tied = [
      post({ id: 'm2', updated_at: '2026-01-01' }),
      post({ id: 'm1', updated_at: '2026-01-01' }),
      post({ id: 'm3', updated_at: '2026-01-01' }),
    ];
    expect(sortPosts(tied, 'updated').map((p) => p.id)).toEqual(['m1', 'm2', 'm3']);
    expect(sortPosts(tied, 'target').map((p) => p.id)).toEqual(['m1', 'm2', 'm3']);
  });

  it('does not mutate the input array', () => {
    const input = [a, b, c];
    sortPosts(input, 'target');
    expect(input.map((p) => p.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('filterByWindow', () => {
  interface WindowRow {
    id: string;
    target_date: string | null;
  }
  function wrow(id: string, target_date: string | null): WindowRow {
    return { id, target_date };
  }
  // A fixed "now": Wed 2026-06-17 12:00 UTC. The Mon-Sun week is 2026-06-15..21.
  const now = new Date('2026-06-17T12:00:00Z');

  it("'any' returns the list unchanged, including a null target_date", () => {
    const items = [wrow('a', '2026-06-17'), wrow('b', null)];
    const out = filterByWindow(items, 'any', { now, timeZone: 'UTC', weekStartDay: 1 });
    expect(out.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('week (weekStartDay=1) keeps the current Mon-Sun and excludes prior/next week', () => {
    const items = [
      wrow('mon', '2026-06-15T00:00:00Z'), // start inclusive
      wrow('mid', '2026-06-17T00:00:00Z'),
      wrow('sun', '2026-06-21T00:00:00Z'), // last day in window
      wrow('prev', '2026-06-14T00:00:00Z'), // prior week
      wrow('next', '2026-06-22T00:00:00Z'), // next week, end exclusive
      wrow('null', null),
    ];
    const out = filterByWindow(items, 'week', { now, timeZone: 'UTC', weekStartDay: 1 });
    expect(out.map((r) => r.id)).toEqual(['mon', 'mid', 'sun']);
  });

  it('week (weekStartDay=0) shifts the boundary to Sun-Sat', () => {
    const items = [
      wrow('sun', '2026-06-14T00:00:00Z'), // now in window when week starts Sunday
      wrow('sat', '2026-06-20T00:00:00Z'), // last day
      wrow('nextsun', '2026-06-21T00:00:00Z'), // end exclusive
    ];
    const out = filterByWindow(items, 'week', { now, timeZone: 'UTC', weekStartDay: 0 });
    expect(out.map((r) => r.id)).toEqual(['sun', 'sat']);
  });

  it('month keeps same-month and excludes the prev/next month boundaries', () => {
    const items = [
      wrow('first', '2026-06-01T00:00:00Z'),
      wrow('mid', '2026-06-17T00:00:00Z'),
      wrow('last', '2026-06-30T00:00:00Z'),
      wrow('prevlast', '2026-05-31T00:00:00Z'),
      wrow('nextfirst', '2026-07-01T00:00:00Z'),
      wrow('null', null),
    ];
    const out = filterByWindow(items, 'month', { now, timeZone: 'UTC', weekStartDay: 1 });
    expect(out.map((r) => r.id)).toEqual(['first', 'mid', 'last']);
  });

  it('excludes a null target_date for week and month', () => {
    const items = [wrow('null', null)];
    expect(filterByWindow(items, 'week', { now, timeZone: 'UTC', weekStartDay: 1 })).toHaveLength(
      0,
    );
    expect(filterByWindow(items, 'month', { now, timeZone: 'UTC', weekStartDay: 1 })).toHaveLength(
      0,
    );
  });

  it('renders the civil date in the workspace zone, not UTC', () => {
    // 2026-06-30T20:00Z is 2026-07-01 in Asia/Kolkata (+5:30) but 2026-06-30 in UTC.
    const item = [wrow('edge', '2026-06-30T20:00:00Z')];
    // June under UTC: in the month.
    expect(
      filterByWindow(item, 'month', { now, timeZone: 'UTC', weekStartDay: 1 }).map((r) => r.id),
    ).toEqual(['edge']);
    // July under Asia/Kolkata: out of June's month window.
    expect(
      filterByWindow(item, 'month', { now, timeZone: 'Asia/Kolkata', weekStartDay: 1 }),
    ).toHaveLength(0);
  });

  it('falls back to UTC for an invalid time zone instead of throwing', () => {
    const items = [wrow('in', '2026-06-17T00:00:00Z'), wrow('out', '2026-07-01T00:00:00Z')];
    expect(() =>
      filterByWindow(items, 'month', { now, timeZone: 'Not/AZone', weekStartDay: 1 }),
    ).not.toThrow();
    const out = filterByWindow(items, 'month', { now, timeZone: 'Not/AZone', weekStartDay: 1 });
    expect(out.map((r) => r.id)).toEqual(['in']);
  });

  it('falls back to UTC for an empty time zone', () => {
    const items = [wrow('in', '2026-06-17T00:00:00Z')];
    expect(() =>
      filterByWindow(items, 'week', { now, timeZone: '', weekStartDay: 1 }),
    ).not.toThrow();
    expect(filterByWindow(items, 'week', { now, timeZone: '', weekStartDay: 1 })).toHaveLength(1);
  });

  it('excludes an unparseable target_date without throwing', () => {
    const items = [wrow('bad', 'not-a-date'), wrow('good', '2026-06-17T00:00:00Z')];
    expect(() =>
      filterByWindow(items, 'week', { now, timeZone: 'UTC', weekStartDay: 1 }),
    ).not.toThrow();
    expect(
      filterByWindow(items, 'week', { now, timeZone: 'UTC', weekStartDay: 1 }).map((r) => r.id),
    ).toEqual(['good']);
  });
});

describe('filterByFields (Pipeline search scope)', () => {
  const posts = [
    post({ id: 'a', title: 'Launch teaser', caption: 'Big reveal', platform: 'instagram' }),
    post({ id: 'b', title: 'Recap reel', caption: 'Behind the scenes', platform: 'tiktok' }),
    post({ id: 'c', title: 'Promo', caption: null, platform: 'youtube' }),
  ];
  const fields = (p: PostRow): (string | null)[] => [p.title, p.caption, p.platform];

  it('matches on title', () => {
    expect(filterByFields(posts, 'launch', fields).map((p) => p.id)).toEqual(['a']);
  });

  it('matches on caption (not just title)', () => {
    expect(filterByFields(posts, 'behind', fields).map((p) => p.id)).toEqual(['b']);
  });

  it('matches on platform (not just title)', () => {
    expect(filterByFields(posts, 'youtube', fields).map((p) => p.id)).toEqual(['c']);
  });

  it('returns empty when nothing matches across any field', () => {
    expect(filterByFields(posts, 'zzz', fields)).toHaveLength(0);
  });

  it('is case-insensitive and trims the query', () => {
    expect(filterByFields(posts, '  TIKTOK ', fields).map((p) => p.id)).toEqual(['b']);
  });

  it('skips null fields without throwing', () => {
    expect(filterByFields(posts, 'promo', fields).map((p) => p.id)).toEqual(['c']);
  });

  it('returns the full list for an empty query', () => {
    expect(filterByFields(posts, '', fields)).toHaveLength(3);
  });

  // Guard: if the scope ever narrows back to title-only, caption/platform-only
  // matches would disappear and these expectations would fail.
  it('would fail if scope narrowed back to title-only', () => {
    const captionOnly = filterByFields(posts, 'behind', fields);
    const platformOnly = filterByFields(posts, 'youtube', fields);
    expect(captionOnly).toHaveLength(1);
    expect(platformOnly).toHaveLength(1);
  });
});
