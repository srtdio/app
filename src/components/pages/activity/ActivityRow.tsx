import type { KeyboardEvent } from 'react';
import { cn } from '@/lib/cn';
import { Avatar } from '@/components/ui/Avatar';
import { IconClock } from '@/components/ui/icons';
import { ActivityRowMenu } from '@/components/pages/activity/ActivityRowMenu';
import {
  activityLine,
  isSnoozed,
  relativeTime,
  type ActivityItem,
  type SnoozeKind,
} from '@/components/pages/activity/data';

interface ActivityRowProps {
  item: ActivityItem;
  nowMs: number;
  /** Open the row's entity (and mark it read). */
  onOpen: (item: ActivityItem) => void;
  onSnooze: (item: ActivityItem, kind: SnoozeKind) => void;
  onMarkRead: (item: ActivityItem) => void;
}

/**
 * One activity entry. The whole card opens the entity (and marks it read); the
 * kebab and its menu stop propagation so they never trigger that. An unread row
 * carries a weightier line plus an accent dot.
 */
export function ActivityRow({ item, nowMs, onOpen, onSnooze, onMarkRead }: ActivityRowProps) {
  const unread = item.readAt === null;
  const snoozed = isSnoozed(item, nowMs);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onOpen(item);
    }
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen(item)}
      onKeyDown={onKeyDown}
      className="group flex min-h-[44px] cursor-pointer items-center gap-3 px-4 py-3 transition-colors hover:bg-panel-2 md:px-6"
    >
      {item.actorName !== null ? <Avatar name={item.actorName} size="md" /> : <Avatar size="md" />}

      <div className="min-w-0 flex-1">
        <p className={cn('truncate text-sm', unread ? 'font-medium text-fg' : 'text-fg-2')}>
          {activityLine(item)}
        </p>
        <p className="mt-0.5 flex items-center gap-2 text-xs text-fg-3">
          <span>{relativeTime(item.createdAt, nowMs)}</span>
          {snoozed ? (
            <span className="inline-flex items-center gap-1">
              <IconClock size={12} inline />
              Snoozed
            </span>
          ) : null}
        </p>
      </div>

      {unread ? (
        <span
          className="h-2 w-2 shrink-0 rounded-full bg-accent"
          aria-label="Unread"
          role="status"
        />
      ) : null}

      <ActivityRowMenu
        snoozed={snoozed}
        unread={unread}
        onSnooze={(kind) => onSnooze(item, kind)}
        onMarkRead={() => onMarkRead(item)}
      />
    </div>
  );
}
