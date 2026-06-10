// v1 read layer. The ONLY place v1 is touched, and only ever with SELECT. The
// pool opens a read-only session (default_transaction_read_only=on) so any
// accidental write against v1 is rejected by the server, and read() also asserts
// the statement is a SELECT/WITH. Reads are batched (LIMIT/OFFSET) so a large v1
// table is never pulled into memory at once.

import { Pool, type QueryResultRow } from 'pg';

export const BATCH_SIZE = 500;

// v1 public.requests -> v2 briefs.
export type V1Request = {
  id: string;
  title: string | null;
  description: string | null;
  content_type: string | null;
  status: string | null;
  target_date: Date | string | null;
  drive_link: string | null;
  images: string[] | null;
};

// v1 public.posts. id (uuid) becomes the v2 posts.id; post_id (text) is the key
// v1 post_comments joins on; brief_id (text) maps via the requests id map.
export type V1Post = {
  id: string;
  post_id: string | null;
  title: string | null;
  caption: string | null;
  format: string | null;
  is_draft: boolean | null;
  stage: string | null;
  brief_id: string | null;
  target_date: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

// v1 public.post_versions, keyed by the owning v1 post id (= v2 post id). v1
// stores ONLY the edited caption plus edit metadata; it has no separate content,
// images, canva_link, drive_link, linkedin_link, content_pillar, or location
// column (confirmed against v1 information_schema). The version body IS the
// caption, so that is the only text field carried over.
export type V1PostVersion = {
  post_id: string;
  caption: string | null;
  edited_by: string | null;
  edited_at: Date | string | null;
};

// Lightweight (id, reply_to) pair used to build the comment id map first pass.
export type V1CommentRef = {
  id: string;
  reply_to: string | null;
};

// Full v1 comment row joined to its v2 post id.
export type V1Comment = {
  id: string;
  v2_post_id: string;
  message: string;
  deleted: boolean | null;
  created_at: Date | string;
  edited_at: Date | string | null;
  reply_to: string | null;
};

// Media-only reads for the asset step. images/attachments are jsonb whose runtime
// shape varies (array, object, or double-encoded string), so they are typed
// `unknown` and normalised by the transform parser. canva_link and linkedin_link
// are deliberately NOT selected: they are dropped from the v2 migration.
export type V1PostMedia = { id: string; images: unknown; drive_link: string | null };
export type V1RequestMedia = { id: string; images: unknown; drive_link: string | null };
export type V1CommentMedia = { id: string; attachments: unknown };

export class SourceDb {
  private readonly pool: Pool;

  constructor(connectionString: string) {
    // Read-only session: any write attempted against v1 throws at the server.
    this.pool = new Pool({
      connectionString,
      options: '-c default_transaction_read_only=on',
      max: 4,
    });
  }

  private async read<T extends QueryResultRow>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<T[]> {
    const head = sql.trimStart().toUpperCase();
    if (!head.startsWith('SELECT') && !head.startsWith('WITH')) {
      throw new Error('SourceDb only permits SELECT/WITH statements against v1.');
    }
    const result = await this.pool.query<T>(sql, [...params]);
    return result.rows;
  }

  private async count(sql: string): Promise<number> {
    const rows = await this.read<{ n: string }>(sql);
    return rows.length > 0 ? Number(rows[0]?.n ?? 0) : 0;
  }

  async countRequests(): Promise<number> {
    return this.count('SELECT count(*)::text AS n FROM public.requests');
  }

  async countPosts(): Promise<number> {
    return this.count('SELECT count(*)::text AS n FROM public.posts');
  }

  async countPostVersionsJoined(): Promise<number> {
    return this.count(
      'SELECT count(*)::text AS n FROM public.post_versions pv JOIN public.posts p ON pv.post_id = p.id',
    );
  }

  async countPostsWithoutVersions(): Promise<number> {
    return this.count(
      'SELECT count(*)::text AS n FROM public.posts p WHERE NOT EXISTS (SELECT 1 FROM public.post_versions pv WHERE pv.post_id = p.id)',
    );
  }

  async countMigratableComments(): Promise<number> {
    return this.count(
      `SELECT count(*)::text AS n
         FROM public.post_comments c
         JOIN public.posts p ON c.post_id = p.post_id
        WHERE c.message IS NOT NULL AND btrim(c.message) <> ''`,
    );
  }

  async fetchRequestsBatch(offset: number, limit: number): Promise<V1Request[]> {
    return this.read<V1Request>(
      `SELECT id::text AS id, title, description, content_type, status, target_date, drive_link, images
         FROM public.requests
        ORDER BY id
        LIMIT $1 OFFSET $2`,
      [limit, offset],
    );
  }

  async fetchPostsBatch(offset: number, limit: number): Promise<V1Post[]> {
    return this.read<V1Post>(
      `SELECT id::text AS id, post_id::text AS post_id, title, caption, format, is_draft, stage,
              brief_id::text AS brief_id, target_date, created_at, updated_at
         FROM public.posts
        ORDER BY id
        LIMIT $1 OFFSET $2`,
      [limit, offset],
    );
  }

  // All versions for a batch of v2 post ids (= v1 posts.id), oldest first so the
  // caller can number them 1..n. No per-post N+1: one query per post batch.
  async fetchVersionsForPosts(postIds: readonly string[]): Promise<V1PostVersion[]> {
    if (postIds.length === 0) return [];
    return this.read<V1PostVersion>(
      `SELECT pv.post_id::text AS post_id, pv.caption, pv.edited_by, pv.edited_at
         FROM public.post_versions pv
        WHERE pv.post_id = ANY($1::uuid[])
        ORDER BY pv.post_id, pv.edited_at ASC NULLS FIRST`,
      [[...postIds]],
    );
  }

  // First pass: (id, reply_to) for every migratable (non-blank) comment, in the
  // same order/filter as the full fetch so the id map covers exactly that set.
  async fetchCommentRefsBatch(offset: number, limit: number): Promise<V1CommentRef[]> {
    return this.read<V1CommentRef>(
      `SELECT c.id::text AS id, c.reply_to::text AS reply_to
         FROM public.post_comments c
         JOIN public.posts p ON c.post_id = p.post_id
        WHERE c.message IS NOT NULL AND btrim(c.message) <> ''
        ORDER BY c.created_at ASC, c.id
        LIMIT $1 OFFSET $2`,
      [limit, offset],
    );
  }

  // Second pass: full migratable comment rows joined to the v2 post id.
  async fetchCommentsBatch(offset: number, limit: number): Promise<V1Comment[]> {
    return this.read<V1Comment>(
      `SELECT c.id::text AS id, p.id::text AS v2_post_id, c.message, c.deleted,
              c.created_at, c.edited_at, c.reply_to::text AS reply_to
         FROM public.post_comments c
         JOIN public.posts p ON c.post_id = p.post_id
        WHERE c.message IS NOT NULL AND btrim(c.message) <> ''
        ORDER BY c.created_at ASC, c.id
        LIMIT $1 OFFSET $2`,
      [limit, offset],
    );
  }

  // Media reads for the asset step. Separate from fetchPostsBatch /
  // fetchCommentsBatch so the existing post/comment load paths are untouched;
  // these select only the jsonb media columns (plus the join key) and are paged
  // like every other read.
  async fetchPostMediaBatch(offset: number, limit: number): Promise<V1PostMedia[]> {
    return this.read<V1PostMedia>(
      `SELECT id::text AS id, images, drive_link
         FROM public.posts
        ORDER BY id
        LIMIT $1 OFFSET $2`,
      [limit, offset],
    );
  }

  async fetchRequestMediaBatch(offset: number, limit: number): Promise<V1RequestMedia[]> {
    return this.read<V1RequestMedia>(
      `SELECT id::text AS id, images, drive_link
         FROM public.requests
        ORDER BY id
        LIMIT $1 OFFSET $2`,
      [limit, offset],
    );
  }

  // Comment attachments joined to the owning post, in the same order/filter
  // family as the comment load so the ids line up with the comment id map. Rows
  // with no attachments are excluded server-side.
  async fetchCommentAttachmentsBatch(offset: number, limit: number): Promise<V1CommentMedia[]> {
    return this.read<V1CommentMedia>(
      `SELECT c.id::text AS id, c.attachments
         FROM public.post_comments c
         JOIN public.posts p ON c.post_id = p.post_id
        WHERE c.attachments IS NOT NULL
        ORDER BY c.created_at ASC, c.id
        LIMIT $1 OFFSET $2`,
      [limit, offset],
    );
  }

  async end(): Promise<void> {
    await this.pool.end();
  }
}
