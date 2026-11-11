// Top bar actions (decision A, 7 Nov): a page publishes its sort and its
// primary "+" into the app top bar; Topbar renders them in two fixed 44 slots
// (sort, then "+" last before the avatar). Pure render plumbing: no reads, no
// awaits, no gates. A page unmount clears its actions.
//
// Two contexts so a publishing page never re-renders when the bar changes:
// the setter is stable; only Topbar reads the actions.

import {
  createContext,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
  type Ref,
} from 'react';
import { ActionMenu, type ActionMenuItem } from '@/components/ui/ActionMenu';
import { Button } from '@/components/ui/Button';
import {
  IconActivity,
  IconPlus,
  IconThreads,
  IconTickDouble,
  ICON_SIZE,
} from '@/components/ui/icons';
import { LIST_CARD_SOLID_GROUP, ListCard } from '@/components/ui/ListCard';
import { useOptionalToast } from '@/components/ui/toast';
import { useMenuGesture } from '@/components/ui/useLongPress';
import { CATCH_UP } from '@/lib/catch-up/copy';
import { useWorkspaceThreads, unreadThreadCount } from '@/lib/catch-up/threads';
import { cn } from '@/lib/cn';

export interface TopbarActions {
  /** The screen's sort control (an IconSort IconButton that opens its menu or sheet). */
  sort?: ReactNode;
  /**
   * The screen's primary control: a filled "+" (TopbarPlus). null/undefined
   * renders an empty slot of the same width, so search and sort never move
   * between tabs.
   */
  primary?: ReactNode;
}

type SetActions = (owner: symbol, actions: TopbarActions | null) => void;

interface Published {
  owner: symbol | null;
  actions: TopbarActions;
}

const EMPTY: Published = { owner: null, actions: {} };

const ActionsContext = createContext<TopbarActions>({});
const SetContext = createContext<SetActions | null>(null);

export function TopbarActionsProvider({ children }: { children: ReactNode }): ReactElement {
  const [published, setPublished] = useState<Published>(EMPTY);
  const set = useMemo<SetActions>(
    () => (owner, actions) =>
      setPublished((prev) => {
        if (actions === null) return prev.owner === owner ? EMPTY : prev;
        return { owner, actions };
      }),
    [],
  );
  return (
    <SetContext.Provider value={set}>
      <ActionsContext.Provider value={published.actions}>{children}</ActionsContext.Provider>
    </SetContext.Provider>
  );
}

/** Topbar's read of the current page's actions. */
export function useTopbarActionsValue(): TopbarActions {
  return useContext(ActionsContext);
}

/**
 * Publish this page's sort and primary into the top bar. Runs after each
 * render of the page (layout effect: same frame, no flash), never awaits, and
 * clears on unmount. Outside the provider (tests, isolated renders) it is a
 * no-op.
 */
export function useTopbarActions(actions: TopbarActions): void {
  const set = useContext(SetContext);
  const [owner] = useState(() => Symbol('topbar-actions'));
  const { sort, primary } = actions;
  useLayoutEffect(() => {
    set?.(owner, { sort, primary });
  }, [set, owner, sort, primary]);
  useLayoutEffect(() => () => set?.(owner, null), [set, owner]);
}

/**
 * The top bar "+" (10 Nov 2026): ONE Button with two faces switched by CSS
 * only (no JS width read). The label is the screen's create label ("New
 * post", "New brief", "New file", "New plan", "Add idea", "New chat"); the old
 * data-induction key rides on it so the tour keeps its target.
 *
 * - Below md: a 36 x 44 hit strip (Topbar's key spacing) around an outlined
 *   22 square, 1.75 line in currentColor, radius 7, no fill, a 14 glyph; fg ink
 *   like Search and Sort, the Tool hover overlay only.
 * - md and up: a 112 x 44 hit around the Main face, 112 x 32, rounded-lg,
 *   accent fill, "+ <label>".
 *
 * Both faces are aria-hidden, so the accessible name (aria-label) is read once.
 *
 * Blocked (9 Nov 2026): a screen's create "+" always shows. Without the
 * capability the caller passes `blocked`: same size, shape and slot, the
 * disabled look via aria-disabled (NOT the disabled attribute, so taps still
 * fire): fg-3 ink on the phone face, a fg-3 fill on the laptop face. A tap
 * only shows a toast saying who creates.
 */
