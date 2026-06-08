// v2 write layer. Writes go DIRECTLY to tables with full DB rights, bypassing the
// SECURITY DEFINER procs and RLS on purpose: those procs need auth.uid(), which a
// script does not have. No .rpc() is ever called. Everything runs inside the
// single transaction opened by index.ts, so any failure rolls the whole load
// back. Inserts are chunked; reads are streamed in batches by the orchestrator.

import type { PoolClient } from 'pg';
import { v7 as uuidv7 } from 'uuid';

import type { EtlConfig } from './config';
import { BATCH_SIZE, type SourceDb, type V1Post, type V1PostVersion } from './source';
import {
  briefCloseFields,
  briefObjective,
  briefTitle,
  buildReferenceLinks,
  buildSnapshot,
  commentBody,
  DISPLAY_NAME_MAX,
  mapBriefFormatRequested,
  mapBriefStatus,
  mapPostFormat,
  mapPostStage,
  postCaption,
  postOrigin,
  postTitle,
  truncate,
  WORKSPACE_NAME_MAX,
  type SnapshotInput,
} from './transform';

// Max rows per INSERT statement. 500 rows * ~15 cols is well under the 65535
// bind-parameter ceiling and keeps each round trip bounded.
const INSERT_CHUNK = 500;

type Row = Record<string, unknown>;

