// The induction procs over the fixture tables, as the live ones read and write
// user_private (20261015035000_induction_progress.sql), plus the post writes
// the first post needs (post_create, stage_transition, gallery_set). The world
// starts done (existing users were backfilled done), so specs that never touch
// the induction see no guide; induction specs call startInduction first.

import type { Row, Tables } from './postgrest';
import { ME } from './chat-data';

type RpcHandler = (args: Record<string, unknown>, tables: Tables) => unknown;

const BACKFILLED = '2026-01-02T00:00:00Z';

function privateRow(tables: Tables): Row {
  const rows = (tables.user_private ??= []);
  let row = rows.find((r) => r.user_id === ME);
  if (row === undefined) {
    row = { user_id: ME, induction_step: null, induction_done_at: BACKFILLED };
    rows.push(row);
  }
  return row;
}

/** A new person: the induction is not done and no step is stored. */
export function startInduction(tables: Tables, step: string | null = null): void {
  const row = privateRow(tables);
  row.induction_step = step;
  row.induction_done_at = null;
}

export function inductionDone(tables: Tables): boolean {
  return privateRow(tables).induction_done_at !== null;
}

const AGENCY_SIDE = new Set(['admin', 'agency']);

export const INDUCTION_RPC: Record<string, RpcHandler> = {
  induction_state: (args, tables) => {
    const row = privateRow(tables);
    const ws = args.p_workspace_id;
    const members = (tables.workspace_members ?? []).filter((m) => m.workspace_id === ws);
    // The sample week's people never count as invited (induction_state does the same).
    const sample = new Set(
      (tables.induction_sample_rows ?? [])
        .filter((r) => r.workspace_id === ws && r.kind === 'member')
        .map((r) => String(r.row_id)),
    );
    const live = members.filter((m) => m.removed_at == null && !sample.has(String(m.user_id)));
    const sent = (tables.posts ?? [])
      .filter(
        (p) =>
          p.workspace_id === ws &&
          p.created_by === ME &&
          p.stage !== 'draft' &&
          p.deleted_at == null,
      )
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    return {
      step: row.induction_step ?? null,
      done_at: row.induction_done_at ?? null,
      role: members.find((m) => m.user_id === ME && m.active === true)?.role ?? null,
      post_id: sent[0]?.id ?? null,
      client_invited: live.some((m) => m.role === 'client'),
      team_invited: live.some((m) => AGENCY_SIDE.has(String(m.role))),
    };
  },
  // The sample week: the harness has none unless a spec seeds induction_sample_rows itself.
  induction_sample_seed: () => ({ seeded: false }),
  induction_sample_clear: (args, tables) => {
    tables.induction_sample_rows = (tables.induction_sample_rows ?? []).filter(
      (r) => r.workspace_id !== args.p_workspace_id,
    );
    return { cleared: true };
  },
  induction_step_set: (args, tables) => {
    privateRow(tables).induction_step = args.p_step;
    return null;
  },
  induction_finish: (_args, tables) => {
    const row = privateRow(tables);
    row.induction_done_at ??= new Date().toISOString();
    return null;
  },
  post_create: (args, tables) => {
    const payload = (args.p_payload ?? {}) as Record<string, unknown>;
    const posts = (tables.posts ??= []);
    const workspace = (tables.workspaces ?? []).find((w) => w.id === args.p_workspace_id);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    posts.push({
      id,
      number: 101 + posts.length,
      workspace_id: args.p_workspace_id,
      title: payload.title,
      caption: payload.caption ?? '',
      bucket_id: null,
      owner_user_id: payload.owner_user_id ?? null,
      platform: workspace?.platform ?? 'linkedin',
      format: payload.format,
      stage: 'draft',
      stage_entered_at: now,
      approved_by: null,
      approved_at: null,
      target_date: payload.target_date ?? null,
      origin: 'manual',
      brief_id: null,
      row_version: 1,
      created_by: ME,
      legacy_author_name: null,
      created_at: now,
      updated_at: now,
      deleted_at: null,
      // One version, as post_create writes it: a caption comment anchors to it.
      post_versions: [
        {
          id: crypto.randomUUID(),
          post_id: id,
          workspace_id: args.p_workspace_id,
          version_number: 1,
          snapshot: {},
          created_by: ME,
          legacy_author_name: null,
          created_at: now,
        },
      ],
      post_annotations: [],
    });
    return id;
  },
  gallery_set: () => crypto.randomUUID(),
  // The look-around writes (onboarding-*.spec.ts): a caption comment and its
  // annotation, and the approver's first brief.
  comment_create: (args, tables) => {
    const id = crypto.randomUUID();
    (tables.comments ??= []).push({
      id,
      workspace_id: args.p_workspace_id,
      entity_type: args.p_entity_type,
      entity_id: args.p_entity_id,
      parent_comment_id: args.p_parent_comment_id ?? null,
      author_user_id: ME,
      body: args.p_body,
      mentions: args.p_mentions ?? null,
      attachment_asset_ids: null,
      resolved_at: null,
      resolved_by: null,
      unaccepted_by: null,
      created_at: new Date().toISOString(),
      edited_at: null,
      deleted_at: null,
    });
    return id;
  },
  annotation_create: () => crypto.randomUUID(),
  // A client's line or pin comment is a checkpoint (PostDetailPage).
  comment_batch_create: (args, tables) => {
    const points = (args.p_points ?? []) as Array<{ body?: string }>;
    const seqBase = (tables.comments ?? []).filter(
      (c) => c.entity_id === args.p_post_id && c.ledger_seq != null,
    ).length;
    return points.map((point, k) => {
      const id = crypto.randomUUID();
      (tables.comments ??= []).push({
        id,
        workspace_id: args.p_workspace_id,
        entity_type: 'post',
        entity_id: args.p_post_id,
        parent_comment_id: null,
        author_user_id: ME,
        body: point.body ?? '',
        mentions: null,
        attachment_asset_ids: null,
        ledger_seq: seqBase + k + 1,
        resolved_at: null,
        resolved_by: null,
        unaccepted_by: null,
        created_at: new Date().toISOString(),
        edited_at: null,
        deleted_at: null,
      });
      return { id, seq: seqBase + k + 1 };
    });
  },
  brief_create: (args, tables) => {
    const payload = (args.p_payload ?? {}) as Record<string, unknown>;
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    (tables.briefs ??= []).push({
      id,
      workspace_id: args.p_workspace_id,
      number: 1 + (tables.briefs?.length ?? 0),
      title: payload.title ?? '',
      objective: payload.objective ?? '',
      brand_requirements: payload.brand_requirements ?? null,
      format_requested: payload.format_requested ?? null,
      reference_links: payload.reference_links ?? null,
      mentions: payload.mentions ?? null,
      status: 'open',
      target_date: payload.target_date ?? null,
      created_via: 'app',
      created_by: ME,
      closed_at: null,
      closed_by: null,
      legacy_author_name: null,
      row_version: 1,
      created_at: now,
      updated_at: now,
      deleted_at: null,
    });
    return id;
  },
  stage_transition: (args, tables) => {
    const post = (tables.posts ?? []).find((p) => p.id === args.p_post_id);
    if (post !== undefined) {
      post.stage = args.p_to_stage;
      post.stage_entered_at = new Date().toISOString();
    }
    return null;
  },
};
