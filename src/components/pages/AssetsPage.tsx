import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { appPresignCache } from '@/lib/shared-presign';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { NoResults } from '@/components/ui/NoResults';
import { LoadError } from '@/components/ui/LoadError';
import { SectionHeader } from '@/components/shell/SectionHeader';
import { ICON_SIZE, IconAssets } from '@/components/ui/icons';
import { AssetGrid } from '@/components/pages/assets/AssetGrid';
import { AssetLightbox } from '@/components/pages/assets/AssetLightbox';
import { SearchWordsContext } from '@/components/ui/SearchHighlight';
import { useSearchJump } from '@/lib/search/jump';
import { assetMenuItems, type AssetToast } from '@/components/pages/assets/AssetActionSheet';
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
  partialDeleteLabel,
  SELECT_ALL_FAILED,
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
import { bottomAnchorProps, useBottomInset } from '@/lib/bottom-inset';
import { cn } from '@/lib/cn';
import {
  addAssetLink,
  canRenameAssets,
  renameAsset,
  uploadAssetFile,
  type LinkOutcome,
  type RenameOutcome,
  type UploadOutcome,
} from '@/lib/asset-upload';
import { attachLateThumbnail } from '@/lib/asset-thumbnail-attach';
import { assetDelete, assetDeleteMany } from '@srtdio/rpc';
import {
  ASSET_SORT_DEFAULT,
  ASSET_SORT_OPTIONS,
  BULK_BATCH_SIZE,
  ASSET_TAB_DEFAULT,
  countAssetTabs,
  deleteInBatches,
  dropAssetsReads,
  displayLabel,
  fetchMemberRole,
  filterAssets,
  findAssetsInUse,
  assetInUseMessage,
  inUseKeptLabel,
  inUseTitle,
  isAssetInUseError,
  splitFreeAssets,
  getAssetItem,
  listAssetIds,
  listAssetsPage,
  mergeAssetPages,
  parseAssetTab,
  readAssetTabCounts,
  readAssetsFirstPage,
  removeAssetsById,
  renameAssetInList,
  sortAssets,
  TAB_EMPTY,
  type AssetListItem,
  type AssetPageNext,
  type AssetSort,
  type AssetTab,
} from '@/lib/assets';

const SKELETON_COUNT = 12;

/** The Load more failure toast: "Couldn't {action}. {reason}". */
export const LOAD_MORE_FAILED = "Couldn't load more files. Try again.";

