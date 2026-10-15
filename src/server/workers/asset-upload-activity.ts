// Activity for library uploads: one 'asset_uploaded' inbox entry per recipient
// per upload batch (not per file), written by the asset-upload Worker through
// its service-role client right after a successful upload.
//
// - Recipients: every active member of the workspace except the uploader.
// - Tier ambient, entity workspace, scope everything (the same envelope the
//   inbox fan-out uses for an assets row).
// - Payload: { batch_id, file_count, filename, asset_id } where filename and
//   asset_id are the batch's first stored file.
// - One multi-row insert for all recipients. inbox_entry_create is one row per
//   call and stays service-only (no grant to authenticated is added).
//
// Idempotency: the batch id rides in the payload. inbox_entries has no
// idempotency column or unique key yet (see the PR's SCHEMA NEEDED), so the
// writer first looks for an existing entry for this batch and writes nothing
// when one exists. The client uploads a batch one file at a time, so the check
// and the insert never race within one batch.
//
// Never throws: Activity is best effort and must not fail the upload.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@srtdio/schemas';
import { TRACE_ID_HEADER } from '@/lib/trace';
import { logger } from '@/server/logger';
import { serializeError } from './lib/serialize-error';

export interface UploadBatch {
  /** Client-minted batch id (uuid); the idempotency key. */
  id: string;
  /** How many files the batch holds. */
  size: number;
}

export interface UploadActivityInput {
  workspaceId: string;
  uploaderId: string;
  batch: UploadBatch;
  /** The stored file this upload produced (the batch's first success writes the entry). */
  assetId: string;
  filename: string;
  traceId: string;
}

export interface InboxRow {
  user_id: string;
  workspace_id: string;
  event_type: 'asset_uploaded';
  entity_type: 'workspace';
  entity_id: string;
  scope: 'everything';
  scope_key: null;
  tier: 'ambient';
  actor_user_id: string;
  payload: { batch_id: string; file_count: number; filename: string; asset_id: string };
}

export interface ActivityStore {
  /** user_id of every active member of the workspace. */
  activeMemberIds(workspaceId: string): Promise<string[]>;
  /** True when an asset_uploaded entry for this batch already exists in the workspace. */
  batchRecorded(workspaceId: string, batchId: string): Promise<boolean>;
  /** One insert for every row. */
  insertEntries(rows: readonly InboxRow[]): Promise<void>;
}

/** Most files one batch can report; anything larger is clamped. */
const MAX_BATCH_SIZE = 500;

/** Parse the optional batch_id / batch_size form fields; null when absent or invalid. */
export function parseBatch(
  idField: FormDataEntryValue | null,
  sizeField: FormDataEntryValue | null,
): UploadBatch | null {
  if (typeof idField !== 'string' || !/^[0-9a-f-]{36}$/i.test(idField)) return null;
  const size = typeof sizeField === 'string' ? Number.parseInt(sizeField, 10) : 1;
  return {
    id: idField.toLowerCase(),
    size: Number.isInteger(size) && size >= 1 ? Math.min(size, MAX_BATCH_SIZE) : 1,
  };
}

/** The rows to write: one per active member except the uploader. Pure. */
export function buildActivityRows(
  input: UploadActivityInput,
  memberIds: readonly string[],
): InboxRow[] {
  const recipients = [...new Set(memberIds)].filter((id) => id !== input.uploaderId);
  return recipients.map((userId) => ({
    user_id: userId,
    workspace_id: input.workspaceId,
    event_type: 'asset_uploaded',
    entity_type: 'workspace',
    entity_id: input.workspaceId,
    scope: 'everything',
    scope_key: null,
    tier: 'ambient',
    actor_user_id: input.uploaderId,
    payload: {
      batch_id: input.batch.id,
      file_count: input.batch.size,
      filename: input.filename,
      asset_id: input.assetId,
    },
  }));
}

/** Write the batch's Activity entries once. Never throws; returns how many rows were written. */
export async function recordUploadActivity(
  store: ActivityStore,
  input: UploadActivityInput,
): Promise<number> {
  try {
    if (await store.batchRecorded(input.workspaceId, input.batch.id)) return 0;
    const rows = buildActivityRows(input, await store.activeMemberIds(input.workspaceId));
    if (rows.length === 0) return 0;
    await store.insertEntries(rows);
    return rows.length;
  } catch (error) {
    logger.error(`asset upload activity failed: ${serializeError(error)}`, {
      workspace_id: input.workspaceId,
      batch_id: input.batch.id,
    });
    return 0;
  }
}

/** How far back the batch check looks; a batch never spans more than a day. */
const BATCH_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/** The service-role store the Worker writes through. */
export function createSupabaseActivityStore(
  env: { SUPABASE_URL: string; SUPABASE_SECRET_KEY: string },
  traceId: string,
  now: () => number = Date.now,
): ActivityStore {
  const client: SupabaseClient<Database> = createClient<Database>(
    env.SUPABASE_URL,
    env.SUPABASE_SECRET_KEY,
    {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { [TRACE_ID_HEADER]: traceId } },
    },
  );
  return {
    async activeMemberIds(workspaceId) {
      const { data, error } = await client
        .from('workspace_members')
        .select('user_id')
        .eq('workspace_id', workspaceId)
        .eq('active', true);
      if (error) throw error;
      return (data ?? []).map((row) => row.user_id);
    },
    async batchRecorded(workspaceId, batchId) {
      const { data, error } = await client
        .from('inbox_entries')
        .select('id')
        .eq('workspace_id', workspaceId)
        .eq('event_type', 'asset_uploaded')
        .eq('payload->>batch_id', batchId)
        .gte('created_at', new Date(now() - BATCH_LOOKBACK_MS).toISOString())
        .limit(1);
      if (error) throw error;
      return (data ?? []).length > 0;
    },
    async insertEntries(rows) {
      const { error } = await client.from('inbox_entries').insert([...rows]);
      if (error) throw error;
    },
  };
}
