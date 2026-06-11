// Cloudflare Worker: asset read path.
//
// POST application/json { asset_version_id }
//   -> verifies the caller, authorizes them against the asset version's
//      workspace, and returns a short-lived signed R2 GET URL:
//      { url, expires_at }.
//
// The Worker is the only holder of the Supabase service-role key, the R2
// credentials and the JWT secret; none is ever shipped to the browser. The
// caller is identified from the verified token's `sub` claim only - never from
// a request-supplied id. Authorization is an explicit DB read against
// workspace_members (membership is not in the JWT), not an RLS side effect, so
// the lookup uses the service role and the worker gates access itself.
//
// This is a read/query endpoint: no idempotency key, no state mutation, no
// audit row. Expected failures (missing/invalid token, unknown version,
// non-member) are returned as typed Results and mapped to 4xx; system faults
// throw and become a 500.

import { jwtVerify } from 'jose';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@srtdio/schemas';
import { R2StorageClient } from '@srtdio/storage';
import { tracedFetch } from '@/server/traced-fetch';
import { err, ok, type Result } from '@/server/assets/types';
import { extractTraceId } from '@/server/trace';
import { logger } from '@/server/logger';
import { TRACE_ID_HEADER } from '@/lib/trace';

/** Signed-URL lifetime: 15 minutes. */
const URL_TTL_SECONDS = 900;

export interface AssetReadEnv {
  CLOUDFLARE_ACCOUNT_ID: string;
  CLOUDFLARE_R2_ACCESS_KEY_ID: string;
  CLOUDFLARE_R2_SECRET_ACCESS_KEY: string;
  SUPABASE_URL: string;
  /** Service role: used only for the server-side row lookups below. */
  SUPABASE_SECRET_KEY: string;
  /** Project JWT secret: local HS256 verification, no GoTrue round-trip. */
  SUPABASE_JWT_SECRET: string;
}

export type ReadErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'not_a_stored_file';

export interface ReadError {
  code: ReadErrorCode;
  message: string;
}

const STATUS_BY_CODE: Record<ReadErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  not_a_stored_file: 400,
};

/**
 * Where an asset version's bytes live: its owning workspace, that workspace's
 * permanent R2 bucket name, its kind, and the object key. A link version (or any
 * version without stored bytes) has a null r2_key and cannot be signed.
 */
export interface AssetVersionLocator {
  workspaceId: string;
  bucket: string | null;
  kind: string;
  r2Key: string | null;
}

/**
 * The two server-side reads the worker needs. Kept as an interface so tests
 * inject a fake and exercise the authorization branching without a network.
 */
export interface AssetReadStore {
  /** Locate a version by id alone (no workspace scope; the worker authorizes). */
  findVersion(assetVersionId: string): Promise<AssetVersionLocator | null>;
  /** True iff the user has an active membership in the workspace. */
  isActiveMember(input: { userId: string; workspaceId: string }): Promise<boolean>;
}

/** Mints a presigned GET URL for an object. Implemented by R2StorageClient. */
export interface PresignedUrlSigner {
  presignGetUrl(input: { bucket: string; key: string; expiresInSeconds: number }): Promise<string>;
}

export interface AuthorizeDeps {
  store: AssetReadStore;
  signer: PresignedUrlSigner;
}

export interface SignedUrlResult {
  url: string;
  expires_at: string;
}

/**
 * Authorize the caller for the asset version, then mint the signed URL. The
 * order is fixed: not-found before forbidden, the membership gate always runs
 * before anything is signed, and the stored-file check runs only after the
 * caller is proven a member. Crashes loudly if a located version is missing its
 * workspace - that is a data-integrity fault, not a 404. A link version (or any
 * version with a null r2_key) has no bytes to sign and is a domain error.
 */
export async function authorizeAndSign(
  deps: AuthorizeDeps,
  input: { userId: string; assetVersionId: string },
): Promise<Result<SignedUrlResult, ReadError>> {
  const version = await deps.store.findVersion(input.assetVersionId);
  if (!version) {
    return err({ code: 'not_found', message: 'Asset version not found.' });
  }
  if (!version.workspaceId) {
    throw new Error(`asset_version ${input.assetVersionId} is missing workspace_id`);
  }

  const member = await deps.store.isActiveMember({
    userId: input.userId,
    workspaceId: version.workspaceId,
  });
  if (!member) {
    return err({ code: 'forbidden', message: 'Not a member of this workspace.' });
  }

  if (version.kind === 'link' || version.r2Key === null) {
    return err({ code: 'not_a_stored_file', message: 'Asset version has no stored file to sign.' });
  }
  if (version.bucket === null) {
    throw new Error(`workspace ${version.workspaceId} is missing asset_bucket`);
  }

  const url = await deps.signer.presignGetUrl({
    bucket: version.bucket,
    key: version.r2Key,
    expiresInSeconds: URL_TTL_SECONDS,
  });
  const expires_at = new Date(Date.now() + URL_TTL_SECONDS * 1000).toISOString();
  return ok({ url, expires_at });
}

