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

  it('Recently updated: updated_at descending (the default)', () => {
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
      post({ id: 'm2', updated_at: '2026-01-01', target_date: '2026-02-01' }),
      post({ id: 'm1', updated_at: '2026-01-01', target_date: '2026-02-01' }),
      post({ id: 'm3', updated_at: '2026-01-01', target_date: '2026-02-01' }),
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
  interface Dated {
    id: string;
    target_date: string | null;
  }
  const item = (id: string, target_date: string | null): Dated => ({ id, target_date });
  // Reference instant: Wed 2026-06-24, noon UTC. With weekStartDay=1 (Mon) the
  // current civil week in UTC is Mon 2026-06-22 .. Sun 2026-06-28 inclusive.
  const NOW = new Date('2026-06-24T12:00:00Z');
  const ids = (rows: Dated[]): string[] => rows.map((r) => r.id);

  it("'any' returns all items unchanged, including a null target_date", () => {
    const rows = [item('a', '2026-06-24'), item('b', null), item('c', '2030-01-01')];
    expect(ids(filterByWindow(rows, 'any', { now: NOW, timeZone: 'UTC', weekStartDay: 1 }))).toEqual(
      ['a', 'b', 'c'],
    );
  });

  it('week (weekStartDay=1) keeps the current Mon-Sun and excludes prior/next week', () => {
    const rows = [
      item('prevSun', '2026-06-21'), // Sunday before the window: excluded (start inclusive)
      item('start', '2026-06-22'), // Monday: the inclusive start
      item('mid', '2026-06-24'), // inside
      item('end', '2026-06-28'), // Sunday: last included day
      item('nextMon', '2026-06-29'), // Monday after: excluded (end exclusive)
      item('null', null), // excluded for week
    ];
    expect(ids(filterByWindow(rows, 'week', { now: NOW, timeZone: 'UTC', weekStartDay: 1 }))).toEqual(
      ['start', 'mid', 'end'],
    );
  });

  it('week (weekStartDay=0) shifts the boundary to Sun-Sat', () => {
    // With Sunday start, the window around Wed 2026-06-24 is Sun 06-21 .. Sat 06-27.
    const rows = [
      item('prevSat', '2026-06-20'), // excluded
      item('start', '2026-06-21'), // Sunday: now the inclusive start
      item('end', '2026-06-27'), // Saturday: last included day
      item('nextSun', '2026-06-28'), // excluded (was inside the Mon-start window)
    ];
    expect(ids(filterByWindow(rows, 'week', { now: NOW, timeZone: 'UTC', weekStartDay: 0 }))).toEqual(
      ['start', 'end'],
    );
  });

  it('month keeps same-month dates and excludes the prev-month last day and next-month first day', () => {
    const rows = [
      item('prevLast', '2026-05-31'), // last day of previous month: excluded
      item('first', '2026-06-01'), // inclusive start of the month
      item('mid', '2026-06-24'),
      item('last', '2026-06-30'), // last day of the month: included
      item('nextFirst', '2026-07-01'), // first day of next month: excluded
      item('null', null), // excluded for month
    ];
    expect(
      ids(filterByWindow(rows, 'month', { now: NOW, timeZone: 'UTC', weekStartDay: 1 })),
    ).toEqual(['first', 'mid', 'last']);
  });

  it('excludes a null target_date for both week and month', () => {
    const rows = [item('null', null)];
    const bounds = { now: NOW, timeZone: 'UTC', weekStartDay: 1 };
    expect(filterByWindow(rows, 'week', bounds)).toHaveLength(0);
    expect(filterByWindow(rows, 'month', bounds)).toHaveLength(0);
  });

  it('buckets a target_date instant by its civil date in the workspace zone', () => {
    // 2026-06-30T20:00:00Z is July 1 (01:30) in Asia/Kolkata (+05:30) but still
    // June 30 in UTC. The month window for a June reference must therefore include
    // it under UTC and exclude it under Asia/Kolkata.
    const rows = [item('borderline', '2026-06-30T20:00:00Z')];
    expect(
      filterByWindow(rows, 'month', { now: NOW, timeZone: 'UTC', weekStartDay: 1 }),
    ).toHaveLength(1);
    expect(
      filterByWindow(rows, 'month', { now: NOW, timeZone: 'Asia/Kolkata', weekStartDay: 1 }),
    ).toHaveLength(0);
  });

  it('returns a new array', () => {
    const rows = [item('a', '2026-06-24')];
    expect(filterByWindow(rows, 'any', { now: NOW, timeZone: 'UTC', weekStartDay: 1 })).not.toBe(
      rows,
    );
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
