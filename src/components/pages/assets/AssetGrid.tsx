import type { PresignCache } from '@/lib/asset-presign';
import type { AssetListItem } from '@/lib/assets';
import { AssetCard } from '@/components/pages/assets/AssetCard';

interface AssetGridProps {
  items: AssetListItem[];
  presignEnabled: boolean;
  cache: PresignCache;
  onOpen: (item: AssetListItem) => void;
  onLongPress: (item: AssetListItem) => void;
  /** When true, cards become selection toggles instead of openers. */
  selectMode?: boolean;
  /** The currently selected asset ids (select mode only). */
  selectedIds?: ReadonlySet<string>;
  /** Toggle one item's selection (select mode only). */
  onToggleSelect?: (item: AssetListItem) => void;
}

/** Responsive asset grid: two columns on mobile, ~158px auto-fill on desktop. */
export function AssetGrid({
  items,
  presignEnabled,
  cache,
  onOpen,
  onLongPress,
  selectMode = false,
  selectedIds,
  onToggleSelect,
}: AssetGridProps) {
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-[repeat(auto-fill,minmax(158px,1fr))]">
      {items.map((item) => (
        <AssetCard
          key={item.id}
          item={item}
          presignEnabled={presignEnabled}
          cache={cache}
          onOpen={() => onOpen(item)}
          onLongPress={() => onLongPress(item)}
          selectMode={selectMode}
          selected={selectedIds?.has(item.id) ?? false}
          onToggleSelect={() => onToggleSelect?.(item)}
        />
      ))}
    </div>
  );
}