function isDevSeed(config: EtlConfig): boolean {
  return config.cli.mode === 'dev-seed';
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// Parameterised multi-row INSERT. jsonb columns must already be JSON strings.
async function insertRows(
  client: PoolClient,
  table: string,
  columns: readonly string[],
  rows: readonly Row[],
): Promise<void> {
  for (const part of chunk(rows, INSERT_CHUNK)) {
    if (part.length === 0) continue;
    const params: unknown[] = [];
    const tuples: string[] = [];
    let p = 1;
    for (const row of part) {
      tuples.push(`(${columns.map(() => `$${p++}`).join(', ')})`);
      for (const col of columns) params.push(row[col]);
    }
    await client.query(
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${tuples.join(', ')}`,
      params,
    );
  }
}

// Step 1: ensure the operator exists in auth.users and public.users. Idempotent.
export async function ensureOperator(client: PoolClient, config: EtlConfig): Promise<void> {
  await client.query(
    `INSERT INTO auth.users (id, email) VALUES ($1, $2)
     ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email`,
    [config.operatorUserId, config.operatorEmail],
  );
  await client.query(
    `INSERT INTO public.users (id, display_name) VALUES ($1, $2)
     ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name, updated_at = now()`,
    [config.operatorUserId, truncate(config.operatorDisplayName, DISPLAY_NAME_MAX)],
  );
}

// Step 2: find-or-create the workspace owned by the operator. Insert fires the
// existing seed triggers (role permissions, onboarding); reuse on reseed keeps a
// stable workspace_id for the dev-seed wipe. Then ensure the owner membership.
export async function ensureWorkspace(client: PoolClient, config: EtlConfig): Promise<string> {
  const name = truncate(config.workspaceName, WORKSPACE_NAME_MAX);
  const existing = await client.query<{ id: string }>(
    `SELECT id FROM public.workspaces
      WHERE name = $1 AND owner_user_id = $2 AND deleted_at IS NULL
      ORDER BY created_at LIMIT 1`,
    [name, config.operatorUserId],
  );
  const found = existing.rows[0];
  const workspaceId =
    found !== undefined
      ? found.id
      : (
          await client.query<{ id: string }>(
            `INSERT INTO public.workspaces (name, owner_user_id, timezone)
             VALUES ($1, $2, $3) RETURNING id`,
            [name, config.operatorUserId, config.workspaceTimezone],
          )
        ).rows[0]?.id;
  if (workspaceId === undefined) {
    throw new Error('Failed to create or locate the target workspace.');
  }

  const member = await client.query(
    `SELECT 1 FROM public.workspace_members
      WHERE workspace_id = $1 AND user_id = $2 AND active = true LIMIT 1`,
    [workspaceId, config.operatorUserId],
  );
  if (member.rowCount === 0) {
    await client.query(
      `INSERT INTO public.workspace_members (workspace_id, user_id, role, active, accepted_at)
       VALUES ($1, $2, 'owner', true, now())`,
      [workspaceId, config.operatorUserId],
    );
  }
  return workspaceId;
}

// Step 3: dev-seed only. Clear migrated content for this workspace so reseeds are
// clean. FK-safe order: comments, post_versions, posts, briefs. Never in cutover.
export async function wipeWorkspaceContent(client: PoolClient, workspaceId: string): Promise<void> {
  await client.query('DELETE FROM public.comments WHERE workspace_id = $1', [workspaceId]);
  await client.query('DELETE FROM public.post_versions WHERE workspace_id = $1', [workspaceId]);
  await client.query('DELETE FROM public.posts WHERE workspace_id = $1', [workspaceId]);
  await client.query('DELETE FROM public.briefs WHERE workspace_id = $1', [workspaceId]);
}

// Step 4: briefs from v1 requests. Returns the v1 requests.id -> v2 briefs.id map
// used to wire post.origin in step 5.
export async function loadBriefs(
  client: PoolClient,
  source: SourceDb,
  config: EtlConfig,
  workspaceId: string,
): Promise<{ map: Map<string, string>; count: number }> {
  const scrub = isDevSeed(config);
  const map = new Map<string, string>();
  let count = 0;
  for (let offset = 0; ; offset += BATCH_SIZE) {
    const batch = await source.fetchRequestsBatch(offset, BATCH_SIZE);
    if (batch.length === 0) break;
    const rows: Row[] = batch.map((r) => {
      const id = uuidv7();
      map.set(r.id, id);
      // Compute status once and derive the close columns from it so every brief
      // row satisfies the briefs_closed_consistency CHECK. v1 has no close
      // timestamp; new Date() is the documented best-effort fallback when the
      // request carries no target_date.
      const status = mapBriefStatus(r.status);
      const close = briefCloseFields(status, r.target_date, config.operatorUserId, new Date());
      return {
        id,
        workspace_id: workspaceId,
        title: briefTitle(r.title),
        objective: briefObjective(r.description, r.title, scrub),
        format_requested: mapBriefFormatRequested(r.content_type),
        status,
        target_date: r.target_date,
        closed_at: close.closed_at,
        closed_by: close.closed_by,
        reference_links: JSON.stringify(buildReferenceLinks(r.drive_link, r.images)),
        created_by: config.operatorUserId,
        created_via: 'app',
        row_version: 1,
      };
    });
    await insertRows(
      client,
      'public.briefs',
      [
        'id',
        'workspace_id',
        'title',
        'objective',
        'format_requested',
        'status',
        'target_date',
        'closed_at',
        'closed_by',
        'reference_links',
        'created_by',
        'created_via',
        'row_version',
      ],
      rows,
    );
    count += rows.length;
    if (batch.length < BATCH_SIZE) break;
  }
  return { map, count };
}

// Step 5: posts from v1 posts. v1 posts.id is preserved as the v2 posts.id.
export async function loadPosts(
  client: PoolClient,
  source: SourceDb,
  config: EtlConfig,
  workspaceId: string,
  briefIdMap: ReadonlyMap<string, string>,
): Promise<number> {
  const scrub = isDevSeed(config);
  let count = 0;
  for (let offset = 0; ; offset += BATCH_SIZE) {
    const batch = await source.fetchPostsBatch(offset, BATCH_SIZE);
    if (batch.length === 0) break;
    const rows: Row[] = batch.map((p: V1Post) => {
      const mappedBrief = p.brief_id !== null ? (briefIdMap.get(p.brief_id) ?? null) : null;
      const { origin, briefId } = postOrigin(mappedBrief);
      return {
        id: p.id,
        workspace_id: workspaceId,
        title: postTitle(p.title),
        caption: postCaption(p.caption, scrub),
        platform: 'linkedin',
        owner_user_id: config.operatorUserId,
        created_by: config.operatorUserId,
        format: mapPostFormat(p.format),
        stage: mapPostStage(p.stage, p.is_draft === true),
        origin,
        brief_id: briefId,
        target_date: p.target_date,
        row_version: 1,
        created_at: p.created_at,
        updated_at: p.updated_at,
      };
    });
    await insertRows(
      client,
      'public.posts',
      [
        'id',
        'workspace_id',
        'title',
        'caption',
        'platform',
        'owner_user_id',
        'created_by',
        'format',
        'stage',
        'origin',
        'brief_id',
        'target_date',
        'row_version',
        'created_at',
        'updated_at',
      ],
      rows,
    );
    count += rows.length;
    if (batch.length < BATCH_SIZE) break;
  }
  return count;
}

function versionRow(
  workspaceId: string,
  operatorUserId: string,
  postId: string,
  versionNumber: number,
  snapshot: SnapshotInput,
  scrub: boolean,
): Row {
  return {
    id: uuidv7(),
    post_id: postId,
    workspace_id: workspaceId,
    version_number: versionNumber,
    snapshot: JSON.stringify(buildSnapshot(snapshot, scrub)),
    created_by: operatorUserId,
  };
}

// Step 6: post_versions. For each post, number its v1 versions 1..n in edited_at
// order; a post with no v1 versions gets a single version 1 from its caption.
export async function loadPostVersions(
  client: PoolClient,
  source: SourceDb,
  config: EtlConfig,
  workspaceId: string,
): Promise<number> {
  const scrub = isDevSeed(config);
  const cols = ['id', 'post_id', 'workspace_id', 'version_number', 'snapshot', 'created_by'];
  let count = 0;
  for (let offset = 0; ; offset += BATCH_SIZE) {
    const posts = await source.fetchPostsBatch(offset, BATCH_SIZE);
    if (posts.length === 0) break;
    const versions = await source.fetchVersionsForPosts(posts.map((p) => p.id));
    const byPost = new Map<string, V1PostVersion[]>();
    for (const v of versions) {
      const list = byPost.get(v.post_id);
      if (list) list.push(v);
      else byPost.set(v.post_id, [v]);
    }
    const rows: Row[] = [];
    for (const post of posts) {
      const list = byPost.get(post.id) ?? [];
      if (list.length === 0) {
        // No v1 versions: snapshot the post's current caption plus the (absent)
        // version-only preserved fields.
        rows.push(
          versionRow(
            workspaceId,
            config.operatorUserId,
            post.id,
            1,
            {
              content: post.caption,
              caption: post.caption,
              images: null,
              canvaLink: null,
              driveLink: null,
              linkedinLink: null,
              contentPillar: null,
              location: null,
              editedBy: null,
            },
            scrub,
          ),
        );
      } else {
        list.forEach((v, i) => {
          rows.push(
            versionRow(
              workspaceId,
              config.operatorUserId,
              post.id,
              i + 1,
              {
                content: v.content,
                caption: v.caption,
                images: v.images,
                canvaLink: v.canva_link,
                driveLink: v.drive_link,
                linkedinLink: v.linkedin_link,
                contentPillar: v.content_pillar,
                location: v.location,
                editedBy: v.edited_by,
              },
              scrub,
            ),
          );
        });
      }
    }
    await insertRows(client, 'public.post_versions', cols, rows);
    count += rows.length;
    if (posts.length < BATCH_SIZE) break;
  }
  return count;
}

// Step 7: comments from v1 post_comments. Two passes build a v1->v2 comment id
// map first, so parent_comment_id can be resolved (null when the parent was not
// migrated). Comments insert with parent NULL, then a batched UPDATE wires the
// parents, avoiding any self-FK insert-ordering hazard.
export async function loadComments(
  client: PoolClient,
  source: SourceDb,
  config: EtlConfig,
  workspaceId: string,
): Promise<number> {
  const scrub = isDevSeed(config);

  // Pass 1: assign a v2 id to every migratable comment.
  const idMap = new Map<string, string>();
  for (let offset = 0; ; offset += BATCH_SIZE) {
    const refs = await source.fetchCommentRefsBatch(offset, BATCH_SIZE);
    if (refs.length === 0) break;
    for (const ref of refs) idMap.set(ref.id, uuidv7());
    if (refs.length < BATCH_SIZE) break;
  }

  // Pass 2: insert rows (parent NULL) and collect child->parent links.
  const cols = [
    'id',
    'workspace_id',
    'entity_type',
    'entity_id',
    'author_user_id',
    'body',
    'is_decision',
    'created_at',
    'edited_at',
    'deleted_at',
  ];
  const parentLinks: Array<{ child: string; parent: string }> = [];
  let count = 0;
  for (let offset = 0; ; offset += BATCH_SIZE) {
    const batch = await source.fetchCommentsBatch(offset, BATCH_SIZE);
    if (batch.length === 0) break;
    const rows: Row[] = [];
    for (const c of batch) {
      const id = idMap.get(c.id);
      if (id === undefined) continue;
      const deletedAt = c.deleted === true ? (c.edited_at ?? c.created_at) : null;
      rows.push({
        id,
        workspace_id: workspaceId,
        entity_type: 'post',
        entity_id: c.v2_post_id,
        author_user_id: config.operatorUserId,
        body: commentBody(c.message, scrub),
        is_decision: false,
        created_at: c.created_at,
        edited_at: c.edited_at,
        deleted_at: deletedAt,
      });
      if (c.reply_to !== null) {
        const parent = idMap.get(c.reply_to);
        if (parent !== undefined) parentLinks.push({ child: id, parent });
      }
    }
    await insertRows(client, 'public.comments', cols, rows);
    count += rows.length;
    if (batch.length < BATCH_SIZE) break;
  }

  // Pass 3: wire parent_comment_id in batches.
  for (const part of chunk(parentLinks, INSERT_CHUNK)) {
    if (part.length === 0) continue;
    const params: unknown[] = [];
    const tuples: string[] = [];
    let p = 1;
    for (const link of part) {
      tuples.push(`($${p++}::uuid, $${p++}::uuid)`);
      params.push(link.child, link.parent);
    }
    await client.query(
      `UPDATE public.comments AS c SET parent_comment_id = v.parent
         FROM (VALUES ${tuples.join(', ')}) AS v(child, parent)
        WHERE c.id = v.child`,
      params,
    );
  }
  return count;
}