export function TopbarPlus({
  label,
  onClick,
  induction,
  blocked,
  ...rest
}: {
  label: string;
  onClick: () => void;
  induction?: string | undefined;
  blocked?: { message: string } | undefined;
  'aria-haspopup'?: 'menu' | 'dialog' | undefined;
  'aria-expanded'?: boolean | undefined;
  buttonRef?: Ref<HTMLButtonElement> | undefined;
}): ReactElement {
  const { buttonRef, ...aria } = rest;
  const toast = useOptionalToast();
  return (
    <Button
      buttonRef={buttonRef}
      type="button"
      variant="ghost"
      aria-label={label}
      data-topbar-plus=""
      {...(blocked !== undefined
        ? { 'aria-disabled': 'true' as const, 'data-topbar-plus-blocked': '' }
        : aria)}
      {...(induction !== undefined ? { 'data-induction': induction } : {})}
      onClick={blocked !== undefined ? () => toast?.show({ title: blocked.message }) : onClick}
      className={TOPBAR_PLUS_HIT}
    >
      <span aria-hidden="true" data-topbar-plus-face="phone" className={TOPBAR_PLUS_PHONE_FACE}>
        <IconPlus size={ICON_SIZE.boxed} />
      </span>
      <span
        aria-hidden="true"
        data-topbar-plus-face="laptop"
        className={cn(
          TOPBAR_PLUS_LAPTOP_FACE,
          blocked !== undefined ? 'bg-fg-3' : 'bg-accent group-hover:bg-accent-hover',
        )}
      >
        <IconPlus size={ICON_SIZE.inline} className="shrink-0" />
        <span className="truncate">{label}</span>
      </span>
    </Button>
  );
}

/** The "+" hit area: a 36 x 44 strip below md, 112 x 44 from md (the Main face's slot). */
const TOPBAR_PLUS_HIT =
  'group shrink-0 px-0 text-fg w-topbar-key min-w-0 md:w-28 md:hover:bg-none md:active:bg-none';
/** Below md: the outlined 22 square, currentColor line (fg, fg-3 when blocked), no fill. */
const TOPBAR_PLUS_PHONE_FACE =
  'inline-flex h-plus-box w-plus-box items-center justify-center rounded-plus-box border-plus-box border-current bg-transparent md:hidden';
/** md and up: the Main face, 112 x 32, accent fill (fg-3 when blocked), "+ <label>". */
const TOPBAR_PLUS_LAPTOP_FACE =
  'hidden h-8 w-28 items-center justify-center gap-2 rounded-lg px-2 text-accent-fg md:inline-flex';

// --- Activity: Catch up and Threads, solid rows (11 Nov 2026) ----------------
//
// The top bar is the same on every tab; Activity's Catch up and Threads are
// solid list rows (ui/ListCard solid + count) on top of the notification
// list, in ListScreen's lead slot under the filter chips: Catch up first, then
// Threads. A row shows only while its count is above 0; both at 0, the lead
// slot is not rendered at all. Rows appear and leave at once (no motion).

/** Threads' accessible name: "Threads, N new" / "Threads". Pure. */
export function threadsLabel(count: number): string {
  return count > 0 ? `Threads, ${count} new` : 'Threads';
}

/** Catch up's accessible name: "Catch up, N unread" / "Catch up". Pure. */
export function catchUpLabel(count: number): string {
  return count > 0 ? `${CATCH_UP}, ${count} unread` : CATCH_UP;
}

/** The long-press menu's one row. */
export const MARK_ALL_AS_READ = 'Mark all as read';

/** The rows' second line: the short count line. Pure. */
export function catchUpLine(count: number): string {
  return `${count} unread`;
}
export function threadsLine(count: number): string {
  return `${count} new`;
}

