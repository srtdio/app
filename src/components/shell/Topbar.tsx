import { TestSiteAnywhereStart } from '@/components/test-site/TestSiteAnywhereStart';
import { NotificationsButton } from '@/components/shell/NotificationsButton';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { IconChevronDown, IconPlus, IconSearch, ICON_SIZE } from '@/components/ui/icons';
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
        <Button
          type="button"
          variant="secondary"
          aria-haspopup="dialog"
          data-induction={INDUCTION_KEYS.topbarWorkspaceSlot}
          onClick={onCreateWorkspace}
          className="min-w-0 border-dashed text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <IconPlus size={ICON_SIZE.inline} className="shrink-0 text-fg-3" />
          <span className="truncate">Create your workspace</span>
        </Button>
      ) : workspaceName === null ? (
        <span className="md:hidden h-4 w-24 rounded bg-panel-3 animate-pulse" aria-hidden />
      ) : (
        <Button
          type="button"
          variant="ghost"
          aria-label="Switch workspace"
          aria-haspopup="dialog"
          data-induction={INDUCTION_KEYS.topbarWorkspaceSlot}
          onClick={() => dispatchSorted('sorted:switch-workspace')}
          className="md:hidden min-w-0 max-w-[190px] text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          {/* "<Brand> - <Platform>" can outgrow one line on a phone: wrap to two
              short lines at word breaks instead of clipping the platform. */}
          <span className="min-w-0 text-fg leading-tight line-clamp-2 break-words">
            {workspaceName}
          </span>
          <IconChevronDown size={ICON_SIZE.inline} className="shrink-0 text-fg-3" />
        </Button>
      )}

      {onCreateWorkspace !== undefined ? null : (
        <Button
          type="button"
          variant="secondary"
          onClick={onOpenPalette}
          className="hidden md:flex min-w-[240px]"
        >
          <IconSearch size={ICON_SIZE.inline} className="text-fg-3" />
          <span className="flex-1 text-left text-fg-3">Search</span>
          <kbd className="text-xs text-fg-3 border border-border rounded px-1.5 py-0.5">⌘K</kbd>
        </Button>
      )}

      <div className="ml-auto flex items-center gap-1">
        <TestSiteAnywhereStart inline />
        {onCreateWorkspace !== undefined ? null : (
          <IconButton label="Search" className="md:hidden" onClick={onOpenPalette}>
            <IconSearch />
          </IconButton>
        )}
        {/* Activity on every main screen (its one mount), with the unread count. */}
        {workspaceName !== null && onCreateWorkspace === undefined ? <NotificationsButton /> : null}

        <IconButton type="button" label="Account menu" onClick={onOpenAvatar}>
          <Avatar
            role="header"
            {...(currentUserName !== undefined ? { name: currentUserName } : {})}
            {...(currentUserAvatarUrl ? { src: currentUserAvatarUrl } : {})}
          />
        </IconButton>
      </div>
    </header>
  );
}
