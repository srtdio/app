// The palette's workspace search over the fixture world: workspace_search_grouped
// (newest first, at most p_per_kind rows per kind, mention tokens cut at the
// end dropped) and workspace_search_counts (each kind's full total), like the
// SQL in supabase/migrations/20261016213000_workspace_search_counts.sql. Only
// people, posts and groups are searched: the fixture world has no others.

import type { Row, Tables } from './postgrest';

type RpcHandler = (args: Record<string, unknown>, tables: Tables) => unknown;

interface Match {
  kind: string;
  id: string;
  parent_id: string | null;
  channel_id: string | null;
  entity_type: string;
  number: number | null;
  title: string;
  body: string;
  actor: string | null;
  created_at: string;
}

function str(row: Row, key: string): string {
  const v = row[key];
  return typeof v === 'string' ? v : '';
}

function activeMember(tables: Tables, workspaceId: string, userId: string | null): boolean {
  return (tables.workspace_members ?? []).some(
    (m) =>
      m.workspace_id === workspaceId &&
      m.user_id === userId &&
      m.active === true &&
      m.removed_at == null,
  );
}

function matches(args: Record<string, unknown>, tables: Tables): Match[] {
  const ws = String(args.p_workspace_id ?? '');
  const q = String(args.p_query ?? '')
    .trim()
    .toLowerCase();
  if (q.length < 2 || q.length > 100) return [];
  const has = (text: string): boolean => text.toLowerCase().includes(q);
  const out: Match[] = [];
  for (const m of tables.workspace_members ?? []) {
    if (m.workspace_id !== ws || m.active !== true || m.removed_at != null) continue;
    const u = (tables.users ?? []).find((x) => x.id === m.user_id && x.deleted_at == null);
    if (u === undefined || !(has(str(u, 'display_name')) || has(str(u, 'username')))) continue;
    out.push({
      kind: 'person',
      id: str(u, 'id'),
      parent_id: null,
      channel_id: null,
      entity_type: 'user',
      number: null,
      title: str(u, 'display_name'),
      body: str(u, 'username'),
      actor: str(u, 'id'),
      created_at: str(m, 'accepted_at'),
    });
  }
  for (const p of tables.posts ?? []) {
    if (p.workspace_id !== ws || p.deleted_at != null) continue;
    if (!(has(str(p, 'title')) || has(str(p, 'caption')))) continue;
    out.push({
      kind: 'post',
      id: str(p, 'id'),
      parent_id: null,
      channel_id: null,
      entity_type: 'post',
      number: typeof p.number === 'number' ? p.number : null,
      title: str(p, 'title'),
      body: str(p, 'caption'),
      actor: str(p, 'created_by'),
      created_at: str(p, 'created_at'),
    });
  }
  for (const g of tables.groups ?? []) {
    if (g.workspace_id !== ws || g.deleted_at != null || !has(str(g, 'name'))) continue;
    out.push({
      kind: 'chat_group',
      id: str(g, 'id'),
      parent_id: null,
      channel_id: `group__${ws}__${str(g, 'id')}`,
      entity_type: 'group',
      number: null,
      title: str(g, 'name'),
      body: '',
      actor: str(g, 'created_by'),
      created_at: str(g, 'created_at'),
    });
  }
  return out;
}

export const SEARCH_RPC: Record<string, RpcHandler> = {
  workspace_search_grouped: (args, tables) => {
    const ws = String(args.p_workspace_id ?? '');
    const per = Math.min(Math.max(Number(args.p_per_kind ?? 5), 1), 20);
    const byKind = new Map<string, Match[]>();
    for (const m of matches(args, tables)) {
      byKind.set(m.kind, [...(byKind.get(m.kind) ?? []), m]);
    }
    return [...byKind.values()].flatMap((rows) =>
      rows
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .slice(0, per)
        .map((m) => ({
          kind: m.kind,
          id: m.id,
          parent_id: m.parent_id,
          channel_id: m.channel_id,
          entity_type: m.entity_type,
          number: m.number,
          title: m.title,
          snippet: m.body.slice(0, 160).replace(/@\[[^\]]*$/, ''),
          actor_user_id: m.actor,
          actor_is_member: activeMember(tables, ws, m.actor),
          created_at: m.created_at,
        })),
    );
  },
  workspace_search_counts: (args, tables) => {
    const totals = new Map<string, number>();
    for (const m of matches(args, tables)) totals.set(m.kind, (totals.get(m.kind) ?? 0) + 1);
    return [...totals.entries()].map(([kind, total]) => ({ kind, total }));
  },
};
