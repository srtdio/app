import { useEffect, useState } from 'react';
import type { KeyboardEvent, ReactElement } from 'react';
import { cn } from '@/lib/cn';
import { Avatar } from '@/components/ui/Avatar';
import { ThumbTile } from '@/components/pages/activity/ThumbTile';
import {
  IconActivity,
  IconBriefs,
  IconChat,
  IconClock,
  IconPin,
  IconPipeline,
  IconUpload,
  IconUser,
} from '@/components/ui/icons';
import { ActivityRowMenu } from '@/components/pages/activity/ActivityRowMenu';
import {
  activityLine,
  cardBodyLine,
  cardTitle,
  isSnoozed,
  relativeTime,
  type ActivityItem,
  type SnoozeKind,
} from '@/components/pages/activity/data';

interface ActivityCardProps {
  /** A digest group: one entry (solo) or several on the same entity (threaded). */
  group: ActivityItem[];
  nowMs: number;
  /** Open the thread: mark every entry read and navigate from the lead. */
  onOpenGroup: (group: ActivityItem[]) => void;
  onSnooze: (item: ActivityItem, kind: SnoozeKind) => void;
  onMarkRead: (item: ActivityItem) => void;
}

type LeadTone = 'good' | 'bad' | 'warn' | 'accent' | 'neutral';

/** The tone of the lead event's icon circle, mirroring the stage / event colours. */
function leadTone(item: ActivityItem): LeadTone {
  if (item.eventType === 'mention') return 'accent';
  if (item.eventType === 'brief_closed') return 'good';
  if (item.eventType === 'stage_change') {
    switch (item.toStage) {
      case 'approved':
        return 'good';
      case 'rejected':
        return 'bad';
      case 'review':
      case 'parked':
      case 'trial':
        return 'warn';
      default:
        return 'neutral';
    }
  }
  return 'neutral';
}

const TONE_CIRCLE: Record<LeadTone, string> = {
  good: 'bg-panel-2 border-good text-good',
  bad: 'bg-panel-2 border-bad text-bad',
  warn: 'bg-panel-2 border-warn text-warn',
  accent: 'bg-accent-soft border-accent-line text-accent',
  neutral: 'bg-panel-2 border-border text-fg-3',
};

/** The lead event's glyph, shown in the tone circle when there is no actor avatar. */
function leadIcon(item: ActivityItem): ReactElement {
  switch (item.eventType) {
    case 'comment':
    case 'mention':
      return <IconChat size={14} />;
    case 'decision_marked':
      return <IconPin size={14} />;
    case 'stage_change':
      return <IconPipeline size={14} />;
    case 'brief_created':
    case 'brief_closed':
      return <IconBriefs size={14} />;
    case 'asset_uploaded':
    case 'asset_version_added':
      return <IconUpload size={14} />;
    case 'invite':
      return <IconUser size={14} />;
    default:
      return <IconActivity size={14} />;
  }
}

const SCOPE_TAG: Record<string, string> = {
  posts: 'Posts',
  briefs: 'Briefs',
  people: 'People',
  groups: 'Groups',
  clients: 'Clients',
};

const UNREAD_DOT = (
  <span className="h-2 w-2 shrink-0 rounded-full bg-accent" aria-label="Unread" role="status" />
);

/**
 * One digest entry as a single contained card. The entity title is the header,
 * shown once; the lead event's short line sits beneath it with the timestamp and a
 * scope tag. A threaded group (>1 entry) gets a "+N more" toggle that expands the
 * remaining events inside the same card, each its own short line and timestamp.
 * The card body opens the thread (marking every entry read); the kebab acts on the
 * lead and stops propagation so it never triggers that.
 */
