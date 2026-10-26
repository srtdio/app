import { useEffect, useState } from 'react';
import type { KeyboardEvent, ReactElement, ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Avatar, avatarFillFor } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { splitAllMentions } from '@/lib/chat/mentions';
import { Thumbnail, type ThumbnailFallback } from '@/components/media';
import { type FormatGlyphToken } from '@/components/ui/format-icon';
import { postFormatLabel } from '@/lib/post-format';
import type { PresignCache } from '@/lib/asset-presign';
import {
  ICON_SIZE,
  IconAlarmClock,
  IconCalendarClock,
  IconChat,
  IconClock,
  IconFile,
  IconLock,
  IconPlan,
  IconTaskSquare,
  IconTickSingle,
} from '@/components/ui/icons';
import { ActivityRowMenu } from '@/components/pages/activity/ActivityRowMenu';
import { useMenuGesture } from '@/components/ui/useLongPress';
import {
  ACTOR_ROW_EVENTS,
  MENTION_EVENT_TYPE,
  PLAN_ITEM_ENTITY,
  UNKNOWN_ACTOR,
  activityLine,
  actorRowLine,
  alertBody,
  alertTitle,
  alertTopLine,
  cardBodyLine,
  cardTitle,
  deletedCount,
  deletedFilesBody,
  fileKindLabel,
  filesPhrase,
  isSnoozed,
  isChatMention,
  isWelcome,
  opensNothing,
  segmentSelfMentions,
  upcomingChat,
  upcomingTag,
  type ActivityItem,
  type AlertInfo,
  type SnoozeKind,
  type UpcomingItem,
} from '@/components/pages/activity/data';
import { ONLY_YOU_LABEL, alertDisplayTime } from '@/lib/inbox/alerts';
import { formatSendLabel } from '@/lib/chat/scheduled';
import type { ViewerSide } from '@/lib/chat/viewer-role';
import { formatRelative } from '@/lib/time';

interface ActivityCardProps {
  /** A digest group: one entry (solo) or several on the same entity (threaded). */
  group: ActivityItem[];
  nowMs: number;
  /** The page-owned presign cache, threaded into the thumbnail tile. */
  cache: PresignCache;
  /** False when presigning is unconfigured: the tile shows the fallback. */
  presignEnabled: boolean;
  /** Open the thread: mark the lead entry read and navigate from it. */
  onOpenGroup: (group: ActivityItem[]) => void;
  /** Open a single thread entry: mark it read and navigate from that entry. */
  onOpenEntry: (entry: ActivityItem) => void;
  onSnooze: (item: ActivityItem, kind: SnoozeKind) => void;
  onMarkRead: (item: ActivityItem) => void;
  /** The signed-in user's resolved display name, used to accent their own @name
   *  inside a mention preview; null when it has not resolved yet. */
  selfName: string | null;
  /** The viewer's side: a plan_opened alert reads "shared with you" for a client. */
  side?: ViewerSide;
  /** A failed scheduled send's Retry (send it now; a stale row just clears). */
  onRetry?: (item: ActivityItem) => void;
  /** A failed scheduled send's Edit (open its chat; a stale row just clears). */
  onEdit?: (item: ActivityItem) => void;
  /** A card a live refresh just added: it slides up into place (never sideways). */
  entering?: boolean;
}

/**
 * Render a resolved mention body as a preview line, accenting only the current
 * user's own `@name` (the same accent the comment thread gives a mention) and
 * leaving every other name in the surrounding body colour. Plain string in, so no
 * `@[uuid]` ever reaches the DOM.
 */
