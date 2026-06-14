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
export const POSTS_PAGE_SIZE_MAX = 500;

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

/**
 * The post fields the chat post-share surfaces use: the picker rows and the
 * shared post card (title + platform + format + stage). A strict subset of the
 * generated Row, so no column is fabricated. No cover image is surfaced here:
 * a post's first image lives in `asset_attachments`, and building that join is
 * out of scope, so the card renders a neutral placeholder instead.
 */
export type PostCardFields = Pick<Post, 'id' | 'title' | 'platform' | 'format' | 'stage'>;

const POST_CARD_COLUMNS = 'id, title, platform, format, stage';

export interface ListPostsForPickerInput {
  /** Workspace to scope to; RLS confines reads to the caller's workspaces. */
  workspaceId: string;
  /** Optional stage filter (the picker's Review / Approved chips). */
  stage?: Stage;
  /** Optional case-insensitive title substring match (the picker's search). */
  titleQuery?: string;
  /** Page size. Defaults to {@link POSTS_PAGE_SIZE}, capped at {@link POSTS_PAGE_SIZE_MAX}. */
  limit?: number;
}

/** Escape the LIKE metacharacters in a user-typed search term. */
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (match) => `\\${match}`);
}

/**
 * List posts for the chat post picker: an RLS-scoped select of the card fields,
 * newest first, soft-deleted rows excluded. Stage and a simple case-insensitive
 * title match are applied as filters in the single query (no full-text index).
 * RLS already excludes stages a viewer cannot see (e.g. Draft for clients), so
 * the "All Posts" filter passes no stage and never special-cases roles.
 */
export async function listPostsForPicker(
  client: Client,
  input: ListPostsForPickerInput,
): Promise<Result<PostCardFields[]>> {
  const limit = Math.min(input.limit ?? POSTS_PAGE_SIZE, POSTS_PAGE_SIZE_MAX);

  let query = client
    .from('posts')
    .select(POST_CARD_COLUMNS)
    .eq('workspace_id', input.workspaceId)
    .is('deleted_at', null);

  if (input.stage !== undefined) query = query.eq('stage', input.stage);
  const title = input.titleQuery?.trim();
  if (title !== undefined && title !== '') {
    query = query.ilike('title', `%${escapeLike(title)}%`);
  }

  const { data, error } = await query.order('created_at', { ascending: false }).limit(limit);

  if (error) return { ok: false, error: transportError(error.message) };
  return { ok: true, data: (data ?? []) as PostCardFields[] };
}

/**
 * Batched resolve of shared posts for the chat post card: one RLS-scoped IN read
 * over every id in a message, never one read per id. A post the viewer cannot
 * see (RLS) or that has been deleted simply does not come back; the caller renders
 * those ids as an "unavailable" card. Returns [] for no ids without a round-trip.
 */
export async function readPostsByIds(
  client: Client,
  params: { workspaceId: string; ids: string[] },
): Promise<Result<PostCardFields[]>> {
  if (params.ids.length === 0) return { ok: true, data: [] };

  const { data, error } = await client
    .from('posts')
    .select(POST_CARD_COLUMNS)
    .eq('workspace_id', params.workspaceId)
    .in('id', params.ids)
    .is('deleted_at', null);

  if (error) return { ok: false, error: transportError(error.message) };
  return { ok: true, data: (data ?? []) as PostCardFields[] };
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

/**
 * One image in a post's gallery: an asset_attachments row joined to its pinned
 * version (asset_versions) and the parent asset's filename. Flattened to exactly
 * the fields the gallery + lightbox render, so the UI never reaches back into the
 * raw embedded shapes.
 */
export interface GalleryItem {
  assetAttachmentId: string;
  assetVersionId: string;
  assetId: string;
  position: number;
  /** From assets.filename; a sensible fallback when the join is missing it. */
  filename: string;
  mimeType: string | null;
  /** asset_versions.kind (image / video / file / link); never null server-side. */
  kind: string;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  r2Key: string | null;
  externalUrl: string | null;
}

/** Shown when the parent asset has no filename (defensive; filename is NOT NULL). */
const GALLERY_FILENAME_FALLBACK = 'Untitled';

// The shape of one embedded gallery row. asset_attachments.entity_id is a plain
// TEXT column with no FK to posts, so the gallery cannot be embedded from posts;
// it is read directly off asset_attachments and the version/asset are embedded
// here instead. Cast through `unknown` because the aliased select is wider than
// the generated row type can express.
interface GalleryRow {
  id: string;
  asset_id: string;
  asset_version_id: string;
  position: number;
  asset_versions: {
    mime_type: string | null;
    kind: string;
    width: number | null;
    height: number | null;
    duration_ms: number | null;
    r2_key: string | null;
    external_url: string | null;
  } | null;
  assets: { filename: string | null } | null;
}

/**
 * Read a post's image gallery in one round trip: every live asset_attachments row
 * for the post, in display order, each joined to its pinned asset_versions row and
 * the parent asset's filename. No N+1, no per-row loop. Returns [] (never null)
 * when the post has no images. A plain RLS-scoped read, so it takes no trace_id.
 */
export async function getPostGallery(
  client: Client,
  postId: string,
): Promise<Result<GalleryItem[]>> {
  const { data, error } = await client
    .from('asset_attachments')
    .select('*, asset_versions(*), assets:asset_id(filename)')
    .eq('entity_type', 'post')
    .eq('entity_id', postId)
    .is('deleted_at', null)
    .order('position', { ascending: true });

  if (error) return { ok: false, error: transportError(error.message) };

  const rows = (data ?? []) as unknown as GalleryRow[];
  return {
    ok: true,
    data: rows.map((row) => {
      const version = row.asset_versions;
      return {
        assetAttachmentId: row.id,
        assetVersionId: row.asset_version_id,
        assetId: row.asset_id,
        position: row.position,
        filename: row.assets?.filename ?? GALLERY_FILENAME_FALLBACK,
        mimeType: version?.mime_type ?? null,
        kind: version?.kind ?? 'file',
        width: version?.width ?? null,
        height: version?.height ?? null,
        durationMs: version?.duration_ms ?? null,
        r2Key: version?.r2_key ?? null,
        externalUrl: version?.external_url ?? null,
      };
    }),
  };
}
