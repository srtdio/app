// Create or update one feature-flag row, then record the change in the audit log.
//
// Writes go through the service-role client (see client.ts). The table's
// uniqueness is COALESCE(workspace_id,'GLOBAL'), flag_name, an expression index
// PostgREST cannot target with onConflict, so we locate any existing row for the
// (workspace, flag) pair and UPDATE it, otherwise INSERT. Every successful write
// appends an audit_log row via the audit_log_write RPC, carrying the caller's
// trace_id.
//
// Inputs are validated against the same enums/regex the DB enforces, so callers
// get a clear error here instead of an opaque constraint violation.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from '@srtdio/schemas';
import { FLAG_NAME_PATTERN, isFlagCategory, isPlanTier, isRolloutPercentage } from './types';

export class FlagValidationError extends Error {
  override readonly name = 'FlagValidationError';
}

export interface SetFlagInput {
  /** Service-role client. Required: the table is operator-write only. */
  client: SupabaseClient<Database>;
  /** uuid trace id, recorded on the audit_log row. */
  traceId: string;
  flagName: string;
  /** null writes/updates the GLOBAL row. */
  workspaceId: string | null;
  enabled: boolean;
  category: string;
  rolloutPercentage: number;
  tierMin: string | null;
  reason: string | null;
  updatedByUserId: string;
}

export async function setFlag(input: SetFlagInput): Promise<void> {
  const {
    client,
    traceId,
    flagName,
    workspaceId,
    enabled,
    category,
    rolloutPercentage,
    tierMin,
    reason,
    updatedByUserId,
  } = input;

  if (!traceId) {
    throw new FlagValidationError('setFlag: traceId is required');
  }
  if (!FLAG_NAME_PATTERN.test(flagName)) {
    throw new FlagValidationError(`setFlag: invalid flag_name "${flagName}"`);
  }
  if (!isFlagCategory(category)) {
    throw new FlagValidationError(`setFlag: invalid category "${category}"`);
  }
  if (!isRolloutPercentage(rolloutPercentage)) {
    throw new FlagValidationError(`setFlag: invalid rollout_percentage ${rolloutPercentage}`);
  }
  if (tierMin !== null && !isPlanTier(tierMin)) {
    throw new FlagValidationError(`setFlag: invalid tier_min "${tierMin}"`);
  }

  const values = {
    workspace_id: workspaceId,
    flag_name: flagName,
    category,
    enabled,
    rollout_percentage: rolloutPercentage,
    tier_min: tierMin,
    reason,
    updated_by: updatedByUserId,
    updated_at: new Date().toISOString(),
  };

  const locate = client.from('feature_flags').select('id').eq('flag_name', flagName);
  const existing =
    workspaceId === null
      ? await locate.is('workspace_id', null)
      : await locate.eq('workspace_id', workspaceId);
  if (existing.error) {
    throw existing.error;
  }
  const existingId = existing.data?.[0]?.id ?? null;

  if (existingId === null) {
    const { error } = await client.from('feature_flags').insert(values);
    if (error) {
      throw error;
    }
  } else {
    const { error } = await client.from('feature_flags').update(values).eq('id', existingId);
    if (error) {
      throw error;
    }
  }

  await writeAuditRow(client, {
    traceId,
    workspaceId,
    flagName,
    category,
    enabled,
    rolloutPercentage,
    tierMin,
  });
}

interface AuditArgs {
  traceId: string;
  workspaceId: string | null;
  flagName: string;
  category: string;
  enabled: boolean;
  rolloutPercentage: number;
  tierMin: string | null;
}

async function writeAuditRow(client: SupabaseClient<Database>, args: AuditArgs): Promise<void> {
  const payload: Json = {
    flag_name: args.flagName,
    category: args.category,
    enabled: args.enabled,
    rollout_percentage: args.rolloutPercentage,
    tier_min: args.tierMin,
  };

  const rpcArgs: Database['public']['Functions']['audit_log_write']['Args'] = {
    p_action: 'feature_flag.set',
    p_outcome: 'success',
    p_trace_id: args.traceId,
    p_entity_type: 'feature_flag',
    p_entity_id: args.flagName,
    p_payload: payload,
    ...(args.workspaceId !== null ? { p_workspace_id: args.workspaceId } : {}),
  };

  // audit_log_write takes the trace as p_trace_id (the audit row's own column),
  // not the _trace_id context param callRpc()/the lint rule add; sending
  // _trace_id would break the PostgREST function lookup. Trace is still passed
  // as an explicit RPC argument (rpcArgs.p_trace_id), honoring the invariant.
  const { error } = await client.rpc('audit_log_write', rpcArgs);
  if (error) {
    throw error;
  }
}
