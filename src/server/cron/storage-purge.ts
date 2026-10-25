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
//   2. Workspaces: workspace_purge_due() lists workspaces soft-deleted more
//      than 30 days ago (the restore window). Each one has its Agora chat
//      groups deleted (best effort: a failed group is logged and never blocks
//      the rest), then its R2 bytes removed by bucket kind:
//        a. bucket = SHARED_ASSET_BUCKET: only keys under ws/<workspace_id>/
//           are deleted, page by page; the shared bucket itself is never
//           emptied or deleted. Unset SHARED_ASSET_BUCKET never matches.
//        b. legacy per-workspace bucket: emptied and deleted only when no
//           other workspaces row (live or soft-deleted) has the same
//           asset_bucket. A shared one is left untouched in R2 and the row
//           still goes, so the last row referencing it deletes it.
//        c. keys under induction-sample/ are never deleted (they ship with
//           the site); a legacy bucket that still holds one is kept.
//      Then workspace_purge_done drops its rows. A failing workspace is logged
//      and skipped without purge_done, so the next night retries it; it never
//      stops the others.
//
// A Worker invocation has a bounded subrequest budget (Free plan: 50), and
// every outbound call counts: Supabase, R2 and Agora. The run spends at most
// RUN_CALL_BUDGET of them: the asset pass up to ASSET_CALL_BUDGET, the
// workspace pass whatever is left. A pass that runs out stops cleanly; an
// unfinished workspace is not marked done, and the next night picks up where
// this one stopped (every delete is idempotent).
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

/**
 * Supabase + R2 + Agora calls one run may make, kept under the Worker
 * subrequest limit (50 per invocation on the Free plan) with room to spare.
 */
export const RUN_CALL_BUDGET = 45;

/** The asset pass's share of RUN_CALL_BUDGET; the workspace pass gets the rest. */
export const ASSET_CALL_BUDGET = Math.floor(RUN_CALL_BUDGET / 2);

/** Keys under this prefix are onboarding samples served by the site; never deleted. */
export const SAMPLE_KEY_PREFIX = 'induction-sample/';

/** Key prefix of a workspace's objects in the shared asset bucket. */
export function sharedBucketPrefix(workspaceId: string): string {
  return `ws/${workspaceId}/`;
}

function isSampleKey(key: string): boolean {
  return key.startsWith(SAMPLE_KEY_PREFIX);
}

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
  /**
   * The one bucket new workspaces share, objects under ws/<workspace_id>/.
   * Optional until that bucket exists; unset, no workspace matches it.
   */
  SHARED_ASSET_BUCKET?: string;
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
  /** Agora group ids of the workspaces' synced group channels, by workspace id; one query. */
  workspaceAgoraGroupIds(workspaceIds: string[]): Promise<Map<string, string[]>>;
  /** How many other workspaces rows, live or soft-deleted, have this asset_bucket. */
  bucketSharers(bucket: string, workspaceId: string): Promise<number>;
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
  /** SHARED_ASSET_BUCKET, or null while it is unset. */
  sharedBucket: string | null;
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
  /** Agora groups whose delete failed; their workspaces still purged. */
  agoraGroupsFailed: number;
  /** Supabase + R2 + Agora calls made. */
  calls: number;
  /** True when a pass stopped early because the call budget ran out. */
  budgetExhausted: boolean;
}

/** Calls left for this run; take() claims n of them or none. */
class CallBudget {
  constructor(private left: number) {}

  get remaining(): number {
    return this.left;
  }

  take(n: number): boolean {
    if (n > this.left) return false;
    this.left -= n;
    return true;
  }

  /** Give back calls claimed but not made. */
  refund(n: number): void {
    this.left += n;
  }
}

/** Thrown inside a workspace teardown when the budget runs out mid-way. */
class BudgetExhausted extends Error {}

function errorText(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return text.slice(0, MAX_ERROR_CHARS);
}

