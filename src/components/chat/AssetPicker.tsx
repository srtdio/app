// The composer's Assets tile: a picker over the workspace's library assets, in
// the same Sheet chrome as the share picker (a bottom sheet on touch, the
// centred panel on a laptop). A grid of library assets, newest uploaded first,
// 50 a page with "Load 50 more". Search is the palette in pick mode (the
// header's search button, files only): its picks come back here and are added
// the same way. An image tile shows its thumbnail through the shared presign
// cache (presigned lazily as tiles scroll in, deduped and concurrency-bounded);
// any other file shows its file tile and name. Tap to select (several at once);
// Add hands the picks to the composer as already uploaded attachments. Every
// read is dropped on close and unmount.

import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { Button } from '@/components/ui/Button';
import { PressableRow } from '@/components/ui/PressableRow';
import { EmptyState } from '@/components/ui/EmptyState';
import { SelectCheck } from '@/components/ui/SelectCheck';
import { Sheet } from '@/components/ui/Sheet';
import { ICON_SIZE, IconAssets } from '@/components/ui/icons';
import { Thumbnail } from '@/components/media';
import { PRESIGN_ENABLED, sharedCardPresignCache } from '@/components/chat/PostCard';
import { PalettePickButton } from '@/components/shell/CommandPalette';
import { fileExtension } from '@/lib/assets';
import { cn } from '@/lib/cn';
import { logger } from '@/lib/logger';
import { supabase } from '@/lib/supabase';
import { useWorkspace } from '@/lib/workspace-context';
import type { WorkspaceHit } from '@/lib/search/workspace-search';
import {
  ASSETS_LOAD_FAILED,
  ASSET_PAGE_SIZE,
  assetCursorAfter,
  assetsShownOf,
  isLibraryImage,
  listLibraryAssetsPage,
  toggleLibraryAsset,
  type LibraryAsset,
} from '@/lib/chat/asset-picker';

/** The sheet's title. */
const ASSET_PICKER_TITLE = 'Add from Assets';

/** The header's search button (the palette in pick mode, files only). */
export const SEARCH_FILES_LABEL = 'Search files';

interface AssetListState {
  rows: LibraryAsset[];
  count: number;
  loadingMore: boolean;
}

/**
 * Palette file picks as library assets, in tick order: the ones already in the
 * loaded grid at once (`found`), the rest in `missing` (their row is fetched
 * by name). Pure.
 */
export function assetsFromHits(
  hits: readonly WorkspaceHit[],
  rows: readonly LibraryAsset[],
): { found: LibraryAsset[]; missing: WorkspaceHit[] } {
  const found: LibraryAsset[] = [];
  const missing: WorkspaceHit[] = [];
  for (const hit of hits) {
    if (hit.kind !== 'file') continue;
    const row = rows.find((r) => r.assetId === hit.id);
    if (row !== undefined) found.push(row);
    else missing.push(hit);
  }
  return { found, missing };
}

/**
 * Picks not in the loaded grid: one first-page library read per pick, by its
 * name (the same read the grid makes), keeping the row whose id matches. A
 * pick that is not a library file (or failed to read) is left out. Tick order.
 */
export async function resolveMissingAssets(
  missing: readonly WorkspaceHit[],
  read: (name: string) => Promise<LibraryAsset[] | null>,
): Promise<LibraryAsset[]> {
  const rows = await Promise.all(missing.map((hit) => read(hit.title)));
  const out: LibraryAsset[] = [];
  missing.forEach((hit, i) => {
    const row = rows[i]?.find((r) => r.assetId === hit.id);
    if (row !== undefined) out.push(row);
  });
  return out;
}

