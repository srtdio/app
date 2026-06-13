// Cloudflare Worker: Agora-sync (A2b). A Supabase Realtime consumer that mirrors
// our group/channel state into Agora Chat, following the inbox-writer precedent:
// a bare service-role supabase-js client (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY),
// stateless, idempotent, one uuid_v7 trace id per handled event.
//
// It subscribes to postgres_changes on:
//   * public.chat_channels INSERT  - create the Agora group (group channels) and
//     stamp last_synced_at via chat_channel_mark_synced; DM channels have no Agora
//     object, so they are just stamped with a null group id.
//   * public.group_members INSERT  - add the user to the synced Agora group.
//   * public.group_members DELETE  - remove the user from the synced Agora group.
//   * public.groups UPDATE         - rename the Agora group when the name changed.
//
// Idempotency: adding an existing member, removing an absent one, and re-handling
// an already-synced group channel are all safe no-ops (see chat-agora-rest). A
// member event for a not-yet-synced group is a deferred no-op - Realtime
// redelivery and the reconciliation cron are the backstop. A failed Agora call is
// logged loudly and swallowed per event so one bad event never tears down the
// subscription.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@srtdio/schemas';
import { v7 as uuidv7 } from 'uuid';
import { logger } from '@/server/logger';
import { toAgoraUsername } from './agora-identity';
import { createAgoraGroupApi, serializeError, type AgoraGroupApi } from './chat-agora-rest';

export interface ChatAgoraSyncEnv {
  SUPABASE_URL: string;
  /** Service role: bare client, no minted member JWT. Reads + mark-synced rpc. */
  SUPABASE_SERVICE_ROLE_KEY: string;
  AGORA_APP_ID: string;
  AGORA_APP_CERTIFICATE: string;
  AGORA_CHAT_APP_KEY: string;
  /** Base host + org + app for the Agora Chat REST API, no trailing slash. */
  AGORA_CHAT_REST_URL: string;
}

/** The four change shapes the consumer acts on. */
export type SyncEvent =
  | {
      kind: 'channel_insert';
      channelId: string;
      channelType: string;
      groupId: string | null;
      agoraGroupId: string | null;
    }
  | { kind: 'member_insert'; groupId: string; userId: string }
  | { kind: 'member_delete'; groupId: string; userId: string }
  | { kind: 'group_rename'; groupId: string; name: string };

/** A postgres_changes payload, narrowed to the fields we read. */
export interface ChangePayload {
  table: string;
  eventType: 'INSERT' | 'UPDATE' | 'DELETE';
  new: Record<string, unknown>;
  old: Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Map a raw postgres_changes payload to a SyncEvent, or null to ignore it. Only
 * the watched (table, eventType) combinations forward; a groups UPDATE forwards
 * only when the name actually changed.
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
  if (table === 'group_members' && (eventType === 'INSERT' || eventType === 'DELETE')) {
    const row = eventType === 'INSERT' ? payload.new : payload.old;
    const groupId = asString(row.group_id);
    const userId = asString(row.user_id);
    if (!groupId || !userId) return null;
    return { kind: eventType === 'INSERT' ? 'member_insert' : 'member_delete', groupId, userId };
  }
  if (table === 'groups' && eventType === 'UPDATE') {
    const groupId = asString(payload.new.id);
    const name = asString(payload.new.name);
    if (!groupId || name === null) return null;
    // Only a name change is actionable; ignore other column updates.
    if (asString(payload.old.name) === name) return null;
    return { kind: 'group_rename', groupId, name };
  }
  return null;
}

/** The DB reads + mark-synced write the consumer needs; injected for tests. */
export interface SyncReader {
  getGroup(groupId: string): Promise<{ name: string; createdBy: string } | null>;
  getGroupMemberIds(groupId: string): Promise<string[]>;
  getChannelByGroupId(
    groupId: string,
  ): Promise<{ channelId: string; agoraGroupId: string | null } | null>;
  markSynced(channelId: string, agoraGroupId: string | null, traceId: string): Promise<void>;
}

export interface SyncDeps {
  reader: SyncReader;
  agora: AgoraGroupApi;
  /** Fresh uuid_v7 trace id per event. */
  newTraceId(): string;
  log: Pick<typeof logger, 'info' | 'warn' | 'error'>;
}

