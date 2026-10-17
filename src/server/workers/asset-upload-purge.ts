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
// Both sweeps only ever remove rows the caller just marked (purge_requested_at
// set), so neither needs storage_purge_due's 31-day branch. They read this
// workspace's marked rows (and only the given ids) with one service-role select
// per chunk of ids that embeds the R2 keys and sizes, and apply the proc's
// eligibility in the same way: deleted_at set, purge_requested_at set, and not
// asset_in_use (no live attachment to a live post, brief or comment). Reading
// storage_purge_due globally and filtering would find nothing here whenever
// more than its limit of rows were due elsewhere. storage_purge_done rechecks
// eligibility and stays the authority for dropping rows, and a caller can never
// purge another tenant's files. freedBytes sums the version and rendition sizes
// of the rows actually removed.

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

/** Most ids one call accepts, and the most rows one sweep reads. */
const MAX_IDS = 1000;

/**
 * R2 deletes one call may send. A Worker request has a bounded subrequest
 * budget; rows past this are left for the next call or the nightly sweep.
 */
const MAX_KEY_DELETES = 900;

/** Rows deleted from R2 at once. */
const DELETE_CONCURRENCY = 8;

/** Ids per read; keeps the PostgREST query string short. */
const ID_CHUNK = 150;

/** asset_attachments.entity_type -> the table asset_in_use checks for a live row. */
const ENTITY_TABLES = { post: 'posts', brief: 'briefs', comment: 'comments' } as const;
type EntityType = keyof typeof ENTITY_TABLES;

function entityType(value: string): EntityType | null {
  return Object.hasOwn(ENTITY_TABLES, value) ? (value as EntityType) : null;
}

/** `items` in slices of at most `size`. */
function chunked<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * asset_in_use compares `id::text` with entity_id, and a uuid renders as
 * lowercase canonical text, so only such an entity_id can name a live row.
 */
const UUID_TEXT_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One purge-requested row, as storage_purge_due shapes it, plus its stored bytes. */
export interface PurgeDueRow {
  asset_id: string;
  workspace_id: string;
  bucket: string | null;
  /** Version keys, then rendition keys (nulls dropped), as storage_purge_due builds them. */
  r2_keys: string[];
  /** Stored bytes (versions plus renditions). */
  bytes: number;
}

