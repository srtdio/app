/// <reference types="@cloudflare/workers-types" />
// Nightly storage purge (Cron Trigger 03:30 UTC; see
// workers/storage-purge/wrangler.toml). Two passes, one uuid_v7 trace id:
//
//   1. Assets: storage_purge_due(500) lists deleted assets whose bytes may go
//      (purge requested, or deleted more than 31 days ago, and not in use).
//      Every R2 key of a row is deleted (404 = already gone); only rows whose
//      keys all went are passed to storage_purge_done, which drops the rows.
//      Repeats until a batch is empty, marks nothing new, or MAX_ASSET_BATCHES
//      ran. A row with a failed key stays due and is retried next night.
//   2. Workspaces: workspace_purge_due() lists soft-deleted workspaces. Each one
//      has its Agora chat groups deleted (404 = gone), every object in its
//      bucket deleted page by page, the bucket deleted, then
//      workspace_purge_done drops its rows. A failing workspace is logged and
//      skipped without purge_done, so the next night retries it; it never stops
//      the others.
//
// handleScheduled() wires the live clients; runPurge() carries the logic
// against injected interfaces and is unit-testable.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@srtdio/schemas';
import {
  R2StorageClient,
  type BucketStorage,
  type R2StorageEnv,
  type MultipartStorage,
} from '@srtdio/storage';
import { ChatTokenBuilder } from 'agora-token';
import { v7 as uuidv7 } from 'uuid';
import { TRACE_ID_HEADER, withTraceLogger } from '@/server/trace';
import { tracedFetch } from '@/server/traced-fetch';
import { logger } from '@/server/logger';
import type { TracedFetchFn } from '@/server/workers/chat-agora-rest';

/** Rows asked of storage_purge_due per batch. */
export const ASSET_BATCH_SIZE = 500;

/** Asset batches per run; a larger backlog drains across nights. */
export const MAX_ASSET_BATCHES = 20;

/** App-token TTL for Agora REST auth, as chat-agora-rest uses. */
const APP_TOKEN_TTL_SECONDS = 3_600;

/** Agora error bodies are truncated to this many chars before they are logged. */
const MAX_ERROR_CHARS = 500;

export interface StoragePurgeEnv extends R2StorageEnv {
  SUPABASE_URL: string;
  /** Service role: the purge rpcs are granted to service_role only. */
  SUPABASE_SECRET_KEY: string;
  AGORA_APP_ID: string;
  AGORA_APP_CERTIFICATE: string;
  /** Base host + org + app for the Agora Chat REST API, no trailing slash. */
  AGORA_CHAT_REST_URL: string;
}

export interface DueAsset {
  assetId: string;
  bucket: string | null;
  keys: string[];
}

export interface DueWorkspace {
  workspaceId: string;
  bucket: string | null;
}

/** The DB reads + writes the purge needs; injected for tests. */
export interface PurgeDb {
  storagePurgeDue(limit: number): Promise<DueAsset[]>;
  /** Returns how many asset rows were dropped. */
  storagePurgeDone(assetIds: string[]): Promise<number>;
  workspacePurgeDue(): Promise<DueWorkspace[]>;
  /** Agora group ids of the workspace's synced group channels. */
  workspaceAgoraGroupIds(workspaceId: string): Promise<string[]>;
  /** True when a live (not deleted) workspace other than this one uses the bucket. */
  bucketInUse(bucket: string, workspaceId: string): Promise<boolean>;
  workspacePurgeDone(workspaceId: string): Promise<void>;
}

/** The R2 operations the purge needs; each treats a missing object or bucket as gone. */
export type PurgeStorage = Pick<MultipartStorage, 'deleteObject'> & BucketStorage;

/** Agora group teardown; a missing group counts as deleted. */
export interface PurgeAgora {
  deleteGroup(groupId: string, traceId: string): Promise<void>;
}

export interface PurgeDeps {
  db: PurgeDb;
  storage: PurgeStorage;
  agora: PurgeAgora;
  traceId: string;
  log: Pick<typeof logger, 'info' | 'warn' | 'error'>;
}

export interface PurgeSummary {
  batches: number;
  assetsPurged: number;
  assetsFailed: number;
  keysDeleted: number;
  keysFailed: number;
  workspacesPurged: number;
  workspacesFailed: number;
}

function errorText(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return text.slice(0, MAX_ERROR_CHARS);
}

