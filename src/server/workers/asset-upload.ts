// Cloudflare Worker: asset upload + read route.
//
// POST  multipart/form-data { file, workspace_id, asset_id? }
//   -> verifies the caller's Bearer token, confirms they are an active member of
//      workspace_id, runs the upload pipeline, and returns the asset summary.
//      The acting user is the verified token's `sub` claim only - the body never
//      carries an uploaded_by id.
// GET   ?workspace_id=&asset_id=
//   -> same auth + membership gate, then returns the current summary scoped to
//      the workspace (cross-tenant 404).
//
// The Worker is the only holder of the Supabase service-role key and the R2
// credentials; neither is ever shipped to the browser. Caller tokens are
// verified against the project's published asymmetric JWKS (ES256); membership
// is an explicit service-role DB read, not an RLS side effect. Expected pipeline
// failures map to 4xx; unexpected faults bubble up to a 500.

import {
  createSupabaseAssetRepository,
  getAssetSummary,
  runUploadPipeline,
  selectScanner,
  err,
  ok,
  type AssetRepository,
  type AssetSummary,
  type Result,
  type UploadError,
  type UploadErrorCode,
  type UploadInput,
} from '@/server/assets';
import { R2StorageClient, type StorageClient } from '@srtdio/storage';
import { extractTraceId } from '@/server/trace';
import { TRACE_ID_HEADER } from '@/lib/trace';
import { tracedFetch } from '@/server/traced-fetch';
import { logger } from '@/server/logger';
// Reuse asset-read's verified-token + membership primitives verbatim so the two
// workers cannot drift: same ES256 JWKS verification, same workspace_members read.
import { createSupabaseAssetReadStore, getSupabaseJwks, verifyCaller } from './asset-read';

export interface AssetUploadEnv {
  CLOUDFLARE_ACCOUNT_ID: string;
  CLOUDFLARE_R2_ACCESS_KEY_ID: string;
  CLOUDFLARE_R2_SECRET_ACCESS_KEY: string;
  SUPABASE_URL: string;
  SUPABASE_SECRET_KEY: string;
  VIRUS_SCAN_PROVIDER?: string;
}

/** Every code the worker can return, including the auth/transport layer. */
export type UploadResponseCode =
  | UploadErrorCode
  | 'bad_request'
  | 'unauthorized'
  | 'forbidden'
  | 'method_not_allowed'
  | 'internal_error';

const STATUS_BY_CODE: Record<UploadResponseCode, number> = {
  unsupported_mime: 415,
  mime_mismatch: 415,
  file_too_large: 413,
  empty_file: 400,
  invalid_image: 422,
  virus_detected: 422,
  not_found: 404,
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  method_not_allowed: 405,
  internal_error: 500,
};

/** The single membership read the upload path authorizes against. */
export interface MembershipChecker {
  isActiveMember(input: { userId: string; workspaceId: string }): Promise<boolean>;
}

/** Runs the upload pipeline with its deps already bound. */
export type PipelineRunner = (input: UploadInput) => Promise<Result<AssetSummary, UploadError>>;

export interface UploadDeps {
  membership: MembershipChecker;
  runPipeline: PipelineRunner;
}

export interface AuthorizedUploadInput {
  /** The acting user, from the verified token's `sub`. Never from the body. */
  userId: string;
  workspaceId: string;
  filename: string;
  contentType: string;
  bytes: Uint8Array;
  traceId: string;
  assetId?: string;
}

export interface UploadResult {
  summary: AssetSummary;
  reused: boolean;
}

/**
 * Gate the upload on workspace membership, then run the pipeline with the actor
 * fixed to the verified user id. The membership check always runs before any
 * bytes are processed; a non-member is a forbidden Result and never reaches the
 * pipeline.
 */
export async function authorizeAndUpload(
  deps: UploadDeps,
  input: AuthorizedUploadInput,
): Promise<Result<UploadResult, { code: UploadResponseCode; message: string }>> {
  const member = await deps.membership.isActiveMember({
    userId: input.userId,
    workspaceId: input.workspaceId,
  });
  if (!member) {
    return err({ code: 'forbidden', message: 'Not a member of this workspace.' });
  }

  const result = await deps.runPipeline({
    workspaceId: input.workspaceId,
    uploadedBy: input.userId,
    filename: input.filename,
    contentType: input.contentType,
    bytes: input.bytes,
    traceId: input.traceId,
    ...(input.assetId !== undefined ? { assetId: input.assetId } : {}),
  });
  if (!result.ok) {
    return err(result.error);
  }
  return ok({ summary: result.value, reused: result.value.reused });
}

function json(status: number, body: unknown, traceId: string): Response {
  const headers = new Headers({ 'content-type': 'application/json' });
  headers.set(TRACE_ID_HEADER, traceId);
  return new Response(JSON.stringify(body), { status, headers });
}

