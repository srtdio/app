// Persistence boundary for assets.
//
// All writes go through the Worker's service-role Supabase client - the
// authenticated role has no write grants on these tables (and PR 5 revokes any
// remaining ones). The pipeline depends only on AssetRepository, so tests use an
// in-memory implementation. Every mutation records an audit row carrying the
// request trace_id. Reads are always scoped by workspace_id, which is how
// cross-tenant access is denied at the API layer.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from '@srtdio/schemas';
import type { AssetRow, AssetVersionRow } from './types';

/** The asset_versions.kind values that are backed by stored bytes (not links). */
export type FileVersionKind =
  | 'image'
  | 'video'
  | 'audio'
  | 'pdf'
  | 'document'
  | 'spreadsheet'
  | 'presentation';

const FILE_VERSION_KINDS: readonly FileVersionKind[] = [
  'image',
  'video',
  'audio',
  'pdf',
  'document',
  'spreadsheet',
  'presentation',
];

function isFileVersionKind(kind: string): kind is FileVersionKind {
  return (FILE_VERSION_KINDS as readonly string[]).includes(kind);
}

/** A stored-file version: bytes live in R2, so the byte columns are all set. */
export interface FileVersionRef {
  id: string;
  assetId: string;
  versionNumber: number;
  kind: FileVersionKind;
  sha256: string;
  r2Key: string;
  mimeType: string;
  sizeBytes: number;
  externalUrl: null;
}

/** A link version: no bytes, only an external URL. */
export interface LinkVersionRef {
  id: string;
  assetId: string;
  versionNumber: number;
  kind: 'link';
  externalUrl: string;
}

/**
 * A version with the columns the pipeline reasons about, discriminated on
 * `kind` so the byte fields are reachable only on the file variant.
 */
export type VersionRef = FileVersionRef | LinkVersionRef;

/** Narrow a {@link VersionRef} to its stored-file variant. */
export function isFileVersionRef(ref: VersionRef): ref is FileVersionRef {
  return ref.kind !== 'link';
}

export interface NewAsset {
  id: string;
  workspaceId: string;
  filename: string;
  uploadedBy: string;
  folderPath?: string;
  tags?: string[];
}

/** A new stored-file version: bytes live in R2, so the byte columns are set. */
export interface NewFileVersion {
  id: string;
  assetId: string;
  workspaceId: string;
  versionNumber: number;
  kind: FileVersionKind;
  r2Key: string;
  mimeType: string;
  sha256: string;
  sizeBytes: number;
  uploadedBy: string;
  width?: number | null;
  height?: number | null;
  durationMs?: number | null;
}

/** A new link version: only an external URL, every byte column null. */
export interface NewLinkVersion {
  id: string;
  assetId: string;
  workspaceId: string;
  versionNumber: number;
  kind: 'link';
  externalUrl: string;
  uploadedBy: string;
}

/** A version to insert, discriminated on `kind` so the byte fields are reachable
 * only on the file variant (the DB's kind_shape_check enforces the same split). */
export type NewVersion = NewFileVersion | NewLinkVersion;

function isNewLinkVersion(version: NewVersion): version is NewLinkVersion {
  return version.kind === 'link';
}

/**
 * The kind-dependent columns of an asset_versions row. A link sets external_url
 * and nulls every byte column; a stored file does the reverse. Centralized so
 * the service-role and in-memory repositories cannot drift from the DB CHECK.
 */
function versionShapeColumns(version: NewVersion): {
  external_url: string | null;
  r2_key: string | null;
  mime_type: string | null;
  sha256: string | null;
  size_bytes: number | null;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
} {
  if (isNewLinkVersion(version)) {
    return {
      external_url: version.externalUrl,
      r2_key: null,
      mime_type: null,
      sha256: null,
      size_bytes: null,
      width: null,
      height: null,
      duration_ms: null,
    };
  }
  return {
    external_url: null,
    r2_key: version.r2Key,
    mime_type: version.mimeType,
    sha256: version.sha256,
    size_bytes: version.sizeBytes,
    width: version.width ?? null,
    height: version.height ?? null,
    duration_ms: version.durationMs ?? null,
  };
}

