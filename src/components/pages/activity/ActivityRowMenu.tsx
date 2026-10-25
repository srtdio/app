import { useState } from 'react';
import type { MouseEvent } from 'react';
import { ActionMenu, type ActionMenuItem } from '@/components/ui/ActionMenu';
import { IconButton } from '@/components/ui/IconButton';
import { ICON_SIZE, IconCheck, IconClock, IconMore } from '@/components/ui/icons';
import { SNOOZE_OPTIONS, type SnoozeKind } from '@/components/pages/activity/data';

interface ActivityRowMenuProps {
  /** True when the row is currently snoozed (offers Clear instead of nothing). */
  snoozed: boolean;
  /** True when the row is unread (offers Mark as read). */
  unread: boolean;
  onSnooze: (kind: SnoozeKind) => void;
  onMarkRead: () => void;
}

/** Stop a click from bubbling to the card (navigate / mark-read) underneath. */
function isolate(event: MouseEvent): void {
  event.stopPropagation();
}

/** A snooze row's label: "Snooze 1 hour", "Snooze next week". Pure. */
export function snoozeLabel(option: { label: string }): string {
  const first = option.label.charAt(0);
  const rest = /[A-Z]/.test(first) ? first.toLowerCase() + option.label.slice(1) : option.label;
  return `Snooze ${rest}`;
}

/** The row's ⋯ actions: Mark as read (unread only), the snoozes, Un-snooze (snoozed only). Pure. */
export function activityRowItems(props: ActivityRowMenuProps): ActionMenuItem[] {
  return [
    ...(props.unread
      ? [{ id: 'mark-read', label: 'Mark as read', icon: IconCheck, onSelect: props.onMarkRead }]
      : []),
    ...SNOOZE_OPTIONS.map((option) => ({
      id: `snooze-${option.kind}`,
      label: snoozeLabel(option),
      icon: IconClock,
      onSelect: () => props.onSnooze(option.kind),
    })),
    ...(props.snoozed
      ? [{ id: 'clear', label: 'Un-snooze', icon: IconClock, onSelect: () => props.onSnooze('clear') }]
      : []),
  ];
}

/**
 * The per-row ⋯: the shared ActionMenu (popover on a laptop, Sheet on a phone).
 * The wrapper stops every click (the trigger and, through the React tree, the
 * menu rows) so the menu never triggers the card's navigate or mark-read.
 * Offers snooze (and Un-snooze when snoozed) plus Mark as read for an unread row.
 */
export function ActivityRowMenu(props: ActivityRowMenuProps) {
  const [open, setOpen] = useState(false);
  return (
    <div onClick={isolate}>
      <ActionMenu
        title="Activity options"
        items={activityRowItems(props)}
        open={open}
        onOpenChange={setOpen}
        trigger={
          <IconButton
            type="button"
            aria-haspopup="menu"
            aria-expanded={open}
            label="Activity options"
            // text-fg-3 sorts after IconButton's text-fg-2, so it wins without an override.
            className="text-fg-3 shrink-0"
          >
            <IconMore size={ICON_SIZE.control} />
          </IconButton>
        }
      />
    </div>
  );
}
