// The post read layer: plain RLS-scoped SELECTs, no proc involved. Tenant
// isolation is Postgres' job (the caller's JWT drives RLS), so these add no
// membership checks of their own. Results use the same Result shape the write
// wrappers return, so callers branch uniformly; a transport/PostgREST failure
// surfaces as a { code: 'unknown' } error rather than a throw.

import type { Client, DomainError, Result } from '@srtdio/rpc';
import type { Database } from '@srtdio/schemas';
import type { Stage } from './stage-machine';

export type Post = Database['public']['Tables']['posts']['Row'];
export type PostVersion = Database['public']['Tables']['post_versions']['Row'];
export type PostAnnotation = Database['public']['Tables']['post_annotations']['Row'];

/** Default page size for {@link listPosts}. */
export const POSTS_PAGE_SIZE = 50;
/** Hard cap on {@link listPosts} page size, regardless of the requested limit. */
export const POSTS_PAGE_SIZE_MAX = 100;

export interface ListPostsInput {
  /** Workspace to scope to. RLS confines reads to the caller's workspaces; the
   *  explicit filter also pins the query to the (workspace_id, stage, created_at)
   *  index. */
  workspaceId: string;
  /** Optional stage filter. */
  stage?: Stage;
  /** Page size. Defaults to {@link POSTS_PAGE_SIZE}, capped at {@link POSTS_PAGE_SIZE_MAX}. */
  limit?: number;
  /** Keyset cursor: return rows strictly older than this created_at (ISO). */
  before?: string;
}

/** A post with its full version chain and annotations, fetched in one query. */
export interface PostDetail {
  post: Post;
  versions: PostVersion[];
  annotations: PostAnnotation[];
}

function transportError(message: string): DomainError {
  return { code: 'unknown', message };
}

/**
 * List live posts in a workspace, newest first. Soft-deleted rows are excluded.
 * A single query: stage and the `before` cursor are applied as filters, the
 * page size is capped, and ordering matches the composite index
 * (workspace_id, stage, created_at desc).
 */
export async function listPosts(client: Client, input: ListPostsInput): Promise<Result<Post[]>> {
  const limit = Math.min(input.limit ?? POSTS_PAGE_SIZE, POSTS_PAGE_SIZE_MAX);

  let query = client
    .from('posts')
    .select('*')
    .eq('workspace_id', input.workspaceId)
    .is('deleted_at', null);

  if (input.stage !== undefined) query = query.eq('stage', input.stage);
  if (input.before !== undefined) query = query.lt('created_at', input.before);

  const { data, error } = await query
    .order('workspace_id', { ascending: true })
    .order('stage', { ascending: true })
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) return { ok: false, error: transportError(error.message) };
  return { ok: true, data: data ?? [] };
}

/**
 * Fetch one post by id together with its versions and annotations in a single
 * RLS-scoped query via PostgREST resource embedding (no per-row loops, no N+1).
 * Returns `{ ok: true, data: null }` when the post is absent or hidden by RLS.
 */
export async function getPost(client: Client, postId: string): Promise<Result<PostDetail | null>> {
  const { data, error } = await client
    .from('posts')
    .select('*, post_versions(*), post_annotations(*)')
    .eq('id', postId)
    .is('deleted_at', null)
    .maybeSingle();

  if (error) return { ok: false, error: transportError(error.message) };
  if (data === null) return { ok: true, data: null };

  const { post_versions, post_annotations, ...post } = data;
  return {
    ok: true,
    data: { post: post as Post, versions: post_versions, annotations: post_annotations },
  };
}
