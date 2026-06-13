import { describe, expect, it } from 'vitest';
import type { PostCardFields } from '@srtdio/posts';
import {
  indexPostsById,
  postRoute,
  sharedPostViews,
  type SharedPostView,
} from '@/components/chat/post-card';

function post(id: string, over: Partial<PostCardFields> = {}): PostCardFields {
  return {
    id,
    title: `Post ${id}`,
    platform: 'instagram',
    format: 'reel',
    stage: 'approved',
    ...over,
  };
}

describe('postRoute', () => {
  it('points at the existing /posts/:id view', () => {
    expect(postRoute('p1')).toBe('/posts/p1');
  });
});

describe('sharedPostViews', () => {
  it('renders one card per id (title + stage), preserving message order', () => {
    const byId = indexPostsById([
      post('p1', { title: 'Launch teaser', stage: 'review' }),
      post('p2', { title: 'Recap', stage: 'approved' }),
    ]);
    const views = sharedPostViews(['p1', 'p2'], byId);
    expect(views).toEqual<SharedPostView[]>([
      { kind: 'post', postId: 'p1', title: 'Launch teaser', stage: 'review' },
      { kind: 'post', postId: 'p2', title: 'Recap', stage: 'approved' },
    ]);
  });

  it('renders an "unavailable" card for an id the batched resolve did not return', () => {
    // p2 is denied by the viewer's RLS (or deleted): it is absent from the map.
    const byId = indexPostsById([post('p1', { title: 'Visible' })]);
    const views = sharedPostViews(['p1', 'p2'], byId);
    expect(views[0]).toMatchObject({ kind: 'post', postId: 'p1' });
    expect(views[1]).toEqual({ kind: 'unavailable', postId: 'p2' });
  });

  it('renders only unavailable cards when the resolve returned nothing', () => {
    const views = sharedPostViews(['p1', 'p2'], new Map());
    expect(views.every((v) => v.kind === 'unavailable')).toBe(true);
    expect(views).toHaveLength(2);
  });
});
