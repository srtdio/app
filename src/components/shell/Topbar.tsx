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
import { textRole } from '@/components/ui/Text';
import { GUTTER } from '@/components/ui/layout';
import { SAFE_TOP_BAR_CLASS } from '@/lib/scroll-mode';
import { useTopbarActionsValue } from '@/components/shell/topbar-actions';

/**
 * One fixed 44 slot: the page's control, or an empty box of the same width so
 * search and sort never move between tabs (the "+" hides where a person can't
 * create, and Mark all read hides at 0 unread, keeping the width).
 */
function Slot({ name, children }: { name: 'sort' | 'primary'; children: ReactNode }) {
  return (
    <span data-topbar-slot={name} className="inline-flex h-11 min-w-11 shrink-0 items-center">
      {children ?? <span aria-hidden="true" className="h-11 w-11" />}
    </span>
  );
}

/**
 * The laptop search field's own look (a field, not a Button level): panel
 * fill, hairline edge with the strong bottom line, fg ink. It rides the ghost
 * Button only for its 44 box, press and hover overlay, so the Button levels
 * never grey it.
 */
export const TOPBAR_SEARCH_FIELD = 'border border-b-border-strong bg-panel text-fg';

/**
 * The page's published sort and primary (useTopbarActions), in two fixed
 * slots. Pure render: a context read, no network read, no await. Its own
 * component so Topbar itself stays hookless.
 */
export function TopbarSlots() {
  const actions = useTopbarActionsValue();
  return (
    <>
      <Slot name="sort">{actions.sort}</Slot>
      <Slot name="primary">{actions.primary}</Slot>
    </>
  );
}

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
  const inWorkspace = workspaceName !== null && onCreateWorkspace === undefined;
  return (
    // Sticky to <main> in locked mode (Chat, laptop) and to the window in page
    // mode on a phone or a touch tablet (src/lib/scroll-mode.ts), where the
    // status bar strip above the 56px bar is part of this same solid, lit surface.
    <header
      className={cn(
        // The page edge (GUTTER): 16 phone, 24 laptop, the same edge as the
        // chip row under it.
        'sticky top-0 z-nav flex items-center gap-2 border-b bg-panel lit-header',
        GUTTER,
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
          className="min-w-0 text-left"
        >
          <IconPlus size={ICON_SIZE.inline} className="shrink-0 text-fg" />
          <span className="truncate">Create your workspace</span>
        </Button>
      ) : workspaceName === null ? (
        <Bone lit="flat" className="md:hidden h-4 w-24 rounded" />
      ) : (
        <Button
          type="button"
          variant="ghost"
          aria-label="Switch workspace"
          aria-haspopup="dialog"
          data-induction={INDUCTION_KEYS.topbarWorkspaceSlot}
          onClick={() => dispatchSorted('sorted:switch-workspace')}
          // L6: the tap area keeps the button's 16 inset; the name itself
          // starts on the 16 edge (the box is pulled out by its own inset).
          className="md:hidden -ml-4 min-w-0 max-w-48 text-left"
        >
          {/* "<Brand> - <Platform>" can outgrow one line on a phone: wrap to two
              short lines at word breaks instead of clipping the platform. */}
          <span className={textRole('title', 'min-w-0 line-clamp-2 break-words')}>
            {workspaceName}
          </span>
          <IconChevronDown size={ICON_SIZE.inline} className="shrink-0 text-fg-3" />
        </Button>
      )}

      {onCreateWorkspace !== undefined ? null : (
        <Button
          type="button"
          variant="ghost"
          onClick={onOpenPalette}
          className={cn(TOPBAR_SEARCH_FIELD, 'hidden md:flex min-w-60')}
        >
          <IconSearch size={ICON_SIZE.inline} className="text-fg-3" />
          <span className="flex-1 text-left text-fg-3">Search</span>
          <kbd className="text-xs text-fg-3 border border-border rounded px-1 py-1 lit-pill">
            ⌘K
          </kbd>
        </Button>
      )}

      <div className="ml-auto flex items-center gap-1">
        <TestSiteAnywhereStart inline />
        {onCreateWorkspace !== undefined ? null : (
          <IconButton label="Search" className="md:hidden" onClick={onOpenPalette}>
            <IconSearch size={ICON_SIZE.control} />
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

        {/* Decision A: search | sort | filled "+" (always last) | avatar. The
            workspace-less state has no sort and no "+". */}
        {inWorkspace ? <TopbarSlots /> : null}

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
