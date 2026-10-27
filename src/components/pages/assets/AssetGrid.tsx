import { mark } from '@/lib/perf-marks';
import { useEffect, useRef, useState, type RefObject } from 'react';
import type { ActionMenuItem } from '@/components/ui/ActionMenu';
import type { PresignCache } from '@/lib/asset-presign';
import type { AssetListItem } from '@/lib/assets';
import { AssetCard } from '@/components/pages/assets/AssetCard';

/** Cards drawn first, and added each time the reader nears the end. */
export const ASSET_GRID_PAGE = 60;
/** How far below the last drawn card the next page starts drawing. */
const MORE_MARGIN = '800px';

interface AssetGridProps {
  items: AssetListItem[];
  presignEnabled: boolean;
  cache: PresignCache;
  onOpen: (item: AssetListItem) => void;
  /** The rows of an item's ⋯ menu (its ⋯ or a long press opens it). */
  menuItemsFor?: (item: AssetListItem) => readonly ActionMenuItem[];
  /** When true, cards become selection toggles instead of openers. */
  selectMode?: boolean;
  /** The currently selected asset ids (select mode only). */
  selectedIds?: ReadonlySet<string>;
  /** Toggle one item's selection (select mode only). */
  onToggleSelect?: (item: AssetListItem) => void;
  /** Tap a card's round box: start selecting with that item ticked. */
  onStartSelect?: ((item: AssetListItem) => void) | undefined;
}

/**
 * How many cards to draw: the first page at once, then a page more each time
 * the end comes within MORE_MARGIN of the screen. A workspace with 1,500 files
 * draws a screenful straight away instead of 1,500 cards before anything shows.
 * Without IntersectionObserver every card is drawn.
 */
function useGrowingCount(total: number): {
  count: number;
  sentinelRef: RefObject<HTMLDivElement>;
} {
  const [count, setCount] = useState(ASSET_GRID_PAGE);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const more = count < total;
  useEffect(() => {
    if (!more) return;
    const el = sentinelRef.current;
    if (el === null || typeof IntersectionObserver === 'undefined') {
      setCount(total);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          mark('grid:grow');
          setCount((now) => now + ASSET_GRID_PAGE);
        }
      },
      { rootMargin: MORE_MARGIN },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [more, total, count]);
  return { count, sentinelRef };
}

/** Responsive asset grid: two columns on mobile, ~158px auto-fill on desktop. */
export function AssetGrid({
  items,
  presignEnabled,
  cache,
  onOpen,
  menuItemsFor,
  selectMode = false,
  selectedIds,
  onToggleSelect,
  onStartSelect,
}: AssetGridProps) {
  const { count, sentinelRef } = useGrowingCount(items.length);
  const shown = count >= items.length ? items : items.slice(0, count);
  return (
    <>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-[repeat(auto-fill,minmax(158px,1fr))]">
        {shown.map((item) => (
          <AssetCard
            key={item.id}
            item={item}
            presignEnabled={presignEnabled}
            cache={cache}
            onOpen={() => onOpen(item)}
            menuItems={menuItemsFor?.(item) ?? []}
            selectMode={selectMode}
            selected={selectedIds?.has(item.id) ?? false}
            onToggleSelect={() => onToggleSelect?.(item)}
            onStartSelect={onStartSelect === undefined ? undefined : () => onStartSelect(item)}
          />
        ))}
      </div>
      {shown.length < items.length ? (
        <div ref={sentinelRef} aria-hidden="true" data-asset-grid-more="" className="h-px" />
      ) : null}
    </>
  );
}
