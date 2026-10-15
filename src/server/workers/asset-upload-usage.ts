// Workspace storage usage for the asset-upload Worker's GET /usage route.
//
// Usage is the workspace R2 bucket's stored payload, read from the Cloudflare
// GraphQL Analytics dataset r2StorageAdaptiveGroups (latest datetime first).
// Warn only: no blocking, no billing. The answer is cached per bucket for 5
// minutes through the Workers Cache API. A Cloudflare failure is a domain error
// (never a made-up number), and the UI then shows nothing.
//
// Exempt = the workspace owner is an active platform_operator; exempt never
// warns. The operator read is a service-role select; if that read is refused
// the owner still counts as exempt when they own more than one active
// workspace, which only the workspaces_owner_limit trigger's exemption allows.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@srtdio/schemas';
import { TRACE_ID_HEADER } from '@/lib/trace';
import { tracedFetch } from '@/server/traced-fetch';
import { logger } from '@/server/logger';

/** One warning, at 800 MB of the 1 GB free allowance. */
export const WARN_AT_BYTES = 800 * 1024 * 1024;

/** Per-bucket cache lifetime: 5 minutes. */
export const USAGE_CACHE_SECONDS = 300;

const CLOUDFLARE_GRAPHQL_URL = 'https://api.cloudflare.com/client/v4/graphql';

/** How far back to look for the latest storage sample. */
const LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

export interface UsageBody {
  usedBytes: number;
  warnAtBytes: number;
  warn: boolean;
  exempt: boolean;
}

export type UsageErrorCode = 'usage_unavailable' | 'not_found';

export type UsageResult =
  | { ok: true; value: UsageBody }
  | { ok: false; error: { code: UsageErrorCode; message: string } };

/** The response body for a usage reading. Exempt owners never warn. */
export function usageBody(usedBytes: number, exempt: boolean): UsageBody {
  return {
    usedBytes,
    warnAtBytes: WARN_AT_BYTES,
    warn: !exempt && usedBytes >= WARN_AT_BYTES,
    exempt,
  };
}

/** The slice of the Workers Cache API this route uses. */
export interface UsageCache {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

/** The Worker's default cache, or null outside the Workers runtime. */
export function defaultUsageCache(): UsageCache | null {
  const store = (globalThis as { caches?: { default?: UsageCache } }).caches;
  return store?.default ?? null;
}

/** The workspace facts the route needs, read with the service role. */
export interface UsageStore {
  workspace(workspaceId: string): Promise<{ bucket: string | null; ownerUserId: string } | null>;
  isExemptOwner(ownerUserId: string): Promise<boolean>;
}

export function createSupabaseUsageStore(
  env: { SUPABASE_URL: string; SUPABASE_SECRET_KEY: string },
  traceId: string,
): UsageStore {
  const client: SupabaseClient<Database> = createClient<Database>(
    env.SUPABASE_URL,
    env.SUPABASE_SECRET_KEY,
    {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { [TRACE_ID_HEADER]: traceId } },
    },
  );
  return {
    async workspace(workspaceId) {
      const { data, error } = await client
        .from('workspaces')
        .select('asset_bucket,owner_user_id')
        .eq('id', workspaceId)
        .is('deleted_at', null)
        .maybeSingle();
      if (error) throw error;
      return data ? { bucket: data.asset_bucket, ownerUserId: data.owner_user_id } : null;
    },
    async isExemptOwner(ownerUserId) {
      const operator = await client
        .from('platform_operators')
        .select('user_id')
        .eq('user_id', ownerUserId)
        .is('revoked_at', null)
        .maybeSingle();
      if (!operator.error) return operator.data !== null;
      const owned = await client
        .from('workspaces')
        .select('id', { count: 'exact', head: true })
        .eq('owner_user_id', ownerUserId)
        .is('deleted_at', null);
      if (owned.error) throw owned.error;
      return (owned.count ?? 0) > 1;
    },
  };
}

export interface CloudflareAnalyticsEnv {
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_ANALYTICS_TOKEN?: string;
}

type Fetcher = (input: string, init: RequestInit) => Promise<Response>;

const R2_STORAGE_QUERY = `query R2Storage($accountTag: string!, $bucket: string!, $start: Time!, $end: Time!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      r2StorageAdaptiveGroups(
        limit: 1
        filter: { bucketName: $bucket, datetime_geq: $start, datetime_leq: $end }
        orderBy: [datetime_DESC]
      ) {
        max { payloadSize }
        dimensions { datetime }
      }
    }
  }
}`;

