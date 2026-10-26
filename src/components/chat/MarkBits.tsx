// Small chat-local pieces for marks and multi-select: the bubble badge, the
// selection checkbox, and the lock for own marked messages. Pills are the shared
// Tag (tokens only), so light and dark stay at parity.

import type { ReactElement } from 'react';
import { ICON_SIZE, IconLock } from '@/components/ui/icons';
import { PressableRow } from '@/components/ui/PressableRow';
import { SelectCheck } from '@/components/ui/SelectCheck';
import { Tag, type TagTone } from '@/components/ui/Tag';
import { cn } from '@/lib/cn';
import { canChangePriority, markBadgeLabel, type ChatMark, type MarkType } from '@/lib/chat/marks';

/** The Tag tone per mark type. */
export const MARK_TONE: Record<MarkType, TagTone> = {
  commitment: 'good',
  decision: 'accent',
  pending: 'warn',
};

/**
 * The mark badge on a bubble. Commitment and decision are plain labels; a
 * stamped mark of any type is a plain label with its stamp word appended
 * ("Commitment · Delivered"). An open pending badge is a button that opens the
 * priority chooser; its visible pill is small, inside a 44px-tall target whose
 * negative margins keep the pill where a plain label sits.
 */
export function MarkBadge(props: {
  mark: ChatMark | undefined;
  onChangePriority?: () => void;
}): ReactElement {
  const label = markBadgeLabel(props.mark);
  if (props.mark === undefined || label === '') return <></>;
  const tone = MARK_TONE[props.mark.type];
  if (canChangePriority(props.mark) && props.onChangePriority !== undefined) {
    const onChange = props.onChangePriority;
    return (
      <PressableRow
        type="button"
        inline
        data-mark-badge={props.mark.type}
        aria-label={`${label}. Change priority`}
        onClick={(e) => {
          e.stopPropagation();
          onChange();
        }}
        className="-mx-1 -mb-2 -mt-3 flex items-center px-1"
      >
        <Tag label={label} tone={tone} className="min-w-[44px] justify-center" />
      </PressableRow>
    );
  }
  return (
    <span data-mark-badge={props.mark.type} className="mb-1 flex">
      <Tag label={label} tone={tone} />
    </span>
  );
}

/**
 * The circle's entrance: it fades in on opacity alone (120ms, none under
 * reduced motion); nothing around it moves.
 */
const SELECT_CHECK_FADE =
  'transition-opacity duration-fast motion-reduce:transition-none [@starting-style]:opacity-0';

/**
 * A 44x44 selection check circle for one message row. In the thread the row
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
        SELECT_CHECK_FADE,
        props.className ?? 'self-center',
      )}
    >
      <SelectCheck checked={props.checked} />
    </PressableRow>
  );
}

/** The lock shown in place of a checkbox on an own marked message. */
export function SelectLock(): ReactElement {
  return (
    <span
      data-select-lock=""
      title="Marked messages cannot be deleted"
      className="flex h-11 w-11 shrink-0 items-center justify-center self-center text-fg-3"
    >
      <IconLock size={ICON_SIZE.nav} />
      <span className="sr-only">Marked messages cannot be deleted</span>
    </span>
  );
}
