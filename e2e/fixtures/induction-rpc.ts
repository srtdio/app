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
    const live = members.filter((m) => m.removed_at == null);
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
      post_versions: [],
      post_annotations: [],
    });
    return id;
  },
  gallery_set: () => crypto.randomUUID(),
  stage_transition: (args, tables) => {
    const post = (tables.posts ?? []).find((p) => p.id === args.p_post_id);
    if (post !== undefined) {
      post.stage = args.p_to_stage;
      post.stage_entered_at = new Date().toISOString();
    }
    return null;
  },
};
