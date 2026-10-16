import { Avatar } from '@/components/ui/Avatar';
import { IconButton } from '@/components/ui/IconButton';
import { IconChevronDown, IconPlus, IconSearch } from '@/components/ui/icons';
import { dispatchSorted } from '@/lib/events';
import { INDUCTION_KEYS } from '@/lib/induction';

interface TopbarProps {
  /** The active workspace's display name ("<Brand> - <Platform>"). */
  workspaceName: string | null;
  currentUserName?: string;
  currentUserAvatarUrl?: string | null;
  onOpenPalette: () => void;
  onOpenAvatar: () => void;
  /**
   * Set while the person has no workspace yet: the slot reads "Create your
   * workspace" at every width and opens the create dialog, and search stays
   * out (nothing behind it works without a workspace).
   */
  onCreateWorkspace?: () => void;
}

export function Topbar({
  workspaceName,
  currentUserName,
  currentUserAvatarUrl,
  onOpenPalette,
  onOpenAvatar,
  onCreateWorkspace,
}: TopbarProps) {
  return (
    <header className="sticky top-0 z-30 flex items-center gap-2 h-14 px-3 md:px-4 border-b border-border bg-panel">
      {workspaceName === null && onCreateWorkspace !== undefined ? (
        <button
          type="button"
          aria-haspopup="dialog"
          data-induction={INDUCTION_KEYS.topbarWorkspaceSlot}
          onClick={onCreateWorkspace}
          className="flex min-w-0 items-center gap-1.5 min-h-[44px] px-3 rounded-lg border border-dashed border-border-strong text-left text-[13px] font-semibold text-fg hover:bg-panel-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <IconPlus size={16} className="shrink-0 text-fg-3" />
          <span className="truncate">Create your workspace</span>
        </button>
      ) : workspaceName === null ? (
        <span className="md:hidden h-4 w-24 rounded bg-panel-3 animate-pulse" aria-hidden />
      ) : (
        <button
          type="button"
          aria-label="Switch workspace"
          aria-haspopup="dialog"
          data-induction={INDUCTION_KEYS.topbarWorkspaceSlot}
          onClick={() => dispatchSorted('sorted:switch-workspace')}
          className="md:hidden flex min-w-0 items-center gap-1 min-h-[44px] max-w-[190px] px-2 rounded-lg text-left hover:bg-panel-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          {/* "<Brand> - <Platform>" can outgrow one line on a phone: wrap to two
              short lines at word breaks instead of clipping the platform. */}
          <span className="min-w-0 font-semibold text-[13px] leading-tight line-clamp-2 break-words">
            {workspaceName}
          </span>
          <IconChevronDown size={16} className="shrink-0 text-fg-3" />
        </button>
      )}

      {onCreateWorkspace !== undefined ? null : (
        <button
          type="button"
          onClick={onOpenPalette}
          className="hidden md:flex items-center gap-2 h-9 min-w-[240px] px-3 rounded-lg border border-border bg-panel-2 text-fg-3 text-sm hover:bg-panel-3 transition-colors"
        >
          <IconSearch size={16} />
          <span className="flex-1 text-left">Search</span>
          <kbd className="text-[11px] border border-border rounded px-1.5 py-0.5">⌘K</kbd>
        </button>
      )}

      <div className="ml-auto flex items-center gap-1">
        {onCreateWorkspace !== undefined ? null : (
          <IconButton label="Search" className="md:hidden" onClick={onOpenPalette}>
            <IconSearch />
          </IconButton>
        )}

        <button
          type="button"
          aria-label="Account menu"
          onClick={onOpenAvatar}
          className="inline-flex items-center justify-center h-11 w-11 rounded-md hover:bg-panel-2 transition-colors"
        >
          <Avatar
            size="md"
            {...(currentUserName !== undefined ? { name: currentUserName } : {})}
            {...(currentUserAvatarUrl ? { src: currentUserAvatarUrl } : {})}
          />
        </button>
      </div>
    </header>
  );
}
