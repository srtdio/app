// Data access for the inbox (Notifications) live layer. Every export returns a Result
// and never throws or returns null, so the provider can branch instead of catch.
// The badge counts are one activity_badge_read rpc (explicit p_trace_id); the
// rest are plain RLS-scoped PostgREST selects (each member sees only their own
// rows), so no p_trace_id is involved there. Enrichment is
// batched (no N+1) and degrades each field to null on a failed sub-query, exactly
// like the Activity page's own loader, and names people through the shared name
// registry (people-names.ts): full name, or "Former member".

import { withTraceHeader, type Client, type Result } from '@srtdio/rpc';
import type { Database } from '@srtdio/schemas';
import { mapEntry } from '@/components/pages/activity/data';
import { READ_TIMEOUT_MS, readMentionProfiles } from '@/lib/chat-reads';
import { mentionIds } from '@/lib/chat/mentions';
import {
  actionKey,
  eventVerb,
  pickNewest,
  POLL_CHANGE_SOURCE,
  type EnrichedNew,
  type InboxRow,
  type ToastUpdate,
} from '@/lib/inbox/inbox-live';
import { BELL_CHAT_ENTITY, BELL_MENTION_EVENT, withoutBellEntries } from '@/lib/inbox/bell-types';
import { personAvatar, personMentionLabel, personName, resolvePeople } from '@/lib/people-names';
import { readBoundedPage, upperFromNow, type TimeBounds } from '@/lib/chat/bounded-window';
import { readInboxOldest } from '@/lib/inbox/inbox-oldest';
import { INBOX_CHANGED_EVENT, SIGNOUT_EVENT } from '@/lib/events';
import { invalidateReads, readKey, sharedRead } from '@/lib/session-read';

const SELECT_COLS =
  'id, workspace_id, user_id, actor_user_id, event_type, entity_type, entity_id, scope, tier, created_at, read_at, snoozed_until, payload';

