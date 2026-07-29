import { useState } from 'react';
import type { KeyboardEvent, ReactElement } from 'react';
import { cn } from '@/lib/cn';
import { Avatar } from '@/components/ui/Avatar';
import { Thumbnail, type ThumbnailFallback } from '@/components/media';
import { FORMAT_GLYPH_LABEL, type FormatGlyphToken } from '@/components/ui/format-icon';
import type { PresignCache } from '@/lib/asset-presign';
import { IconClock } from '@/components/ui/icons';
import {
  MENTION_EVENT_TYPE,
  activityLine,
  cardBodyLine,
  cardTitle,
  isSnoozed,
  relativeTime,
  segmentSelfMentions,
  type ActivityItem,
  type SnoozeKind,
} from '@/components/pages/activity/data';

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
  /** The signed-in user's resolved display name, used to accent their own @name
   *  inside a mention preview; null when it has not resolved yet. */
  selfName: string | null;
}

/**
 * Render a resolved mention body as a preview line, accenting only the current
 * user's own `@name` (the same accent the comment thread gives a mention) and
 * leaving every other name in the surrounding body colour. Plain string in, so no
 * `@[uuid]` ever reaches the DOM.
 */
function mentionPreview(body: string, selfName: string | null): ReactElement[] {
  return segmentSelfMentions(body, selfName).map((seg, i) =>
    seg.self ? (
      <span key={`s${i}`} className="font-medium text-accent">
        {seg.text}
      </span>
    ) : (
      <span key={`t${i}`}>{seg.text}</span>
    ),
  );
}

type LeadTone = 'accent' | 'neutral';