/** Threads: the unread threads I am in. A tap opens the Threads list. */
function ThreadsRow(props: { count: number; onOpen: () => void }): ReactElement {
  return (
    <ListCard
      solid
      unread
      count={props.count}
      picture={{ kind: 'icon', icon: IconThreads }}
      title="Threads"
      preview={threadsLine(props.count)}
      onPress={props.onOpen}
      press={{
        'aria-label': threadsLabel(props.count),
        'data-topbar-threads': '',
        'data-count': String(props.count),
      }}
    />
  );
}

/**
 * Catch up: the unread count. A tap opens catch up; a long-press (touch) or
 * right-click (laptop) opens the menu with one row, Mark all as read: the
 * whole inbox read at once, no toast, no Undo.
 */
function CatchUpRow(props: {
  count: number;
  onOpen: () => void;
  onMenu: () => void;
}): ReactElement {
  const gesture = useMenuGesture(props.onMenu);
  return (
    <ListCard
      solid
      unread
      count={props.count}
      picture={{ kind: 'icon', icon: IconActivity }}
      title={CATCH_UP}
      preview={catchUpLine(props.count)}
      onPress={() => {
        if (gesture.consumeClickSuppression()) return;
        props.onOpen();
      }}
      press={{
        ...gesture.handlers,
        'aria-label': catchUpLabel(props.count),
        'data-topbar-catch-up': '',
        'data-count': String(props.count),
      }}
    />
  );
}

/** The solid rows and Catch up's menu. Renders nothing when both counts are 0. */
export function ActivitySolidRows(props: {
  unread: number;
  threads: number;
  onCatchUp: () => void;
  onThreads: () => void;
  onMarkAllRead: () => void;
}): ReactElement | null {
  const [menuOpen, setMenuOpen] = useState(false);
  const showCatchUp = props.unread > 0;
  const showThreads = props.threads > 0;
  if (!showCatchUp && !showThreads) return null;
  const items: ActionMenuItem[] = [
    {
      id: 'mark-all-read',
      label: MARK_ALL_AS_READ,
      icon: IconTickDouble,
      onSelect: props.onMarkAllRead,
    },
  ];
  return (
    <div data-activity-solid-rows="" className="relative">
      <div className={LIST_CARD_SOLID_GROUP}>
        {showCatchUp ? (
          <CatchUpRow
            count={props.unread}
            onOpen={props.onCatchUp}
            onMenu={() => setMenuOpen(true)}
          />
        ) : null}
        {showThreads ? <ThreadsRow count={props.threads} onOpen={props.onThreads} /> : null}
      </div>
      {/* The menu anchors to the rows' box (its trailing edge, under it). */}
      {showCatchUp ? (
        <span className="pointer-events-none absolute inset-0 flex justify-end">
          <ActionMenu
            title={CATCH_UP}
            items={items}
            trigger={null}
            open={menuOpen}
            onOpenChange={setMenuOpen}
          />
        </span>
      ) : null}
    </div>
  );
}

/**
 * Activity's solid rows, for ListScreen's `lead` slot: null when both counts
 * are 0 (ListScreen then skips the slot). Pure render from the two stores
 * already held: totalUnread from the inbox store, the threads the device
 * holds (the threads read starts after the first paint in
 * useWorkspaceThreads' effect and is never awaited; 0 before it lands).
 * Handlers ride a ref so the rows change only with the counts. `ready` is
 * kept for the callers' shape; nothing waits on it.
 */
export function useActivitySolidRows(input: {
  workspaceId: string | null;
  totalUnread: number;
  ready: boolean;
  onCatchUp: () => void;
  onThreads: () => void;
  onMarkAllRead: () => void;
}): ReactElement | null {
  const threads = useWorkspaceThreads(input.workspaceId);
  const threadCount = unreadThreadCount(threads);
  const handlers = useRef(input);
  handlers.current = input;
  const { totalUnread } = input;
  return useMemo(
    () =>
      totalUnread > 0 || threadCount > 0 ? (
        <ActivitySolidRows
          unread={totalUnread}
          threads={threadCount}
          onCatchUp={() => handlers.current.onCatchUp()}
          onThreads={() => handlers.current.onThreads()}
          onMarkAllRead={() => handlers.current.onMarkAllRead()}
        />
      ) : null,
    [threadCount, totalUnread],
  );
}