/**
 * Verify the Bearer token locally (HS256) and return the `sub` claim. Any
 * absent/malformed/expired token is an `unauthorized` Result, never a throw.
 */
export async function verifyCaller(
  request: Request,
  jwtSecret: string,
): Promise<Result<string, ReadError>> {
  const header = request.headers.get('Authorization') ?? request.headers.get('authorization');
  const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
  if (token === '') {
    return err({ code: 'unauthorized', message: 'Missing bearer token.' });
  }
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(jwtSecret), {
      algorithms: ['HS256'],
    });
    if (typeof payload.sub !== 'string' || payload.sub === '') {
      return err({ code: 'unauthorized', message: 'Token has no subject.' });
    }
    return ok(payload.sub);
  } catch {
    return err({ code: 'unauthorized', message: 'Invalid or expired token.' });
  }
}

function json(status: number, body: unknown, traceId: string): Response {
  const headers = new Headers({ 'content-type': 'application/json' });
  headers.set(TRACE_ID_HEADER, traceId);
  return new Response(JSON.stringify(body), { status, headers });
}

function fail(error: ReadError, traceId: string): Response {
  return json(STATUS_BY_CODE[error.code], { error }, traceId);
}

/** Pull the required `asset_version_id` from the JSON body. */
async function readAssetVersionId(request: Request): Promise<Result<string, ReadError>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return err({ code: 'bad_request', message: 'Body must be JSON.' });
  }
  const id =
    typeof body === 'object' && body !== null
      ? (body as Record<string, unknown>).asset_version_id
      : undefined;
  if (typeof id !== 'string' || id === '') {
    return err({ code: 'bad_request', message: 'asset_version_id is required.' });
  }
  return ok(id);
}

/**
 * Service-role-backed store. The service role bypasses RLS; the worker is the
 * only caller and never exposes this key. supabase-js is a stateless HTTP
 * client (no pooled connection to close); it is built per request and discarded
 * when this function returns.
 */
export function createSupabaseAssetReadStore(env: {
  SUPABASE_URL: string;
  SUPABASE_SECRET_KEY: string;
}): AssetReadStore {
  const client: SupabaseClient<Database> = createClient<Database>(
    env.SUPABASE_URL,
    env.SUPABASE_SECRET_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  return {
    async findVersion(assetVersionId) {
      const { data, error } = await client
        .from('asset_versions')
        .select('workspace_id,kind,r2_key,workspaces(asset_bucket)')
        .eq('id', assetVersionId)
        .maybeSingle();
      if (error) {
        throw error;
      }
      if (!data) {
        return null;
      }
      // The embedded workspace carries the bucket; supabase-js types it as an
      // object (to-one) here via the workspace_id FK.
      const workspace = data.workspaces as { asset_bucket: string | null } | null;
      return {
        workspaceId: data.workspace_id,
        bucket: workspace?.asset_bucket ?? null,
        kind: data.kind,
        r2Key: data.r2_key,
      };
    },

    async isActiveMember({ userId, workspaceId }) {
      const { data, error } = await client
        .from('workspace_members')
        .select('id')
        .eq('user_id', userId)
        .eq('workspace_id', workspaceId)
        .eq('active', true)
        .limit(1)
        .maybeSingle();
      if (error) {
        throw error;
      }
      return data !== null;
    },
  };
}

async function handlePost(request: Request, env: AssetReadEnv, traceId: string): Promise<Response> {
  const caller = await verifyCaller(request, env.SUPABASE_JWT_SECRET);
  if (!caller.ok) {
    return fail(caller.error, traceId);
  }

  const parsed = await readAssetVersionId(request);
  if (!parsed.ok) {
    return fail(parsed.error, traceId);
  }

  const result = await authorizeAndSign(
    {
      store: createSupabaseAssetReadStore(env),
      signer: new R2StorageClient(
        {
          CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID,
          CLOUDFLARE_R2_ACCESS_KEY_ID: env.CLOUDFLARE_R2_ACCESS_KEY_ID,
          CLOUDFLARE_R2_SECRET_ACCESS_KEY: env.CLOUDFLARE_R2_SECRET_ACCESS_KEY,
        },
        tracedFetch,
      ),
    },
    { userId: caller.value, assetVersionId: parsed.value },
  );
  if (!result.ok) {
    if (result.error.code === 'forbidden') {
      logger.warn('asset read denied: caller not a workspace member', {
        asset_version_id: parsed.value,
      });
    }
    return fail(result.error, traceId);
  }
  return json(200, result.value, traceId);
}

export default {
  async fetch(request: Request, env: AssetReadEnv): Promise<Response> {
    const traceId = extractTraceId(request);
    logger.setTraceId(traceId);
    try {
      if (request.method !== 'POST') {
        return fail({ code: 'bad_request', message: 'Use POST.' }, traceId);
      }
      return await handlePost(request, env, traceId);
    } catch (error) {
      logger.error('asset read failed', { error: String(error) });
      return json(
        500,
        { error: { code: 'internal_error', message: 'Failed to sign URL.' } },
        traceId,
      );
    } finally {
      logger.clearTraceId();
    }
  },
};
