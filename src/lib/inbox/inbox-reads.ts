// Data access for the inbox (Notifications) live layer. Every export returns a Result
// and never throws or returns null, so the provider can branch instead of catch.
// These are plain RLS-scoped PostgREST selects (each member sees only their own
// rows), NOT @srtdio/rpc procs, so no p_trace_id is involved. Enrichment is
// batched (no N+1) and degrades each field to null on a failed sub-query, exactly
// like the Activity page's own loader, and names people through the shared name
// registry (people-names.ts): full name, or "Former member".

import type { Client, Result } from '@srtdio/rpc';
import { MENTION_EVENT_TYPE, mapEntry } from '@/components/pages/activity/data';
import { READ_TIMEOUT_MS, readMentionProfiles } from '@/lib/chat-reads';
import { mentionIds } from '@/lib/chat/mentions';
import {
  actionKey,
  eventVerb,
  pickNewest,
  type EnrichedNew,
  type InboxRow,
  type ToastUpdate,
} from '@/lib/inbox/inbox-live';
import { BELL_CHAT_ENTITY, BELL_MENTION_EVENT, withoutBellEntries } from '@/lib/inbox/bell-types';
import { personAvatar, personMentionLabel, personName, resolvePeople } from '@/lib/people-names';

const SELECT_COLS =
  'id, workspace_id, user_id, actor_user_id, event_type, entity_type, entity_id, scope, tier, created_at, read_at, snoozed_until, payload';

