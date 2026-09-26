/// <reference types="@cloudflare/workers-types" />
// Cloudflare Worker: Agora-sync (A2b). Mirrors our group/channel state into
// Agora Chat, following the inbox-writer precedent: a bare service-role
// supabase-js client (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY), stateless,
// idempotent, uuid_v7 trace ids on every log line.
//
// Two sources of truth feed it, both driven by the every-minute cron:
//   * public.chat_channels rows with last_synced_at null - create the Agora
//     group (group channels) and stamp last_synced_at via chat_channel_mark_synced;
//     DM channels have no Agora object, so they are just stamped with a null
//     group id. (reconcile)
//   * public.chat_sync_events, the outbox fed by the group_members INSERT/DELETE
//     and groups.name UPDATE triggers: member_add -> add the user to the synced
//     Agora group, member_remove -> remove them, group_rename -> rename the
//     group. (drainSyncEvents)
//
// Idempotency: registering an existing user, adding an existing member,
// removing an absent one, and re-handling an already-synced group channel are
// all safe no-ops (see chat-agora-rest), so every outbox row can be retried
// without side effects. Every Agora user a group operation references is
// registered first, so a member who never minted a chat token cannot fail the
// create or add. An outbox event whose channel has no agora_group_id yet is
// left untouched for the next run. A failed Agora call bumps the row's
// attempts + last_error; after SYNC_EVENT_MAX_ATTEMPTS the row stays
// unprocessed and /health reports it as stuck.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@srtdio/schemas';
import { v7 as uuidv7 } from 'uuid';
import { logger } from '@/server/logger';
import { toAgoraUsername } from './agora-identity';
import {
  AgoraRestError,
  createAgoraGroupApi,
  serializeError,
  type AgoraGroupApi,
} from './chat-agora-rest';

interface ChatAgoraSyncEnv {
  SUPABASE_URL: string;
  /** Service role: bare client, no minted member JWT. Reads + mark-synced rpc. */
  SUPABASE_SERVICE_ROLE_KEY: string;
  AGORA_APP_ID: string;
  AGORA_APP_CERTIFICATE: string;
  AGORA_CHAT_APP_KEY: string;
  /** Base host + org + app for the Agora Chat REST API, no trailing slash. */
  AGORA_CHAT_REST_URL: string;
}

/** An outbox row is retried until this many attempts; then it is stuck. */
export const SYNC_EVENT_MAX_ATTEMPTS = 10;

/**
 * Outbox rows attempted (processed or failed) per cron run; a larger backlog
 * drains across runs. Deferred rows do not count toward it.
 */
export const SYNC_EVENT_BATCH_SIZE = 100;

/**
 * Pending outbox rows read per cron run. Wider than the batch so rows for an
 * unsynced channel at the head of the queue cannot starve other channels.
 */
export const SYNC_EVENT_READ_LIMIT = 500;

/** Unsynced channel ids listed by /health. */
const HEALTH_UNSYNCED_LIMIT = 200;

/** last_error is a short operator hint, not a full dump. */
const MAX_LAST_ERROR_CHARS = 500;

/** The change shapes the consumer acts on. */
export type SyncEvent =
  | {
      kind: 'channel_insert';
      channelId: string;
      channelType: string;
      groupId: string | null;
      agoraGroupId: string | null;
    }
  | { kind: 'member_add'; agoraGroupId: string; userId: string }
  | { kind: 'member_remove'; agoraGroupId: string; userId: string }
  | { kind: 'group_rename'; agoraGroupId: string; name: string };

/** A postgres_changes payload, narrowed to the fields we read. */
export interface ChangePayload {
  table: string;
  eventType: 'INSERT' | 'UPDATE' | 'DELETE';
  new: Record<string, unknown>;
  old: Record<string, unknown>;
}

