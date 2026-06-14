import { describe, expect, it } from 'vitest';
import {
  filterByFields,
  filterByTitle,
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

  it('Newest: created_at descending', () => {
    expect(sortPosts(items, 'newest').map((p) => p.id)).toEqual(['c', 'b', 'a']);
  });

  it('Oldest: created_at ascending', () => {
    expect(sortPosts(items, 'oldest').map((p) => p.id)).toEqual(['a', 'b', 'c']);
  });

  it('Target date: ascending with nulls last', () => {
    const withTargets = [
      post({ id: 'x', target_date: '2026-03-01' }),
      post({ id: 'y', target_date: null }),
      post({ id: 'z', target_date: '2026-02-01' }),
    ];
    expect(sortPosts(withTargets, 'target').map((p) => p.id)).toEqual(['z', 'x', 'y']);
  });

  it('Title A-Z: case-insensitive, locale-aware', () => {
    // 'Apple' < 'banana' < 'cherry' only if the compare ignores case.
    expect(sortPosts(items, 'title').map((p) => p.id)).toEqual(['b', 'a', 'c']);
  });

  it('breaks ties deterministically by id for equal keys', () => {
    const tied = [
      post({ id: 'm2', updated_at: '2026-01-01' }),
      post({ id: 'm1', updated_at: '2026-01-01' }),
      post({ id: 'm3', updated_at: '2026-01-01' }),
    ];
    expect(sortPosts(tied, 'updated').map((p) => p.id)).toEqual(['m1', 'm2', 'm3']);
    expect(sortPosts(tied, 'newest').map((p) => p.id)).toEqual(['m1', 'm2', 'm3']);
    expect(sortPosts(tied, 'target').map((p) => p.id)).toEqual(['m1', 'm2', 'm3']);
  });

  it('does not mutate the input array', () => {
    const input = [a, b, c];
    sortPosts(input, 'title');
    expect(input.map((p) => p.id)).toEqual(['a', 'b', 'c']);
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
