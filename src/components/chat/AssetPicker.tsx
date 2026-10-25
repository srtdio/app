// The composer's Assets tile: a picker over the workspace's library assets, in
// the same Sheet chrome as the share picker (a bottom sheet on touch, the
// centred panel on a laptop). A grid of library assets, newest uploaded first,
// 50 a page with "Load 50 more"; search on display name or filename (server
// side, debounced 200 ms). An image tile shows its thumbnail through the
// shared presign cache (presigned lazily as tiles scroll in, deduped and
// concurrency-bounded); any other file shows its file tile and name. Tap to
// select (several at once); Add hands the picks to the composer as already
// uploaded attachments. Every read and timer is dropped on close and unmount.

import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { Button } from '@/components/ui/Button';
import { PressableRow } from '@/components/ui/PressableRow';
import { EmptyState } from '@/components/ui/EmptyState';
import { NoResults } from '@/components/ui/NoResults';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { Sheet } from '@/components/ui/Sheet';
import { ICON_SIZE, IconAssets, IconCheck, IconSearch } from '@/components/ui/icons';
import { Thumbnail } from '@/components/media';
import { PRESIGN_ENABLED, sharedCardPresignCache } from '@/components/chat/PostCard';
import { fileExtension } from '@/lib/assets';
import { cn } from '@/lib/cn';
import { logger } from '@/lib/logger';
import { supabase } from '@/lib/supabase';
import { useWorkspace } from '@/lib/workspace-context';
import {
  ASSETS_LOAD_FAILED,
  ASSET_PAGE_SIZE,
  ASSET_SEARCH_DEBOUNCE_MS,
  assetCursorAfter,
  assetsShownOf,
  isLibraryImage,
  listLibraryAssetsPage,
  toggleLibraryAsset,
  type LibraryAsset,
} from '@/lib/chat/asset-picker';

/** The sheet's title. */
export const ASSET_PICKER_TITLE = 'Add from Assets';

interface AssetListState {
  /** The settled search text this list answers. */
  text: string;
  rows: LibraryAsset[];
  count: number;
  loadingMore: boolean;
}

export function AssetPicker(props: {
  open: boolean;
  onClose: () => void;
  /** The confirmed picks, in pick order. */
  onConfirm: (picks: LibraryAsset[]) => void;
}): ReactElement {
  const { workspaceId } = useWorkspace();
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [list, setList] = useState<AssetListState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<LibraryAsset[]>([]);
  // The one read in flight (first page or Load more); a new read, a close or
  // an unmount aborts it.
  const readRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!props.open) return;
    setQuery('');
    setDebounced('');
    setList(null);
    setError(null);
    setSelected([]);
  }, [props.open]);

  useEffect(() => {
    const handle = setTimeout(() => setDebounced(query.trim()), ASSET_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [query]);

  // First page: one read per open and per settled search text.
  useEffect(() => {
    if (!props.open || workspaceId === null) return;
    readRef.current?.abort();
    const run = new AbortController();
    readRef.current = run;
    const text = debounced;
    void listLibraryAssetsPage(supabase, {
      workspaceId,
      search: text,
      cursor: null,
      signal: run.signal,
    }).then((result) => {
      if (run.signal.aborted) return;
      if (!result.ok) {
        logger.warn('asset picker: page load failed', { error: result.error.message });
        setError(ASSETS_LOAD_FAILED);
        return;
      }
      setError(null);
      setList({ text, rows: result.data.rows, count: result.data.count ?? 0, loadingMore: false });
    });
    return () => run.abort();
  }, [props.open, workspaceId, debounced]);

  useEffect(
    () => () => {
      readRef.current?.abort();
      readRef.current = null;
    },
    [],
  );

  function loadMore(): void {
    if (workspaceId === null || list === null || list.loadingMore) return;
    const cursor = assetCursorAfter(list.rows);
    if (cursor === null) return;
    readRef.current?.abort();
    const run = new AbortController();
    readRef.current = run;
    const text = list.text;
    setList({ ...list, loadingMore: true });
    void listLibraryAssetsPage(supabase, {
      workspaceId,
      search: text,
      cursor,
      signal: run.signal,
    }).then((result) => {
      if (run.signal.aborted) return;
      setList((prev) => {
        if (prev === null || prev.text !== text) return prev;
        if (!result.ok) return { ...prev, loadingMore: false };
        return { ...prev, rows: [...prev.rows, ...result.data.rows], loadingMore: false };
      });
      if (!result.ok) {
        logger.warn('asset picker: next page load failed', { error: result.error.message });
        setError(ASSETS_LOAD_FAILED);
      }
    });
  }

  function confirm(): void {
    if (selected.length === 0) return;
    props.onConfirm(selected);
    props.onClose();
  }

  const settled = list !== null && list.text === query.trim();
  let body: ReactElement;
  if (error !== null) {
    body = (
      <div
        role="alert"
        className="rounded-xl border border-bad bg-bad-soft px-4 py-3 text-base text-bad"
      >
        {error}
      </div>
    );
  } else if (!settled || list === null) {
    body = <AssetGridSkeleton />;
  } else {
    body = (
      <AssetGrid
        rows={list.rows}
        count={list.count}
        searching={list.text !== ''}
        query={list.text}
        loadingMore={list.loadingMore}
        selected={selected}
        onToggle={(asset) => setSelected((prev) => toggleLibraryAsset(prev, asset))}
        onLoadMore={loadMore}
        onClearSearch={() => setQuery('')}
      />
    );
  }

  return (
    <Sheet
      open={props.open}
      onClose={props.onClose}
      title={ASSET_PICKER_TITLE}
      footer={
        <Button
          variant="primary"
          className="ml-auto"
          disabled={selected.length === 0}
          onClick={confirm}
        >
          {selected.length > 0 ? `Add (${selected.length})` : 'Add'}
        </Button>
      }
    >
      <div className="flex flex-col gap-3" data-asset-picker="">
        <Field label="Search">
          <div className="relative">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-3">
              <IconSearch size={ICON_SIZE.inline} />
            </span>
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search files"
              className="pl-9"
            />
          </div>
        </Field>
        {body}
      </div>
    </Sheet>
  );
}

const GRID_CLASS = 'grid max-h-[50vh] grid-cols-3 gap-2 overflow-y-auto sm:grid-cols-4';

/** Loading state: six static placeholder tiles (no motion). */
export function AssetGridSkeleton(): ReactElement {
  return (
    <ul aria-busy="true" aria-label="Loading files" className={GRID_CLASS}>
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <li key={i} data-skeleton-tile="" className="aspect-square rounded-lg bg-panel-3" />
      ))}
    </ul>
  );
}