function fail<T>(message: string): Result<T> {
  return { ok: false, error: { code: 'unknown', message } };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

/**
 * HEAD count of the caller's actionable unread: unread, not soft-deleted, and not
 * currently snoozed (no snooze, or a snooze that has already elapsed). Every row
 * counts, the chat, plan and task alerts included: Notifications shows them all.
 * One round trip, no rows transferred.
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
 * narrowed to event_type='mention': post, brief and chat mentions alike. Drives
 * the Mentions chip count. One round trip, no rows transferred.
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
 * The created_at of the caller's newest inbox row in a workspace (deleted rows
 * included), or null when there is none. Seeds the live layer's "seen up to"
 * mark from the server's clock, never the device's. One row, one round trip.
 */
export async function fetchNewestInboxAt(
  client: Client,
  params: { workspaceId: string; userId: string },
): Promise<Result<string | null>> {
  const res = await client
    .from('inbox_entries')
    .select('created_at')
    .eq('workspace_id', params.workspaceId)
    .eq('user_id', params.userId)
    .order('created_at', { ascending: false })
    .limit(1);
  if (res.error) return fail(`fetchNewestInboxAt: ${res.error.message}`);
  const first = (res.data ?? [])[0];
  return { ok: true, data: first !== undefined ? first.created_at : null };
}

/** How many new activity rows one poll reads to word the toast (the count is exact regardless). */
export const SINCE_ACTIVITY_LIMIT = 50;

/** How many new chat mention rows one poll reads for their toast. */
export const SINCE_MENTION_LIMIT = 10;

/** One poll's new rows: the activity toast's and the chat mentions, plus the activity count. */
export interface InboxSince {
  /** Every row read, newest first (activity rows and chat mentions). */
  rows: InboxRow[];
  /** The exact number of new activity rows, counted after the bell rows are left out. */
  activityCount: number;
}

/**
 * The caller's inbox rows created strictly after `sinceIso`. The rows the bell
 * used to own (bell-types.ts) are filtered out BEFORE the activity cap and
 * count, so the count is exact however many arrive (the cap only bounds the
 * rows read for wording): one activity read with an exact count, and one chat
 * mention read for the mention toast, in parallel. Soft-deleted rows are
 * excluded.
 */
export async function fetchInboxSince(
  client: Client,
  params: { workspaceId: string; userId: string; sinceIso: string; limit?: number },
): Promise<Result<InboxSince>> {
  const base = () =>
    client
      .from('inbox_entries')
      .select(SELECT_COLS, { count: 'exact' })
      .eq('workspace_id', params.workspaceId)
      .eq('user_id', params.userId)
      .is('deleted_at', null)
      .gt('created_at', params.sinceIso);
  const [activityRes, mentionRes] = await Promise.all([
    withoutBellEntries(base())
      .order('created_at', { ascending: false })
      .limit(params.limit ?? SINCE_ACTIVITY_LIMIT),
    base()
      .eq('event_type', BELL_MENTION_EVENT)
      .eq('entity_type', BELL_CHAT_ENTITY)
      .order('created_at', { ascending: false })
      .limit(SINCE_MENTION_LIMIT),
  ]);
  if (activityRes.error) return fail(`fetchInboxSince: ${activityRes.error.message}`);
  if (mentionRes.error) return fail(`fetchInboxSince: ${mentionRes.error.message}`);
  const activity = (activityRes.data ?? []).map((row) => row as InboxRow);
  const mentions = (mentionRes.data ?? []).map((row) => row as InboxRow);
  return {
    ok: true,
    data: {
      rows: [...activity, ...mentions].sort(
        (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at),
      ),
      activityCount: Math.max(activityRes.count ?? activity.length, activity.length),
    },
  };
}

/**
 * Reduce a batch of new rows to a count plus its enriched lead (the newest row)
 * and every row's grouping key (actor, post, action). Batched only: one comments
 * read, one posts read, one briefs read and one shared name read (users +
 * workspace_members, one .in() each, through the name registry) regardless of
 * row count. The name read is capped at `nameTimeoutMs`. Each sub-query is
 * best-effort, so a failure leaves its field null rather than failing the batch.
 * `total` is the exact new-row count when the rows are a capped page. Never throws.
 */
export async function enrichNewRows(
  client: Client,
  newRows: readonly InboxRow[],
  nameTimeoutMs: number = READ_TIMEOUT_MS,
  total: number = newRows.length,
): Promise<EnrichedNew> {
  const count = Math.max(total, newRows.length);
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

  // Each row's actor: the comment's author for comment rows, else the row's own.
  const actorOf = (item: ReturnType<typeof mapEntry>): string | null =>
    (item.commentId !== null ? (commentAuthors.get(item.commentId) ?? null) : null) ?? item.actorId;

  const leadItem = mapEntry(newest);
  const body =
    leadItem.eventType === 'comment' && leadItem.commentId !== null
      ? (commentBodies.get(leadItem.commentId) ?? null)
      : null;
  const mentioned = body !== null ? mentionIds(body) : [];

  const workspaceId = newest.workspace_id;
  const profileIds = unique([
    ...items.flatMap((i) => {
      const id = actorOf(i);
      return id !== null ? [id] : [];
    }),
    ...mentioned,
  ]);
  const namesRead = await resolvePeople(client, workspaceId, profileIds, (userIds) =>
    readMentionProfiles(client, { workspaceId, userIds, timeoutMs: nameTimeoutMs }),
  );

  const authorId = actorOf(leadItem);
  const actorName = authorId !== null ? (personName(workspaceId, authorId) ?? null) : null;
  const actorAvatarUrl = authorId !== null ? personAvatar(workspaceId, authorId) : null;
  let mentionNames: Map<string, string> | null = null;
  if (namesRead) {
    mentionNames = new Map<string, string>();
    // Each mentioned id's full label: "@username", or "Former member".
    for (const id of mentioned) {
      const label = personMentionLabel(workspaceId, id);
      if (label !== null) mentionNames.set(id, label);
    }
  }
  const titleOf = (item: ReturnType<typeof mapEntry>): string | null =>
    item.entityType === 'post' && item.entityId !== null
      ? (postTitles.get(item.entityId) ?? null)
      : item.entityType === 'brief' && item.entityId !== null
        ? (briefTitles.get(item.entityId) ?? null)
        : null;
  const title =
    titleOf(leadItem) ?? (leadItem.eventType === 'post_deleted' ? leadItem.title : null);

  const byNewest = [...items].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const updates: ToastUpdate[] = byNewest.map((i) => ({
    actorId: actorOf(i),
    entityKey:
      i.entityType !== null && i.entityId !== null ? `${i.entityType}:${i.entityId}` : null,
    action: actionKey(i),
  }));

  return {
    count,
    updates,
    lead: {
      eventType: leadItem.eventType,
      actorName,
      actorAvatarUrl,
      body,
      title,
      mentionNames,
      toStage: leadItem.toStage,
      reviewWithdrawn: leadItem.reviewWithdrawn ?? false,
      reviewPrevious: leadItem.reviewPrevious ?? null,
      verb: eventVerb(leadItem),
    },
  };
}