/** Tab counts before the first server count lands: zero shows no number. */
const NO_COUNTS: Record<AssetTab, number> = {
  all: 0,
  media: 0,
  pdf: 0,
  docs: 0,
  sheets: 0,
  links: 0,
};

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
  // Loading from the first render: the read starts in an effect, after the
  // first paint, so a false start would flash "Files show up here." first.
  const [loading, setLoading] = useState(true);
  // A failed read of the files is a page load error: the grid and counts never
  // render from a partial read. The cause is logged.
  const [assetsFailed, setAssetsFailed] = useState(false);
  const [assetsLoaded, setAssetsLoaded] = useState(false);
  const [retrying, setRetrying] = useState(false);
  // Keyset paging: where the next page starts, or done. Load more appends it.
  const [next, setNext] = useState<AssetPageNext>({ done: true });
  const [loadingMore, setLoadingMore] = useState(false);
  // Bumped by every first-page load, so a Load more that resolves after a
  // reload (or a workspace switch) never appends onto the fresh list.
  const loadGeneration = useRef(0);
  // Tab totals from the server (HEAD counts), never from the loaded pages.
  // Null until the first read lands; a failed read keeps the last good counts.
  const [counts, setCounts] = useState<Record<AssetTab, number> | null>(null);
  const countGeneration = useRef(0);

  const [search, setSearch] = useState('');
  const [viewer, setViewer] = useState<ViewerState | null>(null);
  // A search jump's words: the viewer's file name keeps them coloured until this page unmounts.
  const searchJump = useSearchJump();
  const [uploadOpen, setUploadOpen] = useState(false);
  const [addLinkOpen, setAddLinkOpen] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  // The phone selection bar sits on top of the tab bar (and any other bottom
  // bar), never over it: its bottom is the shared bottom inset.
  const selectBarRef = useRef<HTMLDivElement>(null);
  const selectBarInset = useBottomInset(selectBarRef);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  // Select all reads every matching id from the server; bumped on Cancel or a
  // workspace switch so a late answer never reselects.
  const [selectingAll, setSelectingAll] = useState(false);
  const selectAllGeneration = useRef(0);
  const [renameItem, setRenameItem] = useState<AssetListItem | null>(null);
  // Deleted but still inside the Undo window: hidden from every list until the
  // delete commits (then the rows go) or Undo brings them back.
  const [pendingDelete, setPendingDelete] = useState<ReadonlySet<string>>(() => new Set());
  const [role, setRole] = useState<string | null>(null);
  const [inUse, setInUse] = useState<AssetInUseState | null>(null);
  const navigate = useNavigate();
  const { value: sort, setValue: setSort } = useSort<AssetSort>('assets', ASSET_SORT_DEFAULT);
  // The shell's ui/toast. show is the provider's stable function (the wrapper
  // object is new each render), so callbacks built on it stay stable. A
  // failure passes 'error' (the bad tone); a success stays neutral.
  const showToast = useOptionalToast()?.show;
  const push = useCallback<AssetToast>(
    (message, tone) => {
      showToast?.({ title: message, ...(tone !== undefined ? { tone } : {}) });
    },
    [showToast],
  );
  const { run: runUndoable } = useUndoableAction();
  const [searchParams, setSearchParams] = useSearchParams();
  const openedAssetParam = useRef<string | null>(null);
  // A ?asset= id beyond the loaded pages is looked up once on its own (one
  // row, same read and RLS as the list); the tick re-runs the deep-link effect.
  const lookedUpAssetParam = useRef<string | null>(null);
  const pendingAssetLookup = useRef<string | null>(null);
  const [assetLookupTick, setAssetLookupTick] = useState(0);

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

  // Every tab's total in one parallel burst of HEAD counts. Runs with every
  // first-page load and after every delete; the latest read wins. The mount
  // (`join`) joins the burst a nav press already started (prefetchAssetsData);
  // every other run drops that shared read first and asks the server anew.
  const loadCounts = useCallback(
    async (join = false) => {
      if (workspaceId === null) return;
      countGeneration.current += 1;
      const generation = countGeneration.current;
      if (userId !== null && !join) dropAssetsReads(userId, workspaceId);
      const result =
        userId === null
          ? await countAssetTabs(supabase, workspaceId)
          : await readAssetTabCounts(supabase, userId, workspaceId, countAssetTabs);
      if (generation !== countGeneration.current) return;
      if (!result.ok) {
        logger.warn('assets: tab counts read failed', { error: result.error.message });
        return;
      }
      setCounts(result.data);
    },
    [workspaceId, userId],
  );

  // The first page. Every reload (upload, link, data change, Retry) starts over
  // from the newest page, so the list never mixes a stale tail with fresh rows.
  // The counts reload alongside it, not after it. Only the mount joins the
  // shared read a nav press started; a reload drops it and reads anew.
  const loadAssets = useCallback(
    async (join = false) => {
      if (workspaceId === null) return;
      if (userId !== null && !join) dropAssetsReads(userId, workspaceId);
      void loadCounts(true);
      loadGeneration.current += 1;
      const generation = loadGeneration.current;
      setLoading(true);
      const result =
        userId === null
          ? await listAssetsPage(supabase, workspaceId)
          : await readAssetsFirstPage(supabase, userId, workspaceId, listAssetsPage);
      if (generation !== loadGeneration.current) return;
      setLoading(false);
      setLoadingMore(false);
      if (!result.ok) {
        logger.warn('assets: list read failed', { error: result.error.message });
        setAssetsFailed(true);
        return;
      }
      setAssetsFailed(false);
      setItems(result.data.items);
      setNext(result.data.next);
      setAssetsLoaded(true);
    },
    [workspaceId, userId, loadCounts],
  );

  // The next page, appended with duplicates (by id) dropped. A failure keeps
  // what is loaded and says so in a toast; the button stays for another try.
  const loadMore = useCallback(async () => {
    if (workspaceId === null || next.done || loadingMore) return;
    const generation = loadGeneration.current;
    setLoadingMore(true);
    const result = await listAssetsPage(supabase, workspaceId, next.cursor);
    if (generation !== loadGeneration.current) return;
    setLoadingMore(false);
    if (!result.ok) {
      logger.warn('assets: next page read failed', { error: result.error.message });
      showToast?.({ title: LOAD_MORE_FAILED, tone: 'error' });
      return;
    }
    setItems((prev) => mergeAssetPages(prev, result.data.items));
    setNext(result.data.next);
  }, [workspaceId, next, loadingMore, showToast]);

  const retryLoad = useCallback(async () => {
    setRetrying(true);
    try {
      await loadAssets();
    } finally {
      setRetrying(false);
    }
  }, [loadAssets]);

  useEffect(() => {
    void loadAssets(true);
  }, [loadAssets]);
  // Leaving the page forgets its shared first reads: this page renames and
  // deletes in place, and other surfaces add files, so a later visit must read
  // the server again, never paint this visit's list.
  useEffect(() => {
    if (workspaceId === null || userId === null) return;
    return () => dropAssetsReads(userId, workspaceId);
  }, [workspaceId, userId]);
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
      setCounts(null);
    }
  }, [workspaceId]);

  // Reset overlays when the active workspace changes.
  useEffect(() => {
    setViewer(null);
    setUploadOpen(false);
    setAddLinkOpen(false);
    setSelectMode(false);
    setSelected(new Set());
    selectAllGeneration.current += 1;
    setSelectingAll(false);
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

  // Toggle one asset's selection. No cap: a delete runs in batches the server
  // accepts (BULK_BATCH_SIZE), so any selection size can be deleted.
  const toggleSelect = useCallback((item: AssetListItem): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(item.id)) next.delete(item.id);
      else next.add(item.id);
      return next;
    });
  }, []);

  // Select all = every file in the current tab, loaded or not: its ids are read
  // from the server (keyset pages of 1000). Search filters the loaded pages on
  // the device, so while searching Select all takes the shown matches only.
  const selectAll = useCallback(async (): Promise<void> => {
    if (searching) {
      setSelected(new Set(visible.map((item) => item.id)));
      return;
    }
    if (workspaceId === null) return;
    selectAllGeneration.current += 1;
    const generation = selectAllGeneration.current;
    setSelectingAll(true);
    const result = await listAssetIds(supabase, workspaceId, tab);
    if (generation !== selectAllGeneration.current) return;
    setSelectingAll(false);
    if (!result.ok) {
      logger.warn('assets: select all read failed', { error: result.error.message });
      push(SELECT_ALL_FAILED, 'error');
      return;
    }
    setSelected(new Set(result.data.filter((id) => !pendingDelete.has(id))));
  }, [searching, visible, workspaceId, tab, push, pendingDelete]);

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
    if (
      item === undefined &&
      !next.done &&
      workspaceId !== null &&
      lookedUpAssetParam.current !== asset
    ) {
      lookedUpAssetParam.current = asset;
      pendingAssetLookup.current = asset;
      void getAssetItem(supabase, workspaceId, asset).then((found) => {
        if (found.ok && found.data.length > 0) {
          setItems((prev) => mergeAssetPages(prev, found.data));
        }
        pendingAssetLookup.current = null;
        setAssetLookupTick((tick) => tick + 1);
      });
      return;
    }
    // The one-row lookup is still in flight: the tick re-runs this.
    if (item === undefined && pendingAssetLookup.current === asset) return;
    if (item !== undefined && item.kind !== 'link' && !searching && tab !== ASSET_TAB_DEFAULT) {
      const params = new URLSearchParams(searchParams);
      params.delete('type');
      setSearchParams(params, { replace: true });
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
    const params = new URLSearchParams(searchParams);
    params.delete(ASSET_PARAM);
    setSearchParams(params, { replace: true });
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
    next.done,
    workspaceId,
    assetLookupTick,
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
      if (ids.length === 0) return;
      setPendingDelete((prev) => new Set([...prev, ...ids]));
      runUndoable({
        label: deleteToastLabel(ids.length),
        revert: () => unhide(ids),
        commit: async () => {
          const traceId = newTrace();
          // asset_delete_many is all-or-nothing and takes at most
          // BULK_DELETE_MAX ids, so the ids go in batches of BULK_BATCH_SIZE,
          // one batch at a time, stopping at the first failure. Each batch of a
          // bulk delete checks once which files are in use, deletes the free
          // ones in one call and keeps the rest, saying how many.
          let failedTargets: string[] = [];
          const outcome = await deleteInBatches(ids, BULK_BATCH_SIZE, async (batch) => {
            let targets = batch;
            let kept: string[] = [];
            if (ids.length > 1) {
              const found = await findAssetsInUse(supabase, batch);
              if (found.ok) ({ free: targets, kept } = splitFreeAssets(batch, found.data));
            }
            if (targets.length === 0) return { ok: true, data: { deleted: [], kept } };
            const [only] = targets;
            const result =
              targets.length === 1 && only !== undefined
                ? await assetDelete(supabase, { p_asset_id: only, p_trace_id: traceId })
                : await assetDeleteMany(supabase, { p_asset_ids: targets, p_trace_id: traceId });
            if (!result.ok) {
              failedTargets = targets;
              return { ok: false, error: result.error };
            }
            return { ok: true, data: { deleted: targets, kept } };
          });
          const { deleted, kept, failure } = outcome;
          if (deleted.length > 0) setItems((prev) => removeAssetsById(prev, deleted));
          unhide(ids);
          void loadCounts();
          if (failure !== null) {
            // Some batches went through: say how many, the rest are back.
            if (deleted.length > 0) {
              push(partialDeleteLabel(ids.length - deleted.length, deleted.length), 'error');
            } else if (isAssetInUseError(failure.error)) {
              await showInUse(failedTargets, itemsRef.current);
            } else {
              push(deleteFailedLabel(ids.length), 'error');
            }
            return;
          }
          if (deleted.length === 0) {
            // Every file is in use. The lookup stays one batch wide.
            await showInUse(kept.slice(0, BULK_BATCH_SIZE), itemsRef.current);
            return;
          }
          if (kept.length > 0) push(inUseKeptLabel(kept.length), 'error');
        },
      });
    },
    [runUndoable, unhide, newTrace, showInUse, push, loadCounts],
  );

  const deleteSelected = useCallback((): void => {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
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
      onProgress?: (fraction: number) => void,
    ): Promise<UploadOutcome> => {
      if (uploadEndpoint === undefined || uploadEndpoint === '') {
        return { ok: false, message: "Couldn't upload. Try again." };
      }
      if (workspaceId === null) {
        return { ok: false, message: "Couldn't upload. Try again." };
      }
      const token = (await supabase.auth.getSession()).data.session?.access_token ?? null;
      if (token === null || token === '') {
        return { ok: false, message: "Couldn't upload. Try again." };
      }
      return uploadAssetFile(file, {
        endpoint: uploadEndpoint,
        token,
        workspaceId,
        origin: 'library',
        filename: file.name,
        displayName,
        folderId: targetFolderId,
        attachThumbnail: attachLateThumbnail,
        // XHR so Stop can abort the request in flight (fetchWithTrace takes no
        // signal) and the row's bar shows real bytes sent; the transport sets
        // X-Trace-Id itself.
        xhr: {
          traceId: newTrace(),
          ...(signal !== undefined ? { signal } : {}),
          ...(onProgress !== undefined ? { onProgress } : {}),
        },
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
        return { ok: false, message: "Couldn't add the link. Try again." };
      }
      const token = (await supabase.auth.getSession()).data.session?.access_token ?? null;
      if (token === null || token === '') {
        return { ok: false, message: "Couldn't add the link. Try again." };
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
          message: "Couldn't rename this file. Try again.",
        };
      }
      if (workspaceId === null) {
        return { ok: false, message: "Couldn't rename this file. Try again." };
      }
      const token = (await supabase.auth.getSession()).data.session?.access_token ?? null;
      if (token === null || token === '') {
        return { ok: false, message: "Couldn't rename this file. Try again." };
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

  // A card's ⋯ menu (ui/ActionMenu): Open {domain} or Copy link first, Delete
  // last, which hides the file at once and offers Undo (no dialog).
  const menuItemsFor = useCallback(
    (item: AssetListItem) =>
      assetMenuItems(item, {
        presignEnabled,
        requestDownloadUrl,
        canRename,
        onInfo: (target) => openAsset(target, true),
        onRename: setRenameItem,
        onDelete: (target) => deleteItems([target.id]),
        onToast: push,
      }),
    [presignEnabled, requestDownloadUrl, canRename, openAsset, deleteItems, push],
  );

  const listLoading = workspaceId === null || (loading && items.length === 0);
  const viewerItem = viewer !== null ? navigable[viewer.index] : undefined;

  const exitSelectMode = (): void => {
    selectAllGeneration.current += 1;
    setSelectingAll(false);
    setSelectMode(false);
    setSelected(new Set());
  };

  // Nothing to select: no shown file and, outside a search, a server total of 0.
  const nothingToSelect =
    visible.length === 0 && (searching || counts === null || counts[tab] === 0);

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
              <Button variant="ghost" onClick={exitSelectMode}>
                Cancel
              </Button>
              <span
                className="min-w-0 flex-1 truncate text-center text-base font-semibold text-fg"
                aria-live="polite"
              >
                {selectedLabel(selected.size)}
              </span>
              <Button
                variant="ghost"
                data-assets-select-all=""
                disabled={nothingToSelect || selectingAll}
                aria-busy={selectingAll}
                onClick={() => void selectAll()}
              >
                Select all
              </Button>
              {/* Desktop keeps Delete up here; phones get the bottom bar. */}
              <span className="hidden gap-2 md:flex">
                <Button
                  variant="danger"
                  disabled={selected.size === 0 || selectingAll}
                  onClick={deleteSelected}
                >
                  Delete
                </Button>
              </span>
            </div>
          </div>
        ) : assetsFailed ? null : (
          <AssetTabs value={tab} counts={counts ?? NO_COUNTS} onChange={setTab} />
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
          // One line; the header's New asset is the only create button.
          <EmptyState icon={<IconAssets size={ICON_SIZE.status} />} title="Files show up here." />
        ) : visible.length === 0 ? (
          searching ? (
            <NoResults
              query={search}
              filtersActive={tab !== 'all'}
              onClear={() => {
                setSearch('');
                setTab('all');
              }}
            />
          ) : tab !== 'all' ? (
            <div data-asset-tab-empty={tab} className="px-4 md:px-6 py-10 text-base text-fg-2">
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
              menuItemsFor={menuItemsFor}
              selectMode={selectMode}
              selectedIds={selected}
              onToggleSelect={toggleSelect}
              onStartSelect={startSelectWith}
            />
          </div>
        )}
        {/* Older files load a page at a time; search, tabs and sort work over
            what is loaded. Shown only while another page exists. */}
        {!assetsFailed && !listLoading && !next.done ? (
          <div className="px-4 md:px-6 pb-4 flex justify-center">
            <Button
              variant="secondary"
              type="button"
              data-assets-load-more=""
              disabled={loadingMore}
              aria-busy={loadingMore}
              onClick={() => void loadMore()}
            >
              Load more
            </Button>
          </div>
        ) : null}
      </div>

      {/* Deleted files wait 31 days in Recently deleted; the way there from Assets. */}
      {!selectMode ? (
        <div className="px-4 md:px-6 pb-6 pt-2">
          <Button
            variant="ghost"
            type="button"
            data-recently-deleted-link=""
            onClick={() => navigate(RECENTLY_DELETED_PATH)}
            className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            {RECENTLY_DELETED_LABEL}
          </Button>
        </div>
      ) : null}

      {/* Phones: Delete pinned at the bottom while selecting, in thumb
          reach right above the tab bar (useBottomInset; the tab bar carries
          the safe area, so the bar only pads it when nothing sits under it).
          It is a bottom bar itself, so the Undo strip stacks above it. The
          spacer keeps the last row uncovered. */}
      {selectMode ? (
        <>
          <div aria-hidden="true" className="h-[76px] md:hidden" />
          <div
            ref={selectBarRef}
            data-select-actions=""
            {...bottomAnchorProps}
            style={{ bottom: selectBarInset }}
            className={cn(
              'fixed inset-x-0 z-40 border-t border-border bg-panel px-4 pt-3 md:hidden',
              selectBarInset > 0 ? 'pb-3' : 'pb-[max(12px,env(safe-area-inset-bottom))]',
            )}
          >
            <div className="flex items-center gap-2">
              <Button
                variant="danger"
                className="min-w-[44px] flex-1"
                disabled={selected.size === 0 || selectingAll}
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
          // Any failure makes the summary sticky, so sticky is also the bad tone.
          showToast?.({
            title: summary.title,
            ...(summary.sticky ? { durationMs: null, tone: 'error' as const } : {}),
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
