import type { PresignCache } from '@/lib/asset-presign';
import type { AssetListItem } from '@/lib/assets';
import { AssetCard } from '@/components/pages/assets/AssetCard';

interface AssetGridProps {
  items: AssetListItem[];
  selected: ReadonlySet<string>;
  selecting: boolean;
  presignEnabled: boolean;
  cache: PresignCache;
  onOpen: (item: AssetListItem) => void;
  onToggleSelect: (id: string) => void;
}

/** Responsive asset grid: two columns on mobile, ~158px auto-fill on desktop. */
export function AssetGrid({
  items,
  selected,
  selecting,
  presignEnabled,
  cache,
  onOpen,
  onToggleSelect,
}: AssetGridProps) {
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-[repeat(auto-fill,minmax(158px,1fr))]">
      {items.map((item) => (
        <AssetCard
          key={item.id}
          item={item}
          selected={selected.has(item.id)}
          selecting={selecting}
          presignEnabled={presignEnabled}
          cache={cache}
          onOpen={() => onOpen(item)}
          onToggleSelect={() => onToggleSelect(item.id)}
        />
      ))}
    </div>
  );
}
