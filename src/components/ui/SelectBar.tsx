// The one select mode for list cards (ui/ListCard `select`): useListSelection
// holds which cards are ticked (pure client state: no await, no read) and
// SelectBar is the bottom bar that carries the cards' actions while selecting
// (Pipeline, Assets, Bank; the chat list keeps its own bar in ChannelList).
// A long-press (phone) or right-click / Shift-click / Cmd-click (laptop)
// enters with that card ticked; a tap toggles; unticking the last card, the
// bar's Cancel, Esc and browser Back all leave. The bar sits in thumb reach
// above the floating tab bar (useBottomInset), lit-dock, light and dark alike.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ComponentType, ReactElement, RefObject } from 'react';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { ICON_SIZE, type IconProps } from '@/components/ui/icons';
import { textRole } from '@/components/ui/Text';
import type { ListCardHooks, ListCardSelect } from '@/components/ui/ListCard';
import { cn } from '@/lib/cn';
import { MOVE_CLASS } from '@/lib/motion';
import { bottomAnchorProps, useBottomInset } from '@/lib/bottom-inset';
import { enterHistoryStep, type HistoryStep } from '@/lib/chat/use-history-step';

/** The history.state key of a list's select mode (browser Back leaves it). */
export const LIST_SELECT_STEP_KEY = 'listSelect';

/** "1 selected", "3 selected". */
export function selectCountLabel(count: number): string {
  return `${count} selected`;
}

const NONE: ReadonlySet<string> = new Set();

export interface ListSelection {
  /** The ticked ids. */
  ids: ReadonlySet<string>;
  /** Select mode is on (at least one card ticked). */
  active: boolean;
  count: number;
  /** Enter select mode with this card ticked. */
  enter: (id: string) => void;
  /** Tick or untick; unticking the last card leaves select mode. */
  toggle: (id: string) => void;
  /** Tick exactly these (Select all). An empty set leaves. */
  setMany: (ids: Iterable<string>) => void;
  /** Leave select mode now (Cancel, a finished action). */
  clear: () => void;
  /** Leave select mode first (its Back entry popped), then run `then` (Open). */
  leaveThen: (then: () => void) => void;
  /** The ListCard `select` prop for one card. */
  selectFor: (id: string) => ListCardSelect;
}

/**
 * Which cards are ticked. Select mode is on while one or more are; it holds
 * one history entry (browser Back leaves) and Esc leaves on laptop (unless a
 * sheet or menu above handled the key first).
 */
export function useListSelection(): ListSelection {
  const [ids, setIds] = useState<ReadonlySet<string>>(NONE);
  const active = ids.size > 0;
  const stepRef = useRef<HistoryStep | null>(null);

  const clear = useCallback(() => setIds(NONE), []);
  const enter = useCallback((id: string) => setIds(new Set([id])), []);
  const toggle = useCallback(
    (id: string) =>
      setIds((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next.size === 0 ? NONE : next;
      }),
    [],
  );
  const setMany = useCallback((list: Iterable<string>) => {
    const next = new Set(list);
    setIds(next.size === 0 ? NONE : next);
  }, []);

  useEffect(() => {
    if (!active) return;
    const step = enterHistoryStep(window, LIST_SELECT_STEP_KEY, () => {
      stepRef.current = null;
      setIds(NONE);
    });
    stepRef.current = step;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !event.defaultPrevented) setIds(NONE);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (stepRef.current === step) stepRef.current = null;
      step.dispose();
    };
  }, [active]);

  const leaveThen = useCallback((then: () => void) => {
    const step = stepRef.current;
    stepRef.current = null;
    if (step === null) {
      setIds(NONE);
      then();
      return;
    }
    step.cancel(() => {
      setIds(NONE);
      then();
    });
  }, []);

  const selectFor = useCallback(
    (id: string): ListCardSelect => ({
      active,
      chosen: ids.has(id),
      onEnter: () => enter(id),
      onToggle: () => toggle(id),
    }),
    [active, ids, enter, toggle],
  );

  return useMemo(
    () => ({ ids, active, count: ids.size, enter, toggle, setMany, clear, leaveThen, selectFor }),
    [ids, active, enter, toggle, setMany, clear, leaveThen, selectFor],
  );
}

/** One action on the select bar: an old ⋮ menu row. */
export interface SelectBarAction {
  id: string;
  label: string;
  icon: ComponentType<IconProps>;
  onSelect: () => void;
  /** Delete and other destructive rows: bad ink. */
  tone?: 'bad';
  disabled?: boolean;
  hooks?: ListCardHooks;
}

/**
 * Which actions show for a count: `single` rows (Open, Copy link, Send to
 * chat, Plan it) only when exactly one card is ticked; the rest for any count.
 * Pure.
 */
export function visibleSelectActions<T extends { single?: boolean }>(
  actions: readonly T[],
  count: number,
): T[] {
  return actions.filter((action) => action.single !== true || count === 1);
}

interface SelectBarProps {
  count: number;
  onCancel: () => void;
  /** The actions for the current count (visibleSelectActions). */
  actions: readonly SelectBarAction[];
  /** The toolbar's accessible name ("Selected posts"). */
  label: string;
  /** A trailing text control (Select all), when the list has one. */
  extra?: ReactElement | null;
  barRef?: RefObject<HTMLDivElement>;
  [hook: `data-${string}`]: string | undefined;
}

/**
 * The bottom bar while selecting: Cancel, "N selected", then one 44
 * IconButton per action (Delete last, bad ink). Fixed above the tab bar on
 * phone (its inset measured, the safe area kept when nothing is under it);
 * the same bar on laptop. A spacer keeps the last card uncovered. It comes in
 * on translateY only (mv-slide); instant under Reduce Motion.
 */
export function SelectBar({
  count,
  onCancel,
  actions,
  label,
  extra = null,
  barRef,
  ...hooks
}: SelectBarProps): ReactElement {
  const ownRef = useRef<HTMLDivElement>(null);
  const ref = barRef ?? ownRef;
  const inset = useBottomInset(ref);
  return (
    <>
      <div aria-hidden="true" className="h-20" />
      <div
        ref={ref}
        {...hooks}
        data-select-bar=""
        role="toolbar"
        aria-label={label}
        {...bottomAnchorProps}
        style={{ bottom: inset }}
        className={cn(
          'lit-dock fixed inset-x-0 z-dock flex items-center gap-1 border-t bg-panel pt-3',
          'pl-[calc(1rem+env(safe-area-inset-left))] pr-[calc(1rem+env(safe-area-inset-right))]',
          inset > 0 ? 'pb-3' : 'pb-[max(12px,env(safe-area-inset-bottom))]',
          MOVE_CLASS.slide,
        )}
      >
        <Button variant="ghost" type="button" data-select-bar-cancel="" onClick={onCancel}>
          Cancel
        </Button>
        <span
          data-select-bar-count=""
          aria-live="polite"
          className={textRole('heading', 'min-w-0 flex-1 truncate')}
        >
          {selectCountLabel(count)}
        </span>
        {extra}
        {actions.map((action) => (
          <IconButton
            key={action.id}
            label={action.label}
            data-select-bar-action={action.id}
            {...action.hooks}
            disabled={action.disabled === true || count === 0}
            className={action.tone === 'bad' ? 'text-bad hover:text-bad' : undefined}
            onClick={action.onSelect}
          >
            <action.icon size={ICON_SIZE.control} />
          </IconButton>
        ))}
      </div>
    </>
  );
}
