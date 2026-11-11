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
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
  type Ref,
  type RefObject,
} from 'react';
import { ActionMenu, type ActionMenuItem } from '@/components/ui/ActionMenu';
import { Button } from '@/components/ui/Button';
import { CountBadge } from '@/components/ui/CountBadge';
import { IconPlus, IconTickDouble, ICON_SIZE } from '@/components/ui/icons';
import { useOptionalToast } from '@/components/ui/toast';
import { useMenuGesture } from '@/components/ui/useLongPress';
import { CATCH_UP } from '@/lib/catch-up/copy';
import { useWorkspaceThreads, unreadThreadCount } from '@/lib/catch-up/threads';
import { cn } from '@/lib/cn';
import {
  DUR_SLOW_MS,
  DUR_WIPE_MS,
  EASE,
  motionOff,
  play,
  type MoveSpec,
  type Played,
} from '@/lib/motion';

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

// --- Activity: Threads | Catch up (lead row, 10 Nov 2026) --------------------
//
// The top bar is the same on every tab; Activity's Threads and Catch up sit in
// ListScreen's lead slot under the filter pills: two equal buttons filling the
// row, 8 apart (ActivityLeadRow). One identical box each: face 28 tall
// (PAIR_BOX_HEIGHT), text 12 (500), padding-x 8, gap 6, radius 8, a 1px
// border; the hit is 44 tall through a ::before, so the face never grows.
// Each button on its own: a count > 0 is the Main level (primary, ink fill)
// with the count pill; 0 is the outline (Tool level with a border-strong
// hairline), no pill.

/** Threads' and Catch up's one box: the 28 face, the row's half, the 44 hit on ::before. */
export const ACTIVITY_TOPBAR_BOX =
  'relative h-7 min-h-0 w-full min-w-0 gap-pair border px-2 text-sm before:absolute before:inset-x-0 before:top-1/2 before:h-11 before:-translate-y-1/2';

/** The lead row: two equal columns, 8 apart, filling the content width. */
export const ACTIVITY_LEAD_ROW = 'grid grid-cols-2 gap-2';

/**
 * The pill's text, 10 (the named pair-pill size, the pill only): set on
 * the wrapper over CountBadge's own size, so CountBadge itself is unchanged.
 */
export const ACTIVITY_TOPBAR_PILL_TEXT =
  'inline-flex shrink-0 [&_[data-count-badge]]:text-pair-pill';

/** The count pill on a filled box: 16 tall (PAIR_PILL_HEIGHT; CountBadge on-fill). */
export const ACTIVITY_TOPBAR_PILL = 'h-4 min-w-4 px-1 text-xs';

/** The pulse: the ring scales out and back, 3 times, 1.4 s each (wipe + slow beats). */
export const PULSE_CYCLE_MS = DUR_WIPE_MS + DUR_SLOW_MS;
export const PULSE_CYCLES = 3;
/** Rises this soon after the button mounts or the tab returns never pulse (a refresh landing). */
export const PULSE_QUIET_MS = 3000;
const PULSE_MOVE: MoveSpec = { move: 'touch', axis: ['scale'] };

/** Whether a count change pulses: only a rise, armed, on screen, outside the quiet window. Pure. */
export function shouldPulse(input: {
  prev: number | null;
  next: number;
  armed: boolean;
  hidden: boolean;
  quiet: boolean;
}): boolean {
  if (!input.armed || input.hidden || input.quiet || input.prev === null) return false;
  return input.next > input.prev;
}

/**
 * The ring's three pulses (scale only, never a fade). Its rest pose is
 * scale 0 (hidden), so when the move ends or any tap finishes it, it is gone.
 * Nothing runs under Reduce Motion.
 */
export function pulseRing(el: Element | null): Played | null {
  if (el === null || motionOff()) return null;
  const frames: Keyframe[] = [];
  for (let i = 0; i < PULSE_CYCLES; i += 1) {
    const at = i / PULSE_CYCLES;
    frames.push({ transform: 'scale(1)', offset: at });
    frames.push({ transform: 'scale(1.15)', offset: at + 0.5 / PULSE_CYCLES });
  }
  frames.push({ transform: 'scale(1)', offset: 1 });
  return play(el, PULSE_MOVE, frames, {
    duration: PULSE_CYCLE_MS * PULSE_CYCLES,
    easing: EASE.ios,
  });
}

/**
 * The one pulse helper: the ring under the returned ref pulses when `count`
 * RISES while the button is on screen and armed. Never on mount (the first
 * armed count is the baseline), never in the quiet window after mount or a
 * tab return, never on a fall, never while hidden; never continuous.
 */