export function ActivityCard({
  group,
  nowMs,
  onOpenGroup,
  onSnooze,
  onMarkRead,
}: ActivityCardProps) {
  const [expanded, setExpanded] = useState(false);
  // Mount-only entrance: fade + a small slide up the Y axis (translateY only).
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  const lead = group[0];
  if (lead === undefined) return null;
  const rest = group.slice(1);

  const unread = lead.readAt === null;
  const snoozed = isSnoozed(lead, nowMs);
  const hasEntity = lead.entityType === 'post' || lead.entityType === 'brief';
  const title = hasEntity ? cardTitle(lead) : activityLine(lead);
  const tag = SCOPE_TAG[lead.scope];
  const actorEntry = group.find((entry) => entry.actorName !== null) ?? null;
  const actorName = actorEntry?.actorName ?? null;
  const actorAvatarUrl = actorEntry?.actorAvatarUrl ?? null;

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onOpenGroup(group);
    }
  }

  return (
    <div
      className={cn(
        'overflow-hidden rounded-xl border bg-panel transition duration-[250ms] ease-out',
        mounted ? 'translate-y-0 opacity-100' : 'translate-y-[6px] opacity-0',
        unread ? 'border-accent-line' : 'border-border',
      )}
    >
      <div
        role="button"
        tabIndex={0}
        onClick={() => onOpenGroup(group)}
        onKeyDown={onKeyDown}
        className="group flex min-h-[44px] cursor-pointer items-start gap-3 px-4 py-3 transition-colors hover:bg-panel-2 md:px-5"
      >
        {actorName !== null ? (
          <Avatar
            name={actorName}
            {...(actorAvatarUrl !== null ? { src: actorAvatarUrl } : {})}
            size="md"
          />
        ) : (
          <span
            className={cn(
              'flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full border',
              TONE_CIRCLE[leadTone(lead)],
            )}
          >
            {leadIcon(lead)}
          </span>
        )}

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className={cn('truncate text-sm', unread ? 'font-medium text-fg' : 'text-fg-2')}>
              {title}
            </p>
            {unread ? UNREAD_DOT : null}
          </div>
          {hasEntity ? (
            <p className={cn('mt-0.5 line-clamp-2 text-sm', unread ? 'text-fg-2' : 'text-fg-3')}>
              {cardBodyLine(lead)}
            </p>
          ) : null}
          <p className="mt-0.5 flex items-center gap-2 text-xs text-fg-3">
            <span>{relativeTime(lead.createdAt, nowMs)}</span>
            {tag !== undefined ? (
              <span className="rounded border border-border px-1.5 py-0.5 text-[11px] text-fg-3">
                {tag}
              </span>
            ) : null}
            {snoozed ? (
              <span className="inline-flex items-center gap-1">
                <IconClock size={12} inline />
                Snoozed
              </span>
            ) : null}
          </p>
        </div>

        <ThumbTile
          toneKey={lead.entityId ?? lead.id}
          entityType={lead.entityType}
          format={lead.format}
        />

        <ActivityRowMenu
          snoozed={snoozed}
          unread={unread}
          onSnooze={(kind) => onSnooze(lead, kind)}
          onMarkRead={() => onMarkRead(lead)}
        />
      </div>

      {rest.length > 0 ? (
        <>
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded((prev) => !prev)}
            className="flex min-h-[44px] w-full items-center border-t border-border px-4 text-left text-xs font-medium text-accent transition-colors hover:bg-panel-2 md:px-5"
          >
            {expanded ? 'Show less' : `+${rest.length} more`}
          </button>
          {expanded ? (
            <ul className="border-t border-border">
              {rest.map((entry) => (
                <li
                  key={entry.id}
                  className="flex min-h-[44px] items-center gap-2 py-2 pl-[3.25rem] pr-4 md:pr-5"
                >
                  <div className="min-w-0 flex-1">
                    <p
                      className={cn(
                        'line-clamp-2 text-sm',
                        entry.readAt === null ? 'font-medium text-fg' : 'text-fg-2',
                      )}
                    >
                      {cardBodyLine(entry)}
                    </p>
                    <p className="mt-0.5 text-xs text-fg-3">
                      {relativeTime(entry.createdAt, nowMs)}
                    </p>
                  </div>
                  {entry.readAt === null ? UNREAD_DOT : null}
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
