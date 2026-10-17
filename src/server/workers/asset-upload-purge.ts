// asset-upload Worker purge routes (wire contracts in asset-upload-purge-contracts.ts).
//
// POST /purge       { workspace_id, asset_ids? }
//   -> the owner empties Recently deleted (all of it, or the given ids).
//      asset_purge_request runs AS THE CALLER (the proc checks ownership with
//      auth.uid()), then the rows now due in this workspace are removed from R2
//      and storage_purge_done drops them. A key that will not delete fails the
//      call (500) after the rows that did clear are marked done; a retry sweeps
//      the rest, so the route is idempotent.
// POST /purge-chat  { workspace_id, asset_ids }
//   -> an active member's deleted chat message files. chat_message_delete has
//      already stamped purge_requested_at, so only the sweep runs here. Always
//      200 with counts; the nightly job sweeps any key that failed.
//
// Both sweeps read storage_purge_due (service role) and keep only this
// workspace's rows (and the given ids), so a caller can never purge another
// tenant's files. freedBytes sums the version and rendition sizes of the rows
// actually removed, read once per chunk of ids before the rows are dropped.

import { createClient } from '@supabase/supabase-js';
import type { Database } from '@srtdio/schemas';
import { assetPurgeRequest, type AssetPurgeRequestArgs } from '@srtdio/rpc';
import { R2StorageClient, type MultipartStorage } from '@srtdio/storage';
import { err, ok, type Result } from '@/server/assets';
import { TRACE_ID_HEADER } from '@/lib/trace';
import { tracedFetch } from '@/server/traced-fetch';
import { logger } from '@/server/logger';
import { createSupabaseAssetReadStore, getSupabaseJwks, verifyCaller } from './asset-read';
import type { AssetUploadEnv } from './asset-upload';
import type {
  PurgeChatResponse,
  PurgeErrorBody,
  PurgeRequest,
  PurgeResponse,
} from './asset-upload-purge-contracts';
import { PURGE_ERROR_STATUS } from './asset-upload-purge-contracts';

/**
 * SUPABASE_PUBLISHABLE_KEY lets asset_purge_request run as the caller (the
 * authenticated role, with the caller's token in Authorization). It is a Worker
 * secret; /purge answers 500 until it is set.
 */
export type PurgeEnv = AssetUploadEnv;

/** Most ids one call accepts, and the most rows storage_purge_due returns. */
const MAX_IDS = 1000;

/**
 * R2 deletes one call may send. A Worker request has a bounded subrequest
 * budget; rows past this are left for the next call or the nightly sweep.
 */
const MAX_KEY_DELETES = 900;

/** Rows deleted from R2 at once. */
const DELETE_CONCURRENCY = 8;

/** Ids per size read; keeps the PostgREST query string short. */
const SIZE_CHUNK = 150;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One row of storage_purge_due. */
export interface PurgeDueRow {
  asset_id: string;
  workspace_id: string;
  bucket: string | null;
  r2_keys: string[];
}

/** The service-role reads and writes both sweeps use. */
export interface PurgeStore {
  isActiveMember(input: { userId: string; workspaceId: string }): Promise<boolean>;
  /** storage_purge_due(limit). */
  due(limit: number, traceId: string): Promise<PurgeDueRow[]>;
  /** Stored bytes per asset (versions plus renditions). */
  storedBytes(assetIds: readonly string[], traceId: string): Promise<Map<string, number>>;
  /** storage_purge_done(ids); returns the rows dropped. */
  done(assetIds: readonly string[], traceId: string): Promise<number>;
}

/** asset_purge_request as the caller; owner_only when they do not own the workspace. */
export type PurgeRequester = (input: {
  token: string;
  workspaceId: string;
  assetIds: string[] | null;
  traceId: string;
}) => Promise<Result<number, 'owner_only'>>;

export interface PurgeDeps {
  store: PurgeStore;
  requestPurge: PurgeRequester;
  objects: Pick<MultipartStorage, 'deleteObject'>;
}

export interface SweepResult {
  removed: number;
  freedBytes: number;
  /** Rows whose keys did not all delete; left in place for a retry. */
  failed: number;
}

function json(status: number, body: unknown, traceId: string, acao: string | null): Response {
  const headers = new Headers({ 'content-type': 'application/json' });
  headers.set(TRACE_ID_HEADER, traceId);
  if (acao !== null) {
    headers.set('Access-Control-Allow-Origin', acao);
    headers.set('Vary', 'Origin');
  }
  return new Response(JSON.stringify(body), { status, headers });
}

function errorBody(code: PurgeErrorBody['error']['code'], message: string): PurgeErrorBody {
  return { error: { code, message } };
}

function bearer(request: Request): string {
  const header = request.headers.get('Authorization') ?? '';
  return header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
}

