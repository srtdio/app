// Read paths: direct RLS-scoped SELECTs, no procs. RLS does the tenant
// filtering, so each query trusts the policy rather than re-checking membership:
//   * listMembers  - members of a workspace the caller belongs to.
//   * listWorkspaces - every workspace the caller is an active member of.
//   * switchWorkspace - resolve one workspace; absence means "not a member".
// These are SELECTs, not RPCs, so no _trace_id is threaded (that invariant is
// scoped to .rpc() calls).

import type { Client, Result } from '@srtdio/rpc';
import type { Database } from '@srtdio/schemas';
import { fail, ok } from './result';

type WorkspaceRow = Database['public']['Tables']['workspaces']['Row'];
type WorkspaceMemberRow = Database['public']['Tables']['workspace_members']['Row'];

export async function listMembers(
  client: Client,
  workspaceId: string,
): Promise<Result<WorkspaceMemberRow[]>> {
  const res = await client
    .from('workspace_members')
    .select('*')
    .eq('workspace_id', workspaceId)
    .order('invited_at', { ascending: true });
  if (res.error) return fail('unknown', `listMembers failed: ${res.error.message}`);
  return ok(res.data);
}

/**
 * Count active members of a workspace (those occupying a seat). Uses a
 * head-only count so no rows cross the wire; RLS scopes the table to the
 * caller's memberships, and the workspace_id filter pins it to one tenant.
 */
export async function countActiveMembers(
  client: Client,
  workspaceId: string,
): Promise<Result<number>> {
  const res = await client
    .from('workspace_members')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', workspaceId)
    .eq('active', true);
  if (res.error) return fail('unknown', `countActiveMembers failed: ${res.error.message}`);
  return ok(res.count ?? 0);
}

export async function listWorkspaces(client: Client): Promise<Result<WorkspaceRow[]>> {
  const res = await client.from('workspaces').select('*').order('created_at', { ascending: true });
  if (res.error) return fail('unknown', `listWorkspaces failed: ${res.error.message}`);
  return ok(res.data);
}

export async function switchWorkspace(
  client: Client,
  workspaceId: string,
): Promise<Result<WorkspaceRow>> {
  const res = await client.from('workspaces').select('*').eq('id', workspaceId).maybeSingle();
  if (res.error) return fail('unknown', `switchWorkspace failed: ${res.error.message}`);
  if (!res.data) {
    return fail('workspace_member_only', 'not an active member of the target workspace');
  }
  return ok(res.data);
}
