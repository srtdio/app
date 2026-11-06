// The Plan screen's Add sheet (agency): "Add to Wed 14 Oct" from a day's Add
// row, "Add to plan" from the header's "+". New concept (the Concept sheet
// in add mode, that day prefilled), Pick a post (the post picker; picked
// posts go in on that day) and, when the caller offers it, From bank (an idea
// from the bank onto that day). The screen does the writes.

import type { ReactElement } from 'react';
import { Sheet } from '@/components/ui/Sheet';
import { ActionRow } from '@/components/ui/ActionRow';
import { ICON_SIZE, IconBank, IconPipeline, IconPlus } from '@/components/ui/icons';
import { addSheetTitle } from '@/components/chat/plan-card';

export function PlanAddSheet(props: {
  open: boolean;
  /** The day's header ("Wed 14 Oct"), or null for the header's "+". */
  dayHeader: string | null;
  onNewConcept: () => void;
  onPickPost: () => void;
  /** From bank: the third row (agency); absent hides it. */
  onFromBank?: () => void;
  onClose: () => void;
}): ReactElement {
  return (
    <Sheet
      open={props.open}
      onClose={props.onClose}
      title={addSheetTitle(props.dayHeader)}
      fixedHeight
    >
      <div data-plan-add-sheet="" className="flex flex-col gap-1">
        <ActionRow
          icon={<IconPlus size={ICON_SIZE.nav} />}
          label="New concept"
          sub="Title, note, files"
          onClick={props.onNewConcept}
        />
        <ActionRow
          icon={<IconPipeline size={ICON_SIZE.nav} />}
          label="Pick a post"
          sub="Its own date stays, if it is inside this plan."
          onClick={props.onPickPost}
        />
        {props.onFromBank !== undefined ? (
          <ActionRow
            icon={<IconBank size={ICON_SIZE.nav} />}
            label="From bank"
            sub="Put an idea from the bank on this day."
            onClick={props.onFromBank}
          />
        ) : null}
      </div>
    </Sheet>
  );
}