/** The service-role reads and writes both sweeps use. */
export interface PurgeStore {
  isActiveMember(input: { userId: string; workspaceId: string }): Promise<boolean>;
  /**
   * This workspace's rows storage_purge_due would return that have
   * purge_requested_at set (only `assetIds` when given), oldest request first.
   */
  due(
    input: { workspaceId: string; assetIds: readonly string[] | null; limit: number },
    traceId: string,
  ): Promise<PurgeDueRow[]>;
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
  const due = await deps.store.due(
    { workspaceId: input.workspaceId, assetIds: input.assetIds, limit: MAX_IDS },
    input.traceId,
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

  const cleared: PurgeDueRow[] = [];
  let failed = 0;
  await eachLimited(batch, DELETE_CONCURRENCY, async (row) => {
    try {
      if (row.r2_keys.length > 0 && row.bucket === null) {
        throw new Error(`workspace ${row.workspace_id} has no asset_bucket`);
      }
      for (const key of row.r2_keys) {
        await deps.objects.deleteObject(row.bucket ?? '', key, input.traceId);
      }
      cleared.push(row);
    } catch (error) {
      failed += 1;
      logger.error('purge: R2 delete failed', {
        asset_id: row.asset_id,
        workspace_id: row.workspace_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  const removed =
    cleared.length === 0
      ? 0
      : await deps.store.done(
          cleared.map((row) => row.asset_id),
          input.traceId,
        );
  const freedBytes = cleared.reduce((sum, row) => sum + row.bytes, 0);
  return { removed, freedBytes, failed };
}

function serviceClient(env: PurgeEnv, traceId: string) {
  return createClient<Database>(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { [TRACE_ID_HEADER]: traceId } },
  });
}

/** One assets row of the due read, with its embedded keys, sizes and attachments. */
interface CandidateRow {
  id: string;
  workspace_id: string;
  purge_requested_at: string | null;
  workspaces: { asset_bucket: string | null } | null;
  asset_versions: Array<{
    r2_key: string | null;
    size_bytes: number | null;
    asset_renditions: Array<{ r2_key: string | null; size_bytes: number | null }>;
  }>;
  asset_attachments: Array<{ entity_type: string; entity_id: string; deleted_at: string | null }>;
}

/**
 * asset_in_use over many rows: the ids among `rows` with a live attachment to
 * a live post, brief or comment. One read per entity table per chunk of ids.
 */
async function liveAttachedAssets(
  client: ReturnType<typeof serviceClient>,
  rows: readonly CandidateRow[],
): Promise<Set<string>> {
  const wanted = new Map<EntityType, Set<string>>();
  for (const row of rows) {
    for (const a of row.asset_attachments) {
      const type = entityType(a.entity_type);
      if (a.deleted_at !== null || type === null || !UUID_TEXT_RE.test(a.entity_id)) continue;
      const ids = wanted.get(type) ?? new Set<string>();
      ids.add(a.entity_id);
      wanted.set(type, ids);
    }
  }

  const live = new Map<EntityType, Set<string>>();
  for (const [type, idSet] of wanted) {
    const found = new Set<string>();
    for (const ids of chunked([...idSet], ID_CHUNK)) {
      const { data, error } = await client
        .from(ENTITY_TABLES[type])
        .select('id')
        .in('id', ids)
        .is('deleted_at', null);
      if (error) throw new Error(`purge in-use read failed: ${error.message}`);
      for (const entity of data ?? []) found.add(entity.id);
    }
    live.set(type, found);
  }

  const inUse = new Set<string>();
  for (const row of rows) {
    const used = row.asset_attachments.some((a) => {
      const type = entityType(a.entity_type);
      return a.deleted_at === null && type !== null && (live.get(type)?.has(a.entity_id) ?? false);
    });
    if (used) inUse.add(row.id);
  }
  return inUse;
}

/** The live service-role store. */
export function createSupabasePurgeStore(env: PurgeEnv, traceId: string): PurgeStore {
  const client = serviceClient(env, traceId);
  const members = createSupabaseAssetReadStore(env, traceId);
  return {
    isActiveMember: (input) => members.isActiveMember(input),
    async due({ workspaceId, assetIds, limit }) {
      const chunks: Array<readonly string[] | null> =
        assetIds === null ? [null] : chunked(assetIds, ID_CHUNK);

      const candidates: CandidateRow[] = [];
      for (const ids of chunks) {
        let query = client
          .from('assets')
          .select(
            'id, workspace_id, purge_requested_at, workspaces!assets_workspace_id_fkey(asset_bucket), asset_versions!asset_versions_asset_id_fkey(r2_key, size_bytes, asset_renditions(r2_key, size_bytes)), asset_attachments!asset_attachments_asset_id_fkey(entity_type, entity_id, deleted_at)',
          )
          .eq('workspace_id', workspaceId)
          .not('deleted_at', 'is', null)
          .not('purge_requested_at', 'is', null)
          .order('purge_requested_at')
          .limit(limit);
        if (ids !== null) query = query.in('id', ids);
        const { data, error } = await query;
        if (error) throw new Error(`purge due read failed: ${error.message}`);
        const rows: CandidateRow[] = data ?? [];
        candidates.push(...rows);
      }

      const inUse = await liveAttachedAssets(client, candidates);
      return candidates
        .filter((row) => !inUse.has(row.id))
        .sort((a, b) => (a.purge_requested_at ?? '').localeCompare(b.purge_requested_at ?? ''))
        .slice(0, limit)
        .map((row) => ({
          asset_id: row.id,
          workspace_id: row.workspace_id,
          bucket: row.workspaces?.asset_bucket ?? null,
          r2_keys: [
            ...row.asset_versions.flatMap((v) => (v.r2_key === null ? [] : [v.r2_key])),
            ...row.asset_versions.flatMap((v) =>
              v.asset_renditions.flatMap((r) => (r.r2_key === null ? [] : [r.r2_key])),
            ),
          ],
          bytes: row.asset_versions.reduce(
            (sum, v) =>
              sum +
              (v.size_bytes ?? 0) +
              v.asset_renditions.reduce((s, r) => s + (r.size_bytes ?? 0), 0),
            0,
          ),
        }));
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
