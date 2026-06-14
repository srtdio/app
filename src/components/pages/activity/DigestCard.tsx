import { useState } from 'react';
import { cn } from '@/lib/cn';
import { Avatar } from '@/components/ui/Avatar';
import { ActivityRowMenu, type SnoozeKind } from './ActivityRowMenu';
import { eventIcon, eventTone, TONE_CLASS } from './eventMeta';
import { cardTitle, eventSummary, relativeTime } from './format';
import type { ActivityItem } from './types';

interface DigestCardProps {
  /** One threaded group, newest-first and non-empty. */
  group: ActivityItem[];
  nowMs: number;
  /** Body click: mark every entry in the group read (optimistic) and navigate. */
  onActivate: () => void;
  onMarkRead: (item: ActivityItem) => void;
  onSnooze: (item: ActivityItem, kind: SnoozeKind) => void;
  onUnsnooze: (item: ActivityItem) => void;
  onOpen: (item: ActivityItem) => void;
}

const SCOPE_LABEL: Record<string, string> = {
  everything: 'Everything',
  posts: 'Posts',
  briefs: 'Briefs',
  people: 'People',
  groups: 'Groups',
  clients: 'Clients',
};

function actorNames(group: ActivityItem[]): string[] {
  const names: string[] = [];
  for (const item of group) {
    if (item.actorName !== null && item.actorName.length > 0 && !names.includes(item.actorName)) {
      names.push(item.actorName);
    }
  }
  return names;
}

export function DigestCard({
  group,
  nowMs,
  onActivate,
  onMarkRead,
  onSnooze,
  onUnsnooze,
  onOpen,
}: DigestCardProps) {
  const [expanded, setExpanded] = useState(false);
  const latest = group[0];
  if (latest === undefined) return null;

  const names = actorNames(group);
  const tone = eventTone(latest);
  const hasUnread = group.some((item) => item.readAt === null);
  const extra = group.length - 1;
  const scopeLabel = SCOPE_LABEL[latest.scope] ?? latest.scope;

  return (
    <div className="rounded-xl border border-border bg-panel">
      <div className="flex items-start gap-2 p-3">
        <button
          type="button"
          onClick={onActivate}
          className="flex min-w-0 flex-1 items-start gap-3 text-left"
        >
          {names.length > 0 ? (
            <span className="flex shrink-0 -space-x-1.5">
              {names.slice(0, 3).map((name) => (
                <Avatar key={name} name={name} size="md" />
              ))}
            </span>
          ) : (
            <span
              className={cn(
                'flex h-7 w-7 shrink-0 items-center justify-center rounded-full',
                TONE_CLASS[tone],
              )}
            >
              {eventIcon(latest.eventType, 16)}
            </span>
          )}

          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <span className="truncate text-sm font-semibold text-fg">{cardTitle(latest)}</span>
              {hasUnread ? (
                <span className="h-2 w-2 shrink-0 rounded-full bg-accent" aria-label="Unread" />
              ) : null}
            </span>
            <span className="mt-0.5 block truncate text-sm text-fg-2">{eventSummary(latest)}</span>
            <span className="mt-1 flex items-center gap-2 text-xs text-fg-3">
              <span>{relativeTime(latest.createdAt, nowMs)}</span>
              <span className="rounded-full border border-border px-2 py-0.5">{scopeLabel}</span>
            </span>
          </span>
        </button>

        <ActivityRowMenu
          item={latest}
          nowMs={nowMs}
          onMarkRead={() => onMarkRead(latest)}
          onSnooze={(kind) => onSnooze(latest, kind)}
          onUnsnooze={() => onUnsnooze(latest)}
          onOpen={() => onOpen(latest)}
        />
      </div>

      {extra > 0 ? (
        <div className="px-3 pb-2">
          <button
            type="button"
            onClick={() => setExpanded((prev) => !prev)}
            aria-expanded={expanded}
            className="flex min-h-[44px] w-full items-center text-sm text-accent"
          >
            {expanded ? 'Show less' : `+${extra} more`}
          </button>
          {expanded ? (
            <ul className="flex flex-col gap-1.5 pb-1">
              {group.slice(1).map((item) => (
                <li key={item.id} className="flex items-center gap-2 text-sm text-fg-2">
                  <span
                    className={cn(
                      'flex h-5 w-5 shrink-0 items-center justify-center rounded-full',
                      TONE_CLASS[eventTone(item)],
                    )}
                  >
                    {eventIcon(item.eventType, 12)}
                  </span>
                  <span className="truncate">{eventSummary(item)}</span>
                  <span className="ml-auto shrink-0 text-xs text-fg-3">
                    {relativeTime(item.createdAt, nowMs)}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
