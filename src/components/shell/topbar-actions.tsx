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
  useState,
  type ReactElement,
  type ReactNode,
  type Ref,
} from 'react';
import { Button } from '@/components/ui/Button';
import { IconPlus, ICON_SIZE } from '@/components/ui/icons';
import { useOptionalToast } from '@/components/ui/toast';
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

// Activity's Catch up and Threads solid rows were removed on 13 Nov 2026:
// catch up lives on each tab (catch-up/TabCatchUp), above its chip row.
