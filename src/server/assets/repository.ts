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

/**
 * Stored-file kinds: their bytes live in R2. Excludes 'link', whose versions
 * carry an external_url and no bytes (kind_shape CHECK enforces this split).
 */
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

interface VersionRefBase {
  id: string;
  assetId: string;
  versionNumber: number;
}

/** A stored-file version: bytes live in R2 under r2Key; never a link. */
export interface FileVersionRef extends VersionRefBase {
  kind: FileVersionKind;
  sha256: string;
  r2Key: string;
  mimeType: string;
  sizeBytes: number;
  externalUrl: null;
}

/** A link version: served from its external_url; carries no R2 bytes. */
export interface LinkVersionRef extends VersionRefBase {
  kind: 'link';
  externalUrl: string;
}

/**
 * A version the pipeline reasons about. Discriminated on `kind`: a file ref
 * carries bytes (r2Key/mimeType/sha256/sizeBytes), a link ref carries
 * externalUrl. The two are never conflated, so callers narrow before reaching
 * for bytes - there is no nullable byte field to defend against downstream.
 */
export type VersionRef = FileVersionRef | LinkVersionRef;

export interface NewAsset {
  id: string;
  workspaceId: string;
  filename: string;
  uploadedBy: string;
  folderPath?: string;
  tags?: string[];
}

export interface NewVersion {
  id: string;
  assetId: string;
  workspaceId: string;
  versionNumber: number;
  /**
   * The stored-file kind. Supplied by the caller (the upload pipeline knows it
   * from the MIME type); never hardcoded here. Link versions are not created
   * through this path - they have no bytes to store - so the kind is narrowed
   * to a file kind.
   */
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

export interface AuditEntry {
  traceId: string;
  workspaceId: string;
  action: string;
  entityId: string;
  payload?: Record<string, unknown>;
}

export interface AssetRepository {
  getAsset(workspaceId: string, assetId: string): Promise<AssetRow | null>;
  /** A version by id, scoped to a workspace (cross-tenant reads return null). */
  getVersionById(workspaceId: string, versionId: string): Promise<VersionRef | null>;
  /**
   * Existing version anywhere in the workspace with this content hash (dedup).
   * A sha256 match is always a stored file - links carry no content hash - so
   * the result is narrowed to a file ref.
   */
  findVersionBySha(workspaceId: string, sha256: string): Promise<FileVersionRef | null>;
  /** Existing version of a specific asset with this content hash. */
  findVersionByShaForAsset(assetId: string, sha256: string): Promise<FileVersionRef | null>;
  maxVersionNumber(assetId: string): Promise<number>;
  insertAsset(asset: NewAsset): Promise<void>;
  insertVersion(version: NewVersion): Promise<void>;
  setCurrentVersion(assetId: string, versionId: string): Promise<void>;
  writeAudit(entry: AuditEntry): Promise<void>;
}

function toVersionRef(row: AssetVersionRow): VersionRef {
  const base: VersionRefBase = {
    id: row.id,
    assetId: row.asset_id,
    versionNumber: row.version_number,
  };

  if (row.kind === 'link') {
    if (row.external_url === null) {
      throw new Error(`asset_version ${row.id} is a link with no external_url`);
    }
    return { ...base, kind: 'link', externalUrl: row.external_url };
  }

  if (!isFileVersionKind(row.kind)) {
    throw new Error(`asset_version ${row.id} has unknown kind '${row.kind}'`);
  }

  // A file-kind row with any null byte-column is a data-integrity fault (the
  // kind_shape CHECK forbids it): crash early rather than fabricate bytes.
  if (
    row.r2_key === null ||
    row.mime_type === null ||
    row.sha256 === null ||
    row.size_bytes === null
  ) {
    throw new Error(`asset_version ${row.id} (kind '${row.kind}') is missing stored-file columns`);
  }

  return {
    ...base,
    kind: row.kind,
    sha256: row.sha256,
    r2Key: row.r2_key,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    externalUrl: null,
  };
}

/**
 * Map a row reached by a sha256 lookup. Such a row is always a stored file -
 * links have a null sha256 and are never sha-matched - so a link here is a
 * data-integrity fault.
 */
function toFileVersionRef(row: AssetVersionRow): FileVersionRef {
  const ref = toVersionRef(row);
  if (ref.kind === 'link') {
    throw new Error(`asset_version ${row.id} matched by sha256 but is a link`);
  }
  return ref;
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
      return data ? toFileVersionRef(data as unknown as AssetVersionRow) : null;
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
      return data ? toFileVersionRef(data as unknown as AssetVersionRow) : null;
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

    async insertVersion(version) {
      const { error } = await client.from('asset_versions').insert({
        id: version.id,
        asset_id: version.assetId,
        workspace_id: version.workspaceId,
        version_number: version.versionNumber,
        // File insert: kind is a stored-file kind and external_url stays null,
        // satisfying the kind_shape CHECK (file => bytes set, external_url null).
        kind: version.kind,
        external_url: null,
        r2_key: version.r2Key,
        mime_type: version.mimeType,
        sha256: version.sha256,
        size_bytes: version.sizeBytes,
        uploaded_by: version.uploadedBy,
        width: version.width ?? null,
        height: version.height ?? null,
        duration_ms: version.durationMs ?? null,
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

    async writeAudit(entry) {
      // Direct insert via the service role (RLS bypassed). audit_log_write is the
      // authenticated path; the Worker has no auth.uid(), so actor_user_id is
      // null and trace_id is carried explicitly. Swapped for the @srtdio/rpc
      // helper once it lands.
      const { error } = await client.from('audit_log').insert({
        action: entry.action,
        outcome: 'success',
        trace_id: entry.traceId,
        workspace_id: entry.workspaceId,
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

  findVersionBySha(workspaceId: string, sha256: string): Promise<FileVersionRef | null> {
    const match = this.versions
      .filter((v) => v.workspace_id === workspaceId && v.sha256 === sha256)
      .sort((a, b) => a.version_number - b.version_number)[0];
    return Promise.resolve(match ? toFileVersionRef(match) : null);
  }

  findVersionByShaForAsset(assetId: string, sha256: string): Promise<FileVersionRef | null> {
    const match = this.versions.find((v) => v.asset_id === assetId && v.sha256 === sha256);
    return Promise.resolve(match ? toFileVersionRef(match) : null);
  }

  maxVersionNumber(assetId: string): Promise<number> {
    const max = this.versions
      .filter((v) => v.asset_id === assetId)
      .reduce((acc, v) => Math.max(acc, v.version_number), 0);
    return Promise.resolve(max);
  }

  insertAsset(asset: NewAsset): Promise<void> {
    const now = new Date().toISOString();
    this.assets.set(asset.id, {
      id: asset.id,
      workspace_id: asset.workspaceId,
      filename: asset.filename,
      current_version_id: null,
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
      external_url: null,
      r2_key: version.r2Key,
      mime_type: version.mimeType,
      sha256: version.sha256,
      size_bytes: version.sizeBytes,
      width: version.width ?? null,
      height: version.height ?? null,
      duration_ms: version.durationMs ?? null,
      uploaded_by: version.uploadedBy,
      uploaded_at: new Date().toISOString(),
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

  writeAudit(entry: AuditEntry): Promise<void> {
    this.audits.push({ ...entry, outcome: 'success' });
    return Promise.resolve();
  }
}
