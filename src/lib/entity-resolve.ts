// Resolve a pretty entity reference (workspace key + per-workspace number) to a
// concrete post or brief id. These are plain RLS-scoped SELECTs: tenant
// isolation is Postgres' job, so a workspace key that belongs to another tenant
// simply returns no row and is indistinguishable from "does not exist" (the
// resolvers never special-case cross-tenant). Each lookup is a single query, so
// resolving a ref costs one workspace read plus one entity read (no N+1).

import type { Client, DomainError, Result } from '@srtdio/rpc';

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
  const { data, error } = await client
    .from('workspaces')
    .select('id')
    .eq('key', key)
    .maybeSingle();
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
