// The empty-day menu (creators, laptop): anchored to the clicked day cell and
// kept on screen near the edges. Header "Add on <day> to", then only the
// plans whose dates hold that day (dot in the plan's colour, title on up to
// two lines, mono date range, Draft tag), a divider and "+ New plan". Escape
// or a click outside closes it and focus goes back to the cell; it opens with
// focus on its first row. Tokens only.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { planRangeLabel } from '@/components/chat/plan-card';
import { popoverClass } from '@/components/ui/popover-classes';
import { cn } from '@/lib/cn';
import type { PlanBundle } from '@/lib/chat/plans';
import {
  NEW_PLAN_ROW_LABEL,
  PLAN_TONE_CLASSES,
  addOnLabel,
  isDraftPlan,
  type PlanTone,
} from '@/lib/plan-tab';
import { DraftTag } from './PlanTabList';

/** The gap the menu keeps from the viewport's edges. */
const EDGE = 8;

/**
 * Where the menu goes: at the cell's top-left (inset a little), moved left
 * and up as needed to stay inside the viewport. Pure.
 */
export function menuPosition(
  cell: { left: number; top: number; bottom: number },
  menu: { width: number; height: number },
  viewport: { width: number; height: number },
): { left: number; top: number } {
  const left = Math.max(EDGE, Math.min(cell.left + 4, viewport.width - menu.width - EDGE));
  const below = cell.top + 28;
  const top =
    below + menu.height + EDGE <= viewport.height
      ? below
      : Math.max(EDGE, Math.min(cell.bottom, viewport.height) - menu.height - EDGE);
  return { left, top };
}

export function PlanDayMenu(props: {
  day: string;
  anchor: HTMLElement;
  plans: readonly PlanBundle[];
  tones: ReadonlyMap<string, PlanTone>;
  onPick: (bundle: PlanBundle) => void;
  onNewPlan: () => void;
  onClose: () => void;
}): ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const { anchor, onClose } = props;

  // Measured before paint, so the menu shows once, already in place.
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const cell = anchor.getBoundingClientRect();
    setPos(
      menuPosition(
        cell,
        { width: el.offsetWidth, height: el.offsetHeight },
        { width: window.innerWidth, height: window.innerHeight },
      ),
    );
    el.querySelector<HTMLElement>('[role="menuitem"]')?.focus({ preventScroll: true });
  }, [anchor]);

  const close = (): void => {
    onClose();
    anchor.focus({ preventScroll: true });
  };
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      closeRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  return (
    <>
      <div className="fixed inset-0 z-40" aria-hidden="true" onClick={close} />
      <div
        ref={ref}
        role="menu"
        aria-label={addOnLabel(props.day)}
        data-plan-tab-day-menu={props.day}
        style={pos !== null ? { left: pos.left, top: pos.top } : { left: 0, top: 0 }}
        className={cn(
          'fixed z-50 w-[300px] max-w-[calc(100vw-16px)]',
          popoverClass(pos !== null),
          pos === null && 'invisible',
        )}
      >
        <p className="px-2.5 pb-1.5 pt-1 text-xs font-semibold text-fg-3">
          {addOnLabel(props.day)}
        </p>
        {props.plans.map((bundle) => (
          <button
            key={bundle.plan.id}
            type="button"
            role="menuitem"
            data-plan-tab-menu-plan={bundle.plan.id}
            onClick={() => props.onPick(bundle)}
            className="flex min-h-[44px] w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left transition-colors hover:bg-panel-2 focus-visible:bg-panel-2 focus-visible:outline-none"
          >
            <span
              aria-hidden="true"
              className={cn(
                'h-2.5 w-2.5 shrink-0 rounded-full',
                PLAN_TONE_CLASSES[props.tones.get(bundle.plan.id) ?? 'accent'].dot,
              )}
            />
            <span className="flex min-w-0 flex-1 flex-col">
              <span
                data-plan-tab-menu-title=""
                className="line-clamp-2 text-sm font-medium text-fg [overflow-wrap:anywhere]"
              >
                {bundle.plan.title}
              </span>
              <span className="truncate font-mono text-xs text-fg-3">
                {planRangeLabel(bundle.plan.starts_on, bundle.plan.ends_on)}
              </span>
            </span>
            {isDraftPlan(bundle.plan) ? <DraftTag /> : null}
          </button>
        ))}
        <div className="my-1 border-t border-border" />
        <button
          type="button"
          role="menuitem"
          data-plan-tab-menu-new=""
          onClick={props.onNewPlan}
          className="flex min-h-[44px] w-full items-center rounded-md px-2.5 text-left text-sm font-medium text-accent transition-colors hover:bg-panel-2 focus-visible:bg-panel-2 focus-visible:outline-none"
        >
          {NEW_PLAN_ROW_LABEL}
        </button>
      </div>
    </>
  );
}