/** One pending public.chat_sync_events row, narrowed to what the drain reads. */
export interface SyncEventRow {
  id: string;
  eventType: string;
  channelId: string;
  userId: string | null;
  payload: unknown;
  attempts: number;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Map a raw postgres_changes payload to a SyncEvent, or null to ignore it. Only
 * a chat_channels INSERT forwards; membership and rename changes reach Agora
 * through the chat_sync_events outbox instead (see toSyncEvent).
 */
export function mapChangePayload(payload: ChangePayload): SyncEvent | null {
  const { table, eventType } = payload;
  if (table === 'chat_channels' && eventType === 'INSERT') {
    const channelId = asString(payload.new.channel_id);
    const channelType = asString(payload.new.channel_type);
    if (!channelId || !channelType) return null;
    return {
      kind: 'channel_insert',
      channelId,
      channelType,
      groupId: asString(payload.new.entity_id),
      agoraGroupId: asString(payload.new.agora_group_id),
    };
  }
  return null;
}

/**
 * Map an outbox row to a SyncEvent once its channel's Agora group id is known.
 * Throws on a malformed row (unknown event_type, member event without user_id,
 * rename without payload.name) so the drain records it as a failed attempt and
 * it surfaces as stuck rather than being silently dropped.
 */
export function toSyncEvent(row: SyncEventRow, agoraGroupId: string): SyncEvent {
  switch (row.eventType) {
    case 'member_add':
    case 'member_remove': {
      if (!row.userId) throw new Error(`${row.eventType} event without user_id`);
      return { kind: row.eventType, agoraGroupId, userId: row.userId };
    }
    case 'group_rename': {
      const payload =
        typeof row.payload === 'object' && row.payload !== null
          ? (row.payload as Record<string, unknown>)
          : {};
      const name = asString(payload.name);
      if (name === null) throw new Error('group_rename event without payload.name');
      return { kind: 'group_rename', agoraGroupId, name };
    }
    default:
      throw new Error(`unsupported event_type: ${row.eventType}`);
  }
}

/** The DB reads + writes the consumer needs; injected for tests. */
export interface SyncReader {
  getGroup(groupId: string): Promise<{ name: string; createdBy: string | null } | null>;
  getGroupMemberIds(groupId: string): Promise<string[]>;
  markSynced(channelId: string, agoraGroupId: string | null, traceId: string): Promise<void>;
  /** Channels still awaiting their first Agora sync (last_synced_at is null). */
  listUnsyncedChannels(): Promise<
    Array<{
      channelId: string;
      channelType: string;
      entityId: string | null;
      agoraGroupId: string | null;
    }>
  >;
  /**
   * Pending outbox rows: processed_at null, attempts below the cap, oldest
   * first, capped at SYNC_EVENT_READ_LIMIT.
   */
  listPendingSyncEvents(): Promise<SyncEventRow[]>;
  /** channel_id -> agora_group_id for the given channels, in one query. */
  getChannelAgoraGroupIds(channelIds: string[]): Promise<Map<string, string | null>>;
  markSyncEventProcessed(eventId: string): Promise<void>;
  markSyncEventFailed(eventId: string, attempts: number, lastError: string): Promise<void>;
  /** Unprocessed rows that have exhausted their attempts. */
  countStuckSyncEvents(): Promise<number>;
  /** Unprocessed rows still below the attempt cap. */
  countPendingSyncEvents(): Promise<number>;
  /** Pending rows (as countPendingSyncEvents) for the given channels. */
  countPendingSyncEventsForChannels(channelIds: string[]): Promise<number>;
  /** Group channels with no agora_group_id yet, oldest first. */
  listUnsyncedGroupChannelIds(): Promise<string[]>;
}

export interface SyncDeps {
  reader: SyncReader;
  agora: AgoraGroupApi;
  /** Fresh uuid_v7 trace id. */
  newTraceId(): string;
  log: Pick<typeof logger, 'info' | 'warn' | 'error'>;
}

/** Bare service-role client (no acting member), per the inbox-writer precedent. */
function createServiceClient(env: ChatAgoraSyncEnv): SupabaseClient<Database> {
  return createClient<Database>(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/** The live SyncReader backed by a service-role supabase-js client. */
function createSyncReader(client: SupabaseClient<Database>): SyncReader {
  return {
    async getGroup(groupId) {
      const { data, error } = await client
        .from('groups')
        .select('name, created_by')
        .eq('id', groupId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return data ? { name: data.name, createdBy: data.created_by } : null;
    },
    async getGroupMemberIds(groupId) {
      const { data, error } = await client
        .from('group_members')
        .select('user_id')
        .eq('group_id', groupId);
      if (error) throw new Error(error.message);
      return (data ?? []).map((row) => row.user_id);
    },
    async markSynced(channelId, agoraGroupId, traceId) {
      // p_agora_group_id is nullable in the proc (DM stamps a null group id); the
      // generated arg type widens it to string, so the params are cast.
      const { error } = await client.rpc('chat_channel_mark_synced', {
        p_channel_id: channelId,
        p_agora_group_id: agoraGroupId,
        p_trace_id: traceId,
      } as never);
      if (error) throw new Error(error.message);
    },
    async listUnsyncedChannels() {
      // Cap at 200 rows: bounds the per-run memory/Agora call fan-out and lets a
      // larger backlog drain across successive cron runs rather than in one pass.
      const { data, error } = await client
        .from('chat_channels')
        .select('channel_id, channel_type, entity_id, agora_group_id')
        .is('last_synced_at', null)
        .order('created_at', { ascending: true })
        .limit(200);
      if (error) throw new Error(error.message);
      return (data ?? []).map((row) => ({
        channelId: row.channel_id,
        channelType: row.channel_type,
        entityId: asString(row.entity_id),
        agoraGroupId: asString(row.agora_group_id),
      }));
    },
    async listPendingSyncEvents() {
      const { data, error } = await client
        .from('chat_sync_events')
        .select('id, event_type, channel_id, user_id, payload, attempts')
        .is('processed_at', null)
        .lt('attempts', SYNC_EVENT_MAX_ATTEMPTS)
        .order('created_at', { ascending: true })
        .limit(SYNC_EVENT_READ_LIMIT);
      if (error) throw new Error(error.message);
      return (data ?? []).map((row) => ({
        id: row.id,
        eventType: row.event_type,
        channelId: row.channel_id,
        userId: asString(row.user_id),
        payload: row.payload,
        attempts: row.attempts,
      }));
    },
    async getChannelAgoraGroupIds(channelIds) {
      const byChannel = new Map<string, string | null>();
      if (channelIds.length === 0) return byChannel;
      const { data, error } = await client
        .from('chat_channels')
        .select('channel_id, agora_group_id')
        .in('channel_id', channelIds);
      if (error) throw new Error(error.message);
      for (const row of data ?? []) {
        byChannel.set(row.channel_id, asString(row.agora_group_id));
      }
      return byChannel;
    },
    async markSyncEventProcessed(eventId) {
      const { error } = await client
        .from('chat_sync_events')
        .update({ processed_at: new Date().toISOString(), last_error: null })
        .eq('id', eventId);
      if (error) throw new Error(error.message);
    },
    async markSyncEventFailed(eventId, attempts, lastError) {
      const { error } = await client
        .from('chat_sync_events')
        .update({ attempts, last_error: lastError })
        .eq('id', eventId);
      if (error) throw new Error(error.message);
    },
    async countStuckSyncEvents() {
      const { count, error } = await client
        .from('chat_sync_events')
        .select('id', { count: 'exact', head: true })
        .is('processed_at', null)
        .gte('attempts', SYNC_EVENT_MAX_ATTEMPTS);
      if (error) throw new Error(error.message);
      return count ?? 0;
    },
    async countPendingSyncEvents() {
      const { count, error } = await client
        .from('chat_sync_events')
        .select('id', { count: 'exact', head: true })
        .is('processed_at', null)
        .lt('attempts', SYNC_EVENT_MAX_ATTEMPTS);
      if (error) throw new Error(error.message);
      return count ?? 0;
    },
    async countPendingSyncEventsForChannels(channelIds) {
      if (channelIds.length === 0) return 0;
      const { count, error } = await client
        .from('chat_sync_events')
        .select('id', { count: 'exact', head: true })
        .is('processed_at', null)
        .lt('attempts', SYNC_EVENT_MAX_ATTEMPTS)
        .in('channel_id', channelIds);
      if (error) throw new Error(error.message);
      return count ?? 0;
    },
    async listUnsyncedGroupChannelIds() {
      const { data, error } = await client
        .from('chat_channels')
        .select('channel_id')
        .eq('channel_type', 'group')
        .is('agora_group_id', null)
        .order('created_at', { ascending: true })
        .limit(HEALTH_UNSYNCED_LIMIT);
      if (error) throw new Error(error.message);
      return (data ?? []).map((row) => row.channel_id);
    },
  };
}

/** Build the consumer dependencies from a single service-role client. */
function buildDeps(env: ChatAgoraSyncEnv): SyncDeps {
  const client = createServiceClient(env);
  return {
    reader: createSyncReader(client),
    agora: createAgoraGroupApi({
      appId: env.AGORA_APP_ID,
      appCertificate: env.AGORA_APP_CERTIFICATE,
      restUrl: env.AGORA_CHAT_REST_URL,
    }),
    newTraceId: uuidv7,
    log: logger,
  };
}

async function handleChannelInsert(
  event: Extract<SyncEvent, { kind: 'channel_insert' }>,
  deps: SyncDeps,
  traceId: string,
): Promise<void> {
  if (event.channelType === 'dm') {
    // No Agora object exists for a DM; just stamp last_synced_at.
    await deps.reader.markSynced(event.channelId, null, traceId);
    deps.log.info('chat_agora_sync dm channel stamped', {
      trace_id: traceId,
      channel_id: event.channelId,
    });
    return;
  }
  if (event.channelType !== 'group') {
    return;
  }
  if (!event.groupId) {
    deps.log.error('chat_agora_sync group channel without entity_id', {
      trace_id: traceId,
      channel_id: event.channelId,
    });
    return;
  }
  // Already-synced redelivery: skip the create, re-stamp so the row stays fresh.
  if (event.agoraGroupId) {
    await deps.reader.markSynced(event.channelId, event.agoraGroupId, traceId);
    return;
  }
  const group = await deps.reader.getGroup(event.groupId);
  if (!group) {
    deps.log.error('chat_agora_sync group not found for channel', {
      trace_id: traceId,
      group_id: event.groupId,
    });
    return;
  }
  // created_by is nullable (ex-member, FK ON DELETE SET NULL); an Agora group
  // needs a real owner, so a creator-less group is unsyncable here.
  if (group.createdBy === null) {
    deps.log.error('chat_agora_sync group has no creator to own the agora group', {
      trace_id: traceId,
      group_id: event.groupId,
    });
    return;
  }
  const memberIds = await deps.reader.getGroupMemberIds(event.groupId);
  const ownerUsername = toAgoraUsername(group.createdBy);
  const memberUsernames = memberIds.map(toAgoraUsername);
  // Agora rejects a create that names an unregistered user; the owner or a
  // member who never minted a chat token has no Agora user yet.
  await deps.agora.ensureUsers([ownerUsername, ...memberUsernames], traceId);
  const agoraGroupId = await deps.agora.createGroup(
    { name: group.name, ownerUsername, memberUsernames },
    traceId,
  );
  await deps.reader.markSynced(event.channelId, agoraGroupId, traceId);
  deps.log.info('chat_agora_sync group created', {
    trace_id: traceId,
    channel_id: event.channelId,
    agora_group_id: agoraGroupId,
  });
}

/**
 * Apply one event against Agora / the DB under the given trace id. Throws on
 * failure; callers decide whether to swallow (processEvent) or record the
 * attempt (drainSyncEvents). `registered` holds Agora usernames already
 * ensured this run; a member_add for anyone else registers them first.
 */
async function applyEvent(
  event: SyncEvent,
  deps: SyncDeps,
  traceId: string,
  registered: Set<string> = new Set(),
): Promise<void> {
  switch (event.kind) {
    case 'channel_insert':
      await handleChannelInsert(event, deps, traceId);
      return;
    case 'member_add': {
      const username = toAgoraUsername(event.userId);
      if (!registered.has(username)) {
        await deps.agora.ensureUsers([username], traceId);
        registered.add(username);
      }
      await deps.agora.addMember(event.agoraGroupId, username, traceId);
      return;
    }
    case 'member_remove':
      await deps.agora.removeMember(event.agoraGroupId, toAgoraUsername(event.userId), traceId);
      return;
    case 'group_rename':
      await deps.agora.updateGroupName(event.agoraGroupId, event.name, traceId);
      return;
  }
}

/**
 * Log fields for a failure: an Agora REST fault carries its operation, status
 * and truncated body as separate fields; anything else gets the fallback
 * operation and null status/body. Never includes request headers or tokens.
 */
function failureFields(
  error: unknown,
  fallbackOperation: string,
): { operation: string; status: number | null; body: string | null } {
  if (error instanceof AgoraRestError) {
    return { operation: error.operation, status: error.status, body: error.body };
  }
  return { operation: fallbackOperation, status: null, body: null };
}

/**
 * Handle one event in isolation. Generates a uuid_v7 trace id, dispatches to
 * the per-kind handler, and swallows any failure (logged loudly) so a bad event
 * can never abort a reconciliation batch - the next cron run is the backstop.
 */
export async function processEvent(event: SyncEvent, deps: SyncDeps): Promise<void> {
  const traceId = deps.newTraceId();
  try {
    await applyEvent(event, deps, traceId);
  } catch (error) {
    deps.log.error('chat_agora_sync event failed', {
      trace_id: traceId,
      kind: event.kind,
      channel_id: event.kind === 'channel_insert' ? event.channelId : null,
      ...failureFields(error, event.kind),
      error: serializeError(error).slice(0, MAX_LAST_ERROR_CHARS),
    });
  }
}

/**
 * Cron reconciliation pass: the durable backstop for a Realtime consumer that a
 * stateless Cloudflare Worker cannot host. Reads the channels still awaiting
 * their first sync and replays each through the same processEvent path used for
 * a live INSERT, so the create-group / stamp-synced logic is never duplicated.
 * processEvent mints one uuid_v7 trace id per channel and swallows per-channel
 * failure, so one bad row never aborts the batch.
 */
export async function reconcile(deps: SyncDeps): Promise<void> {
  const rows = await deps.reader.listUnsyncedChannels();
  for (const row of rows) {
    await processEvent(
      {
        kind: 'channel_insert',
        channelId: row.channelId,
        channelType: row.channelType,
        groupId: row.entityId,
        agoraGroupId: row.agoraGroupId,
      },
      deps,
    );
  }
}

/**
 * Cron outbox drain: one uuid_v7 trace id per run. Reads up to
 * SYNC_EVENT_READ_LIMIT pending chat_sync_events rows (oldest first) and the
 * agora_group_id of every distinct channel in them with a single IN query, then
 * applies the rows in created_at order. Rows for a channel that is not synced
 * yet (no agora_group_id) are deferred: left untouched, not counted toward
 * SYNC_EVENT_BATCH_SIZE, and never blocking other channels. Once a row for a
 * channel fails, the channel's later rows are also deferred so a member_remove
 * never overtakes its failed member_add. At most SYNC_EVENT_BATCH_SIZE rows are
 * attempted per run. Every member_add user is registered with Agora in one bulk
 * call first. Success stamps processed_at; failure bumps attempts + last_error,
 * and a failure to record that never aborts the batch. Rows at the attempt cap
 * are excluded by the read and reported by /health.
 */
export async function drainSyncEvents(deps: SyncDeps): Promise<void> {
  const traceId = deps.newTraceId();
  const rows = await deps.reader.listPendingSyncEvents();
  if (rows.length === 0) return;

  const channelIds = [...new Set(rows.map((row) => row.channelId))];
  const agoraGroupIds = await deps.reader.getChannelAgoraGroupIds(channelIds);

  // Register every member_add user on a synced channel in one bulk call. On
  // failure each row registers its own user and records its own failure.
  const registered = new Set<string>();
  const addUsernames = [
    ...new Set(
      rows.flatMap((row) =>
        row.eventType === 'member_add' &&
        row.userId !== null &&
        typeof agoraGroupIds.get(row.channelId) === 'string'
          ? [toAgoraUsername(row.userId)]
          : [],
      ),
    ),
  ];
  if (addUsernames.length > 0) {
    try {
      await deps.agora.ensureUsers(addUsernames, traceId);
      for (const username of addUsernames) registered.add(username);
    } catch (error) {
      deps.log.error('chat_agora_sync outbox bulk user register failed', {
        trace_id: traceId,
        channel_id: null,
        ...failureFields(error, 'register_users'),
        users: addUsernames.length,
        error: serializeError(error).slice(0, MAX_LAST_ERROR_CHARS),
      });
    }
  }

  // Channels whose remaining rows this run must leave untouched.
  const halted = new Set<string>();
  let processed = 0;
  let failed = 0;
  let deferred = 0;

  for (const row of rows) {
    if (processed + failed >= SYNC_EVENT_BATCH_SIZE) break;
    if (halted.has(row.channelId)) {
      deferred += 1;
      continue;
    }
    const agoraGroupId = agoraGroupIds.get(row.channelId);
    if (agoraGroupId === null) {
      // Channel exists but reconcile has not created its Agora group yet.
      halted.add(row.channelId);
      deferred += 1;
      deps.log.info('chat_agora_sync outbox event deferred (channel not synced)', {
        trace_id: traceId,
        event_id: row.id,
        channel_id: row.channelId,
      });
      continue;
    }
    try {
      if (agoraGroupId === undefined) {
        throw new Error('channel not found');
      }
      await applyEvent(toSyncEvent(row, agoraGroupId), deps, traceId, registered);
      await deps.reader.markSyncEventProcessed(row.id);
      processed += 1;
      deps.log.info('chat_agora_sync outbox event processed', {
        trace_id: traceId,
        event_id: row.id,
        channel_id: row.channelId,
        event_type: row.eventType,
      });
    } catch (error) {
      halted.add(row.channelId);
      failed += 1;
      const attempts = row.attempts + 1;
      const lastError = serializeError(error).slice(0, MAX_LAST_ERROR_CHARS);
      deps.log.error('chat_agora_sync outbox event failed', {
        trace_id: traceId,
        event_id: row.id,
        channel_id: row.channelId,
        event_type: row.eventType,
        ...failureFields(error, row.eventType),
        attempts,
        stuck: attempts >= SYNC_EVENT_MAX_ATTEMPTS,
        error: lastError,
      });
      try {
        await deps.reader.markSyncEventFailed(row.id, attempts, lastError);
      } catch (markError) {
        deps.log.error('chat_agora_sync outbox mark failed errored', {
          trace_id: traceId,
          event_id: row.id,
          channel_id: row.channelId,
          error: serializeError(markError).slice(0, MAX_LAST_ERROR_CHARS),
        });
      }
    }
  }

  deps.log.info('chat_agora_sync outbox drained', {
    trace_id: traceId,
    read: rows.length,
    processed,
    failed,
    deferred,
  });
}

/** The full scheduled pass: channel reconcile, then the outbox drain. */
export async function runScheduled(deps: SyncDeps): Promise<void> {
  try {
    await reconcile(deps);
  } catch (error) {
    deps.log.error('chat_agora_sync reconcile failed', {
      trace_id: deps.newTraceId(),
      error: serializeError(error),
    });
  }
  try {
    await drainSyncEvents(deps);
  } catch (error) {
    deps.log.error('chat_agora_sync outbox drain failed', {
      trace_id: deps.newTraceId(),
      error: serializeError(error),
    });
  }
}

function jsonResponse(body: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * /health: liveness plus the outbox state: pending rows (below the attempt
 * cap), deferred rows (pending on a group channel with no agora_group_id),
 * stuck rows (attempts >= SYNC_EVENT_MAX_ATTEMPTS, an operator has to look at
 * last_error), and the unsynced group channel ids (ids only). 503 when any of
 * it cannot be read.
 */
export async function healthResponse(deps: SyncDeps): Promise<Response> {
  const traceId = deps.newTraceId();
  try {
    const [pending, stuck, unsyncedChannelIds] = await Promise.all([
      deps.reader.countPendingSyncEvents(),
      deps.reader.countStuckSyncEvents(),
      deps.reader.listUnsyncedGroupChannelIds(),
    ]);
    const deferred = await deps.reader.countPendingSyncEventsForChannels(unsyncedChannelIds);
    return jsonResponse(
      {
        ok: true,
        service: 'chat-agora-sync',
        pending_sync_events: pending,
        deferred_sync_events: deferred,
        stuck_sync_events: stuck,
        unsynced_channel_ids: unsyncedChannelIds,
      },
      200,
    );
  } catch (error) {
    deps.log.error('chat_agora_sync health check failed', {
      trace_id: traceId,
      error: serializeError(error),
    });
    return jsonResponse({ ok: false, service: 'chat-agora-sync', error: 'db unavailable' }, 503);
  }
}

export default {
  async fetch(request: Request, env: ChatAgoraSyncEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return healthResponse(buildDeps(env));
    }
    return new Response('chat-agora-sync', { status: 200 });
  },

  // Cron entrypoint (see workers/chat-agora-sync/wrangler.toml [triggers]). A
  // Worker cannot hold a Realtime subscription, so the every-minute schedule
  // drives reconcile() (create the Agora group for any not-yet-synced group
  // channel, stamp DM channels) and then drainSyncEvents() (push the
  // chat_sync_events outbox to Agora). waitUntil keeps the run alive past return.
  scheduled(_controller: ScheduledController, env: ChatAgoraSyncEnv, ctx: ExecutionContext): void {
    ctx.waitUntil(runScheduled(buildDeps(env)));
  },
};
