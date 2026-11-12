import type { ReactNode } from 'react';
import { TestSiteAnywhereStart } from '@/components/test-site/TestSiteAnywhereStart';
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
 * A phone top bar key (below md, 10 Nov 2026): a 36 wide x 44 tall hit strip,
 * strips touching (cluster gap 0), so Search, sort, "+" and the avatar sit 36
 * apart centre to centre and a tap goes to the nearest key. The second written
 * exception to 44 x 44 (the first: the composer row keys). md and up keep the
 * 44 boxes, gap-1. Guard: src/__tests__/topbar-keys.test.ts.
 */
export const TOPBAR_KEY = 'max-md:w-topbar-key max-md:min-w-0';

/**
 * One fixed slot: the page's control, or an empty box of the same width so
 * search and sort never move between tabs (an empty slot keeps the width).
 * Below md each is a 36 strip (the sort's IconButton is held to it); md and
 * up the sort is 44 and the primary 112 (TopbarPlus' Main face).
 */
function Slot({ name, children }: { name: 'sort' | 'primary'; children: ReactNode }) {
  return (
    <span
      data-topbar-slot={name}
      className={cn(
        'inline-flex h-11 w-topbar-key shrink-0 items-center justify-center',
        name === 'sort'
          ? 'md:w-auto md:min-w-11 max-md:[&_button]:w-topbar-key max-md:[&_button]:min-w-0'
          : 'md:w-28',
      )}
    >
      {children ?? (
        <span
          aria-hidden="true"
          className={cn('h-11 w-topbar-key', name === 'sort' ? 'md:w-11' : 'md:w-28')}
        />
      )}
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
  // The same two slots on every tab (Activity publishes none, so both stay
  // empty boxes of the same width): search and the avatar never move.
  return (
    <>
      <Slot name="sort">{actions.sort}</Slot>
      <Slot name="primary">{actions.primary}</Slot>
    </>
  );
}

/**
 * The phone's workspace name text: the full name on every tab. "<Brand> -
 * <Platform>" can outgrow one line: it wraps to two short lines at word
 * breaks, then ends in an ellipsis. Pure.
 */
export function WorkspaceNameText({ name }: { name: string }) {
  return (
    <span
      data-topbar-workspace-name=""
      className={textRole('title', 'min-w-0 line-clamp-2 break-words')}
    >
      {name}
    </span>
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
          // Phone: the label is never cut; it wraps to two lines and the key grows inside the bar.
          className="min-w-0 text-left max-md:h-auto max-md:min-h-11 max-md:py-1"
        >
          <IconPlus size={ICON_SIZE.inline} className="shrink-0 text-fg" />
          <span className="truncate max-md:whitespace-normal">Create your workspace</span>
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
          <WorkspaceNameText name={workspaceName} />
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

      <div className="ml-auto flex items-center md:gap-1">
        <TestSiteAnywhereStart inline />
        {onCreateWorkspace !== undefined ? null : (
          <IconButton
            label="Search"
            className={cn('md:hidden', TOPBAR_KEY)}
            onClick={onOpenPalette}
          >
            <IconSearch size={ICON_SIZE.control} />
          </IconButton>
        )}
        {/* The operator's Cockpit dot is one more phone key: a 36 strip in the run. */}
        {cockpitSlot !== undefined && cockpitSlot !== null ? (
          <span
            data-topbar-cockpit=""
            className="inline-flex shrink-0 max-md:[&_button]:w-topbar-key max-md:[&_button]:min-w-0"
          >
            {cockpitSlot}
          </span>
        ) : null}
        {/* Activity lives in the laptop Sidebar after Chat (10 Nov 2026) and in
            the phone's floating tab bar; the top bar has no Activity button. */}

        {/* Decision A: search | sort | filled "+" (always last) | avatar. The
            workspace-less state has no sort and no "+". */}
        {inWorkspace ? <TopbarSlots /> : null}

        {/* A press starts the Settings chunk and the members read it shows. Below
            md a 36 strip, 4 in from the gutter, so the 32 photo's right edge
            stays where it was (6 in from the gutter edge). */}
        <IconButton
          type="button"
          label="Account menu"
          className={cn(TOPBAR_KEY, 'max-md:mr-1')}
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
