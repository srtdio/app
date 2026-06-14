// Activity (Inbox) read + write data layer. The page reads inbox_entries with a
// plain RLS-scoped select (each member sees only their own rows) and maps every
// row into a render-ready ActivityItem. The per-user read-state and snooze
// mutations go through the @srtdio/rpc wrappers (each carries an explicit
// p_trace_id). Everything here that does not touch the network is a pure,
// unit-tested function so the page stays thin.

import type { Client, Result } from '@srtdio/rpc';
import { inboxMarkAllRead, inboxMarkRead, inboxSnooze } from '@srtdio/rpc';
import type { Database, Json } from '@srtdio/schemas';
import { readProfiles } from '@/lib/chat-reads';

type InboxEntryRow = Database['public']['Tables']['inbox_entries']['Row'];

/**
 * Read one string field from an `unknown` jsonb payload. Returns null for a
 * missing key or a non-string value, so a malformed payload never crashes the
 * row and never prints "undefined"/"null". Used for EVERY payload field; the
 * payload is deliberately typed `unknown` and is never cast to `any`.
 */
export function payloadStr(p: unknown, key: string): string | null {
  if (typeof p !== 'object' || p === null) return null;
  const val = (p as Record<string, unknown>)[key];
  return typeof val === 'string' ? val : null;
}

/** The state chips: which slice of the inbox is shown. */
export type ActivityState = 'all' | 'unread' | 'snoozed';

/** The scope chips. 'everything' is the no-filter sentinel. */
export type ActivityScope = 'everything' | 'posts' | 'briefs' | 'people' | 'groups' | 'clients';

/** The sort direction, threaded straight from useSort('activity', ...). */
export type ActivityDirection = 'newest' | 'oldest';

/** Snooze kinds accepted by inbox_snooze (p_kind). 'clear' un-snoozes. */
export type SnoozeKind = '1h' | '4h' | 'tomorrow_9' | 'next_week' | 'clear';

export interface SnoozeOption {
  kind: SnoozeKind;
  label: string;
}

/** Menu options offered in the kebab. 'clear' is shown separately by the menu. */
export const SNOOZE_OPTIONS: readonly SnoozeOption[] = [
  { kind: '1h', label: 'For 1 hour' },
  { kind: '4h', label: 'For 4 hours' },
  { kind: 'tomorrow_9', label: 'Until tomorrow' },
  { kind: 'next_week', label: 'Until next week' },
];

/** One inbox entry, mapped to the fields the row renders. */
export interface ActivityItem {
  id: string;
  workspaceId: string;
  eventType: string;
  entityType: string | null;
  entityId: string | null;
  scope: string;
  tier: string;
  createdAt: string;
  readAt: string | null;
  snoozedUntil: string | null;
  // Derived from the payload via payloadStr (never cast to any).
  commentId: string | null;
  toStage: string | null;
  fromStage: string | null;
  /** The entity title, when the writer recorded one (briefs). */
  title: string | null;
  /** The acting user id (created_by / invited_by), when present. */
  actorId: string | null;
  /** Resolved display name for actorId, filled in after a profile read. */
  actorName: string | null;
}