/** The grid: one tile per asset, then "Load 50 more" while more remain. */
export function AssetGrid(props: {
  rows: LibraryAsset[];
  count: number;
  searching: boolean;
  /** The search text; the no-match line names it. */
  query: string;
  loadingMore: boolean;
  selected: readonly LibraryAsset[];
  onToggle: (asset: LibraryAsset) => void;
  onLoadMore: () => void;
  /** Clears the search box (the no-results state's Clear search). */
  onClearSearch?: () => void;
}): ReactElement {
  if (props.rows.length === 0) {
    if (props.searching) {
      return (
        <NoResults
          query={props.query}
          filtersActive={false}
          onClear={props.onClearSearch ?? (() => undefined)}
        />
      );
    }
    return (
      <EmptyState
        icon={<IconAssets size={ICON_SIZE.tray} />}
        title="Files added to Assets show up here."
      />
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <ul className={GRID_CLASS}>
        {props.rows.map((asset) => (
          <AssetTile
            key={asset.assetId}
            asset={asset}
            active={props.selected.some((item) => item.assetId === asset.assetId)}
            onToggle={props.onToggle}
          />
        ))}
      </ul>
      {props.rows.length < props.count ? (
        <PressableRow
          type="button"
          onClick={props.onLoadMore}
          disabled={props.loadingMore}
          className="flex items-center justify-between gap-3 px-3 py-2 text-base font-medium text-accent transition-colors disabled:text-fg-3"
        >
          <span>{`Load ${ASSET_PAGE_SIZE} more`}</span>
          <span className="text-sm font-normal tabular-nums text-fg-3">
            {assetsShownOf(props.rows.length, props.count)}
          </span>
        </PressableRow>
      ) : null}
    </div>
  );
}

/** One asset: its thumbnail (image) or file tile, its name, and a check when picked. */
export function AssetTile(props: {
  asset: LibraryAsset;
  active: boolean;
  onToggle: (asset: LibraryAsset) => void;
}): ReactElement {
  const { asset } = props;
  const image = isLibraryImage(asset);
  return (
    <li>
      <PressableRow
        type="button"
        aria-pressed={props.active}
        aria-label={asset.name}
        data-asset-tile={asset.assetId}
        onClick={() => props.onToggle(asset)}
        className={cn(
          'flex flex-col gap-1 p-1 transition-colors',
          props.active && 'bg-accent-soft',
        )}
      >
        <span className="relative block overflow-hidden rounded-md">
          <Thumbnail
            assetVersionId={image ? asset.versionId : null}
            cache={sharedCardPresignCache()}
            presignEnabled={PRESIGN_ENABLED}
            fallback={{ kind: 'file', extension: fileExtension(asset.filename) }}
            alt={asset.name}
          />
          {props.active ? (
            <span className="absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded-full bg-accent text-accent-fg">
              <IconCheck size={ICON_SIZE.inline} />
            </span>
          ) : null}
        </span>
        <span className="truncate px-0.5 text-sm text-fg-2">{asset.name}</span>
      </PressableRow>
    </li>
  );
}
