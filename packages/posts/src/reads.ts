// The post read layer: plain RLS-scoped SELECTs, no proc involved. Tenant
// isolation is Postgres' job (the caller's JWT drives RLS), so these add no
// membership checks of their own. Results use the same Result shape the write
// wrappers return, so callers branch uniformly; a transport/PostgREST failure
// surfaces as a { code: 'unknown' } error rather than a throw.

import { withTraceHeader, type Client, type DomainError, type Result } from '@srtdio/rpc';
import type { Database } from '@srtdio/schemas';
import type { Stage } from './stage-machine';
import { resolveTraceId } from './trace';

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
  /** The action's trace id, sent as p_trace_id; a fresh uuid_v7 when absent. */
  traceId?: string;
}

/**
 * A Pipeline board row: the full post Row plus the asset_version_id of its first
 * image attachment (for the card thumbnail), or null when the post has no image
 * attached, and its cover (first photo or video with its stored size, null for
 * none). Both come back from the same posts_list call as the posts, never one
 * query per post. `firstMedia` is optional so
 * rows built elsewhere (fixtures, optimistic rows) need not carry it; absent
 * means "not read", null means "no photo or video".
 */
export type PipelinePost = Post & {
  thumbnailAssetVersionId: string | null;
  firstMedia?: CardFirstMedia | null;
};

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

/**
 * The chat picker row: the card fields plus the per-workspace number (for the
 * entity ref), caption preview and target date. Picker-only, so the card fields
 * shared with {@link readPostsByIds}, the composer chips and the card stay narrow.
 */
export type PostPickerRow = PostCardFields & Pick<Post, 'number' | 'caption' | 'target_date'>;

export const POST_PICKER_COLUMNS = `${POST_CARD_COLUMNS}, number, caption, target_date`;

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
 * List posts for the chat post picker: an RLS-scoped select of the picker fields,
 * newest first, soft-deleted rows excluded. Stage and a simple case-insensitive
 * title match are applied as filters in the single query (no full-text index).
 * RLS already excludes stages a viewer cannot see (e.g. Draft for clients), so
 * the "All Posts" filter passes no stage and never special-cases roles.
 */
export async function listPostsForPicker(
  client: Client,
  input: ListPostsForPickerInput,
): Promise<Result<PostPickerRow[]>> {
  const limit = Math.min(input.limit ?? POSTS_PAGE_SIZE, POSTS_PAGE_SIZE_MAX);

  let query = client
    .from('posts')
    .select(POST_PICKER_COLUMNS)
    .eq('workspace_id', input.workspaceId)
    .is('deleted_at', null);

  if (input.stage !== undefined) query = query.eq('stage', input.stage);
  const title = input.titleQuery?.trim();
  if (title !== undefined && title !== '') {
    query = query.ilike('title', `%${escapeLike(title)}%`);
  }

  const { data, error } = await query.order('created_at', { ascending: false }).limit(limit);

  if (error) return { ok: false, error: transportError(error.message) };
  return { ok: true, data: (data ?? []) as PostPickerRow[] };
}

/** A picker page row: the picker fields plus created_at (the keyset cursor key). */
export type PostPickerPageRow = PostPickerRow & Pick<Post, 'created_at'>;

export const POST_PICKER_PAGE_COLUMNS = `${POST_PICKER_COLUMNS}, created_at`;

/** Keyset cursor for picker paging: the (created_at, id) of the last row shown. */
export interface PostPickerCursor {
  createdAt: string;
  id: string;
}

interface PostPickerFilter {
  /** Workspace to scope to; RLS confines reads to the caller's workspaces. */
  workspaceId: string;
  /** Exact stage filter. */
  stage?: Stage;
  /** Stage to leave out (drafts for a non-agency viewer's search). */
  excludeStage?: Stage;
  /** Keep rows whose stage_entered_at is at or after this ISO instant. */
  enteredSince?: string;
  /** Keep rows whose stage_entered_at is strictly before this ISO instant. */
  enteredBefore?: string;
  /** Search text: title ILIKE OR caption ILIKE (LIKE metacharacters escaped). */
  text?: string;
  /** Exact posts.number match, OR'd with the text match. */
  number?: number;
}