/** An active workspace membership: just the role the authz layer gates on. */
export interface Membership {
  role: string;
}

export interface AuditEntry {
  traceId: string;
  workspaceId: string;
  action: string;
  entityId: string;
  /** The authenticated uploader (JWT sub) that caused this write. */
  actorUserId: string;
  payload?: Record<string, unknown>;
}

export interface AssetRepository {
  /** The workspace's permanent, stored R2 bucket name (workspaces.asset_bucket). */
  getAssetBucket(workspaceId: string): Promise<string>;
  getAsset(workspaceId: string, assetId: string): Promise<AssetRow | null>;
  /** A version by id, scoped to a workspace (cross-tenant reads return null). */
  getVersionById(workspaceId: string, versionId: string): Promise<VersionRef | null>;
  /** Existing version anywhere in the workspace with this content hash (dedup). */
  findVersionBySha(workspaceId: string, sha256: string): Promise<VersionRef | null>;
  /** Existing version of a specific asset with this content hash. */
  findVersionByShaForAsset(assetId: string, sha256: string): Promise<VersionRef | null>;
  maxVersionNumber(assetId: string): Promise<number>;
  /** The caller's active membership in the workspace, or null when not a member.
   * One round trip: returns the role the rename authz check gates on. */
  getMembership(workspaceId: string, userId: string): Promise<Membership | null>;
  insertAsset(asset: NewAsset): Promise<void>;
  insertVersion(version: NewVersion): Promise<void>;
  setCurrentVersion(assetId: string, versionId: string): Promise<void>;
  /** Update assets.filename only, scoped to the workspace. Touches no version
   * rows and no attachments. */
  renameAsset(workspaceId: string, assetId: string, filename: string): Promise<void>;
  writeAudit(entry: AuditEntry): Promise<void>;
}

function toVersionRef(row: AssetVersionRow): VersionRef {
  if (row.kind === 'link') {
    if (row.external_url === null) {
      throw new Error(`asset_version ${row.id} is kind=link but external_url is null`);
    }
    return {
      id: row.id,
      assetId: row.asset_id,
      versionNumber: row.version_number,
      kind: 'link',
      externalUrl: row.external_url,
    };
  }
  if (!isFileVersionKind(row.kind)) {
    throw new Error(`asset_version ${row.id} has unrecognized kind ${row.kind}`);
  }
  if (
    row.sha256 === null ||
    row.r2_key === null ||
    row.mime_type === null ||
    row.size_bytes === null
  ) {
    throw new Error(`asset_version ${row.id} (kind=${row.kind}) is missing a file byte column`);
  }
  return {
    id: row.id,
    assetId: row.asset_id,
    versionNumber: row.version_number,
    kind: row.kind,
    sha256: row.sha256,
    r2Key: row.r2_key,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    externalUrl: null,
  };
}

const VERSION_COLS =
  'id,asset_id,version_number,kind,external_url,sha256,r2_key,mime_type,size_bytes';

export interface SupabaseAssetEnv {
  SUPABASE_URL: string;
  SUPABASE_SECRET_KEY: string;
}

/**
 * Build a service-role-backed repository. The service role bypasses RLS; the
 * Worker is the only caller and never exposes this key to the browser.
 */
