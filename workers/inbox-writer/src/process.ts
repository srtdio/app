// processEvent: the worker's per-event pipeline. Given one Realtime change it
//   1. derives the entry envelope (skips non-trigger changes),
//   2. computes the recipient/event_type/tier set,
//   3. for each recipient: checks the KV dedupe namespace, writes via the
//      service-role proc wrapper, then records the dedupe key (7-day TTL),
//   4. routes any failure through audit_log_write (action inbox_writer_failure)
//      so nothing is ever dropped silently.
//
// All I/O is injected through ProcessDeps, so the integration tests drive this
// against a real database with an in-memory KV and assert ground truth.

import {
  buildEnvelope,
  computeRecipients,
  createActingClient,
  createSupabaseReader,
  dedupeKey,
  resolveActingMember,
  writeInboxEntry,
  type ChangeEvent,
  type RpcClient,
} from '@srtdio/inbox';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@srtdio/schemas';

/** The subset of the KV namespace API the worker uses. */
export interface DedupeKv {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

export interface ProcessDeps {
  /** Service-role client for reads (recipient lookups) and the audit failure path. */
  readerClient: SupabaseClient<Database>;
  url: string;
  serviceKey: string;
  jwtSecret: string;
  kv: DedupeKv;
  /** Fresh trace id per event (uuid v7). */
  newTraceId(): string;
  /** Structured log sink. */
  log(line: Record<string, unknown>): void;
}

const DEDUPE_TTL_SECONDS = 7 * 24 * 60 * 60;

export interface ProcessResult {
  traceId: string;
  written: number;
  deduped: number;
  skipped: boolean;
}

export async function processEvent(event: ChangeEvent, deps: ProcessDeps): Promise<ProcessResult> {
  const traceId = deps.newTraceId();
  const envelope = buildEnvelope(event);
  if (!envelope) return { traceId, written: 0, deduped: 0, skipped: true };

  try {
    const reader = createSupabaseReader(deps.readerClient);
    const recipients = await computeRecipients(event, reader);
    if (recipients.length === 0) return { traceId, written: 0, deduped: 0, skipped: false };

    const actingUserId = await resolveActingMember(deps.readerClient, envelope.workspaceId);
    if (!actingUserId) {
      throw new Error(`no active owner/admin to act as in workspace ${envelope.workspaceId}`);
    }
    // The typed Supabase client's overloaded rpc() is structurally narrower
    // than RpcClient; the cast is sound (both call inbox_entry_create).
    const writer = (await createActingClient({
      url: deps.url,
      serviceKey: deps.serviceKey,
      jwtSecret: deps.jwtSecret,
      actingUserId,
    })) as unknown as RpcClient;

    let written = 0;
    let deduped = 0;
    for (const recipient of recipients) {
      const key = await dedupeKey(
        envelope.sourceTable,
        envelope.sourceId,
        recipient.eventType,
        recipient.userId,
      );
      if (await deps.kv.get(key)) {
        deduped += 1;
        continue;
      }
      const id = await writeInboxEntry(writer, {
        userId: recipient.userId,
        workspaceId: envelope.workspaceId,
        eventType: recipient.eventType,
        entityType: envelope.entityType,
        entityId: envelope.entityId,
        scope: envelope.scope,
        scopeKey: envelope.scopeKey,
        tier: recipient.tier,
        payload: envelope.payload,
        traceId,
      });
      await deps.kv.put(key, id, { expirationTtl: DEDUPE_TTL_SECONDS });
      written += 1;
    }

    deps.log({
      msg: 'inbox_writer_fanout',
      trace_id: traceId,
      source_table: envelope.sourceTable,
      source_id: envelope.sourceId,
      written,
      deduped,
    });
    return { traceId, written, deduped, skipped: false };
  } catch (err) {
    await recordFailure(
      deps,
      traceId,
      envelope.sourceTable,
      envelope.sourceId,
      envelope.workspaceId,
      err,
    );
    throw err;
  }
}

/** No silent drops: persist the failure to audit_log and the structured log. */
async function recordFailure(
  deps: ProcessDeps,
  traceId: string,
  sourceTable: string,
  sourceId: string,
  workspaceId: string,
  err: unknown,
): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  deps.log({
    msg: 'inbox_writer_failure',
    level: 'error',
    trace_id: traceId,
    source_table: sourceTable,
    source_id: sourceId,
    error: message,
  });
  try {
    // Args assembled as a value (explicit p_trace_id), mirroring @srtdio/rpc.
    const params = {
      p_action: 'inbox_writer_failure',
      p_outcome: 'failure',
      p_trace_id: traceId,
      p_workspace_id: workspaceId,
      p_entity_type: 'inbox_writer',
      p_entity_id: sourceId,
      p_error_code: 'inbox_writer_failure',
      p_payload: { source_table: sourceTable, source_id: sourceId, error: message },
    };
    await deps.readerClient.rpc('audit_log_write', params);
  } catch (auditErr) {
    // The audit proc itself failed; emit to the log so the drop is still visible.
    deps.log({
      msg: 'inbox_writer_audit_failed',
      level: 'error',
      trace_id: traceId,
      error: auditErr instanceof Error ? auditErr.message : String(auditErr),
    });
  }
}