/** Parse and validate a purge body. assetIds null = not given (allowed only when optional). */
async function readBody(
  request: Request,
  idsRequired: boolean,
): Promise<Result<{ workspaceId: string; assetIds: string[] | null }, string>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return err('Body must be JSON.');
  }
  if (typeof body !== 'object' || body === null) {
    return err('Body must be a JSON object.');
  }
  const { workspace_id: workspaceId, asset_ids: rawIds } = body as Partial<
    Record<keyof PurgeRequest, unknown>
  >;
  if (typeof workspaceId !== 'string' || !UUID_RE.test(workspaceId)) {
    return err('Invalid workspace_id.');
  }
  if (rawIds === undefined && !idsRequired) {
    return ok({ workspaceId, assetIds: null });
  }
  if (!Array.isArray(rawIds) || rawIds.length < 1 || rawIds.length > MAX_IDS) {
    return err(`asset_ids must be 1 to ${MAX_IDS} ids.`);
  }
  if (!rawIds.every((id): id is string => typeof id === 'string' && UUID_RE.test(id))) {
    return err('Invalid id format.');
  }
  return ok({ workspaceId, assetIds: [...new Set(rawIds.map((id) => id.toLowerCase()))] });
}

/** Run `work` over `items` with at most `limit` in flight. */
async function eachLimited<T>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++] as T;
      await work(item);
    }
  });
  await Promise.all(runners);
}

/**
 * Remove this workspace's due rows (optionally only `assetIds`) from R2 and the
 * DB. deleteObject already treats a missing key as deleted, so a re-run after a
 * partial failure only repeats harmless deletes.
 */
