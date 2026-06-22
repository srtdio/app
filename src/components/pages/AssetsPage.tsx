import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { Chip } from '@/components/ui/Chip';
import { EmptyState } from '@/components/ui/EmptyState';
import { SectionHeader } from '@/components/shell/SectionHeader';
import { IconAssets, IconChevronRight, IconUpload } from '@/components/ui/icons';
import { AssetGrid } from '@/components/pages/assets/AssetGrid';
import { AssetLightbox } from '@/components/pages/assets/AssetLightbox';
import { AssetActionSheet } from '@/components/pages/assets/AssetActionSheet';
import { AssetAddMenu } from '@/components/pages/assets/AssetAddMenu';
import { AssetUploadSheet } from '@/components/pages/assets/AssetUploadSheet';
import { AddLinkSheet } from '@/components/pages/assets/AddLinkSheet';
import { FolderCard } from '@/components/pages/assets/FolderCard';
import { FolderActionSheet } from '@/components/pages/assets/FolderActionSheet';
import { FolderRenameSheet } from '@/components/pages/assets/FolderRenameSheet';
import { NewFolderSheet } from '@/components/pages/assets/NewFolderSheet';
import { Toasts } from '@/components/pages/assets/Toasts';
import { useToasts } from '@/components/pages/assets/useToasts';
import { openLinkInNewTab } from '@/components/pages/assets/openExternal';
import { supabase } from '@/lib/supabase';
import { fetchWithTrace } from '@/lib/fetch';
import { env } from '@/lib/env';
import { useNewTrace } from '@/lib/trace-context';
import { useWorkspace } from '@/lib/workspace-context';
import { useSession } from '@/lib/session-context';
import { useSort } from '@/lib/use-sort';
import { PresignCache } from '@/lib/asset-presign';
import {
  addAssetLink,
  canRenameAssets,
  createFolderRequest,
  deleteFolderRequest,
  renameAsset,
  renameFolderRequest,
  uploadAssetFile,
  type FolderCreateOutcome,
  type FolderDeleteOutcome,
  type FolderRenameOutcome,
  type LinkOutcome,
  type RenameOutcome,
  type UploadOutcome,
} from '@/lib/asset-upload';
import { assetDelete } from '@srtdio/rpc';
import {
  ASSET_SORT_DEFAULT,
  ASSET_SORT_OPTIONS,
  buildKindCounts,
  childFolders,
  fetchFolders,
  fetchMemberRole,
  filterAssets,
  folderBreadcrumb,
  folderChildCount,
  KIND_LABELS,
  listAssets,
  removeAssetsById,
  renameAssetInList,
  sortAssets,
  visibleKinds,
  type AssetListItem,
  type AssetSort,
  type FolderItem,
  type KindFilter,
} from '@/lib/assets';

const SKELETON_COUNT = 12;

/** A viewer target: the index into the navigable list, plus whether Info opens. */
interface ViewerState {
  index: number;
  infoOpen: boolean;
}