function buildStorage(env: AssetUploadEnv): StorageClient {
  return new R2StorageClient(
    {
      CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID,
      CLOUDFLARE_R2_ACCESS_KEY_ID: env.CLOUDFLARE_R2_ACCESS_KEY_ID,
      CLOUDFLARE_R2_SECRET_ACCESS_KEY: env.CLOUDFLARE_R2_SECRET_ACCESS_KEY,
    },
    tracedFetch,
  );
}

function buildRepository(env: AssetUploadEnv): AssetRepository {
  return createSupabaseAssetRepository({
    SUPABASE_URL: env.SUPABASE_URL,
    SUPABASE_SECRET_KEY: env.SUPABASE_SECRET_KEY,
  });
}

function buildPipelineRunner(env: AssetUploadEnv): PipelineRunner {
  const deps = {
    storage: buildStorage(env),
    repository: buildRepository(env),
    scanner: selectScanner(env.VIRUS_SCAN_PROVIDER),
  };
  return (input) => runUploadPipeline(deps, input);
}

async function handlePost(
  request: Request,
  env: AssetUploadEnv,
  traceId: string,
): Promise<Response> {
  const caller = await verifyCaller(request, getSupabaseJwks(env));
  if (!caller.ok) {
    return json(401, { error: { code: 'unauthorized', message: caller.error.message } }, traceId);
  }

  // Idempotency-Key is accepted but needs no dedicated storage: the pipeline's
  // sha256 content-dedup already makes a retry of identical bytes safe (it
  // returns reused=true and stores nothing new). We surface the key in logs only.
  const idempotencyKey = request.headers.get('Idempotency-Key');
  if (idempotencyKey !== null && idempotencyKey !== '') {
    logger.info('asset upload carries idempotency key', { idempotency_key: idempotencyKey });
  }

  const form = await request.formData();
  const file = form.get('file');
  const workspaceId = form.get('workspace_id');
  const assetId = form.get('asset_id');

  if (!(file instanceof File)) {
    return json(400, { error: { code: 'bad_request', message: 'Missing file part.' } }, traceId);
  }
  if (typeof workspaceId !== 'string' || workspaceId === '') {
    return json(400, { error: { code: 'bad_request', message: 'Missing workspace_id.' } }, traceId);
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const outcome = await authorizeAndUpload(
    {
      membership: createSupabaseAssetReadStore(env),
      runPipeline: buildPipelineRunner(env),
    },
    {
      userId: caller.value,
      workspaceId,
      filename: file.name,
      contentType: file.type,
      bytes,
      traceId,
      ...(typeof assetId === 'string' && assetId !== '' ? { assetId } : {}),
    },
  );

  if (!outcome.ok) {
    if (outcome.error.code === 'forbidden') {
      logger.warn('asset upload denied: caller not a workspace member', {
        workspace_id: workspaceId,
      });
    }
    return json(STATUS_BY_CODE[outcome.error.code], { error: outcome.error }, traceId);
  }
  return json(outcome.value.reused ? 200 : 201, { asset: outcome.value.summary }, traceId);
}

async function handleGet(
  request: Request,
  env: AssetUploadEnv,
  traceId: string,
): Promise<Response> {
  const caller = await verifyCaller(request, getSupabaseJwks(env));
  if (!caller.ok) {
    return json(401, { error: { code: 'unauthorized', message: caller.error.message } }, traceId);
  }

  const url = new URL(request.url);
  const workspaceId = url.searchParams.get('workspace_id');
  const assetId = url.searchParams.get('asset_id');
  if (!workspaceId || !assetId) {
    return json(
      400,
      { error: { code: 'bad_request', message: 'workspace_id and asset_id are required.' } },
      traceId,
    );
  }

  const member = await createSupabaseAssetReadStore(env).isActiveMember({
    userId: caller.value,
    workspaceId,
  });
  if (!member) {
    logger.warn('asset read denied: caller not a workspace member', { workspace_id: workspaceId });
    return json(
      403,
      { error: { code: 'forbidden', message: 'Not a member of this workspace.' } },
      traceId,
    );
  }

  const result = await getAssetSummary(buildRepository(env), { workspaceId, assetId });
  if (!result.ok) {
    return json(STATUS_BY_CODE[result.error.code], { error: result.error }, traceId);
  }
  return json(200, { asset: result.value }, traceId);
}

export default {
  async fetch(request: Request, env: AssetUploadEnv): Promise<Response> {
    const traceId = extractTraceId(request);
    logger.setTraceId(traceId);
    try {
      if (request.method === 'POST') {
        return await handlePost(request, env, traceId);
      }
      if (request.method === 'GET') {
        return await handleGet(request, env, traceId);
      }
      return json(
        405,
        { error: { code: 'method_not_allowed', message: 'Use GET or POST.' } },
        traceId,
      );
    } catch (error) {
      const errName = error instanceof Error ? error.name : 'UnknownError';
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error(`asset upload failed: ${errName}: ${errMsg}`.trim());
      return json(500, { error: { code: 'internal_error', message: 'Upload failed.' } }, traceId);
    } finally {
      logger.clearTraceId();
    }
  },
};
