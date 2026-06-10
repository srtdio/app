import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Chip } from '@/components/ui/Chip';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { SortMenu } from '@/components/ui/SortMenu';
import { PageHead } from '@/components/shell/PageHead';
import {
  IconAssets,
  IconChevronRight,
  IconDownload,
  IconSearch,
  IconTrash,
  IconUpload,
  IconX,
} from '@/components/ui/icons';
import { AssetGrid } from '@/components/pages/assets/AssetGrid';
import { AssetDrawer } from '@/components/pages/assets/AssetDrawer';
import { AssetUploadSheet } from '@/components/pages/assets/AssetUploadSheet';
import { supabase } from '@/lib/supabase';
import { fetchWithTrace } from '@/lib/fetch';
import { env } from '@/lib/env';
import { useNewTrace } from '@/lib/trace-context';
import { useWorkspace } from '@/lib/workspace-context';
import { useSort } from '@/lib/use-sort';
import { PresignCache } from '@/lib/asset-presign';
import { assetDelete } from '@srtdio/rpc';
import {
  ASSET_SORT_DEFAULT,
  ASSET_SORT_OPTIONS,
  breadcrumbSegments,
  buildKindCounts,
  deleteAssetsBatch,
  filterAssets,
  KIND_LABELS,
  listAssets,
  removeAssetsById,
  sortAssets,
  subfolders,
  visibleKinds,
  type AssetListItem,
  type AssetSort,
  type KindFilter,
} from '@/lib/assets';

const ROOT_FOLDER = '/';
const SKELETON_COUNT = 12;
// Cap on simultaneous asset_delete calls in a bulk delete, mirroring the
// presign concurrency ceiling so a large multi-select stays bounded.
const DELETE_CONCURRENCY = 6;

