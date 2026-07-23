import { useState } from 'react';
import type { ComponentType, KeyboardEvent, ReactElement } from 'react';
import { cn } from '@/lib/cn';
import { Avatar } from '@/components/ui/Avatar';
import { Thumbnail, type ThumbnailFallback } from '@/components/media';
import { FORMAT_GLYPH_LABEL, type FormatGlyphToken } from '@/components/ui/format-icon';
import type { PresignCache } from '@/lib/asset-presign';
import {
  IconActivity,
  IconAt,
  IconBroadcast,
  IconClock,
  IconDoorOpen,
  IconFrame,
  IconHistory,
  IconHourglass,
  IconListOrdered,
  IconQuote,
  IconReceipt,
  IconScroll,
  IconScrollText,
  IconSignpost,
  IconStamp,
  IconTarget,
  type IconProps,
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
import type { InboxEventTypeValue } from '@srtdio/schemas';

interface ActivityCardProps {
  /** A digest group: one entry (solo) or several on the same entity (threaded). */
  group: ActivityItem[];
  nowMs: number;
  /** The page-owned presign cache, threaded into the thumbnail tile. */
  cache: PresignCache;
  /** False when presigning is unconfigured: the tile shows the fallback. */
  presignEnabled: boolean;
  /** Open the thread: mark every entry read and navigate from the lead. */
  onOpenGroup: (group: ActivityItem[]) => void;
  /** Open a single thread entry: mark it read and navigate from that entry. */
  onOpenEntry: (entry: ActivityItem) => void;
  onSnooze: (item: ActivityItem, kind: SnoozeKind) => void;
  onMarkRead: (item: ActivityItem) => void;
}

type LeadTone = 'accent' | 'neutral';

/**
 * The event types whose icon circle is accented. Every other event type (and any
 * unrecognised value) is neutral. Colour is a two-state signal, keyed on the event
 * type alone: it never reads the stored tier or the stage.
 */
const ACCENT_EVENTS = new Set<string>([
  'mention',
  'checkpoints_added',
  'post_ready',
  'trial_warning',
  'billing_failure',
]);

/** The tone of the lead event's icon circle: accent for the five, neutral otherwise. */
function leadTone(item: ActivityItem): LeadTone {
  return ACCENT_EVENTS.has(item.eventType) ? 'accent' : 'neutral';
}

const TONE_CIRCLE: Record<LeadTone, string> = {
  accent: 'bg-accent-soft border-accent-line text-accent',
  neutral: 'bg-panel-2 border-border text-fg-3',
};

/**
 * One distinct glyph per known inbox event type. Typed as a total Record so the
 * compiler enforces that every InboxEventTypeValue is mapped; a runtime value
 * outside the set falls back to IconActivity in leadIcon.
 */
const LEAD_ICON: Record<InboxEventTypeValue, ComponentType<IconProps>> = {
  mention: IconAt,
  checkpoints_added: IconListOrdered,
  comment: IconQuote,
  comment_resolved: IconStamp,
  stage_change: IconSignpost,
  post_ready: IconTarget,
  brief_created: IconScrollText,
  brief_closed: IconScroll,
  asset_uploaded: IconFrame,
  asset_version_added: IconHistory,
  invite: IconDoorOpen,
  trial_warning: IconHourglass,
  billing_failure: IconReceipt,
  system: IconBroadcast,
};

/** The lead event's glyph: the big circle glyph (no actor) and the avatar badge. */
function leadIcon(item: ActivityItem, size = 24): ReactElement {
  const Icon = LEAD_ICON[item.eventType as InboxEventTypeValue] ?? IconActivity;
  return <Icon size={size} />;
}

/**
 * Map the DB post format to a glyph token (single_image folds into 'image'),
 * mirroring Pipeline's PostCard so the fallback tile speaks the same vocabulary.
 */
function formatToken(format: string): FormatGlyphToken {
  return format === 'single_image' ? 'image' : (format as FormatGlyphToken);
}

/**
 * The Thumbnail fallback for a lead. A post lead gets the format-aware premium
 * tile (the same kind Pipeline's PostCard builds: format glyph + caption body,
 * media layout for video/link), so an imageless post is never a flat colour
 * square. Every non-post lead uses the simplest glyph fallback.
 */
function leadFallback(lead: ActivityItem): ThumbnailFallback {
  if (lead.entityType === 'post' && lead.format !== null) {
    const token = formatToken(lead.format);
    const layout = token === 'video' || token === 'link' ? 'media' : 'text';
    return {
      kind: 'post',
      glyph: token,
      label: FORMAT_GLYPH_LABEL[token],
      body: lead.caption ?? null,
      layout,
    };
  }
  return { kind: 'glyph' };
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
  cache,
  presignEnabled,
  onOpenGroup,
  onOpenEntry,
  onSnooze,
  onMarkRead,
}: ActivityCardProps) {
  const [expanded, setExpanded] = useState(false);

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
        'overflow-hidden rounded-xl border bg-panel transition-colors',
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
          <span className="relative shrink-0">
            <Avatar
              name={actorName}
              {...(actorAvatarUrl !== null ? { src: actorAvatarUrl } : {})}
              size="xl"
            />
            <span
              aria-hidden="true"
              className={cn(
                'absolute -bottom-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full border ring-2 ring-panel',
                TONE_CIRCLE[leadTone(lead)],
              )}
            >
              {leadIcon(lead, 12)}
            </span>
          </span>
        ) : (
          <span
            className={cn(
              'flex h-12 w-12 shrink-0 items-center justify-center rounded-full border',
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

        <div className="h-14 w-14 shrink-0 overflow-hidden rounded-lg">
          <Thumbnail
            assetVersionId={lead.thumbnailAssetVersionId ?? null}
            cache={cache}
            presignEnabled={presignEnabled}
            aspect="square"
            fallback={leadFallback(lead)}
            alt={title}
          />
        </div>

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
                  role="button"
                  tabIndex={0}
                  onClick={() => onOpenEntry(entry)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      onOpenEntry(entry);
                    }
                  }}
                  className="flex min-h-[44px] cursor-pointer items-center gap-2 py-2 pl-[3.25rem] pr-4 transition-colors hover:bg-panel-2 md:pr-5"
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