/** Map a raw inbox_entries row into an ActivityItem. Pure; actorName stays null. */
export function mapEntry(row: InboxEntryRow): ActivityItem {
  const payload: unknown = row.payload as Json;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    eventType: row.event_type,
    entityType: row.entity_type,
    entityId: row.entity_id,
    scope: row.scope,
    tier: row.tier,
    createdAt: row.created_at,
    readAt: row.read_at,
    snoozedUntil: row.snoozed_until,
    commentId: payloadStr(payload, 'comment_id'),
    toStage: payloadStr(payload, 'to_stage') ?? payloadStr(payload, 'to'),
    fromStage: payloadStr(payload, 'from_stage') ?? payloadStr(payload, 'from'),
    title: payloadStr(payload, 'title'),
    actorId: payloadStr(payload, 'created_by') ?? payloadStr(payload, 'invited_by'),
    actorName: null,
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

/** The non-null actor display names in source order, distinct. */
export function bucketActorNames(items: readonly ActivityItem[]): string[] {
  const names: string[] = [];
  for (const item of items) {
    if (item.actorName !== null) names.push(item.actorName);
  }
  return unique(names);
}

/** A post / brief target label that never renders "undefined"/"null". */
function entityTarget(item: ActivityItem): string {
  if (item.title !== null) return item.title;
  if (item.entityType === 'post') return 'a post';
  if (item.entityType === 'brief') return 'a brief';
  return 'Activity';
}

/**
 * The human-readable line for a row. Null-safe: a missing actor name drops the
 * name entirely rather than printing a placeholder, and a missing title falls
 * back to "a post" / "a brief" by entity type.
 */
export function activityLine(item: ActivityItem): string {
  const who = item.actorName;
  const target = entityTarget(item);
  switch (item.eventType) {
    case 'comment':
      return who !== null ? `${who} commented on ${target}` : `New comment on ${target}`;
    case 'mention':
      return who !== null ? `${who} mentioned you in ${target}` : `New mention in ${target}`;
    case 'decision_marked':
      return who !== null
        ? `${who} flagged a decision on ${target}`
        : `Decision flagged on ${target}`;
    case 'stage_change':
      return `Moved to ${item.toStage ?? 'a new stage'}`;
    case 'brief_created':
      return who !== null
        ? `${who} created ${target}`
        : item.title !== null
          ? `New brief: ${item.title}`
          : 'A new brief was created';
    case 'brief_closed':
      return who !== null
        ? `${who} closed ${target}`
        : item.title !== null
          ? `Brief ${item.title} closed`
          : 'A brief was closed';
    case 'asset_uploaded':
      return who !== null ? `${who} uploaded an asset` : 'New asset uploaded';
    case 'asset_version_added':
      return who !== null ? `${who} added an asset version` : 'New asset version';
    case 'invite':
      return who !== null ? `${who} invited a new member` : 'New workspace invite';
    default:
      return target;
  }
}

/** Route to open when a row is clicked, or null when it has no detail surface. */
export function entityHref(item: ActivityItem): string | null {
  if (item.entityId === null) return null;
  if (item.entityType === 'post') return `/posts/${item.entityId}`;
  if (item.entityType === 'brief') return `/briefs/${item.entityId}`;
  return null;
}

/** A row is snoozed when its snoozed_until is in the future. */
export function isSnoozed(item: ActivityItem, nowMs: number): boolean {
  if (item.snoozedUntil === null) return false;
  const until = Date.parse(item.snoozedUntil);
  return !Number.isNaN(until) && until > nowMs;
}

/** Apply the state chip: All hides snoozed; Unread is unread + not snoozed. */
export function filterByState(
  items: readonly ActivityItem[],
  state: ActivityState,
  nowMs: number,
): ActivityItem[] {
  switch (state) {
    case 'snoozed':
      return items.filter((item) => isSnoozed(item, nowMs));
    case 'unread':
      return items.filter((item) => item.readAt === null && !isSnoozed(item, nowMs));
    case 'all':
    default:
      return items.filter((item) => !isSnoozed(item, nowMs));
  }
}

/** Apply the scope chip. 'everything' is the no-filter sentinel. */
export function filterByScope(
  items: readonly ActivityItem[],
  scope: ActivityScope,
): ActivityItem[] {
  if (scope === 'everything') return [...items];
  return items.filter((item) => item.scope === scope);
}

/** Count of currently-unread, non-snoozed rows (drives the chip badge / button). */
export function unreadCount(items: readonly ActivityItem[], nowMs: number): number {
  return items.reduce(
    (n, item) => (item.readAt === null && !isSnoozed(item, nowMs) ? n + 1 : n),
    0,
  );
}

/**
 * A compact relative-time label. No dependency: just elapsed buckets. Future or
 * unparseable timestamps collapse to "just now".
 */
export function relativeTime(iso: string, nowMs: number): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const sec = Math.round((nowMs - then) / 1000);
  if (sec < 45) return 'just now';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day}d`;
  const wk = Math.round(day / 7);
  if (wk < 5) return `${wk}w`;
  const mo = Math.round(day / 30);
  if (mo < 12) return `${mo}mo`;
  return `${Math.round(day / 365)}y`;
}

export interface DigestBucket {
  key: 'today' | 'yesterday' | 'earlier';
  label: string;
  items: ActivityItem[];
}

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Bucket items into Today / Yesterday / Earlier and order both the buckets and
 * the entries by `direction`. 'newest' = Today -> Yesterday -> Earlier with the
 * newest entry first in each; 'oldest' reverses both. Empty buckets are dropped.
 */
export function groupDigest(
  items: readonly ActivityItem[],
  direction: ActivityDirection,
): DigestBucket[] {
  const todayStart = startOfDay(Date.now());
  const yesterdayStart = todayStart - 86_400_000;

  const today: ActivityItem[] = [];
  const yesterday: ActivityItem[] = [];
  const earlier: ActivityItem[] = [];
  for (const item of items) {
    const t = Date.parse(item.createdAt);
    if (!Number.isNaN(t) && t >= todayStart) today.push(item);
    else if (!Number.isNaN(t) && t >= yesterdayStart) yesterday.push(item);
    else earlier.push(item);
  }

  const newestFirst = (a: ActivityItem, b: ActivityItem): number =>
    Date.parse(b.createdAt) - Date.parse(a.createdAt);
  const sortBucket = (bucket: ActivityItem[]): ActivityItem[] => {
    const sorted = [...bucket].sort(newestFirst);
    return direction === 'oldest' ? sorted.reverse() : sorted;
  };

  const buckets: DigestBucket[] = [
    { key: 'today', label: 'Today', items: sortBucket(today) },
    { key: 'yesterday', label: 'Yesterday', items: sortBucket(yesterday) },
    { key: 'earlier', label: 'Earlier', items: sortBucket(earlier) },
  ];
  const ordered = direction === 'oldest' ? buckets.reverse() : buckets;
  return ordered.filter((bucket) => bucket.items.length > 0);
}

// --- network -----------------------------------------------------------------

export type LoadResult = { ok: true; data: ActivityItem[] } | { ok: false; error: string };

/**
 * Read the caller's inbox for a workspace and resolve actor display names. One
 * RLS-scoped select plus one batched profile read (no N+1). Soft-deleted rows
 * are excluded; the inbox itself is a permanent surface (never cleared).
 */
export async function fetchActivityEntries(
  client: Client,
  workspaceId: string,
): Promise<LoadResult> {
  const res = await client
    .from('inbox_entries')
    .select(
      'id, workspace_id, event_type, entity_type, entity_id, scope, tier, created_at, read_at, snoozed_until, payload',
    )
    .eq('workspace_id', workspaceId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(200);
  if (res.error) return { ok: false, error: res.error.message };

  const items = (res.data ?? []).map((row) => mapEntry(row as InboxEntryRow));
  const actorIds = unique(items.flatMap((item) => (item.actorId !== null ? [item.actorId] : [])));
  if (actorIds.length > 0) {
    const profiles = await readProfiles(client, actorIds);
    if (profiles.ok) {
      const names = new Map(profiles.data.map((p) => [p.userId, p.displayName]));
      for (const item of items) {
        if (item.actorId !== null) item.actorName = names.get(item.actorId) ?? null;
      }
    }
  }
  return { ok: true, data: items };
}

/** Clear read_at on one entry (the caller's own, within its month partition). */
export function markEntryRead(
  client: Client,
  item: ActivityItem,
  workspaceId: string,
  traceId: string,
): Promise<Result<undefined>> {
  return inboxMarkRead(client, {
    p_entry_id: item.id,
    p_workspace_id: workspaceId,
    p_created_at: item.createdAt,
    p_trace_id: traceId,
  });
}

/** Mark every unread, non-snoozed entry read (workspace-wide). */
export function markAllEntriesRead(
  client: Client,
  workspaceId: string,
  traceId: string,
): Promise<Result<undefined>> {
  return inboxMarkAllRead(client, { p_workspace_id: workspaceId, p_trace_id: traceId });
}

/** Set or clear snoozed_until on one entry. */
export function snoozeEntry(
  client: Client,
  item: ActivityItem,
  workspaceId: string,
  kind: SnoozeKind,
  traceId: string,
): Promise<Result<undefined>> {
  return inboxSnooze(client, {
    p_entry_id: item.id,
    p_workspace_id: workspaceId,
    p_created_at: item.createdAt,
    p_kind: kind,
    p_trace_id: traceId,
  });
}