/** Pass 1: delete the bytes of due assets in batches, then drop their rows. */
async function purgeAssets(deps: PurgeDeps, summary: PurgeSummary): Promise<void> {
  // Rows that failed this run are not retried until the next night.
  const failed = new Set<string>();
  while (summary.batches < MAX_ASSET_BATCHES) {
    const rows = await deps.db.storagePurgeDue(ASSET_BATCH_SIZE);
    summary.batches += 1;
    if (rows.length === 0) return;

    const doneIds: string[] = [];
    for (const row of rows) {
      if (failed.has(row.assetId)) continue;
      const bucket = row.bucket;
      const results =
        bucket === null
          ? []
          : await Promise.allSettled(
              row.keys.map((key) => deps.storage.deleteObject(bucket, key, deps.traceId)),
            );
      const keyFailures = results.filter((r) => r.status === 'rejected');
      summary.keysDeleted += results.length - keyFailures.length;
      summary.keysFailed += keyFailures.length;
      if (keyFailures.length === 0 && (bucket !== null || row.keys.length === 0)) {
        doneIds.push(row.assetId);
        continue;
      }
      failed.add(row.assetId);
      summary.assetsFailed += 1;
      deps.log.error('storage purge asset failed', {
        trace_id: deps.traceId,
        asset_id: row.assetId,
        keys: row.keys.length,
        failed_keys: bucket === null ? row.keys.length : keyFailures.length,
        error:
          keyFailures[0]?.status === 'rejected'
            ? errorText(keyFailures[0].reason)
            : 'workspace has no bucket',
      });
    }

    // Nothing marked means every due row failed or is no longer purgeable;
    // asking again would return the same rows.
    const marked = doneIds.length === 0 ? 0 : await deps.db.storagePurgeDone(doneIds);
    summary.assetsPurged += marked;
    if (marked === 0) return;
  }
}

/** Delete every object in a bucket, page by page, then the bucket itself. */
async function emptyAndDeleteBucket(deps: PurgeDeps, bucket: string): Promise<void> {
  let cursor: string | null = null;
  do {
    const page = await deps.storage.listObjects({ bucket, cursor, traceId: deps.traceId });
    for (const object of page.objects) {
      await deps.storage.deleteObject(bucket, object.key, deps.traceId);
    }
    cursor = page.nextCursor;
  } while (cursor !== null);
  await deps.storage.deleteBucket(bucket, deps.traceId);
}

async function purgeWorkspace(deps: PurgeDeps, workspace: DueWorkspace): Promise<void> {
  const { workspaceId, bucket } = workspace;
  // The bucket name is unique among live workspaces only, so a new workspace
  // can inherit a deleted one's name; never wipe a bucket someone still uses.
  if (bucket !== null && (await deps.db.bucketInUse(bucket, workspaceId))) {
    throw new Error(`bucket ${bucket} is in use by a live workspace`);
  }
  const groupIds = await deps.db.workspaceAgoraGroupIds(workspaceId);
  for (const groupId of groupIds) {
    await deps.agora.deleteGroup(groupId, deps.traceId);
  }
  if (bucket !== null) {
    await emptyAndDeleteBucket(deps, bucket);
  }
  await deps.db.workspacePurgeDone(workspaceId);
}

/** Pass 2: tear down each deleted workspace in isolation. */
async function purgeWorkspaces(deps: PurgeDeps, summary: PurgeSummary): Promise<void> {
  const workspaces = await deps.db.workspacePurgeDue();
  for (const workspace of workspaces) {
    try {
      await purgeWorkspace(deps, workspace);
      summary.workspacesPurged += 1;
    } catch (error) {
      summary.workspacesFailed += 1;
      deps.log.error('storage purge workspace failed', {
        trace_id: deps.traceId,
        workspace_id: workspace.workspaceId,
        error: errorText(error),
      });
    }
  }
}

/** The full nightly run: assets, then workspaces. A failed pass never skips the other. */
export async function runPurge(deps: PurgeDeps): Promise<PurgeSummary> {
  const summary: PurgeSummary = {
    batches: 0,
    assetsPurged: 0,
    assetsFailed: 0,
    keysDeleted: 0,
    keysFailed: 0,
    workspacesPurged: 0,
    workspacesFailed: 0,
  };
  try {
    await purgeAssets(deps, summary);
  } catch (error) {
    deps.log.error('storage purge asset pass failed', {
      trace_id: deps.traceId,
      error: errorText(error),
    });
  }
  try {
    await purgeWorkspaces(deps, summary);
  } catch (error) {
    deps.log.error('storage purge workspace pass failed', {
      trace_id: deps.traceId,
      error: errorText(error),
    });
  }
  return summary;
}

