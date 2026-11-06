import { useState } from 'react';
import type { MouseEvent } from 'react';
import { ActionMenu, type ActionMenuItem, ActionMenuTrigger } from '@/components/ui/ActionMenu';
import { IconCheck, IconClock } from '@/components/ui/icons';
import { SNOOZE_OPTIONS, type SnoozeKind } from '@/components/pages/activity/data';

interface ActivityRowMenuProps {
  /** True when the row is currently snoozed (offers Clear instead of nothing). */
  snoozed: boolean;
  /** True when the row is unread (offers Mark as read). */
  unread: boolean;
  onSnooze: (kind: SnoozeKind) => void;
  onMarkRead: () => void;
  /** Controlled open state (the card's long-press / right-click opens it); omit to self-manage. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

/** Stop a click from bubbling to the card (navigate / mark-read) underneath. */
function isolate(event: MouseEvent): void {
  event.stopPropagation();
}

/** A snooze row's label: "Snooze 1 hour", "Snooze next week". Pure. */
function snoozeLabel(option: { label: string }): string {
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
      ? [
          {
            id: 'clear',
            label: 'Un-snooze',
            icon: IconClock,
            onSelect: () => props.onSnooze('clear'),
          },
        ]
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
  const [ownOpen, setOwnOpen] = useState(false);
  const open = props.open ?? ownOpen;
  const setOpen = props.onOpenChange ?? setOwnOpen;
  // Pointer down and right-click stop here so the card's menu gesture never arms under the ⋯.
  return (
    <div
      onClick={isolate}
      onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.stopPropagation()}
    >
      <ActionMenu
        title="Activity options"
        items={activityRowItems(props)}
        open={open}
        onOpenChange={setOpen}
        trigger={
          <ActionMenuTrigger
            type="button"
            aria-expanded={open}
            label="Activity options"
            // cn() merges classes: text-fg-3 is the last colour, so it wins.
            className="text-fg-3"
          />
        }
      />
    </div>
  );
}
