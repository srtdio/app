import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { appPresignCache } from '@/lib/shared-presign';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadError } from '@/components/ui/LoadError';
import { SectionHeader } from '@/components/shell/SectionHeader';
import { IconAssets, IconUpload } from '@/components/ui/icons';
import { AssetGrid } from '@/components/pages/assets/AssetGrid';
import { AssetLightbox } from '@/components/pages/assets/AssetLightbox';
import { SearchWordsContext } from '@/components/ui/SearchHighlight';
import { useSearchJump } from '@/lib/search/jump';
import { AssetActionSheet } from '@/components/pages/assets/AssetActionSheet';
import { AssetInUseSheet, type AssetInUseState } from '@/components/pages/assets/AssetInUseSheet';
import { AssetAddMenu } from '@/components/pages/assets/AssetAddMenu';
import { AssetUploadSheet } from '@/components/pages/assets/AssetUploadSheet';
import { AddLinkSheet } from '@/components/pages/assets/AddLinkSheet';
import { ASSET_TABPANEL_ID, AssetTabs, assetTabId } from '@/components/pages/assets/AssetTabs';
import { AssetRenameSheet } from '@/components/pages/assets/AssetRenameSheet';
import {
  ASSET_GONE_TOAST,
  ASSET_PARAM,
  RECENTLY_DELETED_LABEL,
  RECENTLY_DELETED_PATH,
  assetParamIsGone,
  deleteFailedLabel,
  deleteToastLabel,
  selectAllCapLabel,
  selectAllIds,
  selectCapLabel,
  selectedLabel,
} from '@/components/pages/assets/assets-nav';
import { useOptionalToast } from '@/components/ui/toast';
import { useUndoableAction } from '@/lib/use-undoable-action';
import { openLinkInNewTab } from '@/components/pages/assets/openExternal';
import { supabase } from '@/lib/supabase';
import { fetchWithTrace } from '@/lib/fetch';
import { env } from '@/lib/env';
import { useNewTrace } from '@/lib/trace-context';
import { useWorkspace } from '@/lib/workspace-context';
import { useSession } from '@/lib/session-context';
import { useSort } from '@/lib/use-sort';
import { useWorkspaceDataChanged } from '@/lib/use-workspace-data-changed';
import { logger } from '@/lib/logger';
import {
  addAssetLink,
  canRenameAssets,
  renameAsset,
  uploadAssetFile,
  type LinkOutcome,
  type RenameOutcome,
  type UploadOutcome,
} from '@/lib/asset-upload';
import { assetDelete, assetDeleteMany } from '@srtdio/rpc';
import {
  ASSET_SORT_DEFAULT,
  ASSET_SORT_OPTIONS,
  BULK_DELETE_MAX,
  ASSET_TAB_DEFAULT,
  buildTabCounts,
  canBulkDelete,
  displayLabel,
  fetchMemberRole,
  filterAssets,
  findAssetsInUse,
  assetInUseMessage,
  inUseKeptLabel,
  inUseTitle,
  isAssetInUseError,
  splitFreeAssets,
  listAssets,
  parseAssetTab,
  removeAssetsById,
  renameAssetInList,
  sortAssets,
  TAB_EMPTY,
  type AssetListItem,
  type AssetSort,
  type AssetTab,
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
  const [loading, setLoading] = useState(false);
  // A failed read of the files is a page load error: the grid and counts never
  // render from a partial read. The cause is logged.
  const [assetsFailed, setAssetsFailed] = useState(false);
  const [assetsLoaded, setAssetsLoaded] = useState(false);
  const [retrying, setRetrying] = useState(false);

  const [search, setSearch] = useState('');
  const [viewer, setViewer] = useState<ViewerState | null>(null);
  // A search jump's words: the viewer's file name keeps them coloured until this page unmounts.
  const searchJump = useSearchJump();
  const [actionItem, setActionItem] = useState<AssetListItem | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [addLinkOpen, setAddLinkOpen] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [renameItem, setRenameItem] = useState<AssetListItem | null>(null);
  // Deleted but still inside the Undo window: hidden from every list until the
  // delete commits (then the rows go) or Undo brings them back.
  const [pendingDelete, setPendingDelete] = useState<ReadonlySet<string>>(() => new Set());
  const [role, setRole] = useState<string | null>(null);
  const [inUse, setInUse] = useState<AssetInUseState | null>(null);
  const navigate = useNavigate();
  const { value: sort, setValue: setSort } = useSort<AssetSort>('assets', ASSET_SORT_DEFAULT);
  // The shell's ui/toast. show is the provider's stable function (the wrapper
  // object is new each render), so callbacks built on it stay stable.
  const showToast = useOptionalToast()?.show;
  const push = useCallback(
    (message: string): void => {
      showToast?.({ title: message });
    },
    [showToast],
  );
  const { run: runUndoable } = useUndoableAction();
  const [searchParams, setSearchParams] = useSearchParams();
  const openedAssetParam = useRef<string | null>(null);

  // The tab lives in ?type= (default All, unknown is All), so it survives Back
  // and refresh. Switching only filters the loaded list: no read, instant.
  const tab = parseAssetTab(searchParams.get('type'));
  const setTab = useCallback(
    (next: AssetTab): void => {
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev);
          if (next === ASSET_TAB_DEFAULT) params.delete('type');
          else params.set('type', next);
          return params;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  // One presign cache for the whole page: bounds concurrency and caches URLs so
  // the viewer never re-fetches a still-valid link. Rebuilt only if the endpoint
  // changes (effectively never within a session).
  const presignEnabled = env.VITE_ASSET_READ_URL !== undefined;
  const cache = appPresignCache();

  const loadAssets = useCallback(async () => {
    if (workspaceId === null) return;
    setLoading(true);
    const result = await listAssets(supabase, workspaceId);
    setLoading(false);
    if (!result.ok) {
      logger.warn('assets: list read failed', { error: result.error.message });
      setAssetsFailed(true);
      return;
    }
    setAssetsFailed(false);
    setItems(result.data);
    setAssetsLoaded(true);
  }, [workspaceId]);

  const retryLoad = useCallback(async () => {
    setRetrying(true);
    try {
      await loadAssets();
    } finally {
      setRetrying(false);
    }
  }, [loadAssets]);

  useEffect(() => {
    void loadAssets();
  }, [loadAssets]);
  useWorkspaceDataChanged(() => {
    void loadAssets();
  });

  // Forget the last workspace's load state when the active workspace changes.
  const lastWorkspace = useRef(workspaceId);
  useEffect(() => {
    const previous = lastWorkspace.current;
    lastWorkspace.current = workspaceId;
    if (previous !== null && previous !== workspaceId) {
      setAssetsLoaded(false);
      setAssetsFailed(false);
    }
  }, [workspaceId]);

  // Reset overlays when the active workspace changes.
  useEffect(() => {
    setViewer(null);
    setActionItem(null);
    setUploadOpen(false);
    setAddLinkOpen(false);
    setSelectMode(false);
    setSelected(new Set());
    setRenameItem(null);
    setPendingDelete(new Set());
    setInUse(null);
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

  const searching = search.trim() !== '';

  // Every list reads the live rows: files inside an Undo window are hidden.
  const liveItems = useMemo(
    () => (pendingDelete.size === 0 ? items : items.filter((item) => !pendingDelete.has(item.id))),
    [items, pendingDelete],
  );

  // Tab counts reflect the whole library. Same loaded list, no extra read.
  const counts = useMemo(() => buildTabCounts(liveItems), [liveItems]);

  const visible = useMemo(
    () => sortAssets(filterAssets(liveItems, tab, search), sort),
    [liveItems, tab, search, sort],
  );

  // The viewer iterates the currently visible list with links excluded; links
  // open their external URL directly and never enter the lightbox.
  const navigable = useMemo(() => visible.filter((item) => item.kind !== 'link'), [visible]);

  // Display labels of the assets already in the library, so the upload sheet
  // continues numbering past them when auto-naming.
  const siblingLabels = useMemo(() => liveItems.map(displayLabel), [liveItems]);

  // Toggle one asset's selection, capping the set at 200 (the delete batch limit);
  // adding past the cap is ignored with a toast rather than silently dropped.
  const toggleSelect = useCallback(
    (item: AssetListItem): void => {
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(item.id)) {
          next.delete(item.id);
          return next;
        }
        if (next.size >= BULK_DELETE_MAX) {
          push(selectCapLabel(BULK_DELETE_MAX));
          return prev;
        }
        next.add(item.id);
        return next;
      });
    },
    [push],
  );

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
  // list has loaded (an empty library counts as loaded). Fired once per distinct
  // id; only 'asset' is stripped, preserving any sibling deep-link param. A
  // copied link (/assets?asset=<id>) lands on the All tab first, so it is in the
  // navigable list when it opens. An id that is not
  // in the library (deleted, or never here) says so, with a way to Recently deleted.
  useEffect(() => {
    if (!assetsLoaded) return;
    const asset = searchParams.get(ASSET_PARAM);
    if (asset === null || asset === '') return;
    if (openedAssetParam.current === asset) return;
    const item = items.find((candidate) => candidate.id === asset);
    if (item !== undefined && item.kind !== 'link' && !searching && tab !== ASSET_TAB_DEFAULT) {
      const next = new URLSearchParams(searchParams);
      next.delete('type');
      setSearchParams(next, { replace: true });
      return;
    }
    openedAssetParam.current = asset;
    if (item !== undefined) openAsset(item);
    else if (assetParamIsGone(assetsLoaded, items, asset)) {
      showToast?.({
        title: ASSET_GONE_TOAST,
        action: { label: RECENTLY_DELETED_LABEL, onPress: () => navigate(RECENTLY_DELETED_PATH) },
      });
    }
    const next = new URLSearchParams(searchParams);
    next.delete(ASSET_PARAM);
    setSearchParams(next, { replace: true });
  }, [
    items,
    assetsLoaded,
    showToast,
    navigate,
    searchParams,
    setSearchParams,
    openAsset,
    tab,
    searching,
  ]);

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

  // A delete refused with asset_in_use: look up where the blocked files are used
  // and open the in-use sheet naming the first one (and how many more). The
  // lookup failing still explains, just without the Open button.
  const showInUse = useCallback(async (ids: string[], snapshot: AssetListItem[]): Promise<void> => {
    const found = await findAssetsInUse(supabase, ids);
    const blocked = found.ok ? found.data : [];
    const firstId = blocked[0]?.assetId ?? ids[0];
    const first = snapshot.find((candidate) => candidate.id === firstId);
    const name = first !== undefined ? displayLabel(first) : '';
    // The copy follows where the first blocked file is used (post, brief or
    // comment); a failed lookup says only that it is in use.
    const kind = blocked[0]?.parent.kind ?? null;
    setInUse({
      title: inUseTitle(kind),
      message: assetInUseMessage(name, Math.max(0, blocked.length - 1), kind),
      parent: blocked[0]?.parent ?? null,
    });
  }, []);

  // Delete files (menu, viewer or select mode): hide them at once and show the
  // Undo toast; the soft-delete RPC runs only when the window ends. Undo, or a
  // failed commit, brings the rows back; asset_in_use opens the in-use sheet.
  // Delete is offered to every member, matching asset_delete's policy.
  const unhide = useCallback((ids: readonly string[]): void => {
    setPendingDelete((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.delete(id);
      return next;
    });
  }, []);

  const itemsRef = useRef(items);
  itemsRef.current = items;

  const deleteItems = useCallback(
    (ids: string[]): void => {
      if (ids.length === 0 || (ids.length > 1 && !canBulkDelete(ids.length))) return;
      setPendingDelete((prev) => new Set([...prev, ...ids]));
      runUndoable({
        label: deleteToastLabel(ids.length),
        revert: () => unhide(ids),
        commit: async () => {
          const traceId = newTrace();
          // asset_delete_many is all-or-nothing: one file in use refuses the
          // whole call. A bulk delete checks once which files are in use, deletes
          // the free ones in one call and keeps the rest, saying how many.
          let targets = ids;
          let kept: string[] = [];
          if (ids.length > 1) {
            const found = await findAssetsInUse(supabase, ids);
            if (found.ok) ({ free: targets, kept } = splitFreeAssets(ids, found.data));
          }
          if (targets.length === 0) {
            unhide(ids);
            await showInUse(ids, itemsRef.current);
            return;
          }
          const [only] = targets;
          const result =
            targets.length === 1 && only !== undefined
              ? await assetDelete(supabase, { p_asset_id: only, p_trace_id: traceId })
              : await assetDeleteMany(supabase, { p_asset_ids: targets, p_trace_id: traceId });
          if (!result.ok) {
            unhide(ids);
            if (isAssetInUseError(result.error)) await showInUse(targets, itemsRef.current);
            else push(deleteFailedLabel(ids.length));
            return;
          }
          setItems((prev) => removeAssetsById(prev, targets));
          unhide(ids);
          if (kept.length > 0) push(inUseKeptLabel(kept.length));
        },
      });
    },
    [runUndoable, unhide, newTrace, showInUse, push],
  );

  const deleteSelected = useCallback((): void => {
    const ids = Array.from(selected);
    if (!canBulkDelete(ids.length)) return;
    setSelectMode(false);
    setSelected(new Set());
    deleteItems(ids);
  }, [selected, deleteItems]);

  // Commit one queued file to the asset-upload worker: the file part keeps its
  // ORIGINAL device name (stored as assets.filename, with its extension for type
  // icons), the sheet's resolved friendly name rides along as display_name, and
  // folder_id is null (the library root). The worker resolves the
  // shown label as display_name ?? filename and now persists display_name on
  // upload (and supports rename), so there is no naming gap to work around.
  const uploadEndpoint = env.VITE_ASSET_UPLOAD_URL;
  const handleUploadFile = useCallback(
    async (
      file: File,
      displayName: string,
      targetFolderId: string | null,
      signal?: AbortSignal,
    ): Promise<UploadOutcome> => {
      if (uploadEndpoint === undefined || uploadEndpoint === '') {
        return { ok: false, message: "Couldn't upload. Try again." };
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
        origin: 'library',
        filename: file.name,
        displayName,
        folderId: targetFolderId,
        // XHR so Stop can abort the request in flight (fetchWithTrace takes no
        // signal); the transport sets X-Trace-Id itself.
        xhr: { traceId: newTrace(), ...(signal !== undefined ? { signal } : {}) },
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
        return { ok: false, message: "Couldn't add the link. Try again." };
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

  // Rename one asset via the worker's /rename route. On success the name is
  // updated in place (grid card + open lightbox) without a full reload; a 403
  // (defense in depth) surfaces the agency-only message.
  const handleRename = useCallback(
    async (item: AssetListItem, name: string): Promise<RenameOutcome> => {
      if (uploadEndpoint === undefined || uploadEndpoint === '') {
        return {
          ok: false,
          message: "Couldn't rename this asset. Try again.",
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

  const exitSelectMode = (): void => {
    setSelectMode(false);
    setSelected(new Set());
  };

  // The round box on a card: one tap starts selecting with that file ticked.
  const startSelectWith = (item: AssetListItem): void => {
    setSelected(new Set([item.id]));
    setSelectMode(true);
  };

  return (
    <>
      {/* Search + sort + add, then the type tabs: shared page-header chrome. */}
      <SectionHeader<AssetSort>
        search={{ value: search, onChange: setSearch, placeholder: 'Search files' }}
        sort={{ options: ASSET_SORT_OPTIONS, value: sort, onChange: setSort }}
        primaryAction={{
          node: (
            <AssetAddMenu
              onUploadFiles={() => setUploadOpen(true)}
              onAddLink={() => setAddLinkOpen(true)}
            />
          ),
        }}
        stickyChildren={selectMode}
      >
        {selectMode ? (
          <div data-select-bar="" className="flex w-full flex-col gap-1">
            <div className="flex w-full items-center gap-2">
              <Button size="lg" variant="ghost" onClick={exitSelectMode}>
                Cancel
              </Button>
              <span
                className="min-w-0 flex-1 truncate text-center text-sm font-semibold text-fg"
                aria-live="polite"
              >
                {selectedLabel(selected.size)}
              </span>
              <Button
                size="lg"
                variant="ghost"
                disabled={visible.length === 0}
                onClick={() => {
                  setSelected(new Set(selectAllIds(visible, BULK_DELETE_MAX)));
                  if (visible.length > BULK_DELETE_MAX) push(selectAllCapLabel(BULK_DELETE_MAX));
                }}
              >
                Select all
              </Button>
              {/* Desktop keeps Delete up here; phones get the bottom bar. */}
              <span className="hidden gap-2 md:flex">
                <Button
                  size="lg"
                  variant="danger"
                  disabled={!canBulkDelete(selected.size)}
                  onClick={deleteSelected}
                >
                  Delete
                </Button>
              </span>
            </div>
            {selected.size > BULK_DELETE_MAX ? (
              <span className="text-center text-xs text-fg-3">
                Select 200 or fewer to delete at once.
              </span>
            ) : null}
          </div>
        ) : assetsFailed ? null : (
          <AssetTabs value={tab} counts={counts} onChange={setTab} />
        )}
      </SectionHeader>

      <div
        role={selectMode ? undefined : 'tabpanel'}
        id={ASSET_TABPANEL_ID}
        aria-labelledby={selectMode ? undefined : assetTabId(tab)}
      >
        {assetsFailed ? (
          <div className="px-4 md:px-6 mt-4">
            <LoadError title="your files" onRetry={() => void retryLoad()} retrying={retrying} />
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
        ) : tab === 'all' && liveItems.length === 0 ? (
          <EmptyState
            icon={<IconAssets size={24} />}
            title="No assets yet"
            description="Upload photos, videos, PDFs and docs, or add a link. Files used in posts and briefs show up here too."
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
          ) : tab !== 'all' ? (
            <div data-asset-tab-empty={tab} className="px-4 md:px-6 py-10 text-sm text-fg-3">
              {TAB_EMPTY[tab]}
            </div>
          ) : null
        ) : (
          <div className="px-4 md:px-6 py-4">
            <AssetGrid
              items={visible}
              presignEnabled={presignEnabled}
              cache={cache}
              onOpen={(item) => openAsset(item)}
              onLongPress={setActionItem}
              selectMode={selectMode}
              selectedIds={selected}
              onToggleSelect={toggleSelect}
              onStartSelect={startSelectWith}
            />
          </div>
        )}
      </div>

      {/* Deleted files wait 31 days in Recently deleted; the way there from Assets. */}
      {!selectMode ? (
        <div className="px-4 md:px-6 pb-6 pt-2">
          <button
            type="button"
            data-recently-deleted-link=""
            onClick={() => navigate(RECENTLY_DELETED_PATH)}
            className="inline-flex min-h-[44px] items-center rounded-md px-1 text-sm text-fg-2 transition-colors duration-fast hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            {RECENTLY_DELETED_LABEL}
          </button>
        </div>
      ) : null}

      {/* Phones: Delete pinned at the bottom while selecting, in thumb
          reach above the tab bar; the spacer keeps the last row uncovered. */}
      {selectMode ? (
        <>
          <div aria-hidden="true" className="h-[76px] md:hidden" />
          <div
            data-select-actions=""
            className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-panel px-4 pt-3 pb-[max(12px,env(safe-area-inset-bottom))] md:hidden"
          >
            <div className="flex items-center gap-2">
              <Button
                size="lg"
                variant="danger"
                className="min-w-[44px] flex-1"
                disabled={!canBulkDelete(selected.size)}
                onClick={deleteSelected}
              >
                {selected.size > 0 ? `Delete ${selected.size}` : 'Delete'}
              </Button>
            </div>
          </div>
        </>
      ) : null}

      {viewer !== null && viewerItem !== undefined ? (
        <SearchWordsContext.Provider value={searchJump.words}>
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
            onDelete={(item) => {
              setViewer(null);
              deleteItems([item.id]);
            }}
            canRename={canRename}
            onRename={handleRename}
            onToast={push}
          />
        </SearchWordsContext.Provider>
      ) : null}

      {actionItem !== null ? (
        <AssetActionSheet
          item={actionItem}
          presignEnabled={presignEnabled}
          requestDownloadUrl={requestDownloadUrl}
          canRename={canRename}
          onClose={() => setActionItem(null)}
          onInfo={(item) => {
            setActionItem(null);
            openAsset(item, true);
          }}
          onRename={(item) => {
            setActionItem(null);
            setRenameItem(item);
          }}
          onDelete={(item) => {
            setActionItem(null);
            deleteItems([item.id]);
          }}
          onToast={push}
        />
      ) : null}

      <AssetRenameSheet
        open={renameItem !== null}
        initialName={renameItem !== null ? displayLabel(renameItem) : ''}
        onClose={() => setRenameItem(null)}
        onSubmit={(name) => handleRename(renameItem!, name)}
        onToast={push}
      />

      <AssetUploadSheet
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        onSubmit={
          uploadEndpoint !== undefined && uploadEndpoint !== '' ? handleUploadFile : undefined
        }
        onToast={push}
        onSummary={(summary) => {
          // A failure stays until dismissed; a success times out as usual.
          showToast?.({
            title: summary.title,
            ...(summary.sticky ? { durationMs: null } : {}),
          });
          void loadAssets();
        }}
        onUploaded={() => {
          void loadAssets();
        }}
        siblingLabels={siblingLabels}
      />

      <AddLinkSheet
        open={addLinkOpen}
        onClose={() => setAddLinkOpen(false)}
        onSubmit={handleAddLink}
        onToast={push}
        onAdded={() => void loadAssets()}
      />

      <AssetInUseSheet
        state={inUse}
        onClose={() => setInUse(null)}
        onOpenParent={(parent) => {
          setInUse(null);
          navigate(parent.href);
        }}
      />
    </>
  );
}