function mentionPreview(body: string, selfName: string | null, chat = false): ReactElement[] {
  return segmentSelfMentions(body, selfName).flatMap((seg, i) =>
    seg.self
      ? [
          <span key={`s${i}`} className="font-medium text-accent">
            {seg.text}
          </span>,
        ]
      : // A chat "@all" reached me too: bold, with the same accent as my own name.
        (chat ? splitAllMentions(seg.text) : [{ text: seg.text, all: false }]).map((run, j) =>
          run.all ? (
            <span key={`a${i}-${j}`} data-mention-all="" className="font-semibold text-accent">
              {run.text}
            </span>
          ) : (
            <span key={`t${i}-${j}`}>{run.text}</span>
          ),
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
      label: postFormatLabel(lead.format),
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
  clients: 'Approvers',
};

/** The welcome row's top line. */
const WELCOME_LABEL = 'Welcome';

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
  // A chat mention's title already reads "<who> mentioned you ...": the top line is the name.
  if (isChatMention(item)) return who ?? 'New mention';
  // A deleted post: "<who> deleted" over the post title (no body line).
  if (item.eventType === 'post_deleted') return `${who ?? UNKNOWN_ACTOR} deleted`;
  // Deleted files: "<who> deleted 3 files" over the first filename.
  if (item.eventType === 'assets_deleted') {
    return `${who ?? UNKNOWN_ACTOR} deleted ${filesPhrase(deletedCount(item))}`;
  }
  // Actor rows (approve, reject, park, review): the action rides the top line
  // ("chitraaraj parked") over the post title, and no body line repeats the name.
  if (ACTOR_ROW_EVENTS.has(item.eventType)) {
    return actorRowLine({ ...item, actorName: who }, { title: false }) ?? who ?? UNKNOWN_ACTOR;
  }
  if (isWelcome(item)) return WELCOME_LABEL;
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
    case 'post_ready':
      return who !== null ? `${who} sent for review` : 'Ready for review';
    case 'plan_comment':
      return who !== null ? `${who} commented` : 'New comment';
    case 'plan_review':
      return who ?? UNKNOWN_ACTOR;
    default:
      return who !== null ? who : activityLine(item);
  }
}

/** The newest entry of a group, whatever the sort direction (ties keep the first). */
function newestEntry(group: readonly ActivityItem[]): ActivityItem | undefined {
  let newest: ActivityItem | undefined;
  let newestMs = Number.NEGATIVE_INFINITY;
  for (const entry of group) {
    const ms = Date.parse(entry.createdAt);
    if (newest === undefined || (!Number.isNaN(ms) && ms > newestMs)) {
      newest = entry;
      if (!Number.isNaN(ms)) newestMs = ms;
    }
  }
  return newest;
}

/** One expanded row's author: their photo and full name above the row's text. */
function EntryAuthor({ entry }: { entry: ActivityItem }) {
  if (entry.actorName === null) return null;
  return (
    <div data-activity-entry-author="" className="mb-0.5 flex items-center gap-1.5">
      <Avatar
        name={entry.actorName}
        {...(entry.actorAvatarUrl !== null ? { src: entry.actorAvatarUrl } : {})}
        role="inline"
      />
      <span className="truncate text-sm font-medium text-fg-3">{entry.actorName}</span>
    </div>
  );
}

/** True when any entry in a group is unread: the whole card is highlighted. Pure. */
export function groupHasUnread(group: readonly ActivityItem[]): boolean {
  return group.some((entry) => entry.readAt === null);
}

/** The unread dot: one size (8px) on the card and on every expanded row. */
export const UNREAD_DOT_CLASS = 'h-2 w-2 shrink-0 rounded-full bg-accent';

/** An alert card's icon tile: what kind of alert at a glance (a missed or failed one in bad). */
function AlertIcon({ item, alert }: { item: ActivityItem; alert: AlertInfo }): ReactElement {
  const bad = alert.kind === 'failed' || item.eventType === 'task_due';
  const icon =
    alert.kind === 'reminder' || item.eventType === 'task_due' ? (
      <IconAlarmClock size={ICON_SIZE.status} />
    ) : alert.kind === 'sent' ? (
      <IconTickSingle size={ICON_SIZE.status} />
    ) : alert.kind === 'failed' ? (
      <IconCalendarClock size={ICON_SIZE.status} />
    ) : alert.kind === 'plan' ? (
      <IconPlan size={ICON_SIZE.status} />
    ) : (
      <IconTaskSquare size={ICON_SIZE.status} />
    );
  return (
    <div
      data-activity-alert-icon={alert.kind}
      aria-hidden="true"
      className={cn(
        'flex aspect-square w-full items-center justify-center bg-panel-2',
        bad ? 'text-bad' : 'text-fg-3',
      )}
    >
      {icon}
    </div>
  );
}

