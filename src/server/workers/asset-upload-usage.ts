// Workspace storage usage and the storage cap for the asset-upload Worker.
//
// Usage is the workspace's stored bytes, read with the service role through the
// workspace_bytes_used RPC. GET /usage reports it (warn only). Every upload
// (library or chat, direct or resumable) passes checkWorkspaceCap before any
// bytes are stored. A failed read is a domain error (never a made-up number):
// GET /usage then shows nothing and an upload is refused.
//
// Exempt = the workspace owner is an active platform_operators row (a
// service-role read); exempt never warns and is never capped. A failed read is
// not exempt.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@srtdio/schemas';
import { workspaceBytesUsed } from '@srtdio/rpc';
import { TRACE_ID_HEADER } from '@/lib/trace';
import { err, ok, type Result } from '@/server/assets';
import { logger } from '@/server/logger';
import { WORKSPACE_FULL_BODY } from './asset-upload-purge-contracts';

import { CAP_BYTES, WARN_AT_BYTES } from '@/lib/storage-limits';

export { CAP_BYTES, WARN_AT_BYTES };

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

export type CapErrorCode = UsageErrorCode | 'workspace_full';

const USAGE_UNAVAILABLE = {
  code: 'usage_unavailable',
  message: 'Storage usage is unavailable right now.',
} as const;

/** The response body for a usage reading. Exempt owners never warn. */
export function usageBody(usedBytes: number, exempt: boolean): UsageBody {
  return {
    usedBytes,
    warnAtBytes: WARN_AT_BYTES,
    warn: !exempt && usedBytes >= WARN_AT_BYTES,
    exempt,
  };
}

/** The workspace facts usage needs, read with the service role. */
export interface UsageStore {
  workspace(workspaceId: string): Promise<{ ownerUserId: string } | null>;
  isExemptOwner(ownerUserId: string): Promise<boolean>;
  /** Stored bytes, or null when the read failed. */
  bytesUsed(workspaceId: string): Promise<number | null>;
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
        .select('owner_user_id')
        .eq('id', workspaceId)
        .is('deleted_at', null)
        .maybeSingle();
      if (error) throw error;
      return data ? { ownerUserId: data.owner_user_id } : null;
    },
    async isExemptOwner(ownerUserId) {
      const { data, error } = await client
        .from('platform_operators')
        .select('user_id')
        .eq('user_id', ownerUserId)
        .is('revoked_at', null)
        .maybeSingle();
      if (error) {
        // Never guess: a failed read is not exempt.
        logger.warn('usage: platform_operators read failed', { error: error.message });
        return false;
      }
      return data !== null;
    },
    async bytesUsed(workspaceId) {
      // The proc takes no p_trace_id; the trace rides on the client's X-Trace-Id header.
      const result = await workspaceBytesUsed(client, { p_workspace_id: workspaceId });
      if (!result.ok) {
        logger.warn('usage: workspace_bytes_used failed', { error: result.error.message });
        return null;
      }
      const bytes = Number(result.data);
      if (Number.isFinite(bytes) && bytes >= 0) return bytes;
      logger.warn('usage: workspace_bytes_used answer was unusable');
      return null;
    },
  };
}

/** Resolve a workspace's usage once the caller is verified as an active member. */
export async function resolveWorkspaceUsage(input: {
  workspaceId: string;
  store: UsageStore;
}): Promise<UsageResult> {
  const workspace = await input.store.workspace(input.workspaceId);
  if (workspace === null) {
    return { ok: false, error: { code: 'not_found', message: 'Workspace not found.' } };
  }
  const [exempt, bytes] = await Promise.all([
    input.store.isExemptOwner(workspace.ownerUserId),
    input.store.bytesUsed(input.workspaceId),
  ]);
  if (bytes === null) {
    return { ok: false, error: { ...USAGE_UNAVAILABLE } };
  }
  return { ok: true, value: usageBody(bytes, exempt) };
}

/**
 * Whether addBytes more fit the workspace. Exactly at the cap fits; one byte
 * over is workspace_full. Run after auth + membership, before any bytes are
 * stored. Fail closed: a usage read that fails refuses the upload
 * (usage_unavailable), matching GET /usage, which never makes up a number.
 */
export async function checkWorkspaceCap(input: {
  workspaceId: string;
  addBytes: number;
  store: UsageStore;
}): Promise<Result<null, { code: CapErrorCode; message: string }>> {
  const workspace = await input.store.workspace(input.workspaceId);
  if (workspace === null) {
    return err({ code: 'not_found', message: 'Workspace not found.' });
  }
  if (await input.store.isExemptOwner(workspace.ownerUserId)) return ok(null);
  const bytes = await input.store.bytesUsed(input.workspaceId);
  if (bytes === null) {
    return err({ ...USAGE_UNAVAILABLE });
  }
  if (bytes + input.addBytes > CAP_BYTES) return err({ ...WORKSPACE_FULL_BODY.error });
  return ok(null);
}
