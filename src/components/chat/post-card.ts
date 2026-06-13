// Pure, React-free helpers for rendering shared posts in the message thread. The
// view dispatch is derived from the message's shared post ids and the batched
// resolve, so it is unit-tested without a DOM: every id maps to exactly one card,
// and an id the RLS-scoped read did not return (denied or deleted) maps to an
// "unavailable" card rather than throwing or leaking.

import type { PostCardFields } from '@srtdio/posts';

/** The route a shared post card navigates to (the existing /posts/:id view). */
export function postRoute(id: string): string {
  return `/posts/${id}`;
}

/** The render branch for one shared post id. */
export type SharedPostView =
  | { kind: 'post'; postId: string; title: string; stage: string }
  | { kind: 'unavailable'; postId: string };

/** Index a batched post resolve by id for O(1) per-id lookup (no per-id scan). */
export function indexPostsById(posts: readonly PostCardFields[]): Map<string, PostCardFields> {
  const map = new Map<string, PostCardFields>();
  for (const post of posts) map.set(post.id, post);
  return map;
}

/**
 * One view per shared post id, preserving the message's order. An id present in
 * the resolve renders as a card (title + stage); an id the resolve did not return
 * renders as an "unavailable" card. The viewer's RLS is the security boundary:
 * a post the viewer cannot see simply never appears in `postsById`.
 */
export function sharedPostViews(
  ids: readonly string[],
  postsById: Map<string, PostCardFields>,
): SharedPostView[] {
  return ids.map((postId) => {
    const post = postsById.get(postId);
    return post !== undefined
      ? { kind: 'post', postId, title: post.title, stage: post.stage }
      : { kind: 'unavailable', postId };
  });
}