export function createSupabaseAssetRepository(env: SupabaseAssetEnv): AssetRepository {
  const client: SupabaseClient<Database> = createClient<Database>(
    env.SUPABASE_URL,
    env.SUPABASE_SECRET_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  return {
    async getAssetBucket(workspaceId) {
      const { data, error } = await client
        .from('workspaces')
        .select('asset_bucket')
        .eq('id', workspaceId)
        .maybeSingle();
      if (error) {
        throw error;
      }
      if (!data || data.asset_bucket === null) {
        throw new Error(`workspace ${workspaceId} has no asset_bucket`);
      }
      return data.asset_bucket;
    },

    async getAsset(workspaceId, assetId) {
      const { data, error } = await client
        .from('assets')
        .select('*')
        .eq('id', assetId)
        .eq('workspace_id', workspaceId)
        .is('deleted_at', null)
        .maybeSingle();
      if (error) {
        throw error;
      }
      return data ?? null;
    },

    async getVersionById(workspaceId, versionId) {
      const { data, error } = await client
        .from('asset_versions')
        .select(VERSION_COLS)
        .eq('id', versionId)
        .eq('workspace_id', workspaceId)
        .maybeSingle();
      if (error) {
        throw error;
      }
      return data ? toVersionRef(data as unknown as AssetVersionRow) : null;
    },

    async findVersionBySha(workspaceId, sha256) {
      const { data, error } = await client
        .from('asset_versions')
        .select(VERSION_COLS)
        .eq('workspace_id', workspaceId)
        .eq('sha256', sha256)
        .order('version_number', { ascending: true })
        .limit(1)
        .maybeSingle();
      if (error) {
        throw error;
      }
      return data ? toVersionRef(data as unknown as AssetVersionRow) : null;
    },

    async findVersionByShaForAsset(assetId, sha256) {
      const { data, error } = await client
        .from('asset_versions')
        .select(VERSION_COLS)
        .eq('asset_id', assetId)
        .eq('sha256', sha256)
        .limit(1)
        .maybeSingle();
      if (error) {
        throw error;
      }
      return data ? toVersionRef(data as unknown as AssetVersionRow) : null;
    },

    async maxVersionNumber(assetId) {
      const { data, error } = await client
        .from('asset_versions')
        .select('version_number')
        .eq('asset_id', assetId)
        .order('version_number', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) {
        throw error;
      }
      return data?.version_number ?? 0;
    },

    async insertAsset(asset) {
      const { error } = await client.from('assets').insert({
        id: asset.id,
        workspace_id: asset.workspaceId,
        filename: asset.filename,
        uploaded_by: asset.uploadedBy,
        folder_path: asset.folderPath ?? '/',
        tags: asset.tags ?? [],
      });
      if (error) {
        throw error;
      }
    },

    async getMembership(workspaceId, userId) {
      const { data, error } = await client
        .from('workspace_members')
        .select('role')
        .eq('workspace_id', workspaceId)
        .eq('user_id', userId)
        .eq('active', true)
        .limit(1)
        .maybeSingle();
      if (error) {
        throw error;
      }
      return data ? { role: data.role } : null;
    },

    async insertVersion(version) {
      const { error } = await client.from('asset_versions').insert({
        id: version.id,
        asset_id: version.assetId,
        workspace_id: version.workspaceId,
        version_number: version.versionNumber,
        kind: version.kind,
        uploaded_by: version.uploadedBy,
        ...versionShapeColumns(version),
      });
      if (error) {
        throw error;
      }
    },

    async setCurrentVersion(assetId, versionId) {
      const { error } = await client
        .from('assets')
        .update({ current_version_id: versionId })
        .eq('id', assetId);
      if (error) {
        throw error;
      }
    },

    async renameAsset(workspaceId, assetId, filename) {
      const { error } = await client
        .from('assets')
        .update({ filename })
        .eq('id', assetId)
        .eq('workspace_id', workspaceId);
      if (error) {
        throw error;
      }
    },

    async writeAudit(entry) {
      // Direct insert via the service role (RLS bypassed). audit_log_write is the
      // authenticated path; the Worker has no auth.uid(), so actor_user_id is
      // threaded explicitly from the verified JWT sub, as is trace_id. Swapped
      // for the @srtdio/rpc helper once it lands.
      const { error } = await client.from('audit_log').insert({
        action: entry.action,
        outcome: 'success',
        trace_id: entry.traceId,
        workspace_id: entry.workspaceId,
        actor_user_id: entry.actorUserId,
        entity_type: 'asset',
        entity_id: entry.entityId,
        payload: (entry.payload ?? null) as Json,
      });
      if (error) {
        throw error;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// In-memory implementation for tests.
// ---------------------------------------------------------------------------

export interface AuditRecord extends AuditEntry {
  outcome: 'success';
}

export class InMemoryAssetRepository implements AssetRepository {
  readonly assets = new Map<string, AssetRow>();
  readonly versions: AssetVersionRow[] = [];
  readonly audits: AuditRecord[] = [];
  /** Active memberships keyed by `${userId}:${workspaceId}` -> role. */
  readonly memberships = new Map<string, string>();
  /** Stand-in for the stored workspaces.asset_bucket. Per-workspace overrides
   * fall back to {@link assetBucket}, the default used by most tests. */
  assetBucket = 'assets-test-ws';
  readonly assetBuckets = new Map<string, string>();

  getAssetBucket(workspaceId: string): Promise<string> {
    return Promise.resolve(this.assetBuckets.get(workspaceId) ?? this.assetBucket);
  }

  getAsset(workspaceId: string, assetId: string): Promise<AssetRow | null> {
    const asset = this.assets.get(assetId);
    if (!asset || asset.workspace_id !== workspaceId || asset.deleted_at !== null) {
      return Promise.resolve(null);
    }
    return Promise.resolve(asset);
  }

  getVersionById(workspaceId: string, versionId: string): Promise<VersionRef | null> {
    const match = this.versions.find((v) => v.id === versionId && v.workspace_id === workspaceId);
    return Promise.resolve(match ? toVersionRef(match) : null);
  }

  findVersionBySha(workspaceId: string, sha256: string): Promise<VersionRef | null> {
    const match = this.versions
      .filter((v) => v.workspace_id === workspaceId && v.sha256 === sha256)
      .sort((a, b) => a.version_number - b.version_number)[0];
    return Promise.resolve(match ? toVersionRef(match) : null);
  }

  findVersionByShaForAsset(assetId: string, sha256: string): Promise<VersionRef | null> {
    const match = this.versions.find((v) => v.asset_id === assetId && v.sha256 === sha256);
    return Promise.resolve(match ? toVersionRef(match) : null);
  }

  maxVersionNumber(assetId: string): Promise<number> {
    const max = this.versions
      .filter((v) => v.asset_id === assetId)
      .reduce((acc, v) => Math.max(acc, v.version_number), 0);
    return Promise.resolve(max);
  }

  getMembership(workspaceId: string, userId: string): Promise<Membership | null> {
    const role = this.memberships.get(`${userId}:${workspaceId}`);
    return Promise.resolve(role !== undefined ? { role } : null);
  }

  insertAsset(asset: NewAsset): Promise<void> {
    const now = new Date().toISOString();
    this.assets.set(asset.id, {
      id: asset.id,
      workspace_id: asset.workspaceId,
      filename: asset.filename,
      display_name: null,
      current_version_id: null,
      folder_id: null,
      folder_path: asset.folderPath ?? '/',
      tags: asset.tags ?? [],
      uploaded_by: asset.uploadedBy,
      uploaded_at: now,
      deleted_at: null,
    });
    return Promise.resolve();
  }

  insertVersion(version: NewVersion): Promise<void> {
    this.versions.push({
      id: version.id,
      asset_id: version.assetId,
      workspace_id: version.workspaceId,
      version_number: version.versionNumber,
      kind: version.kind,
      uploaded_by: version.uploadedBy,
      uploaded_at: new Date().toISOString(),
      ...versionShapeColumns(version),
    });
    return Promise.resolve();
  }

  setCurrentVersion(assetId: string, versionId: string): Promise<void> {
    const asset = this.assets.get(assetId);
    if (asset) {
      this.assets.set(assetId, { ...asset, current_version_id: versionId });
    }
    return Promise.resolve();
  }

  renameAsset(workspaceId: string, assetId: string, filename: string): Promise<void> {
    const asset = this.assets.get(assetId);
    if (asset && asset.workspace_id === workspaceId && asset.deleted_at === null) {
      this.assets.set(assetId, { ...asset, filename });
    }
    return Promise.resolve();
  }

  writeAudit(entry: AuditEntry): Promise<void> {
    this.audits.push({ ...entry, outcome: 'success' });
    return Promise.resolve();
  }
}
