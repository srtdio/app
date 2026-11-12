// The Bank's select bar (ui/SelectBar): a long-press (phone) or right-click /
// Shift-click / Cmd-click (laptop) on an idea card enters select mode with it
// ticked. The bar carries every row the card's old ⋮ menu held: Open, Plan it
// and Send to chat for one idea only; Show to approvers / Hide from approvers, Star /
// Unstar, Archive / Unarchive and Delete (last, bad ink) for any count. The
// toggles follow the selection: every picked idea already starred reads
// Unstar, else Star (it stars the rest); the same for Hide / Show and
// Unarchive / Archive. All (ghost) ticks every loaded idea. The writes behind
// them are BankList's bank-proc handlers; Delete, Archive and Hide sit behind
// the Undo strip there, and a finished action leaves select mode.

import type { ReactElement } from 'react';
import { Button } from '@/components/ui/Button';
import { SelectBar, visibleSelectActions, type SelectBarAction } from '@/components/ui/SelectBar';
import {
  IconArchive,
  IconArrowUpRight,
  IconCalendar,
  IconEye,
  IconEyeOff,
  IconForward,
  IconStar,
  IconStarFilled,
  IconTrash,
} from '@/components/ui/icons';
import type { BankIdea } from '@/lib/chat/plans';
import { HIDE_FROM_CLIENT_LABEL, SHOW_TO_CLIENT_LABEL } from '@/lib/chat/plan-item-bank';

/** A select bar action; `single` rows show only with exactly one idea ticked. */
export type BankSelectAction = SelectBarAction & { single?: boolean };

/** The writes and flows behind the bar (BankSurface's existing handlers). */
export interface BankSelectHandlers {
  onOpen: (idea: BankIdea) => void;
  onPlanIt: (idea: BankIdea) => void;
  onSend: (idea: BankIdea) => void;
  /** Show to approvers: the ideas not yet shown (the warning sheet first). */
  onShow: (ideas: BankIdea[]) => void;
  /** Hide from approvers: every picked idea (all shown). */
  onHide: (ideas: BankIdea[]) => void;
  /** Star the unstarred (on) or unstar every picked idea (off). */
  onStar: (ideas: BankIdea[], on: boolean) => void;
  /** Archive the live ones (on) or unarchive every picked idea (off). */
  onArchive: (ideas: BankIdea[], on: boolean) => void;
  onDelete: (ideas: BankIdea[]) => void;
}

/**
 * Every bar action for the picked ideas, in the old menu's order (Delete
 * last), before the count filter (visibleSelectActions). Pure.
 */
export function bankSelectActions(
  picked: readonly BankIdea[],
  handlers: BankSelectHandlers,
): BankSelectAction[] {
  const first = picked[0];
  const some = picked.length > 0;
  const allShown = some && picked.every((i) => i.show_to_client === true);
  const allStarred = some && picked.every((i) => i.starred_at != null);
  const allArchived = some && picked.every((i) => i.archived_at != null);
  const single = (run: (idea: BankIdea) => void) => () => {
    if (first !== undefined) run(first);
  };
  return [
    {
      id: 'open',
      label: 'Open',
      icon: IconArrowUpRight,
      single: true,
      hooks: { 'data-bank-select-open': '' },
      onSelect: single(handlers.onOpen),
    },
    {
      id: 'plan-it',
      label: 'Plan it',
      icon: IconCalendar,
      single: true,
      hooks: { 'data-bank-select-plan-it': '' },
      onSelect: single(handlers.onPlanIt),
    },
    {
      id: 'send-to-chat',
      label: 'Send to chat',
      icon: IconForward,
      single: true,
      hooks: { 'data-bank-select-send': '' },
      onSelect: single(handlers.onSend),
    },
    allShown
      ? {
          id: 'hide',
          label: HIDE_FROM_CLIENT_LABEL,
          icon: IconEyeOff,
          hooks: { 'data-bank-select-show': 'hide' },
          onSelect: () => handlers.onHide([...picked]),
        }
      : {
          id: 'show',
          label: SHOW_TO_CLIENT_LABEL,
          icon: IconEye,
          hooks: { 'data-bank-select-show': 'show' },
          onSelect: () => handlers.onShow(picked.filter((i) => i.show_to_client !== true)),
        },
    allStarred
      ? {
          id: 'unstar',
          label: 'Unstar',
          icon: IconStar,
          hooks: { 'data-bank-select-star': 'unstar' },
          onSelect: () => handlers.onStar([...picked], false),
        }
      : {
          id: 'star',
          label: 'Star',
          icon: IconStarFilled,
          hooks: { 'data-bank-select-star': 'star' },
          onSelect: () =>
            handlers.onStar(
              picked.filter((i) => i.starred_at == null),
              true,
            ),
        },
    allArchived
      ? {
          id: 'unarchive',
          label: 'Unarchive',
          icon: IconArchive,
          hooks: { 'data-bank-select-archive': 'unarchive' },
          onSelect: () => handlers.onArchive([...picked], false),
        }
      : {
          id: 'archive',
          label: 'Archive',
          icon: IconArchive,
          hooks: { 'data-bank-select-archive': 'archive' },
          onSelect: () =>
            handlers.onArchive(
              picked.filter((i) => i.archived_at == null),
              true,
            ),
        },
    {
      id: 'delete',
      label: 'Delete',
      icon: IconTrash,
      tone: 'bad',
      hooks: { 'data-bank-select-delete': '' },
      onSelect: () => handlers.onDelete([...picked]),
    },
  ];
}

export function BankSelectBar(
  props: {
    picked: readonly BankIdea[];
    onCancel: () => void;
    /** Tick every loaded idea; absent hides All. */
    onAll?: () => void;
  } & BankSelectHandlers,
): ReactElement {
  const { picked, onCancel, onAll, ...handlers } = props;
  return (
    <SelectBar
      data-bank-select-bar=""
      label="Selected ideas"
      count={picked.length}
      onCancel={onCancel}
      actions={visibleSelectActions(bankSelectActions(picked, handlers), picked.length)}
      extra={
        onAll !== undefined ? (
          <Button
            variant="ghost"
            type="button"
            data-bank-select-all=""
            onClick={onAll}
            className="shrink-0"
          >
            All
          </Button>
        ) : null
      }
    />
  );
}
