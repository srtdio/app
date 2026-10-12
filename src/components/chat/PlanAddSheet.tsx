// The Plan screen's Add sheet (agency): "Add to Wed 14 Oct" from a day's Add
// row, "Add to plan" from the header's "+". Two rows: New concept (the
// Concept sheet in add mode, that day prefilled) and Pick a post (the post
// picker; picked posts go in on that day). The screen does the writes.

import type { ReactElement } from 'react';
import { Sheet } from '@/components/ui/Sheet';
import { ActionRow } from '@/components/ui/ActionRow';
import { IconPipeline, IconPlus } from '@/components/ui/icons';
import { addSheetTitle } from '@/components/chat/plan-card';

export function PlanAddSheet(props: {
  open: boolean;
  /** The day's header ("Wed 14 Oct"), or null for the header's "+". */
  dayHeader: string | null;
  onNewConcept: () => void;
  onPickPost: () => void;
  onClose: () => void;
}): ReactElement {
  return (
    <Sheet open={props.open} onClose={props.onClose} title={addSheetTitle(props.dayHeader)}>
      <div data-plan-add-sheet="" className="flex flex-col gap-1">
        <ActionRow
          icon={<IconPlus size={18} />}
          label="New concept"
          sub="Title, note, files"
          onClick={props.onNewConcept}
        />
        <ActionRow
          icon={<IconPipeline size={18} />}
          label="Pick a post"
          sub="Any post. Its own date stays as it is."
          onClick={props.onPickPost}
        />
      </div>
    </Sheet>
  );
}
