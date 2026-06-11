import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Chip } from '@/components/ui/Chip';
import { EmptyState } from '@/components/ui/EmptyState';
import { SortMenu } from '@/components/ui/SortMenu';
import { PageHead } from '@/components/shell/PageHead';
import { IconAssets, IconChevronRight, IconSearch, IconUpload, IconX } from '@/components/ui/icons';
import { AssetGrid } from '@/components/pages/assets/AssetGrid';
import { AssetLightbox } from '@/components/pages/assets/AssetLightbox';
import { AssetActionSheet } from '@/components/pages/assets/AssetActionSheet';
import { AssetUploadSheet } from '@/components/pages/assets/AssetUploadSheet';
import { Toasts } from '@/components/pages/assets/Toasts';
import { useToasts } from '@/components/pages/assets/useToasts';
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

/** A viewer target: the index into the navigable list, plus whether Info opens. */
interface ViewerState {
  index: number;
  infoOpen: boolean;
}

export function AssetsPage() {
  const { workspaceId } = useWorkspace();
  const newTrace = useNewTrace();

  const [items, setItems] = useState<AssetListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [kind, setKind] = useState<KindFilter>('all');
  const [search, setSearch] = useState('');
  const [folder, setFolder] = useState(ROOT_FOLDER);
  const [viewer, setViewer] = useState<ViewerState | null>(null);
  const [actionItem, setActionItem] = useState<AssetListItem | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const { value: sort, setValue: setSort } = useSort<AssetSort>('assets', ASSET_SORT_DEFAULT);
  const { toasts, push, dismiss } = useToasts();

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

  useEffect(() => {
    void loadAssets();
  }, [loadAssets]);

  // Reset folder + overlays when the active workspace changes.
  useEffect(() => {
    setFolder(ROOT_FOLDER);
    setViewer(null);
    setActionItem(null);
    setUploadOpen(false);
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

  // The viewer iterates the currently visible list with links excluded; links
  // open their external URL directly and never enter the lightbox.
  const navigable = useMemo(() => visible.filter((item) => item.kind !== 'link'), [visible]);

  const folders = useMemo(
    () => (searching ? [] : subfolders(items, folder)),
    [items, folder, searching],
  );

  const segments = useMemo(() => breadcrumbSegments(folder), [folder]);

  // Tap a card: open its external link, or open the lightbox at that asset.
  const openAsset = useCallback(
    (item: AssetListItem, infoOpen = false): void => {
      if (item.kind === 'link') {
        if (item.externalUrl !== null) {
          window.open(item.externalUrl, '_blank', 'noopener,noreferrer');
        }
        return;
      }
      const index = navigable.findIndex((candidate) => candidate.id === item.id);
      if (index >= 0) setViewer({ index, infoOpen });
    },
    [navigable],
  );

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

  const listLoading = workspaceId === null || (loading && items.length === 0);
  const viewerItem = viewer !== null ? navigable[viewer.index] : undefined;

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

      {/* Search above the chips, with leading icon and a clear button. */}
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
            className="h-11 w-full rounded-md border border-border bg-panel pl-9 pr-11 text-sm text-fg placeholder:text-fg-3 focus:border-border-strong focus:outline-none"
          />
          {searching ? (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => setSearch('')}
              className="absolute right-0 top-1/2 -translate-y-1/2 inline-flex h-11 w-11 items-center justify-center rounded-md text-fg-3 hover:bg-panel-2 hover:text-fg"
            >
              <IconX size={16} />
            </button>
          ) : null}
        </div>
        <SortMenu options={ASSET_SORT_OPTIONS} value={sort} onChange={setSort} />
        <Button
          variant="primary"
          size="lg"
          className="h-11 shrink-0"
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
        searching ? (
          <div className="px-4 md:px-6 py-12 text-center">
            <p className="text-sm text-fg-2">No assets match &quot;{search.trim()}&quot;</p>
            <p className="mt-1 text-xs text-fg-3">Try a different name or clear the search.</p>
          </div>
        ) : (
          <div className="px-4 md:px-6 py-10 text-sm text-fg-3">No assets in this folder.</div>
        )
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
          initialInfoOpen={viewer.infoOpen}
          onIndexChange={(index) =>
            setViewer((prev) => (prev === null ? prev : { ...prev, index }))
          }
          onClose={() => setViewer(null)}
          onDelete={deleteOne}
          onToast={push}
        />
      ) : null}

      {actionItem !== null ? (
        <AssetActionSheet
          item={actionItem}
          presignEnabled={presignEnabled}
          cache={cache}
          onClose={() => setActionItem(null)}
          onInfo={(item) => {
            setActionItem(null);
            openAsset(item, true);
          }}
          onToast={push}
        />
      ) : null}

      <AssetUploadSheet open={uploadOpen} onClose={() => setUploadOpen(false)} />

      <Toasts toasts={toasts} onDismiss={dismiss} />
    </>
  );
}
