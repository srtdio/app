// The 44x44 selection check circle for one message row, on its own so the
// bubble (MessageBubble, also drawn by plan threads) does not pull in the
// selection bars, the delete sheet and their flows.

import type { ReactElement } from 'react';
import { PressableRow } from '@/components/ui/PressableRow';
import { SelectCheck } from '@/components/ui/SelectCheck';
import { cn } from '@/lib/cn';

/**
 * A 44x44 selection check circle for one message row. It appears at once
 * (motion never fades); nothing around it moves. In the thread the row
 * itself takes the tap (anywhere on it toggles), so this is the visible state
 * and the keyboard stop; `className` places it (the row's left column).
 */
export function SelectCheckbox(props: {
  checked: boolean;
  onToggle: () => void;
  className?: string;
}): ReactElement {
  return (
    <PressableRow
      type="button"
      inline
      role="checkbox"
      aria-checked={props.checked}
      aria-label={props.checked ? 'Deselect message' : 'Select message'}
      data-select-circle=""
      onClick={props.onToggle}
      className={cn(
        'flex h-11 w-11 shrink-0 items-center justify-center',
        props.className ?? 'self-center',
      )}
    >
      <SelectCheck checked={props.checked} />
    </PressableRow>
  );
}
