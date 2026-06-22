import { cn } from '@/lib/cn';
import { IconFolder } from '@/components/ui/icons';
import { useLongPress } from '@/components/pages/assets/useLongPress';

interface FolderCardProps {
  name: string;
  /** Direct children (child folders + assets) inside this folder. */
  count: number;
  /** Tap: open this folder (set it as the current level). */
  onOpen: () => void;
  /**
   * Long-press: open the folder action sheet (rename / delete). Omitted for
   * members without manage rights, in which case a long-press just opens.
   */
  onManage?: (() => void) | undefined;
}

/**
 * A folder tile in the Assets grid, mirroring AssetCard's container so folders
 * and assets line up in the same grid. A tap opens the folder; for owner/admin/
 * agency a long-press opens the action sheet (rename/delete) via onManage. When
 * onManage is undefined a long-press is identical to a tap (it just opens).
 * Themed with semantic tokens so light and dark match; the tile is >=44px tall.
 */
export function FolderCard({ name, count, onOpen, onManage }: FolderCardProps) {
  const longPress = useLongPress(onManage ?? onOpen, onOpen);

  return (
    <button
      type="button"
      aria-label={`Open folder ${name}`}
      {...longPress}
      style={{ touchAction: 'manipulation' }}
      className={cn(
        'group relative flex flex-col overflow-hidden rounded-xl border border-border bg-panel text-left transition-colors',
        'hover:border-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
      )}
    >
      <div className="aspect-[4/3] w-full bg-panel-2 grid place-items-center">
        <IconFolder size={28} className="text-accent" />
      </div>

      <div className="flex items-center gap-2 border-t border-border px-2.5 py-2">
        <span className="flex-1 truncate text-xs font-medium" title={name}>
          {name}
        </span>
      </div>

      <div className="px-2.5 pb-2 text-[11px] text-fg-3">
        {count} item{count === 1 ? '' : 's'}
      </div>
    </button>
  );
}
