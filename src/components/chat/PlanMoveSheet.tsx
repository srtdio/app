// An item's plan actions (agency only), outside the embedded post view's
// own sheet: the concept overflow (Move to another day, Edit concept, Remove
// from plan), the day list Move opens (each plan day and No date, the
// current one marked) and the Remove confirm. The item screen does the
// writes; these sheets only ask.

import { createContext } from 'react';
import type { ReactElement } from 'react';
import { Sheet } from '@/components/ui/Sheet';
import { ActionRow } from '@/components/ui/ActionRow';
import { Button } from '@/components/ui/Button';
import { IconCalendar, IconEdit, IconTrash } from '@/components/ui/icons';
import { cn } from '@/lib/cn';

/**
 * A plan item's rows for the embedded post view's own sheet (agency only),
 * provided by the item screen around it: Move to another day and Remove from
 * plan. Absent everywhere else, so the pipeline's sheet is unchanged.
 */
export interface PostSheetPlanRows {
  onMove: () => void;
  onRemove: () => void;
}
export const PostSheetPlanRowsContext = createContext<PostSheetPlanRows | null>(null);

/** The row labels, shared with the post view's sheet. */
export const MOVE_ROW_LABEL = 'Move to another day';
export const REMOVE_ROW_LABEL = 'Remove from plan';

/** One day the Move sheet offers: its day ("YYYY-MM-DD", null = No date) and label. */
export interface MoveDay {
  day: string | null;
  label: string;
}

/** A concept's overflow: Move, Edit concept, Remove. */
export function PlanConceptActionsSheet(props: {
  open: boolean;
  title: string;
  onMove: () => void;
  onEdit: () => void;
  onRemove: () => void;
  onClose: () => void;
}): ReactElement {
  return (
    <Sheet open={props.open} onClose={props.onClose} title={props.title}>
      <div data-plan-item-actions="" className="flex flex-col gap-1">
        <ActionRow
          icon={<IconCalendar size={18} />}
          label={MOVE_ROW_LABEL}
          onClick={props.onMove}
        />
        <ActionRow icon={<IconEdit size={18} />} label="Edit concept" onClick={props.onEdit} />
        <ActionRow
          danger
          icon={<IconTrash size={18} />}
          label={REMOVE_ROW_LABEL}
          onClick={props.onRemove}
        />
      </div>
    </Sheet>
  );
}

/** The day list: each plan day and No date, the current one marked; a pick moves it. */
export function PlanMoveSheet(props: {
  open: boolean;
  days: readonly MoveDay[];
  current: string | null;
  busy: boolean;
  onPick: (day: string | null) => void;
  onClose: () => void;
}): ReactElement {
  return (
    <Sheet open={props.open} onClose={props.onClose} title="Move to">
      <ul data-plan-move-sheet="" className="flex flex-col">
        {props.days.map((d) => {
          const current = d.day === props.current;
          return (
            <li key={d.day ?? 'none'}>
              <button
                type="button"
                data-plan-move-day={d.day ?? 'none'}
                {...(current ? { 'aria-current': 'true' as const } : {})}
                disabled={props.busy}
                onClick={() => props.onPick(d.day)}
                className={cn(
                  'flex min-h-[48px] w-full items-center justify-between rounded-lg px-3 text-left text-[15px] hover:bg-panel-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-60',
                  current ? 'text-fg-3' : 'text-fg',
                )}
              >
                <span>{d.label}</span>
                {current ? <span className="text-xs text-fg-3">Current</span> : null}
              </button>
            </li>
          );
        })}
      </ul>
    </Sheet>
  );
}

/** Remove from plan, confirmed in a sheet. */
export function PlanRemoveSheet(props: {
  open: boolean;
  title: string;
  busy: boolean;
  onConfirm: () => void;
  onClose: () => void;
}): ReactElement {
  return (
    <Sheet open={props.open} onClose={props.onClose} title="Remove from plan?">
      <div data-plan-remove-sheet="" className="flex flex-col gap-3">
        <p className="text-sm text-fg">
          {`"${props.title}" leaves the plan. Its comments stay with it.`}
        </p>
        <Button
          variant="danger"
          size="lg"
          data-plan-remove-confirm=""
          disabled={props.busy}
          onClick={props.onConfirm}
        >
          Remove
        </Button>
        <Button variant="ghost" size="lg" disabled={props.busy} onClick={props.onClose}>
          Cancel
        </Button>
      </div>
    </Sheet>
  );
}