export async function sweepWorkspace(
  deps: PurgeDeps,
  input: { workspaceId: string; assetIds: readonly string[] | null; traceId: string },
): Promise<SweepResult> {
  const only = input.assetIds === null ? null : new Set(input.assetIds);
  const due = (await deps.store.due(MAX_IDS, input.traceId)).filter(
    (row) => row.workspace_id === input.workspaceId && (only === null || only.has(row.asset_id)),
  );

  // Fit the rows to the subrequest budget; the rest wait for the next sweep.
  const batch: PurgeDueRow[] = [];
  let budget = MAX_KEY_DELETES;
  for (const row of due) {
    if (row.r2_keys.length > budget) break;
    budget -= row.r2_keys.length;
    batch.push(row);
  }
  if (batch.length === 0) {
    return { removed: 0, freedBytes: 0, failed: 0 };
  }

  const sizes = await deps.store.storedBytes(
    batch.map((row) => row.asset_id),
    input.traceId,
  );

  const cleared: string[] = [];
  let failed = 0;
  await eachLimited(batch, DELETE_CONCURRENCY, async (row) => {
    try {
      if (row.r2_keys.length > 0 && row.bucket === null) {
        throw new Error(`workspace ${row.workspace_id} has no asset_bucket`);
      }
      for (const key of row.r2_keys) {
        await deps.objects.deleteObject(row.bucket ?? '', key, input.traceId);
      }
      cleared.push(row.asset_id);
    } catch (error) {
      failed += 1;
      logger.error('purge: R2 delete failed', {
        asset_id: row.asset_id,
        workspace_id: row.workspace_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  const removed = cleared.length === 0 ? 0 : await deps.store.done(cleared, input.traceId);
  const freedBytes = cleared.reduce((sum, id) => sum + (sizes.get(id) ?? 0), 0);
  return { removed, freedBytes, failed };
}

function serviceClient(env: PurgeEnv, traceId: string) {
  return createClient<Database>(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { [TRACE_ID_HEADER]: traceId } },
  });
}

/** The live service-role store. */
export function createSupabasePurgeStore(env: PurgeEnv, traceId: string): PurgeStore {
  const client = serviceClient(env, traceId);
  const members = createSupabaseAssetReadStore(env, traceId);
  return {
    isActiveMember: (input) => members.isActiveMember(input),
    async due(limit) {
      const args = { p_limit: limit };
      const { data, error } = await client.rpc('storage_purge_due', args);
      if (error) throw new Error(`storage_purge_due failed: ${error.message}`);
      return data ?? [];
    },
    async storedBytes(assetIds) {
      const sizes = new Map<string, number>();
      for (let i = 0; i < assetIds.length; i += SIZE_CHUNK) {
        const { data, error } = await client
          .from('asset_versions')
          .select('asset_id, size_bytes, asset_renditions(size_bytes)')
          .in('asset_id', assetIds.slice(i, i + SIZE_CHUNK));
        if (error) throw new Error(`asset size read failed: ${error.message}`);
        for (const row of data ?? []) {
          const renditions = row.asset_renditions.reduce((sum, r) => sum + (r.size_bytes ?? 0), 0);
          sizes.set(
            row.asset_id,
            (sizes.get(row.asset_id) ?? 0) + (row.size_bytes ?? 0) + renditions,
          );
        }
      }
      return sizes;
    },
    async done(assetIds) {
      const args = { p_asset_ids: [...assetIds] };
      const { data, error } = await client.rpc('storage_purge_done', args);
      if (error) throw new Error(`storage_purge_done failed: ${error.message}`);
      return data ?? 0;
    },
  };
}

/** asset_purge_request with the caller's own token, so auth.uid() is the caller. */
export function createSupabasePurgeRequester(env: PurgeEnv): PurgeRequester {
  return async ({ token, workspaceId, assetIds, traceId }) => {
    const key = env.SUPABASE_PUBLISHABLE_KEY;
    if (key === undefined || key === '') {
      throw new Error('SUPABASE_PUBLISHABLE_KEY is not set');
    }
    const client = createClient<Database>(env.SUPABASE_URL, key, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${token}`, [TRACE_ID_HEADER]: traceId } },
    });
    // p_asset_ids is nullable in the proc (null = every row); the generated arg
    // type widens it to string[], so the args are cast.
    const result = await assetPurgeRequest(client, {
      p_workspace_id: workspaceId,
      p_asset_ids: assetIds,
      p_trace_id: traceId,
    } as AssetPurgeRequestArgs);
    if (result.ok) return ok(result.data);
    if (result.error.message === 'owner_only') return err('owner_only');
    throw new Error(`asset_purge_request failed: ${result.error.message}`);
  };
}

function defaultDeps(env: PurgeEnv, traceId: string): PurgeDeps {
  return {
    store: createSupabasePurgeStore(env, traceId),
    requestPurge: createSupabasePurgeRequester(env),
    objects: new R2StorageClient(
      {
        CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID,
        CLOUDFLARE_R2_ACCESS_KEY_ID: env.CLOUDFLARE_R2_ACCESS_KEY_ID,
        CLOUDFLARE_R2_SECRET_ACCESS_KEY: env.CLOUDFLARE_R2_SECRET_ACCESS_KEY,
      },
      tracedFetch,
    ),
  };
}

/** POST /purge: the owner empties Recently deleted. */
export async function handlePurge(
  request: Request,
  env: PurgeEnv,
  traceId: string,
  acao: string | null,
  deps: PurgeDeps = defaultDeps(env, traceId),
): Promise<Response> {
  const caller = await verifyCaller(request, getSupabaseJwks(env));
  if (!caller.ok) {
    return json(401, errorBody('unauthorized', caller.error.message), traceId, acao);
  }
  const parsed = await readBody(request, false);
  if (!parsed.ok) {
    return json(400, errorBody('bad_request', parsed.error), traceId, acao);
  }
  const { workspaceId, assetIds } = parsed.value;

  const requested = await deps.requestPurge({
    token: bearer(request),
    workspaceId,
    assetIds,
    traceId,
  });
  if (!requested.ok) {
    logger.warn('purge denied: caller is not the workspace owner', { workspace_id: workspaceId });
    return json(
      PURGE_ERROR_STATUS.owner_only,
      errorBody('owner_only', 'Only the workspace owner can do this.'),
      traceId,
      acao,
    );
  }

  const swept = await sweepWorkspace(deps, { workspaceId, assetIds, traceId });
  if (swept.failed > 0) {
    return json(
      500,
      { error: { code: 'internal_error', message: 'Some files could not be removed.' } },
      traceId,
      acao,
    );
  }
  const body: PurgeResponse = {
    requested: requested.value,
    removed: swept.removed,
    freedBytes: swept.freedBytes,
  };
  return json(200, body, traceId, acao);
}

/** POST /purge-chat: remove a member's deleted chat message files for good. */
export async function handlePurgeChat(
  request: Request,
  env: PurgeEnv,
  traceId: string,
  acao: string | null,
  deps: PurgeDeps = defaultDeps(env, traceId),
): Promise<Response> {
  const caller = await verifyCaller(request, getSupabaseJwks(env));
  if (!caller.ok) {
    return json(401, errorBody('unauthorized', caller.error.message), traceId, acao);
  }
  const parsed = await readBody(request, true);
  if (!parsed.ok) {
    return json(400, errorBody('bad_request', parsed.error), traceId, acao);
  }
  const { workspaceId, assetIds } = parsed.value;

  const member = await deps.store.isActiveMember({ userId: caller.value, workspaceId });
  if (!member) {
    logger.warn('chat purge denied: caller not a workspace member', { workspace_id: workspaceId });
    return json(
      PURGE_ERROR_STATUS.not_member,
      errorBody('not_member', 'Not a member of this workspace.'),
      traceId,
      acao,
    );
  }

  const swept = await sweepWorkspace(deps, { workspaceId, assetIds, traceId });
  const body: PurgeChatResponse = { removed: swept.removed, freedBytes: swept.freedBytes };
  return json(200, body, traceId, acao);
}
