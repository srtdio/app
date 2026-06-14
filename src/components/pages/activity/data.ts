// Activity read path: one RLS-scoped PostgREST select over inbox_entries, then a
// best-effort, batched enrichment pass (no N+1) that resolves actor display
// names and entity titles. Reads stay direct selects under RLS (no read RPC).
// Never throws: every failure degrades to a Result or to null fields.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from '@srtdio/schemas';
import type { Result } from '@srtdio/rpc';
import type { ActivityItem } from './types';

export const ACTIVITY_PAGE_SIZE = 50;

type Client = SupabaseClient<Database>;

interface ListActivityInput {
  workspaceId: string;
  before?: string;
  limit?: number;
}

interface EntryRow {
  id: string;
  event_type: string;
  entity_type: string | null;
  entity_id: string | null;
  scope: string;
  tier: string;
  payload: Json;
  read_at: string | null;
  snoozed_until: string | null;
  created_at: string;
}

// Events whose actor is the author of payload.comment_id (resolved comments -> users).
const COMMENT_EVENTS = new Set(['comment', 'mention', 'decision_marked']);

function asObject(value: Json): Record<string, Json> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, Json>)
    : {};
}

function asString(value: Json | undefined): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asEntityType(value: string | null): ActivityItem['entityType'] {
  return value === 'post' || value === 'brief' || value === 'workspace' ? value : null;
}

/** comment id -> author user id; empty (degrade to null) on any sub-query error. */
async function commentAuthors(client: Client, ids: string[]): Promise<Map<string, string | null>> {
  const map = new Map<string, string | null>();
  if (ids.length === 0) return map;
  const { data, error } = await client.from('comments').select('id, author_user_id').in('id', ids);
  if (error || data === null) return map;
  for (const row of data as { id: string; author_user_id: string | null }[]) {
    map.set(row.id, row.author_user_id);
  }
  return map;
}

/** id -> title for a titled table (posts/briefs); empty on error. */
async function titlesFrom(
  client: Client,
  table: 'posts' | 'briefs',
  ids: string[],
): Promise<Map<string, string | null>> {
  const map = new Map<string, string | null>();
  if (ids.length === 0) return map;
  const { data, error } = await client.from(table).select('id, title').in('id', ids);
  if (error || data === null) return map;
  for (const row of data as { id: string; title: string | null }[]) {
    map.set(row.id, row.title);
  }
  return map;
}

/** user id -> display name; empty on error. */
async function displayNames(client: Client, ids: string[]): Promise<Map<string, string | null>> {
  const map = new Map<string, string | null>();
  if (ids.length === 0) return map;
  const { data, error } = await client.from('users').select('id, display_name').in('id', ids);
  if (error || data === null) return map;
  for (const row of data as { id: string; display_name: string | null }[]) {
    map.set(row.id, row.display_name);
  }
  return map;
}

function distinct(values: (string | null)[]): string[] {
  return [...new Set(values.filter((v): v is string => v !== null))];
}

export async function listActivity(
  client: Client,
  input: ListActivityInput,
): Promise<Result<ActivityItem[]>> {
  let query = client
    .from('inbox_entries')
    .select(
      'id, event_type, entity_type, entity_id, scope, tier, payload, read_at, snoozed_until, created_at',
    )
    .eq('workspace_id', input.workspaceId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(Math.min(input.limit ?? ACTIVITY_PAGE_SIZE, ACTIVITY_PAGE_SIZE));
  if (input.before !== undefined) query = query.lt('created_at', input.before);

  const { data, error } = await query;
  if (error) return { ok: false, error: { code: 'unknown', message: error.message } };
  const rows = (data ?? []) as EntryRow[];

  // Collect the id sets for the batched enrichment (no per-row queries).
  const commentIds: string[] = [];
  const postIds: string[] = [];
  const briefIds: string[] = [];
  for (const row of rows) {
    const payload = asObject(row.payload);
    if (COMMENT_EVENTS.has(row.event_type)) {
      const commentId = asString(payload.comment_id);
      if (commentId !== null) commentIds.push(commentId);
    }
    if (row.entity_type === 'post' && row.entity_id !== null) postIds.push(row.entity_id);
    if (row.entity_type === 'brief' && row.entity_id !== null) briefIds.push(row.entity_id);
  }

  // Wave 1: comments + post/brief titles in parallel (only for non-empty sets).
  const [comments, posts, briefs] = await Promise.all([
    commentAuthors(client, distinct(commentIds)),
    titlesFrom(client, 'posts', distinct(postIds)),
    titlesFrom(client, 'briefs', distinct(briefIds)),
  ]);

  // Wave 2: every actor id we now need a display name for.
  const userIds = distinct([
    ...comments.values(),
    ...rows.flatMap((row) => {
      const payload = asObject(row.payload);
      return [asString(payload.created_by), asString(payload.invited_by)];
    }),
  ]);
  const users = await displayNames(client, userIds);

  const items: ActivityItem[] = rows.map((row) => {
    const payload = asObject(row.payload);
    const entityType = asEntityType(row.entity_type);

    let actorName: string | null = null;
    if (COMMENT_EVENTS.has(row.event_type)) {
      const commentId = asString(payload.comment_id);
      const author = commentId !== null ? (comments.get(commentId) ?? null) : null;
      actorName = author !== null ? (users.get(author) ?? null) : null;
    } else if (row.event_type === 'invite') {
      const inviter = asString(payload.invited_by);
      actorName = inviter !== null ? (users.get(inviter) ?? null) : null;
    } else if (row.event_type === 'brief_created' || row.event_type === 'brief_closed') {
      const creator = asString(payload.created_by);
      actorName = creator !== null ? (users.get(creator) ?? null) : null;
    }

    let entityTitle: string | null = null;
    if (entityType === 'post' && row.entity_id !== null) {
      entityTitle = posts.get(row.entity_id) ?? null;
    } else if (entityType === 'brief' && row.entity_id !== null) {
      entityTitle = briefs.get(row.entity_id) ?? asString(payload.title);
    }

    return {
      id: row.id,
      createdAt: row.created_at,
      eventType: row.event_type,
      tier: row.tier,
      scope: row.scope,
      readAt: row.read_at,
      snoozedUntil: row.snoozed_until,
      actorName,
      entityType,
      entityId: row.entity_id,
      entityTitle,
      fromStage: asString(payload.from_stage) ?? asString(payload.from),
      toStage: asString(payload.to_stage) ?? asString(payload.to),
    };
  });

  return { ok: true, data: items };
}