export function AssetPicker(props: {
  open: boolean;
  onClose: () => void;
  /** The confirmed picks, in pick order. */
  onConfirm: (picks: LibraryAsset[]) => void;
}): ReactElement {
  const { workspaceId } = useWorkspace();
  const [list, setList] = useState<AssetListState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<LibraryAsset[]>([]);
  // A palette pick whose rows are still being fetched: Add shows busy.
  const [resolving, setResolving] = useState(false);
  // The one read in flight (first page or Load more); a new read, a close or
  // an unmount aborts it.
  const readRef = useRef<AbortController | null>(null);
  // The palette pick's own reads; a close or an unmount aborts them.
  const pickRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!props.open) return;
    setList(null);
    setError(null);
    setSelected([]);
    setResolving(false);
  }, [props.open]);

  // First page: one read per open.
  useEffect(() => {
    if (!props.open || workspaceId === null) return;
    readRef.current?.abort();
    const run = new AbortController();
    readRef.current = run;
    void listLibraryAssetsPage(supabase, {
      workspaceId,
      search: '',
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
      setList({ rows: result.data.rows, count: result.data.count ?? 0, loadingMore: false });
    });
    return () => {
      run.abort();
      pickRef.current?.abort();
      pickRef.current = null;
    };
  }, [props.open, workspaceId]);

  useEffect(
    () => () => {
      readRef.current?.abort();
      readRef.current = null;
      pickRef.current?.abort();
      pickRef.current = null;
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
    setList({ ...list, loadingMore: true });
    void listLibraryAssetsPage(supabase, {
      workspaceId,
      search: '',
      cursor,
      signal: run.signal,
    }).then((result) => {
      if (run.signal.aborted) return;
      setList((prev) => {
        if (prev === null) return prev;
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

  // The palette's picks: added the same way as Add (the grid's ticks are not
  // part of it). Loaded rows go at once; the rest are read by name first.
  function addPicked(hits: WorkspaceHit[]): void {
    const { found, missing } = assetsFromHits(hits, list?.rows ?? []);
    if (missing.length === 0 || workspaceId === null) {
      if (found.length === 0) return;
      props.onConfirm(found);
      props.onClose();
      return;
    }
    pickRef.current?.abort();
    const run = new AbortController();
    pickRef.current = run;
    setResolving(true);
    void resolveMissingAssets(missing, async (name) => {
      const result = await listLibraryAssetsPage(supabase, {
        workspaceId,
        search: name,
        cursor: null,
        signal: run.signal,
      });
      return result.ok ? result.data.rows : null;
    }).then((more) => {
      if (run.signal.aborted) return;
      pickRef.current = null;
      setResolving(false);
      const picks = [...found, ...more];
      if (picks.length === 0) {
        setError(ASSETS_LOAD_FAILED);
        return;
      }
      props.onConfirm(picks);
      props.onClose();
    });
  }

  let body: ReactElement;
  if (error !== null) {
    body = (
      <div
        role="alert"
        className="rounded-xl border border-bad bg-bad-soft px-4 py-3 text-base text-bad lit-tint"
      >
        {error}
      </div>
    );
  } else if (list === null) {
    body = <AssetGridSkeleton />;
  } else {
    body = (
      <AssetGrid
        rows={list.rows}
        count={list.count}
        loadingMore={list.loadingMore}
        selected={selected}
        onToggle={(asset) => setSelected((prev) => toggleLibraryAsset(prev, asset))}
        onLoadMore={loadMore}
      />
    );
  }

  return (
    <Sheet
      open={props.open}
      onClose={props.onClose}
      title={ASSET_PICKER_TITLE}
      headerAction={
        <PalettePickButton
          label={SEARCH_FILES_LABEL}
          request={() => ({
            pickKinds: ['file'],
            multi: true,
            verb: 'Add',
            label: 'Files',
            onPick: addPicked,
          })}
        />
      }
      footer={
        <Button
          variant="primary"
          className="ml-auto"
          disabled={selected.length === 0}
          busy={resolving}
          onClick={confirm}
        >
          {selected.length > 0 ? `Add (${selected.length})` : 'Add'}
        </Button>
      }
    >
      <div className="flex flex-col gap-3" data-asset-picker="">
        {body}
      </div>
    </Sheet>
  );
}

const GRID_CLASS = 'grid max-h-[50svh] grid-cols-3 gap-2 overflow-y-auto sm:grid-cols-4';

/** Loading state: six static placeholder tiles (no motion). */
export function AssetGridSkeleton(): ReactElement {
  return (
    <ul aria-busy="true" aria-label="Loading files" className={GRID_CLASS}>
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <li
          key={`bone-${i}`}
          data-skeleton-tile=""
          className="aspect-square rounded-lg bg-panel-2"
        />
      ))}
    </ul>
  );
}

/** The grid: one tile per asset, then "Load 50 more" while more remain. */
export function AssetGrid(props: {
  rows: LibraryAsset[];
  count: number;
  loadingMore: boolean;
  selected: readonly LibraryAsset[];
  onToggle: (asset: LibraryAsset) => void;
  onLoadMore: () => void;
}): ReactElement {
  if (props.rows.length === 0) {
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
          className="flex items-center justify-between gap-3 px-3 py-2 text-base font-medium text-accent mv-tint disabled:text-fg-3"
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
        card
        onClick={() => props.onToggle(asset)}
        className={cn(
          'flex flex-col gap-1 border p-1 mv-tint',
          props.active ? 'lit-selected' : 'border-transparent',
        )}
      >
        <span className="relative block overflow-hidden rounded-lg lit-pill">
          <Thumbnail
            assetVersionId={image ? asset.versionId : null}
            cache={sharedCardPresignCache()}
            presignEnabled={PRESIGN_ENABLED}
            fallback={{ kind: 'file', extension: fileExtension(asset.filename) }}
            alt={asset.name}
          />
          {props.active ? <SelectCheck checked className="absolute right-1 top-1" /> : null}
        </span>
        <span className="truncate px-1 text-sm text-fg-2">{asset.name}</span>
      </PressableRow>
    </li>
  );
}
