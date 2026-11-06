// The empty-day menu (creators, laptop): anchored to the clicked day cell and
// kept on screen near the edges. Header "Add on <day> to", then only the
// plans whose dates hold that day (dot in the plan's colour, title on up to
// two lines, mono date range, Draft tag), a divider, "From bank" (an idea
// from the bank onto that day: BankPickSheet, placed in the plan covering it)
// and "+ New plan". Escape
// or a click outside closes it and focus goes back to the cell; it opens with
// focus on its first row and grows from the cell (growFromTrigger, scale only).
// Tokens only.

import { useLayoutEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { planRangeLabel } from '@/components/chat/plan-card';
import { centreOf, menuOrigin, popoverClass } from '@/components/ui/popover-classes';
import { cn } from '@/lib/cn';
import { useEscapeLayer } from '@/lib/escape-stack';
import { growFromTrigger } from '@/lib/motion';
import { viewportSize } from '@/lib/use-is-laptop';
import { PressableRow } from '@/components/ui/PressableRow';
import { ICON_SIZE, IconBank } from '@/components/ui/icons';
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
  /** From bank: an idea from the bank onto this day; absent hides the row. */
  onFromBank?: () => void;
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
    setPos(menuPosition(cell, { width: el.offsetWidth, height: el.offsetHeight }, viewportSize()));
    el.querySelector<HTMLElement>('[role="menuitem"]')?.focus({ preventScroll: true });
  }, [anchor]);

  // Once placed (still before paint), the menu grows from the clicked cell.
  const grown = useRef(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (pos === null || el === null || grown.current) return;
    grown.current = true;
    growFromTrigger(el, menuOrigin(el, centreOf(anchor)));
  }, [pos, anchor]);

  const close = (): void => {
    onClose();
    anchor.focus({ preventScroll: true });
  };
  // Escape closes it when it is the top layer (the shared escape stack).
  useEscapeLayer(true, close);

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
          'fixed z-50 w-72 max-w-[calc(100vw-16px)]',
          popoverClass(),
          pos === null && 'invisible',
        )}
      >
        <p className="px-3 pb-2 pt-1 text-sm font-semibold text-fg-3">
          {addOnLabel(props.day)}
        </p>
        {props.plans.map((bundle) => (
          <PressableRow
            key={bundle.plan.id}
            type="button"
            role="menuitem"
            data-plan-tab-menu-plan={bundle.plan.id}
            onClick={() => props.onPick(bundle)}
            className="flex items-center gap-2 px-3 py-2 mv-tint focus-visible:bg-panel-2"
          >
            <span
              aria-hidden="true"
              className={cn(
                'h-2 w-2 shrink-0 rounded-full',
                PLAN_TONE_CLASSES[props.tones.get(bundle.plan.id) ?? 'accent'].dot,
              )}
            />
            <span className="flex min-w-0 flex-1 flex-col">
              <span
                data-plan-tab-menu-title=""
                className="line-clamp-2 text-base font-medium text-fg [overflow-wrap:anywhere]"
              >
                {bundle.plan.title}
              </span>
              <span className="truncate font-mono text-sm text-fg-3">
                {planRangeLabel(bundle.plan.starts_on, bundle.plan.ends_on)}
              </span>
            </span>
            {isDraftPlan(bundle.plan) ? <DraftTag /> : null}
          </PressableRow>
        ))}
        <div className="my-1 border-t border-border" />
        {props.onFromBank !== undefined ? (
          <PressableRow
            type="button"
            role="menuitem"
            data-plan-tab-menu-bank=""
            onClick={props.onFromBank}
            className="flex items-center gap-2 px-3 text-base font-medium text-fg mv-tint"
          >
            <IconBank size={ICON_SIZE.inline} className="shrink-0" />
            From bank
          </PressableRow>
        ) : null}
        <PressableRow
          type="button"
          role="menuitem"
          data-plan-tab-menu-new=""
          onClick={props.onNewPlan}
          className="flex items-center px-3 text-base font-medium text-accent mv-tint focus-visible:bg-panel-2"
        >
          {NEW_PLAN_ROW_LABEL}
        </PressableRow>
      </div>
    </>
  );
}