/** Pull payloadSize out of a GraphQL response; null when it is malformed or errored. */
export function parseR2StorageBytes(body: unknown): number | null {
  if (typeof body !== 'object' || body === null) return null;
  const record = body as {
    errors?: unknown;
    data?: {
      viewer?: {
        accounts?: { r2StorageAdaptiveGroups?: { max?: { payloadSize?: unknown } }[] }[];
      };
    };
  };
  if (Array.isArray(record.errors) && record.errors.length > 0) return null;
  const accounts = record.data?.viewer?.accounts;
  if (!Array.isArray(accounts)) return null;
  const groups = accounts[0]?.r2StorageAdaptiveGroups;
  if (!Array.isArray(groups)) return null;
  // No sample in the window: the bucket holds nothing yet.
  if (groups.length === 0) return 0;
  const size = groups[0]?.max?.payloadSize;
  return typeof size === 'number' && Number.isFinite(size) && size >= 0 ? size : null;
}

/** The bucket's latest stored payload in bytes, or null when Cloudflare cannot answer. */
export async function fetchR2BucketBytes(input: {
  env: CloudflareAnalyticsEnv;
  bucket: string;
  traceId: string;
  now: Date;
  fetcher?: Fetcher;
}): Promise<number | null> {
  const accountTag = input.env.CLOUDFLARE_ACCOUNT_ID;
  const token = input.env.CLOUDFLARE_ANALYTICS_TOKEN;
  if (!accountTag || !token) {
    logger.warn('usage: Cloudflare analytics secrets are not set');
    return null;
  }
  const fetcher: Fetcher = input.fetcher ?? ((url, init) => tracedFetch(url, init, input.traceId));
  try {
    const response = await fetcher(CLOUDFLARE_GRAPHQL_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        query: R2_STORAGE_QUERY,
        variables: {
          accountTag,
          bucket: input.bucket,
          start: new Date(input.now.getTime() - LOOKBACK_MS).toISOString(),
          end: input.now.toISOString(),
        },
      }),
    });
    if (!response.ok) {
      logger.warn('usage: Cloudflare analytics returned an error', { status: response.status });
      return null;
    }
    const bytes = parseR2StorageBytes(await response.json());
    if (bytes === null) logger.warn('usage: Cloudflare analytics response was unusable');
    return bytes;
  } catch (error) {
    logger.warn('usage: Cloudflare analytics unreachable', { error: String(error) });
    return null;
  }
}

function cacheKey(bucket: string): Request {
  return new Request(`https://asset-upload.cache/usage/${encodeURIComponent(bucket)}`);
}

/** The bucket's bytes, served from the 5 minute per-bucket cache when warm. */
export async function cachedBucketBytes(
  bucket: string,
  cache: UsageCache | null,
  load: () => Promise<number | null>,
): Promise<number | null> {
  if (cache !== null) {
    const hit = await cache.match(cacheKey(bucket));
    if (hit !== undefined) {
      const body = (await hit.json()) as { usedBytes?: unknown };
      if (typeof body.usedBytes === 'number') return body.usedBytes;
    }
  }
  const bytes = await load();
  // Only a real reading is cached; a failure retries on the next request.
  if (bytes !== null && cache !== null) {
    await cache.put(
      cacheKey(bucket),
      new Response(JSON.stringify({ usedBytes: bytes }), {
        headers: {
          'content-type': 'application/json',
          'cache-control': `max-age=${USAGE_CACHE_SECONDS}`,
        },
      }),
    );
  }
  return bytes;
}

/**
 * Resolve a workspace's usage once the caller is verified as an active member.
 * A workspace with no bucket yet has stored nothing (0 bytes, no Cloudflare call).
 */
export async function resolveWorkspaceUsage(input: {
  workspaceId: string;
  store: UsageStore;
  cache: UsageCache | null;
  readBytes: (bucket: string) => Promise<number | null>;
}): Promise<UsageResult> {
  const workspace = await input.store.workspace(input.workspaceId);
  if (workspace === null) {
    return { ok: false, error: { code: 'not_found', message: 'Workspace not found.' } };
  }
  const exempt = await input.store.isExemptOwner(workspace.ownerUserId);
  const bucket = workspace.bucket;
  if (bucket === null) return { ok: true, value: usageBody(0, exempt) };
  const bytes = await cachedBucketBytes(bucket, input.cache, () => input.readBytes(bucket));
  if (bytes === null) {
    return {
      ok: false,
      error: { code: 'usage_unavailable', message: 'Storage usage is unavailable right now.' },
    };
  }
  return { ok: true, value: usageBody(bytes, exempt) };
}