// --- live wiring -------------------------------------------------------------

/** The live PurgeDb backed by a service-role supabase-js client. */
function createPurgeDb(client: SupabaseClient<Database>): PurgeDb {
  return {
    async storagePurgeDue(limit) {
      const args = { p_limit: limit };
      const { data, error } = await client.rpc('storage_purge_due', args);
      if (error) throw new Error(error.message);
      return (data ?? []).map((row) => ({
        assetId: row.asset_id,
        // asset_bucket is nullable on workspaces; the generated return type is not.
        bucket: (row.bucket as string | null) ?? null,
        keys: row.r2_keys ?? [],
      }));
    },
    async storagePurgeDone(assetIds) {
      const args = { p_asset_ids: assetIds };
      const { data, error } = await client.rpc('storage_purge_done', args);
      if (error) throw new Error(error.message);
      return data ?? 0;
    },
    async workspacePurgeDue() {
      const { data, error } = await client.rpc('workspace_purge_due');
      if (error) throw new Error(error.message);
      return (data ?? []).map((row) => ({
        workspaceId: row.workspace_id,
        bucket: (row.bucket as string | null) ?? null,
      }));
    },
    async workspaceAgoraGroupIds(workspaceId) {
      const { data, error } = await client
        .from('chat_channels')
        .select('agora_group_id')
        .eq('workspace_id', workspaceId)
        .not('agora_group_id', 'is', null);
      if (error) throw new Error(error.message);
      return (data ?? []).flatMap((row) => (row.agora_group_id ? [row.agora_group_id] : []));
    },
    async bucketInUse(bucket, workspaceId) {
      const { count, error } = await client
        .from('workspaces')
        .select('id', { count: 'exact', head: true })
        .eq('asset_bucket', bucket)
        .is('deleted_at', null)
        .neq('id', workspaceId);
      if (error) throw new Error(error.message);
      return (count ?? 0) > 0;
    },
    async workspacePurgeDone(workspaceId) {
      const args = { p_workspace_id: workspaceId };
      const { error } = await client.rpc('workspace_purge_done', args);
      if (error) throw new Error(error.message);
    },
  };
}

/**
 * Agora group teardown over REST, authenticated exactly as chat-agora-rest
 * does (app token from App ID + App Certificate, X-Trace-Id via tracedFetch).
 */
export function createAgoraPurgeApi(
  config: { appId: string; appCertificate: string; restUrl: string },
  fetchImpl: TracedFetchFn = tracedFetch,
): PurgeAgora {
  const base = config.restUrl.replace(/\/+$/, '');
  return {
    async deleteGroup(groupId, traceId) {
      const appToken = ChatTokenBuilder.buildAppToken(
        config.appId,
        config.appCertificate,
        APP_TOKEN_TTL_SECONDS,
      );
      const response = await fetchImpl(
        `${base}/chatgroups/${encodeURIComponent(groupId)}`,
        { method: 'DELETE', headers: { authorization: `Bearer ${appToken}` } },
        traceId,
      );
      if (response.ok || response.status === 404) return;
      const body = (await response.text()).slice(0, MAX_ERROR_CHARS);
      throw new Error(`Agora delete_group failed: ${response.status} ${body}`);
    },
  };
}

export async function handleScheduled(
  env: StoragePurgeEnv,
  now: Date = new Date(),
): Promise<PurgeSummary> {
  const traceId = uuidv7();
  const log = withTraceLogger(traceId);
  const client = createClient<Database>(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { [TRACE_ID_HEADER]: traceId } },
  });
  const summary = await runPurge({
    db: createPurgeDb(client),
    storage: new R2StorageClient(env, tracedFetch),
    agora: createAgoraPurgeApi({
      appId: env.AGORA_APP_ID,
      appCertificate: env.AGORA_APP_CERTIFICATE,
      restUrl: env.AGORA_CHAT_REST_URL,
    }),
    traceId,
    log,
  });
  log.info('storage purge complete', {
    trace_id: traceId,
    started_at: now.toISOString(),
    duration_ms: Date.now() - now.getTime(),
    ...summary,
  });
  return summary;
}

export default {
  async scheduled(_controller: ScheduledController, env: StoragePurgeEnv): Promise<void> {
    await handleScheduled(env);
  },
};
