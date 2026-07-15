// Audit log write helper.
//
// A single typed entry point for appending one row to public.audit_log: the
// permanent trail for sensitive actions (Cockpit operations, billing, ETL, and
// SECURITY DEFINER procedures that surface their effect to operators).
//
// public.audit_log has RLS with a SELECT-only policy, so direct inserts are
// rejected. The sanctioned write path is the SECURITY DEFINER RPC
// `audit_log_write` (EXECUTE granted to authenticated). It is the only thing
// that can append a row, and it derives actor_user_id from auth.uid() rather
// than trusting a caller-supplied id - so there is no actor parameter here by
// design (anti-spoofing). Everything else maps 1:1 to a column.

import { supabase } from '@/lib/supabase';

type AuditOutcome = 'success' | 'failure';

export type AuditWrite = {
  /** uuid_v7, required. Written as the audit row's trace_id column. */
  traceId: string;
  /** Impersonation target, or null when not impersonating. */
  onBehalfOf?: string | null;
  impersonationSessionId?: string | null;
  workspaceId?: string | null;
  /** snake_case, 1..100 chars, e.g. 'post.stage.transition'. */
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  outcome: AuditOutcome;
  errorCode?: string | null;
  /** Max 64KB serialized; partitions also reject embedded secrets. */
  payload?: Record<string, unknown>;
  /** inet; the truncated subnet, never the full IP. */
  ipSubnet?: string | null;
};

const ACTION_MAX_CHARS = 100;
// Matches the DB partition CHECK: octet_length(payload::text) <= 65536.
const PAYLOAD_MAX_BYTES = 64 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Dotted snake_case segments, e.g. 'post.stage.transition', 'billing.charge_failed'.
const ACTION_PATTERN = /^[a-z0-9]+(?:_[a-z0-9]+)*(?:\.[a-z0-9]+(?:_[a-z0-9]+)*)*$/;

/**
 * Append one row to public.audit_log via the audit_log_write RPC.
 *
 * Resolves once the row is written; rejects if validation fails or the RPC
 * errors. The actor is recorded server-side from the authenticated session.
 */
export async function writeAuditLog(input: AuditWrite): Promise<void> {
  if (!input.traceId || !UUID_PATTERN.test(input.traceId)) {
    throw new Error('writeAuditLog: traceId is required and must be a uuid (uuid_v7)');
  }

  if (
    input.action.length < 1 ||
    input.action.length > ACTION_MAX_CHARS ||
    !ACTION_PATTERN.test(input.action)
  ) {
    throw new Error(
      `writeAuditLog: action must be snake_case, 1..${ACTION_MAX_CHARS} chars (got "${input.action}")`,
    );
  }

  if (input.outcome !== 'success' && input.outcome !== 'failure') {
    throw new Error(`writeAuditLog: outcome must be 'success' or 'failure'`);
  }

  if (input.payload !== undefined) {
    let serialized: string;
    try {
      serialized = JSON.stringify(input.payload);
    } catch {
      throw new Error('writeAuditLog: payload is not JSON-serializable');
    }
    if (new TextEncoder().encode(serialized).length > PAYLOAD_MAX_BYTES) {
      throw new Error('writeAuditLog: payload exceeds 64KB serialized');
    }
  }

  // The trace id is written as the audit row's `p_trace_id` column. audit_log_write
  // does not accept the `_trace_id` context param that callRpc()/this rule expect,
  // and sending `_trace_id` would break the PostgREST function lookup. Trace is
  // still passed as an explicit RPC argument, honoring the invariant's intent.
  // eslint-disable-next-line no-restricted-syntax
  const { error } = await supabase.rpc('audit_log_write', {
    p_action: input.action,
    p_outcome: input.outcome,
    p_trace_id: input.traceId,
    p_workspace_id: input.workspaceId ?? null,
    p_entity_type: input.entityType ?? null,
    p_entity_id: input.entityId ?? null,
    p_payload: input.payload ?? null,
    p_error_code: input.errorCode ?? null,
    p_on_behalf_of: input.onBehalfOf ?? null,
    p_impersonation_session_id: input.impersonationSessionId ?? null,
    p_ip_subnet: input.ipSubnet ?? null,
  });

  if (error) {
    throw error;
  }
}
