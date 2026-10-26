// Resolve a pretty entity reference (workspace key + per-workspace number) to a
// concrete post or brief id. resolveEntityRef is the one-round-trip path: a
// single ref_resolve rpc (explicit p_trace_id; the actor is auth.uid() server
// side) answers the workspace and the entity together. Tenant isolation is
// Postgres' job, so a workspace key that belongs to another tenant simply
// returns no row and is indistinguishable from "does not exist" (the resolvers
// never special-case cross-tenant). The per-step RLS SELECTs below remain for
// callers that already hold a workspace id.

import type { Client, DomainError, Result } from '@srtdio/rpc';
import type { Database } from '@srtdio/schemas';

type Functions = Database['public']['Functions'];

/** The kinds a pretty reference names. */
export type RefKind = 'post' | 'brief';

/**
 * A resolved reference: the workspace the key names (null when no workspace
 * with that key is visible) and the live entity's id (null when the workspace
 * has no live post or brief with that number, or the workspace is missing).
 */
export interface ResolvedRef {
  workspaceId: string | null;
  entityId: string | null;
}

const UNRESOLVED: ResolvedRef = { workspaceId: null, entityId: null };

/** Map ref_resolve's rows (zero or one) to a ResolvedRef; no row is unresolved. */
export function mapResolvedRef(data: unknown): ResolvedRef {
  const row: unknown = Array.isArray(data) ? data[0] : data;
  if (typeof row !== 'object' || row === null) return UNRESOLVED;
  const rec = row as { workspace_id?: unknown; entity_id?: unknown };
  const workspaceId = typeof rec.workspace_id === 'string' ? rec.workspace_id : null;
  if (workspaceId === null) return UNRESOLVED;
  return { workspaceId, entityId: typeof rec.entity_id === 'string' ? rec.entity_id : null };
}

/**
 * Resolve `<key>-<number>` of one kind in a single ref_resolve rpc. Always a
 * Result: `{ ok: true, data: { workspaceId: null, entityId: null } }` when the
 * key is absent or hidden by RLS; `entityId: null` with a workspace when the
 * number is not a live entity of that kind. Never throws.
 */
export async function resolveEntityRef(
  client: Client,
  params: { traceId: string; workspaceKey: string; kind: RefKind; number: number },
): Promise<Result<ResolvedRef>> {
  const args: Functions['ref_resolve']['Args'] = {
    p_trace_id: params.traceId,
    p_workspace_key: params.workspaceKey,
    p_kind: params.kind,
    p_number: params.number,
  };
  try {
    const { data, error } = await client.rpc('ref_resolve', args);
    if (error) return { ok: false, error: transportError(error.message) };
    return { ok: true, data: mapResolvedRef(data) };
  } catch (err: unknown) {
    return { ok: false, error: transportError(String(err)) };
  }
}

function transportError(message: string): DomainError {
  return { code: 'unknown', message };
}

/**
 * Resolve a workspace id from its key (uppercase, e.g. "GBL"). Returns
 * `{ ok: true, data: null }` when no workspace with that key is visible to the
 * caller (absent or hidden by RLS).
 */
export async function resolveWorkspaceIdByKey(
  client: Client,
  key: string,
): Promise<Result<string | null>> {
  const { data, error } = await client.from('workspaces').select('id').eq('key', key).maybeSingle();
  if (error) return { ok: false, error: transportError(error.message) };
  return { ok: true, data: data?.id ?? null };
}

/**
 * Resolve a live post's id from its (workspace_id, number) pair. Returns
 * `{ ok: true, data: null }` when no such post exists, is soft-deleted, or is
 * hidden by RLS.
 */
export async function resolvePostIdByNumber(
  client: Client,
  workspaceId: string,
  number: number,
): Promise<Result<string | null>> {
  const { data, error } = await client
    .from('posts')
    .select('id')
    .eq('workspace_id', workspaceId)
    .eq('number', number)
    .is('deleted_at', null)
    .maybeSingle();
  if (error) return { ok: false, error: transportError(error.message) };
  return { ok: true, data: data?.id ?? null };
}

/**
 * Resolve a live brief's id from its (workspace_id, number) pair. Returns
 * `{ ok: true, data: null }` when no such brief exists, is soft-deleted, or is
 * hidden by RLS.
 */
export async function resolveBriefIdByNumber(
  client: Client,
  workspaceId: string,
  number: number,
): Promise<Result<string | null>> {
  const { data, error } = await client
    .from('briefs')
    .select('id')
    .eq('workspace_id', workspaceId)
    .eq('number', number)
    .is('deleted_at', null)
    .maybeSingle();
  if (error) return { ok: false, error: transportError(error.message) };
  return { ok: true, data: data?.id ?? null };
}