/** The square icon tile every iconic card shares: the panel-2 square, the icon in fg-3. */
function IconTile({ kind, children }: { kind: string; children: ReactNode }): ReactElement {
  return (
    <div
      data-activity-icon-tile={kind}
      aria-hidden="true"
      className="flex aspect-square w-full items-center justify-center bg-panel-2 text-fg-3"
    >
      {children}
    </div>
  );
}

/**
 * The post-style text tile: a small icon and an uppercase eyebrow at the top, the
 * body (a brief title, a filename) clamped to 3 lines at the bottom. Fills its box;
 * the caller supplies the square and the panel-3 background.
 */
function TextTile({
  eyebrow,
  icon,
  body,
}: {
  eyebrow: string;
  icon: ReactNode;
  body: string;
}): ReactElement {
  return (
    <div data-activity-text-tile={eyebrow} className="flex h-full w-full flex-col p-3">
      <span className="flex items-center gap-1 text-fg-3">
        {icon}
        <span className="text-xs font-semibold uppercase tracking-[0.06em]">{eyebrow}</span>
      </span>
      <p className="mt-auto line-clamp-3 text-sm leading-snug text-fg-2 [overflow-wrap:anywhere]">
        {body}
      </p>
    </div>
  );
}

/** A brief card's tile: the text tile with the BRIEF eyebrow over the brief title. */
function BriefTile({ title }: { title: string }): ReactElement {
  return (
    <div className="aspect-square w-full bg-panel-3">
      <TextTile eyebrow="Brief" icon={<IconFile size={ICON_SIZE.inline} />} body={title} />
    </div>
  );
}

/** The welcome card's tile: the workspace's avatar colour with its initial in white. */
function WelcomeTile({ name }: { name: string }): ReactElement {
  return (
    <div
      data-activity-welcome-tile=""
      aria-hidden="true"
      className={cn(
        'flex aspect-square w-full items-center justify-center text-3xl font-semibold text-white',
        avatarFillFor(name),
      )}
    >
      {name.trim().charAt(0).toUpperCase()}
    </div>
  );
}

/**
 * A deleted-files card's tile: the first file's thumbnail through the page's
 * presign cache, with a "+N" corner badge for the rest. A wiped file (the image
 * fails) or one without a version shows the text tile: its kind and its name.
 */
function DeletedFilesTile({
  item,
  cache,
  presignEnabled,
}: {
  item: ActivityItem;
  cache: PresignCache;
  presignEnabled: boolean;
}): ReactElement {
  const file = item.deletedFiles?.[0];
  const name = file?.filename ?? item.filenames?.[0] ?? filesPhrase(deletedCount(item));
  const extra = deletedCount(item) - 1;
  return (
    <Thumbnail
      assetVersionId={file?.assetVersionId ?? null}
      cache={cache}
      presignEnabled={presignEnabled}
      aspect="square"
      fallback={{ kind: 'glyph' }}
      fallbackTile={
        <TextTile
          eyebrow={fileKindLabel({ filename: name, mimeType: file?.mimeType ?? null })}
          icon={<IconFile size={ICON_SIZE.inline} />}
          body={name}
        />
      }
      alt={name}
    >
      {extra > 0 ? (
        <span
          data-activity-files-badge=""
          className="absolute bottom-1.5 right-1.5 inline-flex h-5 items-center rounded-md bg-panel px-1.5 text-xs font-medium tabular-nums text-fg-2"
        >
          +{extra}
        </span>
      ) : null}
    </Thumbnail>
  );
}

/**
 * An alert card's title: a failed send's lead ("Couldn't send your scheduled
 * message to <receiver>.") and a missed due time in bad.
 */