export function usePulseOnRise(count: number, armed: boolean): RefObject<HTMLSpanElement> {
  const ring = useRef<HTMLSpanElement>(null);
  const prev = useRef<number | null>(null);
  const quietUntil = useRef(0);
  useEffect(() => {
    quietUntil.current = Date.now() + PULSE_QUIET_MS;
    const onVisibility = (): void => {
      if (!document.hidden) quietUntil.current = Date.now() + PULSE_QUIET_MS;
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);
  useEffect(() => {
    if (!armed) return;
    const pulse = shouldPulse({
      prev: prev.current,
      next: count,
      armed,
      hidden: typeof document !== 'undefined' && document.hidden,
      quiet: Date.now() < quietUntil.current,
    });
    prev.current = count;
    if (pulse) pulseRing(ring.current);
  }, [count, armed]);
  return ring;
}

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

interface PairButtonProps {
  label: string;
  ariaLabel: string;
  count: number;
  armed: boolean;
  onClick: () => void;
  data: 'threads' | 'catch-up';
  gesture?: ReturnType<typeof useMenuGesture> | undefined;
}

/** One of the pair: the box, the label, the count pill (> 0) and the pulse ring. */
function PairButton({ label, ariaLabel, count, armed, onClick, data, gesture }: PairButtonProps) {
  const ring = usePulseOnRise(count, armed);
  const on = count > 0;
  return (
    <Button
      type="button"
      variant={on ? 'primary' : 'ghost'}
      aria-label={ariaLabel}
      {...(data === 'threads' ? { 'data-topbar-threads': '' } : { 'data-topbar-catch-up': '' })}
      data-count={count}
      {...(gesture !== undefined ? gesture.handlers : {})}
      onClick={() => {
        if (gesture?.consumeClickSuppression() === true) return;
        onClick();
      }}
      className={cn(
        ACTIVITY_TOPBAR_BOX,
        on ? 'border-transparent' : 'border-border-strong text-fg',
      )}
    >
      <span
        ref={ring}
        aria-hidden="true"
        data-topbar-pulse=""
        className="pointer-events-none absolute -inset-px scale-0 rounded-lg border border-fg"
      />
      <span className="shrink-0 whitespace-nowrap">{label}</span>
      {on ? (
        <span aria-hidden="true" data-topbar-count="" className={ACTIVITY_TOPBAR_PILL_TEXT}>
          <CountBadge tone="on-fill" count={count} className={ACTIVITY_TOPBAR_PILL} />
        </span>
      ) : null}
    </Button>
  );
}

/** Threads: the unread threads I am in. A tap opens catch up on them (nothing at 0). */
export function ThreadsButton(props: {
  count: number;
  armed: boolean;
  onOpen: () => void;
}): ReactElement {
  return (
    <PairButton
      label="Threads"
      ariaLabel={threadsLabel(props.count)}
      count={props.count}
      armed={props.armed}
      data="threads"
      onClick={() => {
        if (props.count > 0) props.onOpen();
      }}
    />
  );
}

/**
 * Catch up: the unread count. A tap opens catch up (nothing at 0, never
 * greyed: the same outline as Threads at 0, 10 Nov 2026); a
 * long-press (touch) or right-click (laptop) opens the menu with one row,
 * Mark all as read: the whole inbox read at once, no toast, no Undo.
 */
export function CatchUpButton(props: {
  count: number;
  armed: boolean;
  onOpen: () => void;
  onMarkAllRead: () => void;
}): ReactElement {
  const [menuOpen, setMenuOpen] = useState(false);
  const gesture = useMenuGesture(() => setMenuOpen(true));
  const items: ActionMenuItem[] = [
    {
      id: 'mark-all-read',
      label: MARK_ALL_AS_READ,
      icon: IconTickDouble,
      onSelect: props.onMarkAllRead,
    },
  ];
  return (
    <span data-topbar-catch-up-wrap="" className="relative flex min-w-0">
      <PairButton
        label={CATCH_UP}
        ariaLabel={catchUpLabel(props.count)}
        count={props.count}
        armed={props.armed}
        data="catch-up"
        gesture={gesture}
        onClick={() => {
          if (props.count > 0) props.onOpen();
        }}
      />
      {/* The menu anchors to the button's box (its trailing edge, under it). */}
      <span className="pointer-events-none absolute inset-0 flex justify-end">
        <ActionMenu
          title={CATCH_UP}
          items={items}
          trigger={null}
          open={menuOpen}
          onOpenChange={setMenuOpen}
        />
      </span>
    </span>
  );
}

/**
 * Activity's lead row: Threads and Catch up, for ListScreen's `lead` slot.
 * The threads read starts after the first paint (useWorkspaceThreads'
 * effect), never awaited by it; the buttons paint at once from what the
 * device holds (0 before the first read). `ready`: the list has landed (Catch
 * up's pulse arms then). Handlers ride a ref so the row changes only with the
 * counts.
 */
export function useActivityLeadRow(input: {
  workspaceId: string | null;
  totalUnread: number;
  ready: boolean;
  onCatchUp: () => void;
  onThreads: () => void;
  onMarkAllRead: () => void;
}): ReactElement {
  const threads = useWorkspaceThreads(input.workspaceId);
  const threadCount = unreadThreadCount(threads);
  const handlers = useRef(input);
  handlers.current = input;
  const { totalUnread, ready } = input;
  const threadsArmed = threads !== null;
  return useMemo(
    () => (
      <div data-activity-lead-row="" className={ACTIVITY_LEAD_ROW}>
        <ThreadsButton
          count={threadCount}
          armed={threadsArmed}
          onOpen={() => handlers.current.onThreads()}
        />
        <CatchUpButton
          count={totalUnread}
          armed={ready}
          onOpen={() => handlers.current.onCatchUp()}
          onMarkAllRead={() => handlers.current.onMarkAllRead()}
        />
      </div>
    ),
    [threadCount, threadsArmed, totalUnread, ready],
  );
}
