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

export interface TopbarActions {
  /** The screen's sort control (an IconSort IconButton that opens its menu or sheet). */
  sort?: ReactNode;
  /**
   * The screen's primary control: a filled "+" (TopbarPlus), or Activity's
   * Mark all read. null/undefined renders an empty slot of the same width,
   * so search and sort never move between tabs.
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
 * The filled "+": Button variant primary, icon only (IconPlus). The label is
 * the screen's old create label ("New post", "New brief", "New file", "New
 * plan", "Add idea", "New chat"); the old data-induction key rides on it so the
 * tour keeps its target.
 *
 * Blocked (9 Nov 2026): a screen's create "+" always shows. Without the
 * capability the caller passes `blocked`: same size, shape and slot, the
 * disabled look via aria-disabled (NOT the disabled attribute, so taps still
 * fire), and a tap only shows a toast saying who creates. The accessible name
 * stays the label.
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
  if (blocked !== undefined) {
    return (
      <Button
        buttonRef={buttonRef}
        type="button"
        variant="primary"
        aria-label={label}
        aria-disabled="true"
        data-topbar-plus=""
        data-topbar-plus-blocked=""
        {...(induction !== undefined ? { 'data-induction': induction } : {})}
        onClick={() => toast?.show({ title: blocked.message })}
        shape="round"
        className="shrink-0 rounded-lg"
      >
        <IconPlus size={ICON_SIZE.control} />
      </Button>
    );
  }
  return (
    <Button
      buttonRef={buttonRef}
      type="button"
      variant="primary"
      aria-label={label}
      data-topbar-plus=""
      {...(induction !== undefined ? { 'data-induction': induction } : {})}
      {...aria}
      onClick={onClick}
      shape="round"
      className="shrink-0 rounded-lg"
    >
      <IconPlus size={ICON_SIZE.control} />
    </Button>
  );
}
