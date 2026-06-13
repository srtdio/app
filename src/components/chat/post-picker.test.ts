import { describe, expect, it } from 'vitest';
import type { PostCardFields } from '@srtdio/posts';
import {
  DEFAULT_POST_FILTER,
  POST_FILTERS,
  filterStage,
  isPostSelected,
  togglePost,
} from '@/components/chat/post-picker';

function post(id: string, over: Partial<PostCardFields> = {}): PostCardFields {
  return {
    id,
    title: `Post ${id}`,
    platform: 'instagram',
    format: 'reel',
    stage: 'review',
    ...over,
  };
}

describe('post filter chips', () => {
  it('offers Review / Approved / All Posts in order and defaults to Review', () => {
    expect(POST_FILTERS.map((f) => f.key)).toEqual(['review', 'approved', 'all']);
    expect(POST_FILTERS.map((f) => f.label)).toEqual(['Review', 'Approved', 'All Posts']);
    expect(DEFAULT_POST_FILTER).toBe('review');
  });

  it('maps a chip to its stage filter; All Posts passes no stage (RLS bounds it)', () => {
    expect(filterStage('review')).toBe('review');
    expect(filterStage('approved')).toBe('approved');
    expect(filterStage('all')).toBeUndefined();
  });
});

describe('togglePost', () => {
  it('adds a post when absent and removes it when present (by id)', () => {
    const a = post('a');
    const b = post('b');
    const afterAdd = togglePost([a], b);
    expect(afterAdd.map((p) => p.id)).toEqual(['a', 'b']);

    const afterRemove = togglePost(afterAdd, a);
    expect(afterRemove.map((p) => p.id)).toEqual(['b']);
  });

  it('does not mutate the input array', () => {
    const selected = [post('a')];
    togglePost(selected, post('b'));
    expect(selected.map((p) => p.id)).toEqual(['a']);
  });

  it('isPostSelected reflects membership by id', () => {
    expect(isPostSelected([post('a')], 'a')).toBe(true);
    expect(isPostSelected([post('a')], 'b')).toBe(false);
  });
});