function AlertTitle({
  item,
  alert,
  side,
}: {
  item: ActivityItem;
  alert: AlertInfo;
  side: ViewerSide;
}): ReactElement {
  const line = alertTitle(item, alert, side);
  return alert.kind === 'failed' || item.eventType === 'task_due' ? (
    <span className="text-bad">{line}</span>
  ) : (
    <>{line}</>
  );
}

/**
 * One digest entry as a single contained card. The card is a flex row: a 3px lead
 * rail, then a column holding the content row (actor line, entity title, body)
 * beside a square media tile inset from the card edge, above a footer that carries
 * the meta (relative time, scope tag, snoozed chip). A threaded group (>1 entry)
 * adds a "+N more" toggle to the footer that expands the remaining events inside
 * the same card. The content row opens the thread (marking the lead read). The
 * footer's ⋯ opens the row menu (Mark as read, Snooze) for the whole card. A
 * chat, plan or task alert (lead.alert) reads in the bell's words beside its
 * own icon tile; a failed scheduled send adds Edit and Retry under its text.
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
  selfName,
  side = 'unknown',
  onRetry,
  onEdit,
  entering = false,
}: ActivityCardProps) {
  const [expanded, setExpanded] = useState(false);
  // A live-added card starts 8px low and slides up on the next frame (motion-safe only).
  const [settled, setSettled] = useState(!entering);
  useEffect(() => {
    if (settled) return;
    const frame = window.requestAnimationFrame(() => setSettled(true));
    return () => window.cancelAnimationFrame(frame);
  }, [settled]);
  // Long-press on touch and right-click on laptop open the row's ⋯ menu.
  const [menuOpen, setMenuOpen] = useState(false);
  const gesture = useMenuGesture(() => setMenuOpen(true));

  const lead = group[0];
  if (lead === undefined) return null;
  const rest = group.slice(1);
  // A chat, plan or task alert reads in the bell's words, with its own icon.
  const alert = lead.alert ?? null;

  const unread = groupHasUnread(group);
  const snoozed = isSnoozed(lead, nowMs);
  const planItem = lead.entityType === PLAN_ITEM_ENTITY;
  const hasEntity = lead.entityType === 'post' || lead.entityType === 'brief' || planItem;
  // An assets_deleted card has no entity: a short title, and the who-did-what
  // line in the body so it is never cut off.
  const assetsDeleted = lead.eventType === 'assets_deleted';
  // The welcome row: its title names the workspace, the body says what lands here.
  const welcome = isWelcome(lead);
  // An actor row (approve, park, deletes) says who did what on its top line: no
  // body line repeats it. Deleted files list the other names instead.
  const showsBody = (hasEntity || welcome) && !ACTOR_ROW_EVENTS.has(lead.eventType);
  const filesBody = assetsDeleted ? deletedFilesBody(lead) : null;
  const alertLine = alert !== null ? alertBody(alert) : null;
  // An alert's title is its AlertTitle (the bell's line, partly in bad).
  const title =
    hasEntity || welcome
      ? cardTitle(lead)
      : assetsDeleted
        ? (lead.filenames?.[0] ?? 'Files')
        : activityLine(lead);
  const leadTappable = !opensNothing(lead);
  // A scheduled send's alert went to its sender alone: the footer says so in
  // place of the scope tag, and its title (it names the receiver) may wrap.
  const onlyYou = alert !== null && (alert.kind === 'sent' || alert.kind === 'failed');
  const tag = onlyYou ? undefined : SCOPE_TAG[lead.scope];
  // The header names the newest entry's actor (never an older row's).
  const actorEntry = newestEntry(group) ?? lead;
  const actorName = actorEntry.actorName;
  const actorAvatarUrl = actorEntry.actorAvatarUrl;
  const tone = leadTone(lead);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onOpenGroup(group);
    }
  }

  return (
    <div
      data-activity-event={lead.eventType}
      data-activity-id={lead.id}
      {...(entering ? { 'data-activity-entering': '' } : {})}
      {...gesture.handlers}
      onClickCapture={(event) => {
        // The click that trails a long-press never also opens the row.
        if (!gesture.consumeClickSuppression()) return;
        event.preventDefault();
        event.stopPropagation();
      }}
      className={cn(
        'flex overflow-hidden rounded-xl border bg-panel transition-colors motion-safe:transition-[color,background-color,border-color,transform] motion-safe:duration-200',
        unread ? 'border-accent-line' : 'border-border',
        !settled && 'motion-safe:translate-y-2',
      )}
    >
      <div
        aria-hidden="true"
        className={cn('w-[3px] shrink-0', tone === 'accent' ? 'bg-accent' : 'bg-border-strong')}
      />

      <div className="min-w-0 flex-1">
        <div
          {...(leadTappable
            ? {
                role: 'button',
                tabIndex: 0,
                onClick: () => onOpenGroup(group),
                onKeyDown,
              }
            : {})}
          data-activity-lead=""
          className={cn(
            'flex items-start gap-3 p-[14px]',
            leadTappable && 'cursor-pointer transition-colors hover:bg-panel-2',
          )}
        >
          <div className="min-w-0 flex-1">
            <div className="mb-1.5 flex items-center gap-[7px]">
              {actorName !== null ? (
                <Avatar
                  name={actorName}
                  {...(actorAvatarUrl !== null ? { src: actorAvatarUrl } : {})}
                  role="inline"
                />
              ) : null}
              <span className="truncate text-sm font-medium text-fg-3">
                {alert !== null ? alertTopLine(lead, alert) : actorLine(actorEntry, actorName)}
              </span>
              {unread ? (
                <span
                  className={cn('ml-auto', UNREAD_DOT_CLASS)}
                  aria-label="Unread"
                  role="status"
                />
              ) : null}
            </div>

            <p
              className={cn(
                'text-base font-medium text-fg',
                onlyYou ? 'line-clamp-2 [overflow-wrap:anywhere]' : 'truncate',
              )}
            >
              {alert !== null ? <AlertTitle item={lead} alert={alert} side={side} /> : title}
            </p>

            {alertLine !== null ? (
              <p className="mt-[3px] line-clamp-2 text-base text-fg-2 [overflow-wrap:anywhere]">
                {alertLine}
              </p>
            ) : null}

            {showsBody ? (
              <p className="mt-[3px] line-clamp-2 text-base text-fg-2 [overflow-wrap:anywhere]">
                {cardBodyLine(lead)}
              </p>
            ) : null}

            {filesBody !== null ? (
              <p className="mt-[3px] line-clamp-2 text-base text-fg-2 [overflow-wrap:anywhere]">
                {filesBody}
              </p>
            ) : null}

            {lead.eventType === MENTION_EVENT_TYPE && lead.body !== null ? (
              <p className="mt-[3px] line-clamp-2 text-base text-fg-2 [overflow-wrap:anywhere]">
                {mentionPreview(lead.body, selfName, isChatMention(lead))}
              </p>
            ) : null}
          </div>

          <div className="flex w-24 shrink-0 self-start overflow-hidden rounded-lg">
            {alert !== null ? (
              <AlertIcon item={lead} alert={alert} />
            ) : planItem ? (
              <div
                data-activity-plan-icon=""
                aria-hidden="true"
                className="flex aspect-square w-full items-center justify-center bg-panel-2 text-fg-3"
              >
                <IconPlan size={ICON_SIZE.status} />
              </div>
            ) : isChatMention(lead) ? (
              <IconTile kind="chat">
                <IconChat size={ICON_SIZE.status} />
              </IconTile>
            ) : welcome && lead.welcome != null ? (
              <WelcomeTile name={lead.welcome.workspaceName} />
            ) : lead.entityType === 'brief' ? (
              <BriefTile title={title} />
            ) : assetsDeleted ? (
              <DeletedFilesTile item={lead} cache={cache} presignEnabled={presignEnabled} />
            ) : (
              <Thumbnail
                assetVersionId={lead.thumbnailAssetVersionId ?? null}
                cache={cache}
                presignEnabled={presignEnabled}
                aspect="square"
                fallback={leadFallback(lead)}
                alt={title}
                bodyLines={3}
              />
            )}
          </div>
        </div>

        {alert?.kind === 'failed' && (onEdit !== undefined || onRetry !== undefined) ? (
          <div data-activity-failed-actions="" className="flex justify-end gap-2 px-[14px] pb-3">
            {onEdit !== undefined ? (
              <Button type="button" data-activity-action="edit" onClick={() => onEdit(lead)}>
                Edit
              </Button>
            ) : null}
            {onRetry !== undefined ? (
              <Button
                type="button"
                variant="primary"
                data-activity-action="retry"
                onClick={() => onRetry(lead)}
              >
                Retry
              </Button>
            ) : null}
          </div>
        ) : null}

        <div className="h-px bg-border" />
        <div className="flex min-h-[44px] items-center gap-1.5 px-[14px]">
          <span data-activity-time="" className="text-sm tabular-nums text-fg-3">
            {formatRelative(
              alertDisplayTime(lead.eventType, lead.createdAt, lead.alert?.plan),
              new Date(nowMs),
            )}
          </span>
          {tag !== undefined ? (
            <span
              data-activity-scope-tag=""
              className="inline-flex h-5 items-center rounded-md bg-panel-2 px-2 text-xs font-medium text-fg-2"
            >
              {tag}
            </span>
          ) : null}
          {onlyYou ? (
            <span
              data-activity-only-you=""
              className="inline-flex h-5 items-center gap-1 rounded-md bg-panel-2 px-2 text-xs font-medium text-fg-2"
            >
              <IconLock size={ICON_SIZE.inline} inline />
              {ONLY_YOU_LABEL}
            </span>
          ) : null}
          {snoozed ? (
            <span className="inline-flex h-5 items-center gap-1 rounded-md bg-panel-2 px-2 text-xs font-medium text-fg-2">
              <IconClock size={ICON_SIZE.inline} inline />
              Snoozed
            </span>
          ) : null}
          {rest.length > 0 ? (
            <Button
              variant="link"
              type="button"
              aria-expanded={expanded}
              onClick={() => setExpanded((prev) => !prev)}
              className="ml-auto"
            >
              {expanded ? 'Show less' : `+${rest.length} more`}
            </Button>
          ) : null}
          <div data-activity-menu="" className={cn('-mr-2', rest.length === 0 && 'ml-auto')}>
            <ActivityRowMenu
              open={menuOpen}
              onOpenChange={setMenuOpen}
              snoozed={snoozed}
              unread={unread}
              onSnooze={(kind) => {
                for (const entry of group) onSnooze(entry, kind);
              }}
              onMarkRead={() => {
                for (const entry of group) if (entry.readAt === null) onMarkRead(entry);
              }}
            />
          </div>
        </div>
        {rest.length > 0 && expanded ? (
          <ul className="border-t border-border">
            {rest.map((entry) => (
              <li
                key={entry.id}
                {...(opensNothing(entry)
                  ? {}
                  : {
                      role: 'button',
                      tabIndex: 0,
                      onClick: () => onOpenEntry(entry),
                      onKeyDown: (event: KeyboardEvent<HTMLLIElement>) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          onOpenEntry(entry);
                        }
                      },
                    })}
                className={cn(
                  'flex min-h-[44px] items-center gap-2 py-2 pl-[14px] pr-3',
                  !opensNothing(entry) && 'cursor-pointer transition-colors hover:bg-panel-2',
                )}
              >
                <div className="min-w-0 flex-1">
                  <EntryAuthor entry={entry} />
                  <p
                    className={cn(
                      'line-clamp-2 text-base',
                      entry.readAt === null ? 'font-medium text-fg' : 'text-fg-2',
                    )}
                  >
                    {/* The author line above already names who: the text never repeats it. */}
                    {cardBodyLine(entry, { name: entry.actorName === null })}
                  </p>
                  <p className="mt-0.5 text-sm text-fg-3">
                    {formatRelative(
                      alertDisplayTime(entry.eventType, entry.createdAt, entry.alert?.plan),
                      new Date(nowMs),
                    )}
                  </p>
                </div>
                {entry.readAt === null ? (
                  <span className={UNREAD_DOT_CLASS} aria-label="Unread" role="status" />
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

/** A pending reminder's edit: the bell's "Change time" (the reminder sheet in change mode). */
export const CHANGE_TIME_LABEL = 'Change time';

/** An Upcoming row's Edit label: "Change time" on a reminder, "Edit" on a scheduled message. */
export function upcomingEditLabel(item: Pick<UpcomingItem, 'kind'>): string {
  return item.kind === 'reminder' ? CHANGE_TIME_LABEL : 'Edit';
}

/**
 * One Upcoming row, in the same card as every Notifications row: the neutral
 * rail, the tag (Reminder or Scheduled) as the top line, the chat as the
 * title, the message preview, the alarm clock or calendar clock tile, then
 * Edit (Change time on a reminder) and Cancel, and the due time in the footer.
 * Never unread: no dot, no accent border. A tap opens the chat at the
 * reminded message (a scheduled message opens its chat).
 */
export function UpcomingCard({
  item,
  now,
  onOpen,
  onEdit,
  onCancel,
}: {
  item: UpcomingItem;
  now: Date;
  onOpen: (item: UpcomingItem) => void;
  onEdit: (item: UpcomingItem) => void;
  onCancel: (item: UpcomingItem) => void;
}): ReactElement {
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onOpen(item);
    }
  }
  return (
    <div
      data-upcoming-row={item.kind}
      data-upcoming-id={item.id}
      className="flex overflow-hidden rounded-xl border border-border bg-panel transition-colors"
    >
      <div aria-hidden="true" className="w-[3px] shrink-0 bg-border-strong" />

      <div className="min-w-0 flex-1">
        <div
          role="button"
          tabIndex={0}
          onClick={() => onOpen(item)}
          onKeyDown={onKeyDown}
          data-upcoming-open=""
          className="flex cursor-pointer items-start gap-3 p-[14px] transition-colors hover:bg-panel-2"
        >
          <div className="min-w-0 flex-1">
            <div className="mb-1.5 flex items-center gap-[7px]">
              <span data-upcoming-tag="" className="truncate text-sm font-medium text-fg-3">
                {upcomingTag(item)}
              </span>
            </div>
            <p className="truncate text-base font-medium text-fg">{upcomingChat(item)}</p>
            <p className="mt-[3px] line-clamp-2 text-base text-fg-2 [overflow-wrap:anywhere]">
              {item.preview}
            </p>
          </div>

          <div className="flex w-24 shrink-0 self-start overflow-hidden rounded-lg">
            <div
              aria-hidden="true"
              className="flex aspect-square w-full items-center justify-center bg-panel-2 text-fg-3"
            >
              {item.kind === 'reminder' ? (
                <IconAlarmClock size={ICON_SIZE.status} />
              ) : (
                <IconCalendarClock size={ICON_SIZE.status} />
              )}
            </div>
          </div>
        </div>

        <div data-upcoming-actions="" className="flex justify-end gap-2 px-[14px] pb-3">
          <Button type="button" data-upcoming-action="edit" onClick={() => onEdit(item)}>
            {upcomingEditLabel(item)}
          </Button>
          <Button
            variant="secondary"
            type="button"
            data-upcoming-action="cancel"
            className="text-bad hover:bg-bad-soft"
            onClick={() => onCancel(item)}
          >
            Cancel
          </Button>
        </div>

        <div className="h-px bg-border" />
        <div className="flex min-h-[44px] items-center gap-1.5 px-[14px]">
          <span data-upcoming-due="" className="font-mono text-sm tabular-nums text-fg-3">
            {formatSendLabel(new Date(item.dueAt), now)}
          </span>
        </div>
      </div>
    </div>
  );
}