/** Bare service-role client (no acting member), per the inbox-writer precedent. */
export function createServiceClient(env: ChatAgoraSyncEnv): SupabaseClient<Database> {
  return createClient<Database>(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/** The live SyncReader backed by a service-role supabase-js client. */
export function createSyncReader(client: SupabaseClient<Database>): SyncReader {
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
    async getChannelByGroupId(groupId) {
      const { data, error } = await client
        .from('chat_channels')
        .select('channel_id, agora_group_id')
        .eq('entity_id', groupId)
        .eq('channel_type', 'group')
        .maybeSingle();
      if (error) throw new Error(error.message);
      return data ? { channelId: data.channel_id, agoraGroupId: data.agora_group_id } : null;
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
  };
}

/** Build the consumer dependencies from a single service-role client. */
export function buildDeps(env: ChatAgoraSyncEnv): SyncDeps {
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
  const memberIds = await deps.reader.getGroupMemberIds(event.groupId);
  const agoraGroupId = await deps.agora.createGroup(
    {
      name: group.name,
      ownerUsername: toAgoraUsername(group.createdBy),
      memberUsernames: memberIds.map(toAgoraUsername),
    },
    traceId,
  );
  await deps.reader.markSynced(event.channelId, agoraGroupId, traceId);
  deps.log.info('chat_agora_sync group created', {
    trace_id: traceId,
    channel_id: event.channelId,
    agora_group_id: agoraGroupId,
  });
}

async function handleMemberChange(
  event: Extract<SyncEvent, { kind: 'member_insert' | 'member_delete' }>,
  deps: SyncDeps,
  traceId: string,
): Promise<void> {
  const channel = await deps.reader.getChannelByGroupId(event.groupId);
  if (!channel || !channel.agoraGroupId) {
    // Group not synced yet: defer. Realtime redelivery / reconciliation catches it.
    deps.log.info('chat_agora_sync member change deferred (group not synced)', {
      trace_id: traceId,
      group_id: event.groupId,
    });
    return;
  }
  const username = toAgoraUsername(event.userId);
  if (event.kind === 'member_insert') {
    await deps.agora.addMember(channel.agoraGroupId, username, traceId);
  } else {
    await deps.agora.removeMember(channel.agoraGroupId, username, traceId);
  }
}

async function handleGroupRename(
  event: Extract<SyncEvent, { kind: 'group_rename' }>,
  deps: SyncDeps,
  traceId: string,
): Promise<void> {
  const channel = await deps.reader.getChannelByGroupId(event.groupId);
  if (!channel || !channel.agoraGroupId) {
    deps.log.info('chat_agora_sync rename deferred (group not synced)', {
      trace_id: traceId,
      group_id: event.groupId,
    });
    return;
  }
  await deps.agora.updateGroupName(channel.agoraGroupId, event.name, traceId);
}

/**
 * Handle one Realtime change. Generates a uuid_v7 trace id, dispatches to the
 * per-kind handler, and swallows any failure (logged loudly) so a bad event can
 * never tear down the subscription - the reconciliation cron is the backstop.
 */
export async function processEvent(event: SyncEvent, deps: SyncDeps): Promise<void> {
  const traceId = deps.newTraceId();
  try {
    switch (event.kind) {
      case 'channel_insert':
        await handleChannelInsert(event, deps, traceId);
        return;
      case 'member_insert':
      case 'member_delete':
        await handleMemberChange(event, deps, traceId);
        return;
      case 'group_rename':
        await handleGroupRename(event, deps, traceId);
        return;
    }
  } catch (error) {
    deps.log.error('chat_agora_sync event failed', {
      trace_id: traceId,
      kind: event.kind,
      error: serializeError(error),
    });
  }
}

/**
 * Subscribe to postgres_changes on the watched tables and invoke `onEvent` for
 * each payload that maps to a sync action. Returns an unsubscribe fn.
 */
export function subscribeRealtime(
  client: SupabaseClient<Database>,
  onEvent: (event: SyncEvent) => void | Promise<void>,
): () => void {
  const channel = client.channel('chat-agora-sync');
  const bindings: Array<{ event: 'INSERT' | 'UPDATE' | 'DELETE'; table: string }> = [
    { event: 'INSERT', table: 'chat_channels' },
    { event: 'INSERT', table: 'group_members' },
    { event: 'DELETE', table: 'group_members' },
    { event: 'UPDATE', table: 'groups' },
  ];
  for (const binding of bindings) {
    channel.on(
      // The realtime types are loose here; the payload shape is asserted in map.
      'postgres_changes' as never,
      { event: binding.event, schema: 'public', table: binding.table } as never,
      (payload: ChangePayload) => {
        const event = mapChangePayload(payload);
        if (event) void onEvent(event);
      },
    );
  }
  channel.subscribe();
  return () => {
    void client.removeChannel(channel);
  };
}

/** Start the Realtime consumer. Returns an unsubscribe function. */
export function startConsumer(env: ChatAgoraSyncEnv): () => void {
  const client = createServiceClient(env);
  const deps = buildDeps(env);
  return subscribeRealtime(client, (event) => processEvent(event, deps));
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ ok: true, service: 'chat-agora-sync' }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('chat-agora-sync', { status: 200 });
  },
};