/**
 * The event types whose lead rail is accented. Every other event type (and any
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

/** The tone of the lead rail: accent for the five, neutral otherwise. */
function leadTone(item: ActivityItem): LeadTone {
  return ACCENT_EVENTS.has(item.eventType) ? 'accent' : 'neutral';
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

/** "1 point" / "N points". UI vocabulary: the DB stores these as checkpoints. */
function pointsPhrase(n: number): string {
  return `${n} ${n === 1 ? 'point' : 'points'}`;
}

/**
 * The short actor line for the top of a card. It carries NO entity name (the title
 * row already carries the entity): just who did what. `who` is the resolved actor
 * display name, or null when the group has no actor, in which case each event type
 * degrades to a name-free phrase. Unknown/other event types read as the bare actor
 * name, or fall back to the full activity line when there is no actor.
 */
function actorLine(item: ActivityItem, who: string | null): string {
  switch (item.eventType) {
    case 'comment':
      return who !== null ? `${who} commented` : 'New comment';
    case 'mention':
      return who !== null ? `${who} mentioned you` : 'New mention';
    case 'comment_resolved':
      return who !== null ? `${who} resolved a thread` : 'Thread resolved';
    case 'checkpoints_added': {
      const pts = item.pointsAdded;
      if (pts === null) return who !== null ? `${who} sent points` : 'Points sent';
      return who !== null ? `${who} sent ${pointsPhrase(pts)}` : `${pointsPhrase(pts)} sent`;
    }
    case 'checkpoint_asked':
      return who !== null ? `${who} asked a question` : 'Question asked';
    case 'checkpoint_reopened':
      return who !== null ? `${who} reopened a point` : 'Point reopened';
    case 'stage_change':
      return `Moved to ${item.toStage ?? 'a new stage'}`;
    case 'post_ready':
      return 'Ready for review';
    default:
      return who !== null ? who : activityLine(item);
  }
}

/**
 * One digest entry as a single contained card. The card is a flex row: a 3px lead
 * rail, then a column holding the content row (actor line, entity title, body)
 * beside a square media tile inset from the card edge, above a footer that carries
 * the meta (relative time, scope tag, snoozed chip). A threaded group (>1 entry)
 * adds a "+N more" toggle to the footer that expands the remaining events inside
 * the same card. The content row opens the thread (marking every entry read).
 */
export function ActivityCard({
  group,
  nowMs,
  cache,
  presignEnabled,
  onOpenGroup,
  onOpenEntry,
  selfName,
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
  const tone = leadTone(lead);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onOpenGroup(group);
    }
  }

  return (
    <div
      className={cn(
        'flex overflow-hidden rounded-xl border bg-panel transition-colors',
        unread ? 'border-accent-line' : 'border-border',
      )}
    >
      <div
        aria-hidden="true"
        className={cn('w-[3px] shrink-0', tone === 'accent' ? 'bg-accent' : 'bg-border-strong')}
      />

      <div className="min-w-0 flex-1">
        <div
          role="button"
          tabIndex={0}
          onClick={() => onOpenGroup(group)}
          onKeyDown={onKeyDown}
          className="flex cursor-pointer items-start gap-3 p-[14px] transition-colors hover:bg-panel-2"
        >
          <div className="min-w-0 flex-1">
            <div className="mb-1.5 flex items-center gap-[7px]">
              {actorName !== null ? (
                <Avatar
                  name={actorName}
                  {...(actorAvatarUrl !== null ? { src: actorAvatarUrl } : {})}
                  size="sm"
                />
              ) : null}
              <span className="truncate text-xs font-medium text-fg-3">
                {actorLine(lead, actorName)}
              </span>
              {unread ? (
                <span
                  className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
                  aria-label="Unread"
                  role="status"
                />
              ) : null}
            </div>

            <p className="truncate text-[15px] font-semibold leading-[1.3] text-fg">{title}</p>

            {hasEntity ? (
              <p className="mt-[3px] line-clamp-2 text-sm leading-[1.4] text-fg-2">
                {cardBodyLine(lead)}
              </p>
            ) : null}

            {lead.eventType === MENTION_EVENT_TYPE && lead.body !== null ? (
              <p className="mt-[3px] line-clamp-2 text-sm leading-[1.4] text-fg-2 [overflow-wrap:anywhere]">
                {mentionPreview(lead.body, selfName)}
              </p>
            ) : null}
          </div>

          <div className="flex w-24 shrink-0 self-start overflow-hidden rounded-lg">
            <Thumbnail
              assetVersionId={lead.thumbnailAssetVersionId ?? null}
              cache={cache}
              presignEnabled={presignEnabled}
              aspect="square"
              fallback={leadFallback(lead)}
              alt={title}
            />
          </div>
        </div>

        <div className="h-px bg-border" />
        <div className="flex min-h-[44px] items-center gap-1.5 px-[14px]">
          <span className="font-mono text-xs text-fg-3">{relativeTime(lead.createdAt, nowMs)}</span>
          {tag !== undefined ? (
            <span className="inline-flex h-5 items-center rounded-md bg-panel-2 px-2 text-[11px] font-medium text-fg-2">
              {tag}
            </span>
          ) : null}
          {snoozed ? (
            <span className="inline-flex h-5 items-center gap-1 rounded-md bg-panel-2 px-2 text-[11px] font-medium text-fg-2">
              <IconClock size={12} inline />
              Snoozed
            </span>
          ) : null}
          {rest.length > 0 ? (
            <button
              type="button"
              aria-expanded={expanded}
              onClick={() => setExpanded((prev) => !prev)}
              className="ml-auto flex min-h-[44px] items-center px-2 text-[13px] font-medium text-accent transition-colors hover:bg-panel-2"
            >
              {expanded ? 'Show less' : `+${rest.length} more`}
            </button>
          ) : null}
        </div>
        {rest.length > 0 && expanded ? (
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
                className="flex min-h-[44px] cursor-pointer items-center gap-2 py-2 pl-[14px] pr-3 transition-colors hover:bg-panel-2"
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
                  <p className="mt-0.5 text-xs text-fg-3">{relativeTime(entry.createdAt, nowMs)}</p>
                </div>
                {entry.readAt === null ? (
                  <span
                    className="h-2 w-2 shrink-0 rounded-full bg-accent"
                    aria-label="Unread"
                    role="status"
                  />
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