export function AssetsPage() {
  const { workspaceId } = useWorkspace();
  const { session } = useSession();
  const newTrace = useNewTrace();
  const userId = session?.user.id ?? null;

  const [items, setItems] = useState<AssetListItem[]>([]);
  const [folders, setFolders] = useState<FolderItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [kind, setKind] = useState<KindFilter>('all');
  const [search, setSearch] = useState('');
  const [folderId, setFolderId] = useState<string | null>(null);
  const [viewer, setViewer] = useState<ViewerState | null>(null);
  const [actionItem, setActionItem] = useState<AssetListItem | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [addLinkOpen, setAddLinkOpen] = useState(false);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [folderAction, setFolderAction] = useState<FolderItem | null>(null);
  const [renameTarget, setRenameTarget] = useState<FolderItem | null>(null);
  const [role, setRole] = useState<string | null>(null);
  const { value: sort, setValue: setSort } = useSort<AssetSort>('assets', ASSET_SORT_DEFAULT);
  const { toasts, push, dismiss } = useToasts();
  const [searchParams, setSearchParams] = useSearchParams();
  const openedAssetParam = useRef<string | null>(null);

  // One presign cache for the whole page: bounds concurrency and caches URLs so
  // the viewer never re-fetches a still-valid link. Rebuilt only if the endpoint
  // changes (effectively never within a session).
  const presignEnabled = env.VITE_ASSET_READ_URL !== undefined;
  const cache = useMemo(
    () =>
      new PresignCache({
        endpoint: env.VITE_ASSET_READ_URL ?? null,
        getAccessToken: async () =>
          (await supabase.auth.getSession()).data.session?.access_token ?? null,
        fetcher: (input, init) => fetchWithTrace(input, init),
      }),
    [],
  );

  const loadAssets = useCallback(async () => {
    if (workspaceId === null) return;
    setLoading(true);
    setError(null);
    const result = await listAssets(supabase, workspaceId);
    setLoading(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setItems(result.data);
  }, [workspaceId]);

  // Load the workspace's folder rows alongside the assets. A failed read leaves
  // the folder list empty (every asset then sits at the root), never blocking the
  // grid, which is why this does not feed the page error banner.
  const loadFolders = useCallback(async () => {
    if (workspaceId === null) return;
    const result = await fetchFolders(supabase, workspaceId);
    if (result.ok) setFolders(result.data);
  }, [workspaceId]);

  useEffect(() => {
    void loadAssets();
    void loadFolders();
  }, [loadAssets, loadFolders]);

  // Reset folder + overlays when the active workspace changes.
  useEffect(() => {
    setFolderId(null);
    setViewer(null);
    setActionItem(null);
    setUploadOpen(false);
    setAddLinkOpen(false);
    setNewFolderOpen(false);
    setFolderAction(null);
    setRenameTarget(null);
  }, [workspaceId]);

  // Resolve the current member's workspace role with one RLS-scoped read (no
  // worker round-trip), so the rename affordance can be gated to owner/admin/
  // agency. A client (or any failed read) leaves the role null and hides edit.
  useEffect(() => {
    if (workspaceId === null || userId === null) {
      setRole(null);
      return;
    }
    let active = true;
    void fetchMemberRole(supabase, workspaceId, userId).then((next) => {
      if (active) setRole(next);
    });
    return () => {
      active = false;
    };
  }, [workspaceId, userId]);

  const canRename = canRenameAssets(role);
  // Folder rename/delete share the asset rename role gate (owner/admin/agency).
  const canManageFolders = canRename;

  const searching = search.trim() !== '';

  // Chip counts reflect what the grid shows: the whole library while searching,
  // otherwise just the open folder's assets.
  const counts = useMemo(
    () => buildKindCounts(searching ? items : items.filter((item) => item.folderId === folderId)),
    [items, searching, folderId],
  );
  const kinds = useMemo(() => visibleKinds(counts), [counts]);

  // If the active kind chip drops to zero (workspace switch, deletion), fall back
  // to All so the grid never silently shows nothing for a hidden chip.
  useEffect(() => {
    if (kind !== 'all' && counts[kind] === 0) setKind('all');
  }, [kind, counts]);

  const visible = useMemo(() => {
    const byKind = filterAssets(items, kind, search);
    const scoped = searching ? byKind : byKind.filter((item) => item.folderId === folderId);
    return sortAssets(scoped, sort);
  }, [items, kind, search, folderId, searching, sort]);

  // The viewer iterates the currently visible list with links excluded; links
  // open their external URL directly and never enter the lightbox.
  const navigable = useMemo(() => visible.filter((item) => item.kind !== 'link'), [visible]);

  // Child folders of the current level (none while searching, which spans folders).
  const currentFolders = useMemo(
    () => (searching ? [] : childFolders(folders, folderId)),
    [folders, folderId, searching],
  );

  const segments = useMemo(() => folderBreadcrumb(folders, folderId), [folders, folderId]);

  // Tap a card: open its external link in a new tab, or open the lightbox at
  // that asset. Opening a link never navigates the current Sorted tab.
  const openAsset = useCallback(
    (item: AssetListItem, infoOpen = false): void => {
      if (item.kind === 'link') {
        if (item.externalUrl !== null) {
          openLinkInNewTab(item.externalUrl);
        }
        return;
      }
      const index = navigable.findIndex((candidate) => candidate.id === item.id);
      if (index >= 0) setViewer({ index, infoOpen });
    },
    [navigable],
  );

  // Email deep-link: ?asset={assetId} opens that asset in the lightbox once the
  // list has loaded. Fired once per distinct id; only 'asset' is stripped,
  // preserving any sibling deep-link param. If the asset is not in the currently
  // loaded/visible set, openAsset no-ops (it can only open a navigable item).
  useEffect(() => {
    if (items.length === 0) return;
    const asset = searchParams.get('asset');
    if (asset === null || asset === '') return;
    if (openedAssetParam.current === asset) return;
    openedAssetParam.current = asset;
    const item = items.find((candidate) => candidate.id === asset);
    if (item !== undefined) openAsset(item);
    const next = new URLSearchParams(searchParams);
    next.delete('asset');
    setSearchParams(next, { replace: true });
  }, [items, searchParams, setSearchParams, openAsset]);

  // Mint an attachment-disposition presigned URL for a stored asset version, so
  // the browser saves the file instead of rendering it. Distinct from the cached
  // inline presign used for in-place viewing; downloads are infrequent and must
  // never be served from (or pollute) the inline-view cache.
  const requestDownloadUrl = useCallback(async (item: AssetListItem): Promise<string> => {
    const endpoint = env.VITE_ASSET_READ_URL;
    if (endpoint === undefined || endpoint === '') {
      throw new Error('Asset read endpoint is not configured.');
    }
    if (item.currentVersionId === null) {
      throw new Error('Asset has no stored version.');
    }
    const token = (await supabase.auth.getSession()).data.session?.access_token ?? null;
    if (token === null || token === '') {
      throw new Error('No active session.');
    }
    const response = await fetchWithTrace(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ asset_version_id: item.currentVersionId, disposition: 'attachment' }),
    });
    if (!response.ok) {
      throw new Error(`Presign failed with status ${response.status}.`);
    }
    const body = (await response.json()) as { url?: unknown };
    if (typeof body.url !== 'string') {
      throw new Error('Presign response was malformed.');
    }
    return body.url;
  }, []);

  // Soft-delete one asset: remove the row optimistically and roll back on
  // failure. Resolves true on success so the viewer can close onto the new list.
  // Delete is offered to every member, matching asset_delete's policy.
  const deleteOne = useCallback(
    async (item: AssetListItem): Promise<boolean> => {
      const snapshot = items;
      setItems((prev) => removeAssetsById(prev, [item.id]));
      const result = await assetDelete(supabase, { p_asset_id: item.id, p_trace_id: newTrace() });
      if (!result.ok) {
        setItems(snapshot);
        return false;
      }
      return true;
    },
    [items, newTrace],
  );

  // Commit one queued file to the asset-upload worker: the user's display name
  // rides along as the multipart filename (the worker persists it as
  // assets.filename for newly stored content). There is no authenticated client
  // write path for assets, so the name cannot be re-applied after the fact (e.g.
  // to a deduped/reused asset); see src/lib/asset-upload.ts for the gap note.
  const uploadEndpoint = env.VITE_ASSET_UPLOAD_URL;
  const handleUploadFile = useCallback(
    async (file: File, filename: string): Promise<UploadOutcome> => {
      if (uploadEndpoint === undefined || uploadEndpoint === '') {
        return { ok: false, message: 'Upload failed. Check your connection and retry' };
      }
      if (workspaceId === null) {
        return { ok: false, message: 'No workspace selected.' };
      }
      const token = (await supabase.auth.getSession()).data.session?.access_token ?? null;
      if (token === null || token === '') {
        return { ok: false, message: 'Your session expired. Sign in again.' };
      }
      return uploadAssetFile(file, {
        endpoint: uploadEndpoint,
        token,
        workspaceId,
        filename,
        fetcher: (input, init) => fetchWithTrace(input, init, newTrace()),
      });
    },
    [uploadEndpoint, workspaceId, newTrace],
  );

  // Add a link asset: POST {workspace_id, url, name} to the worker's /links
  // route. The grid is refreshed by the sheet (onAdded) so the new link shows
  // with the existing link-card rendering.
  const handleAddLink = useCallback(
    async (url: string, name: string): Promise<LinkOutcome> => {
      if (uploadEndpoint === undefined || uploadEndpoint === '') {
        return { ok: false, message: "Couldn't add the link. Check your connection and retry" };
      }
      if (workspaceId === null) {
        return { ok: false, message: 'No workspace selected.' };
      }
      const token = (await supabase.auth.getSession()).data.session?.access_token ?? null;
      if (token === null || token === '') {
        return { ok: false, message: 'Your session expired. Sign in again.' };
      }
      return addAssetLink({
        endpoint: uploadEndpoint,
        token,
        workspaceId,
        url,
        name,
        fetcher: (input, init) => fetchWithTrace(input, init, newTrace()),
      });
    },
    [uploadEndpoint, workspaceId, newTrace],
  );

  // Create a folder under the current level: POST {workspace_id, name, parent_id}
  // to the worker's /folders route. The folder list is refreshed by the sheet
  // (onCreated) so the new folder shows immediately. Allowed for every active
  // member (no role gate on New folder).
  const handleCreateFolder = useCallback(
    async (name: string): Promise<FolderCreateOutcome> => {
      if (uploadEndpoint === undefined || uploadEndpoint === '') {
        return {
          ok: false,
          message: "Couldn't create the folder. Check your connection and retry",
        };
      }
      if (workspaceId === null) {
        return { ok: false, message: 'No workspace selected.' };
      }
      const token = (await supabase.auth.getSession()).data.session?.access_token ?? null;
      if (token === null || token === '') {
        return { ok: false, message: 'Your session expired. Sign in again.' };
      }
      return createFolderRequest({
        endpoint: uploadEndpoint,
        token,
        workspaceId,
        name,
        parentId: folderId,
        fetcher: (input, init) => fetchWithTrace(input, init, newTrace()),
      });
    },
    [uploadEndpoint, workspaceId, folderId, newTrace],
  );

  // Rename one folder via the worker's /folders/rename route. On success the
  // folder list is reloaded so the new name shows; a sibling collision
  // (folder_name_taken) and the 403 role guard are surfaced by the sheet.
  const handleRenameFolder = useCallback(
    async (folder: FolderItem, name: string): Promise<FolderRenameOutcome> => {
      if (uploadEndpoint === undefined || uploadEndpoint === '') {
        return {
          ok: false,
          nameTaken: false,
          message: "Couldn't rename the folder. Check your connection and retry",
        };
      }
      if (workspaceId === null) {
        return { ok: false, nameTaken: false, message: 'No workspace selected.' };
      }
      const token = (await supabase.auth.getSession()).data.session?.access_token ?? null;
      if (token === null || token === '') {
        return { ok: false, nameTaken: false, message: 'Your session expired. Sign in again.' };
      }
      const outcome = await renameFolderRequest({
        endpoint: uploadEndpoint,
        token,
        workspaceId,
        folderId: folder.id,
        name,
        fetcher: (input, init) => fetchWithTrace(input, init, newTrace()),
      });
      if (outcome.ok) void loadFolders();
      return outcome;
    },
    [uploadEndpoint, workspaceId, newTrace, loadFolders],
  );

  // Delete one folder via the worker's /folders/delete route. The worker
  // soft-deletes the folder and detaches its child folders + assets to the root,
  // so on success both the folder list and the asset list are reloaded.
  const handleDeleteFolder = useCallback(
    async (folder: FolderItem): Promise<FolderDeleteOutcome> => {
      if (uploadEndpoint === undefined || uploadEndpoint === '') {
        return {
          ok: false,
          message: "Couldn't delete the folder. Check your connection and retry",
        };
      }
      if (workspaceId === null) {
        return { ok: false, message: 'No workspace selected.' };
      }
      const token = (await supabase.auth.getSession()).data.session?.access_token ?? null;
      if (token === null || token === '') {
        return { ok: false, message: 'Your session expired. Sign in again.' };
      }
      const outcome = await deleteFolderRequest({
        endpoint: uploadEndpoint,
        token,
        workspaceId,
        folderId: folder.id,
        fetcher: (input, init) => fetchWithTrace(input, init, newTrace()),
      });
      if (outcome.ok) {
        void loadFolders();
        void loadAssets();
      }
      return outcome;
    },
    [uploadEndpoint, workspaceId, newTrace, loadFolders, loadAssets],
  );

  // Rename one asset via the worker's /rename route. On success the name is
  // updated in place (grid card + open lightbox) without a full reload; a 403
  // (defense in depth) surfaces the agency-only message.
  const handleRename = useCallback(
    async (item: AssetListItem, name: string): Promise<RenameOutcome> => {
      if (uploadEndpoint === undefined || uploadEndpoint === '') {
        return {
          ok: false,
          message: "Couldn't rename this asset. Check your connection and retry",
        };
      }
      if (workspaceId === null) {
        return { ok: false, message: 'No workspace selected.' };
      }
      const token = (await supabase.auth.getSession()).data.session?.access_token ?? null;
      if (token === null || token === '') {
        return { ok: false, message: 'Your session expired. Sign in again.' };
      }
      const outcome = await renameAsset({
        endpoint: uploadEndpoint,
        token,
        workspaceId,
        assetId: item.id,
        name,
        fetcher: (input, init) => fetchWithTrace(input, init, newTrace()),
      });
      if (outcome.ok) {
        setItems((prev) => renameAssetInList(prev, item.id, name.trim()));
      }
      return outcome;
    },
    [uploadEndpoint, workspaceId, newTrace],
  );

  const listLoading = workspaceId === null || (loading && items.length === 0);
  const viewerItem = viewer !== null ? navigable[viewer.index] : undefined;

  return (
    <>
      {/* Breadcrumb only inside a folder; the root needs no lone "/" crumb. */}
      {!searching && segments.length > 0 ? (
        <div className="px-4 md:px-6 pt-3 flex items-center gap-1 text-sm text-fg-3 flex-wrap">
          <button
            type="button"
            onClick={() => setFolderId(null)}
            className="hover:text-fg transition-colors"
          >
            Assets
          </button>
          {segments.map((segment) => (
            <span key={segment.id} className="flex items-center gap-1">
              <IconChevronRight size={14} className="text-fg-3" />
              <button
                type="button"
                onClick={() => setFolderId(segment.id)}
                className="hover:text-fg transition-colors"
              >
                {segment.name}
              </button>
            </span>
          ))}
        </div>
      ) : null}

      {/* Search + sort + add, then the kind chips: shared page-header chrome. */}
      <SectionHeader<AssetSort>
        search={{ value: search, onChange: setSearch, placeholder: 'Search files' }}
        sort={{ options: ASSET_SORT_OPTIONS, value: sort, onChange: setSort }}
        primaryAction={{
          node: (
            <AssetAddMenu
              onNewFolder={() => setNewFolderOpen(true)}
              onUploadFiles={() => setUploadOpen(true)}
              onAddLink={() => setAddLinkOpen(true)}
            />
          ),
        }}
      >
        <Chip
          label={`All ${counts.all}`}
          selected={kind === 'all'}
          size="tap"
          onClick={() => setKind('all')}
        />
        {kinds.map((k) => (
          <Chip
            key={k}
            label={`${KIND_LABELS[k]} ${counts[k]}`}
            selected={kind === k}
            size="tap"
            onClick={() => setKind(k)}
          />
        ))}
      </SectionHeader>

      {!searching && currentFolders.length > 0 ? (
        <div className="px-4 md:px-6 mt-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-[repeat(auto-fill,minmax(158px,1fr))]">
            {currentFolders.map((f) => (
              <FolderCard
                key={f.id}
                name={f.name}
                count={folderChildCount(folders, items, f.id)}
                onOpen={() => setFolderId(f.id)}
                onManage={canManageFolders ? () => setFolderAction(f) : undefined}
              />
            ))}
          </div>
        </div>
      ) : null}

      {error !== null ? (
        <div className="px-4 md:px-6 mt-4">
          <div role="alert" className="rounded-xl border border-bad px-4 py-3 text-sm text-bad">
            Could not load assets. {error}
          </div>
          <div className="mt-3">
            <Button onClick={() => void loadAssets()}>Retry</Button>
          </div>
        </div>
      ) : listLoading ? (
        <div className="px-4 md:px-6 py-4 grid grid-cols-2 gap-3 md:grid-cols-[repeat(auto-fill,minmax(158px,1fr))]">
          {Array.from({ length: SKELETON_COUNT }).map((_, i) => (
            <div
              key={i}
              className="rounded-xl border border-border bg-panel overflow-hidden animate-pulse"
            >
              <div className="aspect-[4/3] w-full bg-panel-2" />
              <div className="h-9 border-t border-border" />
            </div>
          ))}
        </div>
      ) : items.length === 0 && folders.length === 0 ? (
        <EmptyState
          icon={<IconAssets size={24} />}
          title="No assets yet"
          description="Files and links used in posts and briefs will show up here."
          action={
            <Button variant="primary" onClick={() => setUploadOpen(true)}>
              <IconUpload size={16} />
              Upload
            </Button>
          }
        />
      ) : visible.length === 0 ? (
        searching ? (
          <div className="px-4 md:px-6 py-12 text-center">
            <p className="text-sm text-fg-2">No assets match &quot;{search.trim()}&quot;</p>
            <p className="mt-1 text-xs text-fg-3">Try a different name or clear the search.</p>
          </div>
        ) : currentFolders.length === 0 ? (
          <div className="px-4 md:px-6 py-10 text-sm text-fg-3">This folder is empty.</div>
        ) : null
      ) : (
        <div className="px-4 md:px-6 py-4">
          <AssetGrid
            items={visible}
            presignEnabled={presignEnabled}
            cache={cache}
            onOpen={(item) => openAsset(item)}
            onLongPress={setActionItem}
          />
        </div>
      )}

      {viewer !== null && viewerItem !== undefined ? (
        <AssetLightbox
          items={navigable}
          index={viewer.index}
          presignEnabled={presignEnabled}
          cache={cache}
          requestDownloadUrl={requestDownloadUrl}
          initialInfoOpen={viewer.infoOpen}
          onIndexChange={(index) =>
            setViewer((prev) => (prev === null ? prev : { ...prev, index }))
          }
          onClose={() => setViewer(null)}
          onDelete={deleteOne}
          canRename={canRename}
          onRename={handleRename}
          onToast={push}
        />
      ) : null}

      {actionItem !== null ? (
        <AssetActionSheet
          item={actionItem}
          presignEnabled={presignEnabled}
          cache={cache}
          requestDownloadUrl={requestDownloadUrl}
          onClose={() => setActionItem(null)}
          onInfo={(item) => {
            setActionItem(null);
            openAsset(item, true);
          }}
          onToast={push}
        />
      ) : null}

      <AssetUploadSheet
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        onSubmit={
          uploadEndpoint !== undefined && uploadEndpoint !== '' ? handleUploadFile : undefined
        }
        onToast={push}
        onUploaded={() => void loadAssets()}
      />

      <AddLinkSheet
        open={addLinkOpen}
        onClose={() => setAddLinkOpen(false)}
        onSubmit={handleAddLink}
        onToast={push}
        onAdded={() => void loadAssets()}
      />

      <NewFolderSheet
        open={newFolderOpen}
        onClose={() => setNewFolderOpen(false)}
        onSubmit={handleCreateFolder}
        onToast={push}
        onCreated={() => void loadFolders()}
      />

      {folderAction !== null ? (
        <FolderActionSheet
          name={folderAction.name}
          onClose={() => setFolderAction(null)}
          onRename={() => {
            const f = folderAction;
            setFolderAction(null);
            setRenameTarget(f);
          }}
          onConfirmDelete={() => handleDeleteFolder(folderAction)}
          onToast={push}
        />
      ) : null}

      <FolderRenameSheet
        open={renameTarget !== null}
        initialName={renameTarget?.name ?? ''}
        onClose={() => setRenameTarget(null)}
        onSubmit={(name) => handleRenameFolder(renameTarget!, name)}
        onToast={push}
        onRenamed={() => void loadFolders()}
      />

      <Toasts toasts={toasts} onDismiss={dismiss} />
    </>
  );
}
