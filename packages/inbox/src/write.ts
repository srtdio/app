// writeInboxEntry: the only write path into inbox_entries. A thin, service-role
// wrapper over the SECURITY DEFINER proc public.inbox_entry_create, which has NO
// EXECUTE grant to the authenticated role (server / service-role callers only).
//
// The proc gates on is_active_workspace_member(auth.uid()), so the supplied
// client must be authenticated as an active member of the target workspace - a
// service_role JWT carrying a `sub` claim (see acting.ts). A bare service key
// has no sub and is rejected with workspace_member_only by design.

import type { InboxEntityType, InboxEventType, InboxScope, InboxTier, Json } from './types';

/** Minimal structural view of a Supabase client: just the rpc() we call. */
export interface RpcClient {
  rpc(
    fn: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: { message: string } | null }>;
}

export interface InboxEntryInput {
  userId: string;
  workspaceId: string;
  eventType: InboxEventType;
  entityType: InboxEntityType | null;
  entityId: string | null;
  scope: InboxScope;
  scopeKey: string | null;
  tier: InboxTier;
  payload: Json;
  /** Explicit trace id (uuid). Never inferred; propagated to the proc. */
  traceId: string;
}

/**
 * Create one inbox entry and return its id. Throws on any proc/transport error
 * so the caller can route the failure through audit_log_write; this wrapper
 * never swallows errors (no silent drops).
 */
export async function writeInboxEntry(client: RpcClient, input: InboxEntryInput): Promise<string> {
  // trace_id travels as the proc's explicit p_trace_id param (never SET LOCAL,
  // never inferred). Args are assembled as a value, mirroring @srtdio/rpc.
  const params: Record<string, unknown> = {
    p_user_id: input.userId,
    p_workspace_id: input.workspaceId,
    p_event_type: input.eventType,
    p_entity_type: input.entityType,
    p_entity_id: input.entityId,
    p_scope: input.scope,
    p_scope_key: input.scopeKey,
    p_tier: input.tier,
    p_payload: input.payload,
    p_trace_id: input.traceId,
  };
  const { data, error } = await client.rpc('inbox_entry_create', params);
  if (error) throw new Error(`inbox_entry_create failed: ${error.message}`);
  return data as string;
}
