// Supabase-backed RecipientReader. Reads run with whatever client is passed in;
// the worker passes a service-role client so these lookups see every member and
// comment regardless of RLS. Read-only: no writes happen here.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@srtdio/schemas';
import type { RecipientReader } from './recipients';
import type { Role } from './types';

export function createSupabaseReader(client: SupabaseClient<Database>): RecipientReader {
  return {
    async postOwner(postId) {
      const { data } = await client
        .from('posts')
        .select('owner_user_id')
        .eq('id', postId)
        .maybeSingle();
      return data?.owner_user_id ?? null;
    },

    async briefCreatedBy(briefId) {
      const { data } = await client
        .from('briefs')
        .select('created_by')
        .eq('id', briefId)
        .maybeSingle();
      return data?.created_by ?? null;
    },

    async commentAuthors(entityType, entityId) {
      const { data } = await client
        .from('comments')
        .select('author_user_id')
        .eq('entity_type', entityType)
        .eq('entity_id', entityId)
        .is('deleted_at', null);
      return [...new Set((data ?? []).map((r) => r.author_user_id))];
    },

    async membersByRole(workspaceId, roles) {
      const { data } = await client
        .from('workspace_members')
        .select('user_id')
        .eq('workspace_id', workspaceId)
        .eq('active', true)
        .in('role', roles as Role[]);
      return (data ?? []).map((r) => r.user_id);
    },

    async validateMembers(workspaceId, candidates) {
      if (candidates.length === 0) return [];
      const { data } = await client
        .from('workspace_members')
        .select('user_id')
        .eq('workspace_id', workspaceId)
        .eq('active', true)
        .in('user_id', candidates as string[]);
      return (data ?? []).map((r) => r.user_id);
    },
  };
}

/**
 * An active member to act as when calling the proc for a workspace. Prefers an
 * owner, then any admin: the most stable, longest-lived members. Returns null
 * if the workspace has no active owner/admin (a degenerate state the worker
 * routes to the failure path rather than silently dropping).
 */
export async function resolveActingMember(
  client: SupabaseClient<Database>,
  workspaceId: string,
): Promise<string | null> {
  const { data } = await client
    .from('workspace_members')
    .select('user_id, role')
    .eq('workspace_id', workspaceId)
    .eq('active', true)
    .in('role', ['owner', 'admin']);
  const rows = data ?? [];
  const owner = rows.find((r) => r.role === 'owner');
  return (owner ?? rows[0])?.user_id ?? null;
}