function fail<T>(message: string): Result<T> {
  return { ok: false, error: { code: 'unknown', message } };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

/** The caller's activity badge in one workspace: actionable unread, and the mentions among them. */
export interface ActivityBadge {
  /** Unread, not soft-deleted, not currently snoozed rows (every kind, chat and plan alerts included). */
  unread: number;
  /** The same set narrowed to mentions (post, brief and chat alike): the Mentions chip count. */
  mentions: number;
}

type Functions = Database['public']['Functions'];

function toCount(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

/**
 * One activity_badge_read rpc: the unread badge and the unread-mention count
 * together, in one round trip. The actor is auth.uid() server side (no user id
 * is sent); the trace id is the explicit p_trace_id. The proc always returns
 * one row; an empty answer reads as zero for both. Never throws.
 */
export async function fetchActivityBadge(
  client: Client,
  params: { workspaceId: string; traceId: string },
): Promise<Result<ActivityBadge>> {
  const args: Functions['activity_badge_read']['Args'] = {
    p_trace_id: params.traceId,
    p_workspace_id: params.workspaceId,
  };
  try {
    const res = await withTraceHeader(client.rpc('activity_badge_read', args), args.p_trace_id);
    if (res.error) return fail(`fetchActivityBadge: ${res.error.message}`);
    return { ok: true, data: mapActivityBadge(res.data) };
  } catch (err: unknown) {
    return fail(`fetchActivityBadge: ${String(err)}`);
  }
}

/** Map the proc's rows (one expected) to the two counts; anything else reads as zero. */
export function mapActivityBadge(data: unknown): ActivityBadge {
  const row: unknown = Array.isArray(data) ? data[0] : data;
  if (typeof row !== 'object' || row === null) return { unread: 0, mentions: 0 };
  const rec = row as { unread?: unknown; mentions?: unknown };
  return { unread: toCount(rec.unread), mentions: toCount(rec.mentions) };
}

// The badge read is shared within this tab session (session-read.ts: in memory
// only, never persisted). Every consumer of one refresh (the shell's count, the
// Activity page's Mentions chip, the bell's prefetch) joins one rpc:
//  - a join (refresh: false) takes the running or fresh read, else starts one;
//  - a refresh (refresh: true) drops the held read and starts a new one, unless
//    a refresh for the same key already started in this same task, which it
//    joins (a write's own reload and the change event it dispatches are one
//    refresh, so they cost one rpc);
//  - an inbox change (INBOX_CHANGED_EVENT) drops the held read, except one a
//    refresh started in this task, and except for the shell poll's own event
//    (the tick read the badge already).
// Signout and workspace-data-changed drop it through session-read itself.

/** The keys read this session (the change event drops exactly these). */
const badgeKeys = new Set<string>();
/** The keys a refresh started in the current task (cleared at its end). */
const refreshedThisTask = new Set<string>();

/** The session read key of the activity badge for one user in one workspace. */
export function activityBadgeKey(userId: string, workspaceId: string): string {
  return readKey(userId, workspaceId, 'activity-badge');
}

function markRefreshed(key: string): void {
  if (refreshedThisTask.size === 0) queueMicrotask(() => refreshedThisTask.clear());
  refreshedThisTask.add(key);
}

/** Drop every held badge read but the ones a refresh started in this task. */
export function invalidateActivityBadge(): void {
  for (const key of [...badgeKeys]) {
    if (refreshedThisTask.has(key)) continue;
    invalidateReads(key);
    badgeKeys.delete(key);
  }
}

/**
 * The activity badge for the signed-in user (userId keys the session cache
 * only; it is never sent) in one workspace, shared as above. A failed read is
 * never kept, so the next caller retries. Never throws.
 */
export function readActivityBadge(
  client: Client,
  params: { userId: string; workspaceId: string; traceId: string; refresh: boolean },
): Promise<Result<ActivityBadge>> {
  const key = activityBadgeKey(params.userId, params.workspaceId);
  if (params.refresh && !refreshedThisTask.has(key)) {
    invalidateReads(key);
    markRefreshed(key);
  }
  badgeKeys.add(key);
  return sharedRead(
    key,
    () => fetchActivityBadge(client, { workspaceId: params.workspaceId, traceId: params.traceId }),
    { isOk: (result) => result.ok },
  );
}

if (typeof window !== 'undefined') {
  window.addEventListener(INBOX_CHANGED_EVENT, (event: Event) => {
    if (event instanceof CustomEvent && event.detail === POLL_CHANGE_SOURCE) return;
    invalidateActivityBadge();
  });
  window.addEventListener(SIGNOUT_EVENT, () => {
    badgeKeys.clear();
    refreshedThisTask.clear();
  });
}

/**
 * The created_at of the caller's newest inbox row in a workspace (deleted rows
 * included), or null when there is none. Seeds the live layer's "seen up to"
 * mark from the server's clock, never the device's. One row; the read is
 * partition-bounded (the last 30 days first, widening back to the oldest entry
 * only when that window is empty), so one round trip for an active inbox.
 */
export async function fetchNewestInboxAt(
  client: Client,
  params: { workspaceId: string; userId: string },
): Promise<Result<string | null>> {
  const res = await readBoundedPage<{ created_at: string }>({
    pageSize: 1,
    upper: upperFromNow(),
    upperInclusive: false,
    openEnded: true,
    oldest: () => readInboxOldest(client, params.workspaceId),
    read: async (bounds: TimeBounds, limit: number) => {
      const base = client
        .from('inbox_entries')
        .select('created_at')
        .eq('workspace_id', params.workspaceId)
        .eq('user_id', params.userId)
        .gte('created_at', bounds.from);
      const capped = bounds.to === null ? base : base.lt('created_at', bounds.to);
      const page = await capped.order('created_at', { ascending: false }).limit(limit);
      if (page.error) return fail(`fetchNewestInboxAt: ${page.error.message}`);
      return { ok: true, data: page.data ?? [] };
    },
  });
  if (!res.ok) return res;
  const first = res.data[0];
  return { ok: true, data: first !== undefined ? first.created_at : null };
}

/** How many new activity rows one poll reads to word the toast (the count is exact regardless). */
const SINCE_ACTIVITY_LIMIT = 50;

/** How many new chat mention rows one poll reads for their toast. */
const SINCE_MENTION_LIMIT = 10;

/** One poll's new rows: the activity toast's and the chat mentions, plus the activity count. */
interface InboxSince {
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
  // Both partition-key bounds: since the mark, up to the server's now plus a
  // minute (bounded below only until the server clock is known).
  const sinceCeiling = upperFromNow();
  const base = () => {
    const since = client
      .from('inbox_entries')
      .select(SELECT_COLS, { count: 'exact' })
      .eq('workspace_id', params.workspaceId)
      .eq('user_id', params.userId)
      .is('deleted_at', null)
      .gt('created_at', params.sinceIso);
    return sinceCeiling !== null ? since.lt('created_at', sinceCeiling) : since;
  };
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