interface ListPostsForPickerPageInput extends PostPickerFilter {
  /** Return rows strictly after this cursor in (created_at desc, id desc) order. */
  cursor?: PostPickerCursor;
  /** Page size. Defaults to {@link POSTS_PAGE_SIZE}, capped at {@link POSTS_PAGE_SIZE_MAX}. */
  limit?: number;
  /** Also return count:'exact' for the filter (same request). */
  withCount?: boolean;
}

interface PostPickerPage {
  rows: PostPickerPageRow[];
  /** Exact match count when requested, else null. */
  count: number | null;
}

/** Quote a PostgREST filter value so commas, dots and parens stay literal. */
function quoteFilterValue(value: string): string {
  return `"${value.replace(/[\\"]/g, (match) => `\\${match}`)}"`;
}

/**
 * The PostgREST or() expression for a picker search: title ILIKE OR caption ILIKE
 * on the escaped term, plus number = N when the term names a post number. Null
 * when there is nothing to match.
 */
export function pickerSearchOr(
  text: string | undefined,
  number: number | undefined,
): string | null {
  const parts: string[] = [];
  const term = text?.trim() ?? '';
  if (term !== '') {
    const pattern = quoteFilterValue(`%${escapeLike(term)}%`);
    parts.push(`title.ilike.${pattern}`, `caption.ilike.${pattern}`);
  }
  if (number !== undefined) parts.push(`number.eq.${number}`);
  return parts.length === 0 ? null : parts.join(',');
}

/** The PostgREST or() expression for "after this cursor" in (created_at desc, id desc). */
export function pickerCursorOr(cursor: PostPickerCursor): string {
  const at = quoteFilterValue(cursor.createdAt);
  return `created_at.lt.${at},and(created_at.eq.${at},id.lt.${quoteFilterValue(cursor.id)})`;
}

// Applies the shared picker filters to a posts select. Generic over the builder
// so the page read and the head-only count read share one filter shape.
interface PickerFilterable<T> {
  eq(column: string, value: unknown): T;
  neq(column: string, value: unknown): T;
  is(column: string, value: null): T;
  gte(column: string, value: string): T;
  lt(column: string, value: string): T;
  or(filters: string): T;
}

function applyPickerFilter<T extends PickerFilterable<T>>(query: T, input: PostPickerFilter): T {
  let q = query.eq('workspace_id', input.workspaceId).is('deleted_at', null);
  if (input.stage !== undefined) q = q.eq('stage', input.stage);
  if (input.excludeStage !== undefined) q = q.neq('stage', input.excludeStage);
  if (input.enteredSince !== undefined) q = q.gte('stage_entered_at', input.enteredSince);
  if (input.enteredBefore !== undefined) q = q.lt('stage_entered_at', input.enteredBefore);
  const search = pickerSearchOr(input.text, input.number);
  if (search !== null) q = q.or(search);
  return q;
}

/**
 * One keyset page for the chat post picker: RLS-scoped, soft-deleted rows out,
 * ordered created_at desc, id desc. A cursor returns the rows strictly after it.
 * With `withCount`, the same request carries count:'exact' for the filter (the
 * cursor is excluded from the count only when no cursor is passed, so callers
 * ask for it on the first page).
 */
export async function listPostsForPickerPage(
  client: Client,
  input: ListPostsForPickerPageInput,
): Promise<Result<PostPickerPage>> {
  const limit = Math.min(input.limit ?? POSTS_PAGE_SIZE, POSTS_PAGE_SIZE_MAX);
  let query = applyPickerFilter(
    client
      .from('posts')
      .select(POST_PICKER_PAGE_COLUMNS, input.withCount === true ? { count: 'exact' } : {}),
    input,
  );
  if (input.cursor !== undefined) query = query.or(pickerCursorOr(input.cursor));

  const { data, error, count } = await query
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit);

  if (error) return { ok: false, error: transportError(error.message) };
  return {
    ok: true,
    data: {
      rows: (data ?? []) as PostPickerPageRow[],
      count: input.withCount === true ? (count ?? 0) : null,
    },
  };
}

