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
import {
  err,
  ok,
  type AssetRow,
  type AssetVersionRow,
  type CreateFolderInput,
  type DeleteFolderInput,
  type FolderError,
  type FolderRow,
  type FolderSummary,
  type MoveAssetsInput,
  type RenameFolderInput,
  type Result,
} from './types';

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
  /** An active folder by id, scoped to a workspace (cross-tenant or soft-deleted
   * returns null). The route's parent/target/existence guard. */
  getFolder(workspaceId: string, folderId: string): Promise<FolderRow | null>;
  /** Insert a folder, resolving a sibling-name collision desktop-style (BASE, then
   * "BASE 2", "BASE 3", ...) server-side; never returns folder_name_taken. */
  createFolder(input: CreateFolderInput): Promise<FolderSummary>;
  /** Rename an existing (already-verified) folder; collision -> folder_name_taken. */
  renameFolder(input: RenameFolderInput): Promise<Result<FolderSummary, FolderError>>;
  /** Reparent child folders to root, detach assets, then soft-delete the folder. */
  softDeleteFolderWithDetach(input: DeleteFolderInput): Promise<void>;
  /** Move the in-workspace, live assets among assetIds into a folder; returns the
   * number of rows updated. */
  moveAssetsToFolder(input: MoveAssetsInput): Promise<number>;
  writeAudit(entry: AuditEntry): Promise<void>;
}

/**
 * Write a success folder audit row via the service role, mirroring
 * {@link AssetRepository.writeAudit} but with entity_type 'folder'. Folder writes
 * record success-path rows only.
 */
async function insertFolderAudit(
  client: SupabaseClient<Database>,
  entry: {
    action: string;
    traceId: string;
    workspaceId: string;
    actorUserId: string;
    entityId: string | null;
    payload: Record<string, unknown>;
  },
): Promise<void> {
  const { error } = await client.from('audit_log').insert({
    action: entry.action,
    outcome: 'success',
    trace_id: entry.traceId,
    workspace_id: entry.workspaceId,
    actor_user_id: entry.actorUserId,
    entity_type: 'folder',
    entity_id: entry.entityId,
    payload: entry.payload as Json,
  });
  if (error) {
    throw error;
  }
}

/** PostgREST surfaces a unique-constraint violation (folders_unique_name) as 23505. */
function isUniqueViolation(error: { code?: string } | null): boolean {
  return error?.code === '23505';
}

const FOLDER_COLS = 'id,name,parent_id';

/** folders.name is a 1..80 column; an over-length name would hit the DB CHECK. */
const FOLDER_NAME_MAX = 80;

/** Service-role createFolder retries this many times when a concurrent creator
 * takes the computed name (23505) between the sibling read and the insert. */
const CREATE_FOLDER_MAX_ATTEMPTS = 5;

/**
 * Desktop-style collision resolution: keep BASE when it is free, else the lowest
 * integer N>=2 such that `${BASE} ${N}` is free, all case-insensitive against
 * `lowerNames` (the active siblings' lower(name) values, matching the
 * folders_unique_name shape). The base portion is truncated so the final name
 * never exceeds {@link FOLDER_NAME_MAX}. Mirrors the upload auto-naming convention.
 */
function resolveFolderName(base: string, lowerNames: ReadonlySet<string>): string {
  if (!lowerNames.has(base.toLowerCase())) {
    return base;
  }
  for (let n = 2; ; n += 1) {
    const suffix = ` ${n}`;
    const room = FOLDER_NAME_MAX - suffix.length;
    const truncatedBase = base.length > room ? base.slice(0, room) : base;
    const candidate = `${truncatedBase}${suffix}`;
    if (!lowerNames.has(candidate.toLowerCase())) {
      return candidate;
    }
  }
}

