// Cloudflare Worker: asset upload + read route.
//
// POST  multipart/form-data { file, workspace_id, uploaded_by, asset_id? }
//   -> runs the upload pipeline and returns the asset summary.
// GET   ?workspace_id=&asset_id=
//   -> returns the current summary, scoped to the workspace (cross-tenant 404).
//
// The Worker is the only holder of the Supabase service-role key and the R2
// credentials; neither is ever shipped to the browser. All config comes from
// env - nothing is hardcoded. Expected pipeline failures map to 4xx; unexpected
// faults bubble up to a 500.

import {
  createSupabaseAssetRepository,
  getAssetSummary,
  runUploadPipeline,
  selectScanner,
  type AssetRepository,
  type UploadErrorCode,
} from '@/server/assets';
import { R2StorageClient, type StorageClient } from '@srtdio/storage';
import { extractTraceId } from '@/server/trace';
import { TRACE_ID_HEADER } from '@/lib/trace';
import { fetchWithTrace } from '@/lib/fetch';

export interface AssetUploadEnv {
  CLOUDFLARE_ACCOUNT_ID: string;
  CLOUDFLARE_R2_ACCESS_KEY_ID: string;
  CLOUDFLARE_R2_SECRET_ACCESS_KEY: string;
  SUPABASE_URL: string;
  SUPABASE_SECRET_KEY: string;
  VIRUS_SCAN_PROVIDER?: string;
}

const STATUS_BY_CODE: Record<UploadErrorCode, number> = {
  unsupported_mime: 415,
  file_too_large: 413,
  empty_file: 400,
  invalid_image: 422,
  virus_detected: 422,
  not_found: 404,
};

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
    fetchWithTrace,
  );
}

function buildRepository(env: AssetUploadEnv): AssetRepository {
  return createSupabaseAssetRepository({
    SUPABASE_URL: env.SUPABASE_URL,
    SUPABASE_SECRET_KEY: env.SUPABASE_SECRET_KEY,
  });
}

async function handlePost(
  request: Request,
  env: AssetUploadEnv,
  traceId: string,
): Promise<Response> {
  const form = await request.formData();
  const file = form.get('file');
  const workspaceId = form.get('workspace_id');
  const uploadedBy = form.get('uploaded_by');
  const assetId = form.get('asset_id');

  if (!(file instanceof File)) {
    return json(400, { error: { code: 'bad_request', message: 'Missing file part.' } }, traceId);
  }
  if (typeof workspaceId !== 'string' || typeof uploadedBy !== 'string') {
    return json(
      400,
      { error: { code: 'bad_request', message: 'Missing workspace_id or uploaded_by.' } },
      traceId,
    );
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const result = await runUploadPipeline(
    {
      storage: buildStorage(env),
      repository: buildRepository(env),
      scanner: selectScanner(env.VIRUS_SCAN_PROVIDER),
    },
    {
      workspaceId,
      uploadedBy,
      filename: file.name,
      contentType: file.type,
      bytes,
      traceId,
      ...(typeof assetId === 'string' && assetId !== '' ? { assetId } : {}),
    },
  );

  if (!result.ok) {
    return json(STATUS_BY_CODE[result.error.code], { error: result.error }, traceId);
  }
  return json(result.value.reused ? 200 : 201, { asset: result.value }, traceId);
}

async function handleGet(
  request: Request,
  env: AssetUploadEnv,
  traceId: string,
): Promise<Response> {
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

  const result = await getAssetSummary(buildRepository(env), { workspaceId, assetId });
  if (!result.ok) {
    return json(STATUS_BY_CODE[result.error.code], { error: result.error }, traceId);
  }
  return json(200, { asset: result.value }, traceId);
}

export default {
  async fetch(request: Request, env: AssetUploadEnv): Promise<Response> {
    const traceId = extractTraceId(request);
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
    } catch {
      return json(500, { error: { code: 'internal_error', message: 'Upload failed.' } }, traceId);
    }
  },
};