/** Pass 1: delete the bytes of due assets in batches, then drop their rows. */
async function purgeAssets(
  deps: PurgeDeps,
  summary: PurgeSummary,
  budget: CallBudget,
): Promise<void> {
  // Rows that failed this run are not retried until the next night.
  const failed = new Set<string>();
  // The due read and the done write are one call each; the rest is R2 deletes.
  const maxRowKeys = ASSET_CALL_BUDGET - 2;
  let outOfBudget = false;
  while (summary.batches < MAX_ASSET_BATCHES && !outOfBudget) {
    // Claim the due read and this batch's done write up front.
    if (!budget.take(2)) {
      summary.budgetExhausted = true;
      return;
    }
    const rows = await deps.db.storagePurgeDue(ASSET_BATCH_SIZE);
    summary.batches += 1;
    if (rows.length === 0) {
      budget.refund(1);
      return;
    }

    const doneIds: string[] = [];
    for (const row of rows) {
      if (failed.has(row.assetId)) continue;
      const bucket = row.bucket;
      // Sample keys ship with the site and are never deleted; the row still goes.
      const keys = row.keys.filter((key) => !isSampleKey(key));
      // A row's keys go together or not at all; the rest wait for the next night.
      // A row that could never fit is skipped so it cannot stall the queue.
      if (bucket !== null && keys.length > maxRowKeys) {
        failed.add(row.assetId);
        summary.assetsFailed += 1;
        deps.log.error('storage purge asset failed', {
          trace_id: deps.traceId,
          asset_id: row.assetId,
          keys: keys.length,
          error: 'more keys than one run may delete',
        });
        continue;
      }
      if (bucket !== null && !budget.take(keys.length)) {
        outOfBudget = true;
        summary.budgetExhausted = true;
        break;
      }
      const results =
        bucket === null
          ? []
          : await Promise.allSettled(
              keys.map((key) => deps.storage.deleteObject(bucket, key, deps.traceId)),
            );
      const keyFailures = results.filter((r) => r.status === 'rejected');
      summary.keysDeleted += results.length - keyFailures.length;
      summary.keysFailed += keyFailures.length;
      if (keyFailures.length === 0 && (bucket !== null || keys.length === 0)) {
        doneIds.push(row.assetId);
        continue;
      }
      failed.add(row.assetId);
      summary.assetsFailed += 1;
      deps.log.error('storage purge asset failed', {
        trace_id: deps.traceId,
        asset_id: row.assetId,
        keys: keys.length,
        failed_keys: bucket === null ? keys.length : keyFailures.length,
        error:
          keyFailures[0]?.status === 'rejected'
            ? errorText(keyFailures[0].reason)
            : 'workspace has no bucket',
      });
    }

    // Nothing marked means every due row failed or is no longer purgeable;
    // asking again would return the same rows.
    if (doneIds.length === 0) {
      budget.refund(1);
      return;
    }
    const marked = await deps.db.storagePurgeDone(doneIds);
    summary.assetsPurged += marked;
    if (marked === 0) return;
  }
}

/** Take one call from the run's budget, or stop the pass. */
function spend(budget: CallBudget): void {
  if (!budget.take(1)) throw new BudgetExhausted('call budget exhausted');
}

/**
 * Delete every non-sample object in a bucket (or under `prefix`), page by
 * page. Returns how many sample keys were left in place.
 */
async function deleteObjects(
  deps: PurgeDeps,
  bucket: string,
  prefix: string | undefined,
  budget: CallBudget,
): Promise<number> {
  let kept = 0;
  let cursor: string | null = null;
  do {
    spend(budget);
    const page = await deps.storage.listObjects({
      bucket,
      ...(prefix === undefined ? {} : { prefix }),
      cursor,
      traceId: deps.traceId,
    });
    const keys = page.objects.map((object) => object.key);
    const deletable = keys.filter((key) => !isSampleKey(key));
    kept += keys.length - deletable.length;
    // Deletes are sent per page; a page larger than the budget left is cut,
    // and the next night lists again from the start (deletes are idempotent).
    const batch = deletable.slice(0, budget.remaining);
    budget.take(batch.length);
    await Promise.all(batch.map((key) => deps.storage.deleteObject(bucket, key, deps.traceId)));
    if (batch.length < deletable.length) throw new BudgetExhausted('call budget exhausted');
    cursor = page.nextCursor;
  } while (cursor !== null);
  return kept;
}

/** Delete the workspace's Agora groups; a failed one is logged and never blocks the purge. */
async function deleteAgoraGroups(
  deps: PurgeDeps,
  workspaceId: string,
  groupIds: string[],
  summary: PurgeSummary,
  budget: CallBudget,
): Promise<void> {
  const failedGroups: string[] = [];
  let firstError: unknown = null;
  for (const groupId of groupIds) {
    spend(budget);
    try {
      await deps.agora.deleteGroup(groupId, deps.traceId);
    } catch (error) {
      failedGroups.push(groupId);
      firstError ??= error;
    }
  }
  if (failedGroups.length === 0) return;
  summary.agoraGroupsFailed += failedGroups.length;
  deps.log.error('storage purge agora group not deleted', {
    trace_id: deps.traceId,
    workspace_id: workspaceId,
    group_ids: failedGroups,
    error: errorText(firstError),
  });
}

