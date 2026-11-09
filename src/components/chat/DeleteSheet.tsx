// The message Delete's choice sheet (ui/Sheet): "Delete for everyone" (an own
// message inside the 30 min window; the existing delete path, its Undo and
// its files confirm), "Delete for me" (hides it from this person only, behind
// an Undo), then Cancel. Both deletes are danger Buttons. The rule of which
// rows show is deleteChoices / selectionDeleteChoices (src/lib/chat/delete-flow.ts).
// Phone: full-width stack. Laptop: one row on the trailing edge, Cancel first.

import type { ReactElement } from 'react';
import { Button } from '@/components/ui/Button';
import { Sheet } from '@/components/ui/Sheet';

/** The sheet's title for `count` messages. Pure. */
export function deleteSheetTitle(count: number): string {
  return count === 1 ? 'Delete message?' : `Delete ${count} messages?`;
}

export const DELETE_FOR_EVERYONE_LABEL = 'Delete for everyone';
export const DELETE_FOR_ME_LABEL = 'Delete for me';

export function DeleteSheet(props: {
  open: boolean;
  count: number;
  /** Offers "Delete for everyone". */
  everyone: boolean;
  onEveryone: () => void;
  onForMe: () => void;
  onClose: () => void;
}): ReactElement {
  return (
    <Sheet open={props.open} onClose={props.onClose} title={deleteSheetTitle(props.count)}>
      <div
        data-testid="delete-sheet"
        className="flex flex-col gap-2 md:flex-row-reverse md:justify-start"
      >
        {props.everyone ? (
          <Button
            type="button"
            variant="danger"
            data-delete-choice="everyone"
            className="w-full md:w-auto"
            onClick={() => {
              props.onClose();
              props.onEveryone();
            }}
          >
            {DELETE_FOR_EVERYONE_LABEL}
          </Button>
        ) : null}
        <Button
          type="button"
          variant="danger"
          data-delete-choice="me"
          className="w-full md:w-auto"
          onClick={() => {
            props.onClose();
            props.onForMe();
          }}
        >
          {DELETE_FOR_ME_LABEL}
        </Button>
        <Button
          type="button"
          variant="ghost"
          data-delete-choice="cancel"
          className="w-full md:w-auto"
          onClick={props.onClose}
        >
          Cancel
        </Button>
      </div>
    </Sheet>
  );
}