/** Count-only picker read (head:true, count:'exact'): no rows transferred. */
export async function countPostsForPicker(
  client: Client,
  input: PostPickerFilter,
): Promise<Result<number>> {
  const { error, count } = await applyPickerFilter(
    client.from('posts').select('id', { count: 'exact', head: true }),
    input,
  );
  if (error) return { ok: false, error: transportError(error.message) };
  return { ok: true, data: count ?? 0 };
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

/**
 * Batched resolve of per-workspace post numbers (pasted /p/ links) to ids: one
 * RLS-scoped IN read over every number in a message, never one per link. A
 * number the viewer cannot see, or a deleted post, simply does not come back.
 * Returns [] for no numbers without a round-trip.
 */
export async function readPostIdsByNumbers(
  client: Client,
  params: { workspaceId: string; numbers: number[] },
): Promise<Result<Array<Pick<Post, 'id' | 'number'>>>> {
  if (params.numbers.length === 0) return { ok: true, data: [] };

  const { data, error } = await client
    .from('posts')
    .select('id, number')
    .eq('workspace_id', params.workspaceId)
    .in('number', params.numbers)
    .is('deleted_at', null);

  if (error) return { ok: false, error: transportError(error.message) };
  return { ok: true, data: (data ?? []) as Array<Pick<Post, 'id' | 'number'>> };
}

function transportError(message: string): DomainError {
  return { code: 'unknown', message };
}

// One row of the batched first-image lookup: an asset_attachments row with its
// pinned version's mime_type embedded via an inner join (so only image-backed
// attachments survive). The aliased select is wider than the generated row type
// can express, so callers cast through `unknown`.
interface FirstImageRow {
  entity_id: string;
  asset_version_id: string;
  asset_versions: { mime_type: string | null } | null;
}

/**
 * Resolve each post's first image attachment's asset_version_id in ONE query over
 * asset_attachments (no N+1, never one read per post). "First image" is the live
 * (deleted_at IS NULL), image-mime attachment with the lowest position, tie-broken
 * by the earliest attached_at. The inner join + LIKE 'image/%' drops video/link/
 * file attachments server-side; rows arrive grouped by entity_id and ordered
 * position then attached_at ascending, so the first row seen per post wins. Posts
 * with no image attachment never appear in the map (the caller maps them to null).
 * Returns an empty map without a round trip when there are no post ids.
 */
async function firstImageByPost(
  client: Client,
  postIds: string[],
): Promise<Result<Map<string, string>>> {
  if (postIds.length === 0) return { ok: true, data: new Map() };

  const { data, error } = await client
    .from('asset_attachments')
    .select('entity_id, asset_version_id, asset_versions!inner(mime_type)')
    .eq('entity_type', 'post')
    .in('entity_id', postIds)
    .is('deleted_at', null)
    .like('asset_versions.mime_type', 'image/%')
    .order('entity_id', { ascending: true })
    .order('position', { ascending: true })
    .order('attached_at', { ascending: true });

  if (error) return { ok: false, error: transportError(error.message) };

  return { ok: true, data: firstImageFromRows((data ?? []) as unknown as FirstImageRow[]) };
}

/**
 * The first image per post from attachment rows already ordered entity_id, then
 * position, then attached_at ascending: the first image-mime row seen per post
 * wins. Rows with a non-image (or unknown) mime are skipped, so the same pick
 * serves the image-only read above and the all-media read below.
 */
function firstImageFromRows(rows: readonly FirstImageRow[]): Map<string, string> {
  const firstByPost = new Map<string, string>();
  for (const row of rows) {
    if (firstByPost.has(row.entity_id)) continue;
    if (row.asset_versions?.mime_type?.startsWith('image/') !== true) continue;
    firstByPost.set(row.entity_id, row.asset_version_id);
  }
  return firstByPost;
}

// One row of the card's batched media read: a FirstImageRow whose embedded
// version also carries its stored size (null for uploads that predate it).
interface CardMediaRow extends FirstImageRow {
  asset_versions: { mime_type: string | null; width: number | null; height: number | null } | null;
}

/** A post's first photo or video in display order: the card's frame and cover. */
export interface CardFirstMedia {
  assetVersionId: string;
  kind: 'image' | 'video';
  /** The stored size; null when the version has none (older uploads). */
  width: number | null;
  height: number | null;
}

/** Per-post media summary for the chat post card. */
export interface PostMediaSummary {
  /** The first image attachment's version id (the post's chip thumbnail), or null. */
  thumbnailAssetVersionId: string | null;
  /** The first image or video attachment (display order), or null. */
  firstMedia: CardFirstMedia | null;
  /** Live (non-deleted) attachments on the post. */
  mediaCount: number;
  /** Whether any live attachment's version is a video. */
  hasVideo: boolean;
}

/**
 * Fold live attachment rows (ordered as {@link firstImageFromRows} expects) into
 * one media summary per post. Pure; posts with no rows are absent from the map.
 */
export function mediaSummaryByPost(rows: readonly CardMediaRow[]): Map<string, PostMediaSummary> {
  const firstImage = firstImageFromRows(rows);
  const summary = new Map<string, PostMediaSummary>();
  for (const row of rows) {
    const current = summary.get(row.entity_id) ?? {
      thumbnailAssetVersionId: firstImage.get(row.entity_id) ?? null,
      firstMedia: null,
      mediaCount: 0,
      hasVideo: false,
    };
    current.mediaCount += 1;
    const version = row.asset_versions;
    const kind = mediaKind(version?.mime_type ?? null);
    if (kind === 'video') current.hasVideo = true;
    if (current.firstMedia === null && kind !== null) {
      current.firstMedia = {
        assetVersionId: row.asset_version_id,
        kind,
        width: version?.width ?? null,
        height: version?.height ?? null,
      };
    }
    summary.set(row.entity_id, current);
  }
  return summary;
}

/** 'image' / 'video' from a stored mime; null for files, links and unknown. Pure. */
function mediaKind(mime: string | null): CardFirstMedia['kind'] | null {
  if (mime?.startsWith('image/') === true) return 'image';
  if (mime?.startsWith('video/') === true) return 'video';
  return null;
}

/**
 * The shared post card row: the posts columns the card shows plus its media
 * summary. approved_by is a user id; the caller resolves display names in one
 * batched lookup of its own.
 */
export type PostCardRow = Pick<
  Post,
  | 'id'
  | 'number'
  | 'title'
  | 'format'
  | 'platform'
  | 'stage'
  | 'target_date'
  | 'stage_entered_at'
  | 'approved_by'
  | 'approved_at'
> &
  PostMediaSummary;

export const POST_CARD_ROW_COLUMNS =
  'id, number, title, format, platform, stage, target_date, stage_entered_at, approved_by, approved_at';

/**
 * Every live attachment row for `postIds` with its version's mime and stored
 * size embedded, in ONE asset_attachments read ordered entity_id, position,
 * attached_at ascending (the order {@link mediaSummaryByPost} expects). Shared
 * by the card and cover reads so both fold the same rows.
 */
async function readCardMediaRows(
  client: Client,
  postIds: readonly string[],
): Promise<Result<CardMediaRow[]>> {
  const { data, error } = await client
    .from('asset_attachments')
    .select('entity_id, asset_version_id, asset_versions!inner(mime_type, width, height)')
    .eq('entity_type', 'post')
    .in('entity_id', [...postIds])
    .is('deleted_at', null)
    .order('entity_id', { ascending: true })
    .order('position', { ascending: true })
    .order('attached_at', { ascending: true });
  if (error) return { ok: false, error: transportError(error.message) };
  return { ok: true, data: (data ?? []) as unknown as CardMediaRow[] };
}

/**
 * Batched resolve of shared posts for the live chat post card: at most TWO
 * queries for the whole batch, never one per post. (1) One RLS-scoped posts IN
 * read over every id. (2) One asset_attachments IN read over the posts that came
 * back (live rows, version mime and stored size embedded), folded into the first
 * image, the first image or video, the live attachment count and a has-video
 * flag per post. A post the viewer cannot see
 * or that is deleted does not come back, and its attachments are never read.
 * Returns [] for no ids without a round trip; the second read is skipped when no
 * post came back. Rows arrive in the database's order; the caller orders them.
 */
export async function readPostCards(
  client: Client,
  params: { workspaceId: string; ids: string[] },
): Promise<Result<PostCardRow[]>> {
  if (params.ids.length === 0) return { ok: true, data: [] };

  const { data, error } = await client
    .from('posts')
    .select(POST_CARD_ROW_COLUMNS)
    .eq('workspace_id', params.workspaceId)
    .in('id', params.ids)
    .is('deleted_at', null);
  if (error) return { ok: false, error: transportError(error.message) };

  const posts = (data ?? []) as Array<Omit<PostCardRow, keyof PostMediaSummary>>;
  if (posts.length === 0) return { ok: true, data: [] };

  const media = await readCardMediaRows(
    client,
    posts.map((post) => post.id),
  );
  if (!media.ok) return media;

  const byPost = mediaSummaryByPost(media.data);
  return {
    ok: true,
    data: posts.map((post) => ({
      ...post,
      ...(byPost.get(post.id) ?? {
        thumbnailAssetVersionId: null,
        firstMedia: null,
        mediaCount: 0,
        hasVideo: false,
      }),
    })),
  };
}

/**
 * Each post's cover (its first photo or video in display order) for the chat
 * post lists, in ONE asset_attachments read over every id (never one per
 * post). Unlike {@link readPostCards} it does not re-read the posts: the
 * caller already has them, so the cover read starts the moment the list lands.
 * Every requested id comes back: a post with no photo or video (or one RLS
 * hides) maps to null. Returns an empty map without a round trip for no ids.
 */
export async function readPostCovers(
  client: Client,
  postIds: readonly string[],
): Promise<Result<Map<string, CardFirstMedia | null>>> {
  if (postIds.length === 0) return { ok: true, data: new Map() };
  const media = await readCardMediaRows(client, postIds);
  if (!media.ok) return media;
  const byPost = mediaSummaryByPost(media.data);
  const covers = new Map<string, CardFirstMedia | null>();
  for (const id of postIds) covers.set(id, byPost.get(id)?.firstMedia ?? null);
  return { ok: true, data: covers };
}

/** One posts_list row: the 23 posts columns plus the proc's media summary. */
export type PostsListRow = Post & {
  thumbnail_asset_version_id: string | null;
  first_media_asset_version_id: string | null;
  first_media_kind: string | null;
  first_media_width: number | null;
  first_media_height: number | null;
};

type PostsListArgs = Database['public']['Functions']['posts_list']['Args'];

/**
 * Map one posts_list row onto a Pipeline row: the posts columns as they are,
 * the thumbnail from thumbnail_asset_version_id and the cover from the
 * first_media_* columns (null when the post has no photo or video, or the kind
 * is not one the card knows). Pure.
 */
export function pipelinePostFromRow(row: PostsListRow): PipelinePost {
  const {
    thumbnail_asset_version_id,
    first_media_asset_version_id,
    first_media_kind,
    first_media_width,
    first_media_height,
    ...post
  } = row;
  const kind =
    first_media_kind === 'image' || first_media_kind === 'video' ? first_media_kind : null;
  return {
    ...post,
    thumbnailAssetVersionId: thumbnail_asset_version_id ?? null,
    firstMedia:
      first_media_asset_version_id !== null && kind !== null
        ? {
            assetVersionId: first_media_asset_version_id,
            kind,
            width: first_media_width ?? null,
            height: first_media_height ?? null,
          }
        : null,
  };
}

/**
 * List live posts in a workspace, newest first, in ONE public.posts_list call.
 * The proc applies the same filters and order as the old posts read (workspace,
 * live rows, optional stage and `before` cursor, ordered by the composite index
 * (workspace_id, stage, created_at desc), page size capped at 500) and returns
 * each row's first image (the card thumbnail) and cover (first photo or video
 * with its stored size) beside the posts columns, so no attachments read
 * follows. The caller can seed a cover store from `firstMedia`. The trace id is
 * an explicit p_trace_id argument (the caller's, or a fresh uuid_v7).
 */
export async function listPosts(
  client: Client,
  input: ListPostsInput,
): Promise<Result<PipelinePost[]>> {
  const limit = Math.min(input.limit ?? POSTS_PAGE_SIZE, POSTS_PAGE_SIZE_MAX);
  const args: PostsListArgs = {
    p_trace_id: resolveTraceId(input.traceId),
    p_workspace_id: input.workspaceId,
    p_limit: limit,
    ...(input.stage !== undefined ? { p_stage: input.stage } : {}),
    ...(input.before !== undefined ? { p_before: input.before } : {}),
  };
  const { data, error } = await withTraceHeader(client.rpc('posts_list', args), args.p_trace_id);
  if (error) return { ok: false, error: transportError(error.message) };
  // The generated Returns marks every column non-null; the proc's LEFT JOINs and
  // nullable posts columns make many of them null, as PostsListRow says.
  const rows: PostsListRow[] = data ?? [];
  return { ok: true, data: rows.map(pipelinePostFromRow) };
}

/** A post linked to a brief, as Brief detail's linked-posts list shows it. */
export type BriefLinkedPostRow = Pick<Post, 'id' | 'title' | 'stage' | 'created_at'>;

export const BRIEF_LINKED_POST_COLUMNS = 'id, title, stage, created_at';

/**
 * The live posts made from one brief, newest first, capped at `limit`. One
 * RLS-scoped posts read filtered on brief_id (never a whole-workspace scan
 * filtered in the browser) and only the four columns the list shows, so it
 * needs no attachments read and can start the moment the brief id is known.
 */
export async function listBriefLinkedPosts(
  client: Client,
  input: { briefId: string; limit: number },
): Promise<Result<BriefLinkedPostRow[]>> {
  const { data, error } = await client
    .from('posts')
    .select(BRIEF_LINKED_POST_COLUMNS)
    .eq('brief_id', input.briefId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(input.limit);
  if (error) return { ok: false, error: transportError(error.message) };
  return { ok: true, data: (data ?? []) as BriefLinkedPostRow[] };
}

/** Row cap for {@link listOpenPosts}; the strip's number comes from {@link countOpenPosts}. */
export const OPEN_POSTS_LIMIT = 100;

/** A post waiting in review, as the chat open-loops sheet lists it. */
export type OpenPostRow = Pick<
  Post,
  'id' | 'number' | 'title' | 'format' | 'target_date' | 'stage_entered_at'
> & { thumbnailAssetVersionId: string | null };

export const OPEN_POST_COLUMNS = 'id, number, title, format, target_date, stage_entered_at';

/**
 * The posts waiting in review in a workspace, longest waiting first
 * (stage_entered_at asc), capped at {@link OPEN_POSTS_LIMIT}. One posts read
 * pinned to (workspace_id, stage) of posts_workspace_stage_idx, then one batched
 * first-image read over the rows that came back (skipped when none did), never
 * one read per post. RLS decides what the viewer sees.
 */
export async function listOpenPosts(
  client: Client,
  input: { workspaceId: string },
): Promise<Result<OpenPostRow[]>> {
  const { data, error } = await client
    .from('posts')
    .select(OPEN_POST_COLUMNS)
    .eq('workspace_id', input.workspaceId)
    .eq('stage', 'review')
    .is('deleted_at', null)
    .order('stage_entered_at', { ascending: true })
    .limit(OPEN_POSTS_LIMIT);
  if (error) return { ok: false, error: transportError(error.message) };

  const posts = (data ?? []) as Array<Omit<OpenPostRow, 'thumbnailAssetVersionId'>>;
  const thumbnails = await firstImageByPost(
    client,
    posts.map((post) => post.id),
  );
  if (!thumbnails.ok) return thumbnails;
  return {
    ok: true,
    data: posts.map((post) => ({
      ...post,
      thumbnailAssetVersionId: thumbnails.data.get(post.id) ?? null,
    })),
  };
}

/** Count-only read (head:true, count:'exact') on the {@link listOpenPosts} filter. */
export async function countOpenPosts(
  client: Client,
  input: { workspaceId: string },
): Promise<Result<number>> {
  const { error, count } = await client
    .from('posts')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', input.workspaceId)
    .eq('stage', 'review')
    .is('deleted_at', null);
  if (error) return { ok: false, error: transportError(error.message) };
  return { ok: true, data: count ?? 0 };
}

/**
 * Fetch one post by id together with its versions and annotations in a single
 * RLS-scoped query via PostgREST resource embedding (no per-row loops, no N+1).
 * Returns `{ ok: true, data: null }` when the post is absent or hidden by RLS.
 * The embedded versions arrive ordered version_number ascending so callers (the
 * F7.5 history viewer) get a deterministic chain without a second read.
 */
export async function getPost(client: Client, postId: string): Promise<Result<PostDetail | null>> {
  const { data, error } = await client
    .from('posts')
    .select('*, post_versions(*), post_annotations(*)')
    .eq('id', postId)
    .is('deleted_at', null)
    .order('version_number', { referencedTable: 'post_versions', ascending: true })
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
  /** PDF page count (asset_versions.page_count); null when unknown. */
  pageCount: number | null;
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
    page_count: number | null;
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
        pageCount: version?.page_count ?? null,
        r2Key: version?.r2_key ?? null,
        externalUrl: version?.external_url ?? null,
      };
    }),
  };
}