async function purgeWorkspaceBucket(
  deps: PurgeDeps,
  workspaceId: string,
  bucket: string,
  budget: CallBudget,
): Promise<void> {
  // a. The shared bucket: only this workspace's prefix goes, never the bucket.
  if (deps.sharedBucket !== null && bucket === deps.sharedBucket) {
    await deleteObjects(deps, bucket, sharedBucketPrefix(workspaceId), budget);
    return;
  }
  // b. A legacy bucket goes only with the last workspaces row that names it.
  // Its name is unique among live workspaces only, so another row (live, or
  // soft-deleted and not yet purged) may still reference it.
  spend(budget);
  const sharers = await deps.db.bucketSharers(bucket, workspaceId);
  if (sharers > 0) {
    deps.log.info('storage purge bucket shared; left in place', {
      trace_id: deps.traceId,
      workspace_id: workspaceId,
      bucket,
      sharers,
    });
    return;
  }
  const kept = await deleteObjects(deps, bucket, undefined, budget);
  if (kept > 0) {
    // c. Sample keys stay, so the bucket is not empty and stays too.
    deps.log.info('storage purge kept induction-sample keys; bucket left in place', {
      trace_id: deps.traceId,
      workspace_id: workspaceId,
      bucket,
      kept,
    });
    return;
  }
  spend(budget);
  await deps.storage.deleteBucket(bucket, deps.traceId);
}

async function purgeWorkspace(
  deps: PurgeDeps,
  workspace: DueWorkspace,
  groupIds: string[],
  summary: PurgeSummary,
  budget: CallBudget,
): Promise<void> {
  const { workspaceId, bucket } = workspace;
  await deleteAgoraGroups(deps, workspaceId, groupIds, summary, budget);
  if (bucket !== null) {
    await purgeWorkspaceBucket(deps, workspaceId, bucket, budget);
  }
  spend(budget);
  await deps.db.workspacePurgeDone(workspaceId);
}

/** Pass 2: tear down each due workspace in isolation. */
async function purgeWorkspaces(
  deps: PurgeDeps,
  summary: PurgeSummary,
  budget: CallBudget,
): Promise<void> {
  let current: string | null = null;
  try {
    spend(budget);
    const workspaces = await deps.db.workspacePurgeDue();
    if (workspaces.length === 0) return;
    spend(budget);
    const groups = await deps.db.workspaceAgoraGroupIds(workspaces.map((w) => w.workspaceId));
    for (const workspace of workspaces) {
      current = workspace.workspaceId;
      try {
        const groupIds = groups.get(workspace.workspaceId) ?? [];
        await purgeWorkspace(deps, workspace, groupIds, summary, budget);
        summary.workspacesPurged += 1;
      } catch (error) {
        if (error instanceof BudgetExhausted) throw error;
        summary.workspacesFailed += 1;
        deps.log.error('storage purge workspace failed', {
          trace_id: deps.traceId,
          workspace_id: workspace.workspaceId,
          error: errorText(error),
        });
      }
    }
  } catch (error) {
    if (!(error instanceof BudgetExhausted)) throw error;
    summary.budgetExhausted = true;
    deps.log.info('storage purge out of call budget; resuming next run', {
      trace_id: deps.traceId,
      workspace_id: current,
    });
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
    agoraGroupsFailed: 0,
    calls: 0,
    budgetExhausted: false,
  };
  const assetBudget = new CallBudget(ASSET_CALL_BUDGET);
  try {
    await purgeAssets(deps, summary, assetBudget);
  } catch (error) {
    deps.log.error('storage purge asset pass failed', {
      trace_id: deps.traceId,
      error: errorText(error),
    });
  }
  const assetCalls = ASSET_CALL_BUDGET - assetBudget.remaining;
  const workspaceBudget = new CallBudget(RUN_CALL_BUDGET - assetCalls);
  try {
    await purgeWorkspaces(deps, summary, workspaceBudget);
  } catch (error) {
    deps.log.error('storage purge workspace pass failed', {
      trace_id: deps.traceId,
      error: errorText(error),
    });
  }
  summary.calls = RUN_CALL_BUDGET - workspaceBudget.remaining;
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
    async workspaceAgoraGroupIds(workspaceIds) {
      const { data, error } = await client
        .from('chat_channels')
        .select('workspace_id, agora_group_id')
        .in('workspace_id', workspaceIds)
        .not('agora_group_id', 'is', null);
      if (error) throw new Error(error.message);
      const groups = new Map<string, string[]>();
      for (const row of data ?? []) {
        if (!row.agora_group_id) continue;
        const ids = groups.get(row.workspace_id) ?? [];
        ids.push(row.agora_group_id);
        groups.set(row.workspace_id, ids);
      }
      return groups;
    },
    async bucketSharers(bucket, workspaceId) {
      // Live and soft-deleted rows alike: a soft-deleted sharer still owns the
      // bucket's objects until its own purge.
      const { count, error } = await client
        .from('workspaces')
        .select('id', { count: 'exact', head: true })
        .eq('asset_bucket', bucket)
        .neq('id', workspaceId);
      if (error) throw new Error(error.message);
      return count ?? 0;
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

/** SHARED_ASSET_BUCKET, or null while it is unset or blank. */
export function sharedBucketName(env: Pick<StoragePurgeEnv, 'SHARED_ASSET_BUCKET'>): string | null {
  const name = env.SHARED_ASSET_BUCKET?.trim() ?? '';
  return name === '' ? null : name;
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
    sharedBucket: sharedBucketName(env),
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
