import type { Row, Tables } from './postgrest';

// public.chat_open_bundle over the fixture tables (RLS is not emulated): the
// one call a chat open makes. p_since null: the latest 50 rows, has_more
// strictly when more exist; p_since set: every row at or after it, oldest
// first, max 200 (has_more: a gap). Quoted and thread root rows not on the
// page, reactions on the page, every cursor and its message's time, reply
// counts per page root, marks, the viewer's scheduled rows, open posts (with
// their first image) and count, the current shared plan ids, open briefs and
// count. A chat not in chat_channels for the workspace raises
// 'workspace_member_only' (the caller maps a thrown Error to a 400).

function live(row: Row): boolean {
  return row.deleted_at === null || row.deleted_at === undefined;
}

function at(row: Row): number {
  return Date.parse(String(row.created_at));
}

/** Oldest first on (created_at, id). */
function byTime(a: Row, b: Row): number {
  return at(a) - at(b) || String(a.id).localeCompare(String(b.id));
}

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function chatOpenBundle(
  args: Record<string, unknown>,
  tables: Tables,
  refuse: (code: string) => Error,
  now: number = Date.now(),
): Record<string, unknown> {
  const channelId = String(args.p_channel_id);
  const workspaceId = String(args.p_workspace_id);
  const channel = (tables.chat_channels ?? []).find(
    (c) => c.channel_id === channelId && c.workspace_id === workspaceId,
  );
  if (channel === undefined) throw refuse('workspace_member_only');
  const since = typeof args.p_since === 'string' ? Date.parse(args.p_since) : Number.NaN;
  const limit = Number.isNaN(since) ? 50 : 200;
  const all = (tables.chat_messages ?? [])
    .filter((m) => m.channel_id === channelId && at(m) < now + 60_000)
    .sort(byTime);
  const window = Number.isNaN(since) ? all : all.filter((m) => at(m) >= since);
  const picked = Number.isNaN(since) ? window.slice(-limit) : window.slice(0, limit);
  const hasMore = window.length > limit;
  const ids = new Set(picked.map((m) => String(m.id)));
  const missing = new Set<string>();
  for (const m of picked) {
    for (const ref of [m.reply_to_message_id, m.thread_root_message_id]) {
      if (typeof ref === 'string' && !ids.has(ref)) missing.add(ref);
    }
  }
  const quoted = (tables.chat_messages ?? []).filter((m) => missing.has(String(m.id)));
  const oldest = picked[0] !== undefined ? at(picked[0]) : null;
  const counts = new Map<string, { n: number; last: string }>();
  if (oldest !== null) {
    for (const m of all) {
      const root = m.thread_root_message_id;
      if (typeof root !== 'string' || !ids.has(root) || !live(m) || at(m) < oldest) continue;
      const prev = counts.get(root);
      const created = String(m.created_at);
      counts.set(root, {
        n: (prev?.n ?? 0) + 1,
        last: prev === undefined || created > prev.last ? created : prev.last,
      });
    }
  }
  const cursors = (tables.chat_read_cursors ?? []).filter((c) => c.channel_id === channelId);
  const cursorIds = new Set(cursors.map((c) => String(c.last_read_message_id)));
  const cursorMessages = (tables.chat_messages ?? [])
    .filter((m) => cursorIds.has(String(m.id)))
    .map((m) => ({ id: m.id, created_at: m.created_at }));
  const reviewPosts = (tables.posts ?? [])
    .filter((p) => p.workspace_id === workspaceId && p.stage === 'review' && live(p))
    .sort((a, b) => String(a.stage_entered_at).localeCompare(String(b.stage_entered_at)));
  const firstImage = (postId: unknown): unknown => {
    const link = (tables.asset_attachments ?? [])
      .filter((a) => a.entity_type === 'post' && a.entity_id === postId && live(a))
      .sort(
        (a, b) =>
          Number(a.position ?? 0) - Number(b.position ?? 0) ||
          String(a.attached_at ?? '').localeCompare(String(b.attached_at ?? '')),
      )
      .find((a) => {
        const embedded = a.asset_versions as Row | null | undefined;
        const version =
          embedded !== null && typeof embedded === 'object'
            ? embedded
            : (tables.asset_versions ?? []).find((v) => v.id === a.asset_version_id);
        return String(version?.mime_type ?? '').startsWith('image/');
      });
    return link?.asset_version_id ?? null;
  };
  const to = utcDay(now + 14 * 3_600_000);
  const from = utcDay(now - 12 * 3_600_000);
  const plans = (tables.plans ?? [])
    .filter(
      (p) =>
        p.workspace_id === workspaceId &&
        p.audience === 'client' &&
        live(p) &&
        String(p.starts_on) <= to &&
        String(p.ends_on) >= from,
    )
    .sort(
      (a, b) =>
        String(a.ends_on).localeCompare(String(b.ends_on)) ||
        String(a.starts_on).localeCompare(String(b.starts_on)) ||
        String(a.id).localeCompare(String(b.id)),
    )
    .slice(0, 100);
  const briefs = (tables.briefs ?? [])
    .filter((b) => b.workspace_id === workspaceId && b.status === 'open' && live(b))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  return {
    server_now: new Date(now).toISOString(),
    messages: picked,
    has_more: hasMore,
    quoted,
    reactions: (tables.chat_reactions ?? [])
      .filter((r) => ids.has(String(r.message_id)))
      .map((r) => ({ message_id: r.message_id, emoji: r.emoji, user_id: r.user_id })),
    read_cursors: cursors.map((c) => ({
      user_id: c.user_id,
      last_read_message_id: c.last_read_message_id,
      last_read_at: c.last_read_at,
      read_at: c.read_at ?? null,
    })),
    cursor_messages: cursorMessages,
    reply_counts: [...counts].map(([root, c]) => ({
      root_id: root,
      reply_count: c.n,
      last_reply_at: c.last,
    })),
    marks: (tables.chat_message_marks ?? []).filter((k) => k.channel_id === channelId),
    scheduled: (tables.chat_scheduled_messages ?? [])
      .filter((s) => s.channel_id === channelId && s.status === 'scheduled')
      .sort((a, b) => String(a.send_at).localeCompare(String(b.send_at))),
    open_posts: reviewPosts.slice(0, 100).map((p) => ({
      id: p.id,
      number: p.number,
      title: p.title,
      format: p.format,
      target_date: p.target_date ?? null,
      stage_entered_at: p.stage_entered_at,
      thumbnail_asset_version_id: firstImage(p.id),
    })),
    open_post_count: reviewPosts.length,
    shared_plan_ids: plans.map((p) => p.id),
    open_briefs: briefs.slice(0, 100).map((b) => ({
      id: b.id,
      number: b.number ?? null,
      title: b.title,
      created_at: b.created_at,
    })),
    open_brief_count: briefs.length,
  };
}
