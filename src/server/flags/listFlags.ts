// Return the merged effective flag set for a workspace.
//
// For each flag_name visible to the caller, the workspace-scoped row overrides
// the GLOBAL row; each entry notes its source ('workspace' or 'global'). This is
// the raw effective configuration, not a per-user evaluation: rollout/experiment
// bucketing and tier gating are applied by evalFlag at call time.
//
// Reads run under the caller's authenticated client (feature_flags RLS applies);
// no service-role access here.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@srtdio/schemas';
import type { EffectiveFlag, FlagCategory, PlanTier } from './types';

type FlagRow = Pick<
  Database['public']['Tables']['feature_flags']['Row'],
  | 'workspace_id'
  | 'flag_name'
  | 'category'
  | 'enabled'
  | 'rollout_percentage'
  | 'tier_min'
  | 'reason'
>;

const SELECT = 'workspace_id, flag_name, category, enabled, rollout_percentage, tier_min, reason';

export interface ListFlagsInput {
  /** Authenticated (non-service-role) client. */
  client: SupabaseClient<Database>;
  /** Workspace whose overrides take precedence, or null for the GLOBAL set only. */
  workspaceId: string | null;
}

export async function listFlags(input: ListFlagsInput): Promise<EffectiveFlag[]> {
  const { client, workspaceId } = input;

  const query = client.from('feature_flags').select(SELECT);
  const { data, error } =
    workspaceId === null
      ? await query.is('workspace_id', null)
      : await query.or(`workspace_id.eq.${workspaceId},workspace_id.is.null`);
  if (error) {
    throw error;
  }

  const merged = new Map<string, EffectiveFlag>();
  for (const row of (data ?? []) as FlagRow[]) {
    const isWorkspaceRow = row.workspace_id !== null;
    const existing = merged.get(row.flag_name);
    // Workspace rows always win over global; skip a global row once a workspace
    // row is recorded.
    if (existing && existing.source === 'workspace' && !isWorkspaceRow) {
      continue;
    }
    merged.set(row.flag_name, {
      flagName: row.flag_name,
      category: row.category as FlagCategory,
      enabled: row.enabled,
      rolloutPercentage: row.rollout_percentage,
      tierMin: row.tier_min as PlanTier | null,
      reason: row.reason,
      source: isWorkspaceRow ? 'workspace' : 'global',
    });
  }

  return [...merged.values()];
}