function folderNameTaken(): { ok: false; error: FolderError } {
  return err({
    code: 'folder_name_taken',
    message: 'A folder with this name already exists here.',
  });
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

    async getFolder(workspaceId, folderId) {
      const { data, error } = await client
        .from('folders')
        .select('*')
        .eq('id', folderId)
        .eq('workspace_id', workspaceId)
        .is('deleted_at', null)
        .maybeSingle();
      if (error) {
        throw error;
      }
      return data ?? null;
    },

    async createFolder(input) {
      // Resolve the name desktop-style server-side: read the active siblings in
      // one query, compute BASE / "BASE N", then insert. A concurrent creator may
      // take the computed name between the read and the insert (23505); retry from
      // the read, bounded, rather than loop unbounded.
      for (let attempt = 0; attempt < CREATE_FOLDER_MAX_ATTEMPTS; attempt += 1) {
        let siblingsQuery = client
          .from('folders')
          .select('name')
          .eq('workspace_id', input.workspaceId)
          .is('deleted_at', null);
        siblingsQuery =
          input.parentId === null
            ? siblingsQuery.is('parent_id', null)
            : siblingsQuery.eq('parent_id', input.parentId);
        const { data: siblings, error: siblingsError } = await siblingsQuery;
        if (siblingsError) {
          throw siblingsError;
        }
        const lowerNames = new Set((siblings ?? []).map((row) => row.name.toLowerCase()));
        const name = resolveFolderName(input.name, lowerNames);

        const { data, error } = await client
          .from('folders')
          .insert({
            workspace_id: input.workspaceId,
            name,
            parent_id: input.parentId,
            created_by: input.actorUserId,
          })
          .select(FOLDER_COLS)
          .single();
        if (error) {
          if (isUniqueViolation(error)) {
            continue;
          }
          throw error;
        }
        await insertFolderAudit(client, {
          action: 'folder.create',
          traceId: input.traceId,
          workspaceId: input.workspaceId,
          actorUserId: input.actorUserId,
          entityId: data.id,
          payload: { name: data.name, parent_id: data.parent_id },
        });
        return { id: data.id, name: data.name, parentId: data.parent_id };
      }
      throw new Error('createFolder: could not resolve a unique folder name after retries');
    },

    async renameFolder(input) {
      const { data, error } = await client
        .from('folders')
        .update({ name: input.name, updated_at: new Date().toISOString() })
        .eq('id', input.folderId)
        .eq('workspace_id', input.workspaceId)
        .is('deleted_at', null)
        .select(FOLDER_COLS)
        .single();
      if (error) {
        if (isUniqueViolation(error)) {
          return folderNameTaken();
        }
        throw error;
      }
      await insertFolderAudit(client, {
        action: 'folder.rename',
        traceId: input.traceId,
        workspaceId: input.workspaceId,
        actorUserId: input.actorUserId,
        entityId: data.id,
        payload: { name: data.name },
      });
      return ok({ id: data.id, name: data.name, parentId: data.parent_id });
    },

    async softDeleteFolderWithDetach(input) {
      // PostgREST is per-statement (no transaction), so order the three writes so
      // a partial failure leaves a recoverable state, mirroring createLinkAsset's
      // non-transactional multi-row writes: detach references before the tombstone.
      const now = new Date().toISOString();
      const { error: reparentError } = await client
        .from('folders')
        .update({ parent_id: null, updated_at: now })
        .eq('parent_id', input.folderId)
        .eq('workspace_id', input.workspaceId)
        .is('deleted_at', null);
      if (reparentError) {
        throw reparentError;
      }
      const { error: detachError } = await client
        .from('assets')
        .update({ folder_id: null })
        .eq('folder_id', input.folderId)
        .eq('workspace_id', input.workspaceId)
        .is('deleted_at', null);
      if (detachError) {
        throw detachError;
      }
      const { error: deleteError } = await client
        .from('folders')
        .update({ deleted_at: now, updated_at: now })
        .eq('id', input.folderId)
        .eq('workspace_id', input.workspaceId)
        .is('deleted_at', null);
      if (deleteError) {
        throw deleteError;
      }
      await insertFolderAudit(client, {
        action: 'folder.delete',
        traceId: input.traceId,
        workspaceId: input.workspaceId,
        actorUserId: input.actorUserId,
        entityId: input.folderId,
        payload: {},
      });
    },

    async moveAssetsToFolder(input) {
      // One batch statement (id = ANY(asset_ids)); never a per-id loop.
      const { data, error } = await client
        .from('assets')
        .update({ folder_id: input.targetFolderId })
        .in('id', input.assetIds)
        .eq('workspace_id', input.workspaceId)
        .is('deleted_at', null)
        .select('id');
      if (error) {
        throw error;
      }
      const moved = data?.length ?? 0;
      await insertFolderAudit(client, {
        action: 'folder.move',
        traceId: input.traceId,
        workspaceId: input.workspaceId,
        actorUserId: input.actorUserId,
        entityId: input.targetFolderId,
        payload: { target_folder_id: input.targetFolderId, moved },
      });
      return moved;
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
  readonly folders = new Map<string, FolderRow>();
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

  getFolder(workspaceId: string, folderId: string): Promise<FolderRow | null> {
    const folder = this.folders.get(folderId);
    if (!folder || folder.workspace_id !== workspaceId || folder.deleted_at !== null) {
      return Promise.resolve(null);
    }
    return Promise.resolve(folder);
  }

  /** Active sibling with the same case-insensitive name (the folders_unique_name
   * shape: per workspace + parent, NULL parents not distinct), excluding `exceptId`. */
  private hasNameCollision(
    workspaceId: string,
    parentId: string | null,
    name: string,
    exceptId: string | null,
  ): boolean {
    const lowered = name.toLowerCase();
    for (const folder of this.folders.values()) {
      if (
        folder.id !== exceptId &&
        folder.deleted_at === null &&
        folder.workspace_id === workspaceId &&
        folder.parent_id === parentId &&
        folder.name.toLowerCase() === lowered
      ) {
        return true;
      }
    }
    return false;
  }

  createFolder(input: CreateFolderInput): Promise<FolderSummary> {
    // Mirror the service-role impl: collect the active siblings' lower(name) for
    // this workspace+parent (NULL parents grouped), then resolve desktop-style.
    const lowerNames = new Set<string>();
    for (const folder of this.folders.values()) {
      if (
        folder.deleted_at === null &&
        folder.workspace_id === input.workspaceId &&
        folder.parent_id === input.parentId
      ) {
        lowerNames.add(folder.name.toLowerCase());
      }
    }
    const name = resolveFolderName(input.name, lowerNames);
    const id = globalThis.crypto.randomUUID();
    const now = new Date().toISOString();
    this.folders.set(id, {
      id,
      workspace_id: input.workspaceId,
      name,
      parent_id: input.parentId,
      created_by: input.actorUserId,
      created_at: now,
      updated_at: now,
      deleted_at: null,
    });
    this.audits.push({
      traceId: input.traceId,
      workspaceId: input.workspaceId,
      action: 'folder.create',
      entityId: id,
      actorUserId: input.actorUserId,
      payload: { name, parent_id: input.parentId },
      outcome: 'success',
    });
    return Promise.resolve({ id, name, parentId: input.parentId });
  }

  renameFolder(input: RenameFolderInput): Promise<Result<FolderSummary, FolderError>> {
    const folder = this.folders.get(input.folderId);
    const parentId = folder?.parent_id ?? null;
    if (this.hasNameCollision(input.workspaceId, parentId, input.name, input.folderId)) {
      return Promise.resolve(folderNameTaken());
    }
    if (folder) {
      this.folders.set(folder.id, {
        ...folder,
        name: input.name,
        updated_at: new Date().toISOString(),
      });
    }
    this.audits.push({
      traceId: input.traceId,
      workspaceId: input.workspaceId,
      action: 'folder.rename',
      entityId: input.folderId,
      actorUserId: input.actorUserId,
      payload: { name: input.name },
      outcome: 'success',
    });
    return Promise.resolve(ok({ id: input.folderId, name: input.name, parentId }));
  }

  softDeleteFolderWithDetach(input: DeleteFolderInput): Promise<void> {
    const now = new Date().toISOString();
    // a) reparent child folders to root
    for (const folder of this.folders.values()) {
      if (
        folder.parent_id === input.folderId &&
        folder.workspace_id === input.workspaceId &&
        folder.deleted_at === null
      ) {
        this.folders.set(folder.id, { ...folder, parent_id: null, updated_at: now });
      }
    }
    // b) detach assets to the All assets root
    for (const [id, asset] of this.assets) {
      if (
        asset.folder_id === input.folderId &&
        asset.workspace_id === input.workspaceId &&
        asset.deleted_at === null
      ) {
        this.assets.set(id, { ...asset, folder_id: null });
      }
    }
    // c) soft-delete the folder itself
    const target = this.folders.get(input.folderId);
    if (target && target.workspace_id === input.workspaceId && target.deleted_at === null) {
      this.folders.set(target.id, { ...target, deleted_at: now, updated_at: now });
    }
    this.audits.push({
      traceId: input.traceId,
      workspaceId: input.workspaceId,
      action: 'folder.delete',
      entityId: input.folderId,
      actorUserId: input.actorUserId,
      payload: {},
      outcome: 'success',
    });
    return Promise.resolve();
  }

  moveAssetsToFolder(input: MoveAssetsInput): Promise<number> {
    let moved = 0;
    for (const id of input.assetIds) {
      const asset = this.assets.get(id);
      if (asset && asset.workspace_id === input.workspaceId && asset.deleted_at === null) {
        this.assets.set(id, { ...asset, folder_id: input.targetFolderId });
        moved += 1;
      }
    }
    this.audits.push({
      traceId: input.traceId,
      workspaceId: input.workspaceId,
      action: 'folder.move',
      entityId: input.targetFolderId ?? '',
      actorUserId: input.actorUserId,
      payload: { target_folder_id: input.targetFolderId, moved },
      outcome: 'success',
    });
    return Promise.resolve(moved);
  }

  writeAudit(entry: AuditEntry): Promise<void> {
    this.audits.push({ ...entry, outcome: 'success' });
    return Promise.resolve();
  }
}
