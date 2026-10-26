// Resolve a pretty entity reference (workspace key + per-workspace number) to a
// concrete post or brief id. resolveEntityRef is the one-round-trip path: a
// single ref_resolve rpc (explicit p_trace_id; the actor is auth.uid() server
// side) answers the workspace and the entity together. Tenant isolation is
// Postgres' job, so a workspace key that belongs to another tenant simply
// returns no row and is indistinguishable from "does not exist" (the resolvers
// never special-case cross-tenant). It is the only resolver: the short-link
// routes (useRefResolution) and the recents recorder (recent-items) both use it.

import { withTraceHeader, type Client, type DomainError, type Result } from '@srtdio/rpc';
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
    const { data, error } = await withTraceHeader(client.rpc('ref_resolve', args), args.p_trace_id);
    if (error) return { ok: false, error: transportError(error.message) };
    return { ok: true, data: mapResolvedRef(data) };
  } catch (err: unknown) {
    return { ok: false, error: transportError(String(err)) };
  }
}

function transportError(message: string): DomainError {
  return { code: 'unknown', message };
}
