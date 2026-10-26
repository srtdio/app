// An item's plan actions (agency only), outside the embedded post view's
// own sheet: the concept ⋯ rows (Move to another day, Edit concept; the item
// screen shows them in ui/ActionMenu), the
// day list Move opens (each plan day and No date, the current one marked),
// the Remove confirm (the item screen's red "Remove from plan" button opens
// it) and "Keep the approval?" for a move of an Open plan's client-approved
// slot. The item screen does the writes; these sheets only ask.

import { createContext } from 'react';
import type { ReactElement } from 'react';
import { Sheet } from '@/components/ui/Sheet';
import type { ActionMenuItem } from '@/components/ui/ActionMenu';
import { Button } from '@/components/ui/Button';
import { PressableRow } from '@/components/ui/PressableRow';
import { ICON_SIZE, IconCalendar, IconCheck, IconEdit, IconTrash } from '@/components/ui/icons';
import { KEEP_APPROVAL_NO, KEEP_APPROVAL_YES } from '@/components/chat/plan-card';
import { cn } from '@/lib/cn';

/**
 * A plan item's row for the embedded post view's own sheet (agency only),
 * provided by the item screen around it: Move to another day. (Remove from
 * plan is the item screen's own button.) Absent everywhere else, so the
 * pipeline's sheet is unchanged.
 */
interface PostSheetPlanRows {
  onMove: () => void;
}
export const PostSheetPlanRowsContext = createContext<PostSheetPlanRows | null>(null);

/** The row label, shared with the post view's sheet. */
export const MOVE_ROW_LABEL = 'Move to another day';
/** The item screen's red button. */
export const REMOVE_ROW_LABEL = 'Remove from plan';

/** One day the Move sheet offers: its day ("YYYY-MM-DD", null = No date) and label. */
export interface MoveDay {
  day: string | null;
  label: string;
}

/** A concept's ⋯ rows (ui/ActionMenu): Move to another day, Edit concept. Pure. */
export function planConceptMenuItems(props: {
  onMove: () => void;
  onEdit: () => void;
}): ActionMenuItem[] {
  return [
    { id: 'move', label: MOVE_ROW_LABEL, icon: IconCalendar, onSelect: props.onMove },
    { id: 'edit', label: 'Edit concept', icon: IconEdit, onSelect: props.onEdit },
  ];
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
    <Sheet open={props.open} onClose={props.onClose} title="Move to" fixedHeight>
      <ul data-plan-move-sheet="" className="flex flex-col">
        {props.days.map((d) => {
          const current = d.day === props.current;
          return (
            <li key={d.day ?? 'none'}>
              <PressableRow
                type="button"
                data-plan-move-day={d.day ?? 'none'}
                {...(current ? { 'aria-current': 'true' as const } : {})}
                disabled={props.busy}
                onClick={() => props.onPick(d.day)}
                className={cn(
                  'flex min-h-[48px] items-center justify-between px-3 text-lg',
                  current ? 'text-fg-3' : 'text-fg',
                )}
              >
                <span>{d.label}</span>
                {current ? <span className="text-sm text-fg-3">Current</span> : null}
              </PressableRow>
            </li>
          );
        })}
      </ul>
    </Sheet>
  );
}

/** Remove from plan, confirmed in a sheet: Cancel (ghost) left of Remove in the footer. */
export function PlanRemoveSheet(props: {
  open: boolean;
  title: string;
  busy: boolean;
  onConfirm: () => void;
  onClose: () => void;
}): ReactElement {
  return (
    <Sheet
      open={props.open}
      onClose={props.onClose}
      title="Remove from plan?"
      footer={
        <div className="grid w-full grid-cols-2 gap-2">
          <Button variant="ghost" disabled={props.busy} onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            data-plan-remove-confirm=""
            disabled={props.busy}
            onClick={props.onConfirm}
          >
            Remove
          </Button>
        </div>
      }
    >
      <p data-plan-remove-sheet="" className="text-base text-fg">
        {`"${props.title}" leaves the plan. Its comments stay with it.`}
      </p>
    </Sheet>
  );
}

/**
 * "Slot approved by {name}" / "Moving it to {day}. Keep the approval?": an
 * Open plan's client-approved slot changing day. "Yes, keep it" moves keeping
 * the reviews, "No, ask again" moves resetting them; closing the sheet cancels
 * the move. The sheet moves on translateY only.
 */
export function PlanKeepApprovalSheet(props: {
  open: boolean;
  title: string;
  body: string;
  onKeep: (keep: boolean) => void;
  onCancel: () => void;
}): ReactElement {
  return (
    <Sheet open={props.open} onClose={props.onCancel} title={props.title}>
      <div data-plan-keep-sheet="" className="flex flex-col gap-3">
        <p className="text-lg text-fg-2">{props.body}</p>
        <Button variant="primary" data-plan-keep-yes="" onClick={() => props.onKeep(true)}>
          <IconCheck size={ICON_SIZE.inline} />
          {KEEP_APPROVAL_YES}
        </Button>
        <Button data-plan-keep-no="" onClick={() => props.onKeep(false)}>
          {KEEP_APPROVAL_NO}
        </Button>
      </div>
    </Sheet>
  );
}

/**
 * The item screen's red "Remove from plan" (agency side), at the bottom of
 * the item; it opens the Remove confirm. 44px tall.
 */
export function RemoveFromPlanButton(props: { busy: boolean; onClick: () => void }): ReactElement {
  return (
    <Button
      variant="danger"
      data-plan-remove=""
      className="w-full"
      disabled={props.busy}
      onClick={props.onClick}
    >
      <IconTrash size={ICON_SIZE.inline} />
      {REMOVE_ROW_LABEL}
    </Button>
  );
}
