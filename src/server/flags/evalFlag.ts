// Resolve and evaluate a single feature flag for a principal.
//
// Resolution order (most specific wins):
//   1. The workspace-scoped row (workspace_id = workspaceId, flag_name).
//   2. Otherwise the GLOBAL row (workspace_id IS NULL, flag_name).
//   3. Otherwise the flag is unknown: disabled, reason 'flag_not_found'.
//
// Once a row is chosen, the category determines the gate:
//   - killswitch:  `enabled` governs directly; rollout_percentage is ignored.
//   - rollout:     `enabled` gates; if on, the principal's bucket must fall
//                  within rollout_percentage (see bucket.ts).
//   - experiment:  identical gate to rollout; the bucket is sticky per userId by
//                  construction, so a principal's assignment never flips.
//   - tier_gated:  `enabled` gates; if on, planTier must meet tier_min.
//
// Reads run under the caller's authenticated client, honoring feature_flags RLS;
// no service-role access here.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@srtdio/schemas';
import { bucketFor } from './bucket';
import { TIER_RANK, isPlanTier, type EvalResult, type PlanTier } from './types';

type FlagRow = Pick<
  Database['public']['Tables']['feature_flags']['Row'],
  'workspace_id' | 'flag_name' | 'category' | 'enabled' | 'rollout_percentage' | 'tier_min'
>;

const SELECT = 'workspace_id, flag_name, category, enabled, rollout_percentage, tier_min';

export interface EvalFlagInput {
  /** Authenticated (non-service-role) client; evaluation runs under its RLS context. */
  client: SupabaseClient<Database>;
  flagName: string;
  /** Workspace to evaluate within, or null to consult only the GLOBAL row. */
  workspaceId: string | null;
  /** Stable principal id used for rollout/experiment bucketing. */
  userId: string;
  planTier: PlanTier;
}

export async function evalFlag(input: EvalFlagInput): Promise<EvalResult> {
  const { client, flagName, workspaceId, userId, planTier } = input;

  const query = client.from('feature_flags').select(SELECT).eq('flag_name', flagName);
  const { data, error } =
    workspaceId === null
      ? await query.is('workspace_id', null)
      : await query.or(`workspace_id.eq.${workspaceId},workspace_id.is.null`);
  if (error) {
    throw error;
  }

  const rows = (data ?? []) as FlagRow[];
  const row = pickRow(rows, workspaceId);
  if (!row) {
    return { enabled: false, reason: 'flag_not_found' };
  }

  return evaluateRow(row, { userId, flagName, planTier });
}

/** Prefer the workspace-scoped row; fall back to the GLOBAL (null) row. */
function pickRow(rows: readonly FlagRow[], workspaceId: string | null): FlagRow | null {
  if (workspaceId !== null) {
    const scoped = rows.find((r) => r.workspace_id === workspaceId);
    if (scoped) {
      return scoped;
    }
  }
  return rows.find((r) => r.workspace_id === null) ?? null;
}

interface EvalCtx {
  userId: string;
  flagName: string;
  planTier: PlanTier;
}

async function evaluateRow(row: FlagRow, ctx: EvalCtx): Promise<EvalResult> {
  switch (row.category) {
    case 'killswitch':
      return { enabled: row.enabled, reason: row.enabled ? 'killswitch_on' : 'killswitch_off' };

    case 'rollout':
    case 'experiment': {
      if (!row.enabled) {
        return { enabled: false, reason: `${row.category}_disabled` };
      }
      const bucket = await bucketFor(ctx.userId, ctx.flagName);
      const included = bucket < row.rollout_percentage;
      return {
        enabled: included,
        reason: included ? `${row.category}_included` : `${row.category}_excluded`,
      };
    }

    case 'tier_gated': {
      if (!row.enabled) {
        return { enabled: false, reason: 'tier_gated_disabled' };
      }
      const minRank = row.tier_min && isPlanTier(row.tier_min) ? TIER_RANK[row.tier_min] : 0;
      const allowed = TIER_RANK[ctx.planTier] >= minRank;
      return { enabled: allowed, reason: allowed ? 'tier_allowed' : 'tier_below_min' };
    }

    default:
      // The category CHECK constraint makes this unreachable, but a row written
      // out-of-band should fail closed rather than throw.
      return { enabled: false, reason: 'unknown_category' };
  }
}
