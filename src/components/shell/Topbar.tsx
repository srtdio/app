import type { ReactNode } from 'react';
import { TestSiteAnywhereStart } from '@/components/test-site/TestSiteAnywhereStart';
import { NotificationsButton } from '@/components/shell/NotificationsButton';
import { Avatar } from '@/components/ui/Avatar';
import { settingsPrefetchProps } from '@/lib/route-prefetch';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { IconChevronDown, IconPlus, IconSearch, ICON_SIZE } from '@/components/ui/icons';
import { dispatchSorted } from '@/lib/events';
import { INDUCTION_KEYS } from '@/lib/induction';
import { Bone } from '@/lib/motion';
import { cn } from '@/lib/cn';
import { SAFE_TOP_BAR_CLASS } from '@/lib/scroll-mode';

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
  /** The operator's Cockpit dot, left of Activity (AppLayout passes it only for the operator). */
  cockpitSlot?: ReactNode;
}

export function Topbar({
  workspaceName,
  currentUserName,
  currentUserAvatarUrl,
  onOpenPalette,
  onOpenAvatar,
  onCreateWorkspace,
  cockpitSlot,
}: TopbarProps) {
  return (
    // Sticky to <main> in locked mode (Chat, laptop) and to the window in page
    // mode on a phone (src/lib/scroll-mode.ts), where the status bar strip
    // above the 56px bar is part of this same solid, lit surface.
    <header
      className={cn(
        'sticky top-0 z-30 flex items-center gap-2 px-3 md:px-4 border-b bg-panel lit-header',
        SAFE_TOP_BAR_CLASS,
      )}
    >
      {workspaceName === null && onCreateWorkspace !== undefined ? (
        <Button
          type="button"
          variant="secondary"
          aria-haspopup="dialog"
          data-induction={INDUCTION_KEYS.topbarWorkspaceSlot}
          onClick={onCreateWorkspace}
          className="min-w-0 border-dashed text-left"
        >
          <IconPlus size={ICON_SIZE.inline} className="shrink-0 text-fg-3" />
          <span className="truncate">Create your workspace</span>
        </Button>
      ) : workspaceName === null ? (
        <Bone className="md:hidden h-4 w-24 rounded" />
      ) : (
        <Button
          type="button"
          variant="ghost"
          aria-label="Switch workspace"
          aria-haspopup="dialog"
          data-induction={INDUCTION_KEYS.topbarWorkspaceSlot}
          onClick={() => dispatchSorted('sorted:switch-workspace')}
          className="md:hidden min-w-0 max-w-[190px] text-left"
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
          <kbd className="text-xs text-fg-3 border border-border rounded px-1.5 py-0.5 lit-pill">
            ⌘K
          </kbd>
        </Button>
      )}

      <div className="ml-auto flex items-center gap-1">
        <TestSiteAnywhereStart inline />
        {onCreateWorkspace !== undefined ? null : (
          <IconButton label="Search" className="md:hidden" onClick={onOpenPalette}>
            <IconSearch />
          </IconButton>
        )}
        {cockpitSlot}
        {/* Activity on every main laptop screen, with the unread count. Phone shows
            it in the floating tab bar instead: CSS hides it below md (no JS width
            check, no flash), so Search sits beside the avatar there. */}
        {workspaceName !== null && onCreateWorkspace === undefined ? (
          <span data-topbar-activity="" className="hidden md:inline-flex">
            <NotificationsButton />
          </span>
        ) : null}

        {/* A press starts the Settings chunk and the members read it shows. */}
        <IconButton
          type="button"
          label="Account menu"
          onClick={onOpenAvatar}
          {...settingsPrefetchProps()}
        >
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