export function AssetsPage() {
  const { workspaceId, workspaces } = useWorkspace();
  const newTrace = useNewTrace();
  const bucket = useMemo(
    () => workspaces.find((w) => w.id === workspaceId)?.asset_bucket ?? null,
    [workspaces, workspaceId],
  );

  const [items, setItems] = useState<AssetListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [kind, setKind] = useState<KindFilter>('all');
  const [search, setSearch] = useState('');
  const [folder, setFolder] = useState(ROOT_FOLDER);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [openItem, setOpenItem] = useState<AssetListItem | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const { value: sort, setValue: setSort } = useSort<AssetSort>('assets', ASSET_SORT_DEFAULT);
  const [confirmBulk, setConfirmBulk] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // One presign cache for the whole page: bounds concurrency and caches URLs so
  // a screen of image cards never fires a burst of presigns. Rebuilt only if the
  // endpoint changes (effectively never within a session).
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

  useEffect(() => {
    void loadAssets();
  }, [loadAssets]);

  // Reset folder + selection when the active workspace changes.
  useEffect(() => {
    setFolder(ROOT_FOLDER);
    setSelected(new Set());
    setOpenItem(null);
    setUploadOpen(false);
    setConfirmBulk(false);
    setActionError(null);
  }, [workspaceId]);

  const counts = useMemo(() => buildKindCounts(items), [items]);
  const kinds = useMemo(() => visibleKinds(counts), [counts]);
  const searching = search.trim() !== '';

  // If the active kind chip drops to zero (workspace switch, deletion), fall back
  // to All so the grid never silently shows nothing for a hidden chip.
  useEffect(() => {
    if (kind !== 'all' && counts[kind] === 0) setKind('all');
  }, [kind, counts]);

  const visible = useMemo(() => {
    const byKind = filterAssets(items, kind, search);
    const scoped = searching ? byKind : byKind.filter((item) => item.folderPath === folder);
    return sortAssets(scoped, sort);
  }, [items, kind, search, folder, searching, sort]);

  const folders = useMemo(
    () => (searching ? [] : subfolders(items, folder)),
    [items, folder, searching],
  );

  const segments = useMemo(() => breadcrumbSegments(folder), [folder]);

  const toggleSelect = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => setSelected(new Set()), []);

  // Single delete (from the drawer): remove the row optimistically, call the
  // proc, and roll the row back on failure. Resolves true so the drawer knows to
  // close. Delete is offered to every member, matching asset_delete's policy
  // (is_active_workspace_member); there is no UI role gate.
  const deleteOne = useCallback(
    async (item: AssetListItem): Promise<boolean> => {
      setActionError(null);
      const snapshot = items;
      setItems((prev) => removeAssetsById(prev, [item.id]));
      const result = await assetDelete(supabase, { p_asset_id: item.id, p_trace_id: newTrace() });
      if (!result.ok) {
        setItems(snapshot);
        setActionError('Could not delete that asset. Please try again.');
        return false;
      }
      setSelected((prev) => {
        if (!prev.has(item.id)) return prev;
        const next = new Set(prev);
        next.delete(item.id);
        return next;
      });
      return true;
    },
    [items, newTrace],
  );

  // Bulk delete (from the selection bar): fan out asset_delete with bounded
  // concurrency, remove only the ids that succeeded, clear selection, and
  // surface a count of any failures (their rows stay in the list).
  const deleteSelected = useCallback(async (): Promise<void> => {
    const ids = [...selected];
    if (ids.length === 0) return;
    setDeleting(true);
    setActionError(null);
    const outcome = await deleteAssetsBatch(ids, DELETE_CONCURRENCY, (id) =>
      assetDelete(supabase, { p_asset_id: id, p_trace_id: newTrace() }),
    );
    if (outcome.succeeded.length > 0) {
      setItems((prev) => removeAssetsById(prev, outcome.succeeded));
    }
    setDeleting(false);
    setConfirmBulk(false);
    setSelected(new Set());
    if (outcome.failed.length > 0) {
      const n = outcome.failed.length;
      setActionError(`Could not delete ${n} ${n === 1 ? 'asset' : 'assets'}. Please try again.`);
    }
  }, [selected, newTrace]);

  const downloadSelected = useCallback(async () => {
    const chosen = items.filter((item) => selected.has(item.id));
    for (const item of chosen) {
      try {
        const url =
          item.kind === 'link'
            ? item.externalUrl
            : item.currentVersionId !== null
              ? (await cache.resolve(item.currentVersionId)).url
              : null;
        if (url !== null) window.open(url, '_blank', 'noopener,noreferrer');
      } catch {
        // A single failed presign should not abort the rest of the batch.
      }
    }
  }, [items, selected, cache]);

  const listLoading = workspaceId === null || (loading && items.length === 0);

  return (
    <>
      <PageHead title="Assets" />

      {/* Breadcrumb only inside a folder; the root needs no lone "/" crumb. */}
      {!searching && segments.length > 0 ? (
        <div className="px-4 md:px-6 pt-3 flex items-center gap-1 text-sm text-fg-3 flex-wrap">
          <button
            type="button"
            onClick={() => setFolder(ROOT_FOLDER)}
            className="hover:text-fg transition-colors"
          >
            Assets
          </button>
          {segments.map((segment) => (
            <span key={segment.path} className="flex items-center gap-1">
              <IconChevronRight size={14} className="text-fg-3" />
              <button
                type="button"
                onClick={() => setFolder(segment.path)}
                className="hover:text-fg transition-colors"
              >
                {segment.name}
              </button>
            </span>
          ))}
        </div>
      ) : null}

      {/* One-line toolbar at every breakpoint: search grows, sort + upload stay. */}
      <div className="px-4 md:px-6 mt-3 flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-3">
            <IconSearch size={16} />
          </span>
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search files"
            className="h-11 w-full rounded-md border border-border bg-panel pl-9 pr-3 text-sm text-fg placeholder:text-fg-3 focus:border-border-strong focus:outline-none md:h-9"
          />
        </div>
        <SortMenu options={ASSET_SORT_OPTIONS} value={sort} onChange={setSort} />
        <Button
          variant="primary"
          size="lg"
          className="h-11 shrink-0 md:h-9"
          onClick={() => setUploadOpen(true)}
        >
          <IconUpload size={16} />
          <span className="hidden sm:inline">Upload</span>
        </Button>
      </div>

      {/* Kind chips on a single horizontally-scrollable row; zero-count kinds hidden. */}
      <div className="px-4 md:px-6 mt-3 flex gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
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
      </div>

      {!searching && folders.length > 0 ? (
        <div className="px-4 md:px-6 mt-3 flex flex-wrap gap-2">
          {folders.map((name) => (
            <Chip
              key={name}
              label={name}
              variant="add"
              size="tap"
              onClick={() => setFolder(`${folder.endsWith('/') ? folder : `${folder}/`}${name}/`)}
            />
          ))}
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
      ) : items.length === 0 ? (
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
        <div className="px-4 md:px-6 py-10 text-sm text-fg-3">No matching assets.</div>
      ) : (
        <div className="px-4 md:px-6 py-4">
          <AssetGrid
            items={visible}
            selected={selected}
            selecting={selected.size > 0}
            presignEnabled={presignEnabled}
            cache={cache}
            onOpen={setOpenItem}
            onToggleSelect={toggleSelect}
          />
        </div>
      )}

      {selected.size > 0 ? (
        <div className="fixed inset-x-0 bottom-[56px] z-30 md:bottom-0">
          <div className="mx-auto m-3 flex max-w-xl items-center gap-3 rounded-xl border border-border bg-panel px-4 py-2.5 shadow-lg">
            <span className="text-sm font-medium">{selected.size} selected</span>
            <span className="ml-auto flex items-center gap-2">
              <Button variant="primary" size="sm" onClick={() => void downloadSelected()}>
                <IconDownload size={16} />
                Download
              </Button>
              <Button variant="danger" size="sm" onClick={() => setConfirmBulk(true)}>
                <IconTrash size={16} />
                Delete
              </Button>
              <Button variant="ghost" size="sm" onClick={clearSelection}>
                <IconX size={16} />
                Clear
              </Button>
            </span>
          </div>
        </div>
      ) : null}

      {actionError !== null ? (
        <div className="fixed inset-x-0 bottom-[112px] z-30 px-3 md:bottom-[56px]">
          <div
            role="alert"
            className="mx-auto max-w-xl rounded-xl border border-bad bg-panel px-4 py-2.5 text-sm text-bad shadow-lg"
          >
            {actionError}
          </div>
        </div>
      ) : null}

      {confirmBulk ? (
        <ConfirmDialog
          title="Delete assets?"
          message={`Delete ${selected.size} ${selected.size === 1 ? 'asset' : 'assets'}? They will be removed from the library.`}
          confirmLabel="Delete"
          busyLabel="Deleting"
          destructive
          busy={deleting}
          onConfirm={() => void deleteSelected()}
          onCancel={() => setConfirmBulk(false)}
        />
      ) : null}

      {openItem !== null ? (
        <AssetDrawer
          item={openItem}
          bucket={bucket}
          presignEnabled={presignEnabled}
          cache={cache}
          onClose={() => setOpenItem(null)}
          onDelete={deleteOne}
        />
      ) : null}

      <AssetUploadSheet open={uploadOpen} onClose={() => setUploadOpen(false)} />
    </>
  );
}
