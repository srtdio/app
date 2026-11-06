// The Bank's select bar: it replaces the 90-day nudge while select mode is on
// (a long-press, or Select in a row's menu; on the laptop table, any ticked
// row). Cancel (ghost), "{n} selected", All / None (ghost), then Archive and
// Delete (bad ink) as IconButtons. The writes behind Archive and Delete sit
// behind the Undo strip in BankList; a finished action leaves select mode.

import type { ReactElement } from 'react';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { ICON_SIZE, IconArchive, IconTrash } from '@/components/ui/icons';
import { selectedLabel } from './bank-parts';

export function BankSelectBar(props: {
  count: number;
  onCancel: () => void;
  onAll: () => void;
  onNone: () => void;
  onArchive: () => void;
  onDelete: () => void;
}): ReactElement {
  const none = props.count === 0;
  return (
    <div
      data-bank-select-bar=""
      role="toolbar"
      aria-label="Selected ideas"
      className="lit-card mx-4 flex items-center gap-1 rounded-xl border bg-panel px-1 md:mx-0"
    >
      <Button variant="ghost" type="button" data-bank-select-cancel="" onClick={props.onCancel}>
        Cancel
      </Button>
      <span
        data-bank-select-count=""
        className="min-w-0 flex-1 truncate text-base font-medium text-fg"
      >
        {selectedLabel(props.count)}
      </span>
      <Button variant="ghost" type="button" data-bank-select-all="" onClick={props.onAll}>
        All
      </Button>
      <Button variant="ghost" type="button" data-bank-select-none="" onClick={props.onNone}>
        None
      </Button>
      <IconButton
        label="Archive"
        data-bank-select-archive=""
        disabled={none}
        onClick={props.onArchive}
      >
        <IconArchive size={ICON_SIZE.control} />
      </IconButton>
      <IconButton
        label="Delete"
        data-bank-select-delete=""
        disabled={none}
        className="text-bad hover:text-bad"
        onClick={props.onDelete}
      >
        <IconTrash size={ICON_SIZE.control} />
      </IconButton>
    </div>
  );
}
