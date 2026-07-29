// Data access for the inbox (Activity) live layer. Every export returns a Result
// and never throws or returns null, so the provider can branch instead of catch.
// These are plain RLS-scoped PostgREST selects (each member sees only their own
// rows), NOT @srtdio/rpc procs, so no p_trace_id is involved. Enrichment is
// batched (no N+1) and degrades each field to null on a failed sub-query, exactly
// like the Activity page's own loader, and reuses readProfiles for author display.

import type { Client, Result } from '@srtdio/rpc';
import { MENTION_EVENT_TYPE, mapEntry } from '@/components/pages/activity/data';
import { readProfiles } from '@/lib/chat-reads';
import { pickNewest, type EnrichedNew, type InboxRow } from '@/lib/inbox/inbox-live';

const SELECT_COLS =
  'id, workspace_id, user_id, event_type, entity_type, entity_id, scope, tier, created_at, read_at, snoozed_until, payload';

function fail<T>(message: string): Result<T> {
  return { ok: false, error: { code: 'unknown', message } };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

/**
 * HEAD count of the caller's actionable unread: unread, not soft-deleted, and not
 * currently snoozed (no snooze, or a snooze that has already elapsed). One round
 * trip, no rows transferred.
 */
export async function fetchInboxUnreadCount(
  client: Client,
  params: { workspaceId: string; userId: string; nowIso: string },
): Promise<Result<number>> {
  const res = await client
    .from('inbox_entries')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', params.workspaceId)
    .eq('user_id', params.userId)
    .is('read_at', null)
    .is('deleted_at', null)
    .or(`snoozed_until.is.null,snoozed_until.lte.${params.nowIso}`);
  if (res.error) return fail(`fetchInboxUnreadCount: ${res.error.message}`);
  return { ok: true, data: res.count ?? 0 };
}

/**
 * HEAD count of the caller's actionable unread mentions: identical to
 * fetchInboxUnreadCount (unread, not soft-deleted, not currently snoozed) but
 * narrowed to event_type='mention'. Drives the Mentions chip count. One round
 * trip, no rows transferred.
 */
export async function fetchUnreadMentionCount(
  client: Client,
  params: { workspaceId: string; userId: string; nowIso: string },
): Promise<Result<number>> {
  const res = await client
    .from('inbox_entries')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', params.workspaceId)
    .eq('user_id', params.userId)
    .eq('event_type', MENTION_EVENT_TYPE)
    .is('read_at', null)
    .is('deleted_at', null)
    .or(`snoozed_until.is.null,snoozed_until.lte.${params.nowIso}`);
  if (res.error) return fail(`fetchUnreadMentionCount: ${res.error.message}`);
  return { ok: true, data: res.count ?? 0 };
}

/**
 * The caller's inbox rows created strictly after `sinceIso`, newest first, capped
 * at `limit` (default 10). Soft-deleted rows are excluded. Returns the raw rows so
 * the pure layer can diff them against the high-water mark.
 */
export async function fetchInboxSince(
  client: Client,
  params: { workspaceId: string; userId: string; sinceIso: string; limit?: number },
): Promise<Result<InboxRow[]>> {
  const limit = params.limit ?? 10;
  const res = await client
    .from('inbox_entries')
    .select(SELECT_COLS)
    .eq('workspace_id', params.workspaceId)
    .eq('user_id', params.userId)
    .is('deleted_at', null)
    .gt('created_at', params.sinceIso)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (res.error) return fail(`fetchInboxSince: ${res.error.message}`);
  return { ok: true, data: (res.data ?? []).map((row) => row as InboxRow) };
}

/**
 * Reduce a batch of new rows to a count plus its enriched lead (the newest row).
 * Batched only: one comments read, one posts read, one briefs read and one
 * batched profile read regardless of row count. Each sub-query is best-effort, so
 * a failure leaves its field null rather than failing the batch. Never throws.
 */
export async function enrichNewRows(
  client: Client,
  newRows: readonly InboxRow[],
): Promise<EnrichedNew> {
  const count = newRows.length;
  const newest = pickNewest(newRows);
  if (newest === null) return { count, lead: null };

  const items = newRows.map(mapEntry);
  const commentIds = unique(items.flatMap((i) => (i.commentId !== null ? [i.commentId] : [])));
  const postIds = unique(
    items.flatMap((i) => (i.entityType === 'post' && i.entityId !== null ? [i.entityId] : [])),
  );
  const briefIds = unique(
    items.flatMap((i) => (i.entityType === 'brief' && i.entityId !== null ? [i.entityId] : [])),
  );

  const [commentsRes, postsRes, briefsRes] = await Promise.all([
    commentIds.length > 0
      ? client.from('comments').select('id, author_user_id, body').in('id', commentIds)
      : Promise.resolve(null),
    postIds.length > 0
      ? client.from('posts').select('id, title').in('id', postIds)
      : Promise.resolve(null),
    briefIds.length > 0
      ? client.from('briefs').select('id, title').in('id', briefIds)
      : Promise.resolve(null),
  ]);

  const commentAuthors = new Map<string, string>();
  const commentBodies = new Map<string, string>();
  if (commentsRes !== null && commentsRes.error === null) {
    for (const r of commentsRes.data ?? []) {
      commentAuthors.set(r.id, r.author_user_id);
      if (typeof r.body === 'string') commentBodies.set(r.id, r.body);
    }
  }
  const postTitles = new Map<string, string>();
  if (postsRes !== null && postsRes.error === null) {
    for (const r of postsRes.data ?? []) postTitles.set(r.id, r.title);
  }
  const briefTitles = new Map<string, string>();
  if (briefsRes !== null && briefsRes.error === null) {
    for (const r of briefsRes.data ?? []) briefTitles.set(r.id, r.title);
  }

  const authorIds = unique([...commentAuthors.values()]);
  const names = new Map<string, string>();
  const avatars = new Map<string, string>();
  if (authorIds.length > 0) {
    const profiles = await readProfiles(client, authorIds);
    if (profiles.ok) {
      for (const p of profiles.data) {
        names.set(p.userId, p.displayName);
        if (p.avatarUrl !== null) avatars.set(p.userId, p.avatarUrl);
      }
    }
  }

  const leadItem = mapEntry(newest);
  const authorId =
    leadItem.commentId !== null ? (commentAuthors.get(leadItem.commentId) ?? null) : null;
  const actorName = authorId !== null ? (names.get(authorId) ?? null) : null;
  const actorAvatarUrl = authorId !== null ? (avatars.get(authorId) ?? null) : null;
  const body =
    leadItem.eventType === 'comment' && leadItem.commentId !== null
      ? (commentBodies.get(leadItem.commentId) ?? null)
      : null;
  const title =
    leadItem.entityType === 'post' && leadItem.entityId !== null
      ? (postTitles.get(leadItem.entityId) ?? null)
      : leadItem.entityType === 'brief' && leadItem.entityId !== null
        ? (briefTitles.get(leadItem.entityId) ?? null)
        : null;

  return { count, lead: { eventType: leadItem.eventType, actorName, actorAvatarUrl, body, title } };
}
