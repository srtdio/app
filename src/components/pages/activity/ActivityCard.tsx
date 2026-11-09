import { stripFormat } from '@srtdio/comments';
import { itemIn, itemOut, rememberCard, useMoveOnMount, usePresence } from '@/lib/motion';
import { useGrowBackIntoCard } from '@/lib/motion/pages';
import { useId, useState, type ComponentType, type ReactElement, type ReactNode } from 'react';
import { Avatar } from '@/components/ui/Avatar';
import {
  ListCard,
  LIST_CARD_SUB_INSET,
  LIST_CARD_UNREAD_DOT,
  type ListCardPicture,
} from '@/components/ui/ListCard';
import { PressableRow } from '@/components/ui/PressableRow';
import { cn } from '@/lib/cn';
import { textRole } from '@/components/ui/Text';
import { PostPlaceholder, postPlaceholderKind } from '@/components/ui/PostPlaceholder';
import { splitAllMentions } from '@/lib/chat/mentions';
import { Thumbnail } from '@/components/media';
import type { PresignCache } from '@/lib/asset-presign';
import {
  ICON_SIZE,
  IconActivity,
  IconAlarmClock,
  IconBriefs,
  IconCalendarClock,
  IconFile,
  IconPlan,
  IconTaskSquare,
  type IconProps,
} from '@/components/ui/icons';
import {
  BRIEFS_SCOPE,
  MENTION_EVENT_TYPE,
  PLAN_ITEM_ENTITY,
  WELCOME_BODY,
  activityLine,
  alertBody,
  alertTitle,
  cardBodyLine,
  deletedFilesBody,
  cardTitle,
  entryLine,
  groupOpenEntry,
  isChatMention,
  isChatRow,
  isThreadStarted,
  THREAD_STARTED_EVENT,
  isWelcome,
  opensNothing,
  segmentSelfMentions,
  updatesLabel,
  welcomeTitle,
  type ActivityItem,
  type AlertInfo,
} from '@/components/pages/activity/data';
import { alertDisplayTime } from '@/lib/inbox/alerts';
import type { ViewerSide } from '@/lib/chat/viewer-role';
import { formatAgo } from '@/lib/time';

interface ActivityCardProps {
  /** A digest group: one entry (solo) or several on the same entity (one card). */
  group: ActivityItem[];
  /** The list's one clock (the shared minute clock); the time reads "5m" against it. */
  nowMs: number;
  /** The zone "Yesterday" and the weekday read on (formatAgo). Absent: the device zone. */
  timeZone?: string | null | undefined;
  /** The page-owned presign cache, threaded into the picture. */
  cache: PresignCache;
  /** False when presigning is unconfigured: the picture shows the fallback. */
  presignEnabled: boolean;
  /** Open the thread: mark it read and navigate from `entry` (groupOpenEntry:
   *  the newest entry that links to a comment, else the lead). */
  onOpenGroup: (group: ActivityItem[], entry: ActivityItem) => void;
  /** Open one entry of a grouped card (its unfolded row): navigate to its own
   *  place at its comment and mark it read. */
  onOpenEntry: (entry: ActivityItem) => void;
  /** The signed-in user's resolved display name, used to accent their own @name
   *  inside a mention preview; null when it has not resolved yet. */
  selfName: string | null;
  /** The viewer's side: a plan_opened alert reads "shared with you" for a client. */
  side?: ViewerSide;
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
  return segmentSelfMentions(stripFormat(body), selfName).flatMap((seg, i) =>
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

/** True when any entry in a group is unread: the card shows the unread dot. Pure. */
export function groupHasUnread(group: readonly ActivityItem[]): boolean {
  return group.some((entry) => entry.readAt === null);
}

/** The unread dot: one size (8px), ui/ListCard's. */
export const UNREAD_DOT_CLASS = LIST_CARD_UNREAD_DOT;

/** The kind an Activity card names in its one tag. */
export type ActivityKind = 'Mention' | 'Thread' | 'Post' | 'Brief' | 'Plan' | 'Reminder';

/**
 * What one entry is, in one word: a reminder (a task's missed due time), a
 * mention (a comment's or a chat's), a plan (plan alerts, plan items, plan
 * events), a brief, a post. A chat message, an invite, a file or the welcome
 * row names none. Pure.
 */
export function activityKind(item: ActivityItem): ActivityKind | undefined {
  const alert = item.alert ?? null;
  if (isWelcome(item)) return undefined;
  if (item.eventType === 'task_due') return 'Reminder';
  if (item.eventType === MENTION_EVENT_TYPE || isChatMention(item)) return 'Mention';
  // A thread start wears the chat mention's tag, in its own word.
  if (isThreadStarted(item)) return 'Thread';
  if (
    alert?.kind === 'plan' ||
    alert?.kind === 'bank' ||
    item.entityType === PLAN_ITEM_ENTITY ||
    item.entityType === 'plan' ||
    (item.planId !== null && item.planId !== undefined)
  ) {
    return 'Plan';
  }
  if (item.scope === BRIEFS_SCOPE || item.entityType === 'brief') return 'Brief';
  if (item.entityType === 'post' || item.scope === 'posts') return 'Post';
  return undefined;
}

/**
 * The card's ONE grey tag on line 2: a digest group of several entries counts
 * them ("3 updates"); else what the entry is (activityKind: Mention, Post,
 * Brief, Plan, Reminder). None for the welcome row or a kindless entry. Pure.
 */
export function activityCardTag(group: readonly ActivityItem[]): string | undefined {
  const lead = group[0];
  if (lead === undefined) return undefined;
  if (group.length > 1) return updatesLabel(group.length);
  return activityKind(lead);
}

/**
 * The card's title (line 1): who did what, the actor's name first ("Priya
 * mentioned you", "Maya approved Watch launch"), named by the group's newest
 * entry's actor (never an older row's). An alert reads in the bell's words;
 * the welcome row names its workspace. Pure.
 */
export function activityCardTitle(
  group: readonly ActivityItem[],
  side: ViewerSide = 'unknown',
): string {
  const lead = group[0];
  if (lead === undefined) return '';
  const alert = lead.alert ?? null;
  if (alert !== null) return alertTitle(lead, alert, side);
  if (isWelcome(lead)) return welcomeTitle(lead);
  const actor = newestEntry(group) ?? lead;
  const line = activityLine({
    ...lead,
    actorId: actor.actorId,
    actorName: actor.actorName,
    actorAvatarUrl: actor.actorAvatarUrl,
  });
  // A plan item row names its item (the old card's header) in place of "a plan item".
  if (lead.entityType === PLAN_ITEM_ENTITY && lead.title !== null && lead.title !== '') {
    return line.replace(PLAN_ITEM_PHRASE, lead.title);
  }
  return line;
}

/** How activityLine names a plan item when it does not name it. */
const PLAN_ITEM_PHRASE = 'a plan item';

/**
 * The card's preview text (line 2) when it is plain text: the comment, the
 * alert's second line, the files a delete also took, the welcome's line; else
 * how many more updates the group holds ("+2 more"), else ''. A mention's
 * preview is drawn (its @name accented) by the card. Pure.
 */
export function activityPreviewText(group: readonly ActivityItem[]): string {
  const lead = group[0];
  if (lead === undefined) return '';
  const alert = lead.alert ?? null;
  const more = group.length > 1 ? `+${group.length - 1} more` : '';
  if (alert !== null) return alertBody(alert) ?? more;
  if (isWelcome(lead)) return WELCOME_BODY;
  if (lead.eventType === MENTION_EVENT_TYPE && lead.body !== null) return stripFormat(lead.body);
  if (lead.eventType === 'assets_deleted') {
    // The first file by name, then the others ("deck.pdf · Also hero.png and teaser.mov").
    const first = lead.filenames?.[0];
    const others = deletedFilesBody(lead);
    if (first === undefined) return others ?? more;
    return others !== null ? `${first} · ${others}` : first;
  }
  const hasBody =
    lead.eventType === 'comment' ||
    lead.eventType === 'checkpoints_added' ||
    lead.eventType === 'plan_comment';
  if (hasBody && lead.body !== null && lead.body.trim() !== '') {
    return stripFormat(cardBodyLine(lead));
  }
  return more;
}

/** An alert's glyph: what kind of alert at a glance. */
function alertIcon(item: ActivityItem, alert: AlertInfo): ComponentType<IconProps> {
  if (item.eventType === 'task_due') return IconAlarmClock;
  if (alert.kind === 'plan' || alert.kind === 'bank') return IconPlan;
  return IconTaskSquare;
}

/**
 * Retired event types (RETIRED_EVENT_TYPES; the page never lists them, an old
 * row can still land): a plain card with its own glyph, never blank.
 */
const RETIRED_ICONS: Readonly<Record<string, ComponentType<IconProps>>> = {
  reminder: IconAlarmClock,
  scheduled_sent: IconCalendarClock,
  scheduled_failed: IconCalendarClock,
};

/** The event types that are about a person: the picture is their photo. */
const PERSON_EVENTS: ReadonlySet<string> = new Set([
  MENTION_EVENT_TYPE,
  THREAD_STARTED_EVENT,
  'invite',
]);

/**
 * The picture (48), never blank: the thing the event is about (the post's
 * picture, else its "Aa" / play placeholder; the brief, plan or alert icon;
 * the first deleted file; a retired type's glyph), or, for a mention or a
 * person event, that person's photo (initials on their colour when none);
 * else the Activity glyph.
 */
function activityPicture(
  lead: ActivityItem,
  actor: ActivityItem,
  cache: PresignCache,
  presignEnabled: boolean,
  alt: string,
): ListCardPicture {
  const alert = lead.alert ?? null;
  if (alert !== null) return { kind: 'icon', icon: alertIcon(lead, alert) };
  const retired = RETIRED_ICONS[lead.eventType];
  if (retired !== undefined) return { kind: 'icon', icon: retired };
  if (isWelcome(lead) && lead.welcome != null) {
    return {
      kind: 'image',
      node: <Avatar name={lead.welcome.workspaceName} role="card" kind="group" decorative />,
    };
  }
  if (PERSON_EVENTS.has(lead.eventType) && actor.actorName !== null) {
    return { kind: 'person', name: actor.actorName, src: actor.actorAvatarUrl };
  }
  if (lead.entityType === 'post') {
    const placeholder = postPlaceholderKind(lead.format);
    if (lead.thumbnailAssetVersionId === null) return { kind: 'placeholder', placeholder };
    return {
      kind: 'image',
      node: (
        <Thumbnail
          assetVersionId={lead.thumbnailAssetVersionId}
          cache={cache}
          presignEnabled={presignEnabled}
          aspect="square"
          fallback={{ kind: 'glyph' }}
          fallbackTile={<PostPlaceholder kind={placeholder} size={ICON_SIZE.control} fill />}
          alt={alt}
        />
      ),
    };
  }
  if (lead.entityType === 'brief' || lead.scope === BRIEFS_SCOPE) {
    return { kind: 'icon', icon: IconBriefs };
  }
  if (lead.entityType === PLAN_ITEM_ENTITY || lead.entityType === 'plan') {
    return { kind: 'icon', icon: IconPlan };
  }
  if (lead.eventType === 'assets_deleted') {
    const file = lead.deletedFiles?.[0];
    if (file === undefined || file.assetVersionId === null) return { kind: 'icon', icon: IconFile };
    return {
      kind: 'image',
      node: (
        <Thumbnail
          assetVersionId={file.assetVersionId}
          cache={cache}
          presignEnabled={presignEnabled}
          aspect="square"
          fallback={{ kind: 'glyph' }}
          fallbackTile={
            <span className="flex h-full w-full items-center justify-center bg-panel-2 text-fg-2">
              <IconFile size={ICON_SIZE.control} />
            </span>
          }
          alt={file.filename}
        />
      ),
    };
  }
  if (lead.eventType === 'asset_uploaded' || lead.eventType === 'asset_version_added') {
    return { kind: 'icon', icon: IconFile };
  }
  if (actor.actorName !== null) {
    return { kind: 'person', name: actor.actorName, src: actor.actorAvatarUrl };
  }
  return { kind: 'icon', icon: IconActivity };
}

/** An entry's "how long ago" on the list's one clock ("just now", "3h", "Mon"). */
function entryAgo(entry: ActivityItem, nowMs: number, timeZone: string | null | undefined): string {
  return formatAgo(
    alertDisplayTime(entry.eventType, entry.createdAt, entry.alert?.plan),
    new Date(nowMs),
    timeZone ?? undefined,
  );
}

/** The entity types an item card groups under (a post, brief, plan or plan item). */
const ITEM_ENTITIES: ReadonlySet<string> = new Set(['post', 'brief', 'plan', PLAN_ITEM_ENTITY]);

/** Whether a row belongs to an item (or is a plan / bank alert): it gets the item card. Pure. */
export function hasItem(lead: ActivityItem): boolean {
  if (lead.alert != null) return lead.alert.kind !== 'task';
  return lead.entityType !== null && ITEM_ENTITIES.has(lead.entityType);
}

/** Lines an item card shows before "+N more" (Android InboxStyle: 5). */
export const ACTIVITY_LINES_SHOWN = 5;

/** "N new" on an item card's head (only when something is unread). Pure. */
export function newLabel(n: number): string {
  return `${n} new`;
}

/** "+N more" / its accessible name. Pure. */
export function moreLabel(n: number): string {
  return `+${n} more`;
}

/**
 * The item a non-chat card is about, by name: the post, brief, plan item or
 * idea title; an alert names its item or plan; else the card title. Pure.
 */
export function itemCardTitle(lead: ActivityItem, side: ViewerSide = 'unknown'): string {
  const alert = lead.alert ?? null;
  if (alert !== null) {
    return alert.itemTitle ?? alert.planTitle ?? activityCardTitle([lead], side);
  }
  return cardTitle(lead);
}

/**
 * The lines of an item card, newest first: one per notification the group
 * holds (the chip already filtered them), own actions left out. Pure.
 */
export function itemCardLines(group: readonly ActivityItem[]): ActivityItem[] {
  return [...group]
    .filter((entry) => entry.own !== true)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

/**
 * One notification's line (44 tall, on the head's title column): a small
 * photo, the actor, the Activity line without the name, the time, the unread
 * dot. Read lines are muted with no dot. A tap opens ITS spot and marks only
 * it read.
 */
function EntryLine(props: {
  entry: ActivityItem;
  nowMs: number;
  timeZone: string | null | undefined;
  side: ViewerSide;
  onOpen: (entry: ActivityItem) => void;
}): ReactElement {
  const { entry } = props;
  const { actor, text } = entryLine(entry, props.side);
  const unread = entry.readAt === null;
  return (
    <PressableRow
      data-activity-line={entry.id}
      {...(unread ? { 'data-activity-line-unread': '' } : {})}
      onClick={() => props.onOpen(entry)}
      className="flex min-w-0 items-center gap-2 overflow-hidden whitespace-nowrap"
    >
      <Avatar
        name={actor}
        {...(entry.actorAvatarUrl !== null ? { src: entry.actorAvatarUrl } : {})}
        role="inline"
        decorative
      />
      <span className={textRole('label', cn('shrink-0 truncate', !unread && 'text-fg-3'))}>
        {actor}
      </span>
      <span
        className={textRole('secondary', cn('min-w-0 flex-1 truncate', !unread && 'text-fg-3'))}
      >
        {text}
      </span>
      <span className={textRole('meta', 'shrink-0 whitespace-nowrap')}>
        {entryAgo(entry, props.nowMs, props.timeZone)}
      </span>
      {unread ? (
        <span
          data-activity-line-dot=""
          role="img"
          aria-label="Unread"
          className={LIST_CARD_UNREAD_DOT}
        />
      ) : null}
    </PressableRow>
  );
}

/**
 * One digest group as one card (9 Nov 2026: every notification gets its own
 * line, grouped by item; Android InboxStyle, Notion, Asana).
 * - A chat row (isChatRow, or a chat task alert), and a row with no item
 *   (deleted files, an invite, the welcome row), keeps its one ui/ListCard: the who-did-what title,
 *   the preview, the tag, the unread dot; a tap opens it.
 * - Every other item (post, brief, plan, plan item, idea, anything else): a
 *   head ListCard (the picture, the item title, the kind tag, "N new" while
 *   anything is unread; a tap opens the item, unchanged), then one line per
 *   notification, newest first, on the head's title column. The first 5 show;
 *   more fold behind "+N more" (44 tall, aria-expanded), which unfolds the
 *   rest in place (itemIn, Y) and becomes "Show less" (itemOut on fold). The
 *   fold is per card, in memory. A line opens its own spot and marks only
 *   that entry read.
 */
export function ActivityCard({
  group,
  nowMs,
  timeZone,
  cache,
  presignEnabled,
  onOpenGroup,
  onOpenEntry,
  selfName,
  side = 'unknown',
  entering = false,
}: ActivityCardProps) {
  const [open, setOpen] = useState(false);
  const lines = itemCardLines(group);
  const hidden = Math.max(0, lines.length - ACTIVITY_LINES_SHOWN);
  // The rest unfold in place: itemIn (Y only) as they land, itemOut (clip)
  // before they unmount; never a fade; instant under Reduce Motion.
  const rest = usePresence<HTMLDivElement>(open && hidden > 0, {
    enter: (el) => itemIn(el),
    exit: (el) => itemOut(el),
  });
  const restId = useId();
  // itemIn (docs/motion.md): a live-added card renders in place and rises
  // 8 px over its final state on its first frame. Y only, never a fade.
  // growFromCard: a tap remembers this card so the page grows out of it, and
  // Back grows the page back into it.
  const growKey = group[0]?.entityId ?? '';
  const cardRef = useGrowBackIntoCard<HTMLElement>(growKey);
  useMoveOnMount(cardRef, (el) => itemIn(el), entering);
  const rememberThisCard = (): void => {
    if (growKey !== '') rememberCard(growKey, cardRef.current);
  };
  const lead = group[0];
  if (lead === undefined) return null;
  // Chat rows keep their one card: chat mentions, thread starts and chat task
  // alerts. So do rows with no item to group under (deleted files, invites, the
  // welcome row): they read as one who-did-what card with their own preview.
  const chat = isChatRow(lead) || lead.alert?.kind === 'task' || !hasItem(lead);
  // The head opens the newest entry that links to a comment, else the lead.
  const openEntry = groupOpenEntry(group) ?? lead;
  const alert = lead.alert ?? null;
  const actor = newestEntry(group) ?? lead;
  const title = chat ? activityCardTitle(group, side) : itemCardTitle(lead, side);
  const unreadLines = lines.filter((entry) => entry.readAt === null).length;
  const preview: ReactNode = chat
    ? lead.eventType === MENTION_EVENT_TYPE && lead.body !== null
      ? mentionPreview(lead.body, selfName, isChatMention(lead))
      : activityPreviewText(group)
    : unreadLines > 0
      ? newLabel(unreadLines)
      : undefined;
  const tappable = !opensNothing(lead, side);
  const tag = chat ? activityCardTag(group) : activityKind(lead);
  // Line 1 trailing: how long ago, on the list's one clock ("just now", "3h", "Mon").
  const time = entryAgo(chat ? lead : actor, nowMs, timeZone);
  const bad = lead.eventType === 'task_due';

  const card = (
    <ListCard
      rootRef={cardRef}
      surface={{
        'data-activity-event': lead.eventType,
        'data-activity-id': lead.id,
        ...(chat ? {} : { 'data-activity-item-head': '' }),
        ...(entering ? { 'data-activity-entering': '' } : {}),
      }}
      picture={activityPicture(lead, actor, cache, presignEnabled, title)}
      {...(alert !== null
        ? { pictureHooks: { 'data-activity-alert-icon': alert.kind } }
        : lead.entityType === PLAN_ITEM_ENTITY
          ? { pictureHooks: { 'data-activity-plan-icon': '' } }
          : {})}
      title={title}
      unread={chat ? groupHasUnread(group) : unreadLines > 0}
      preview={preview}
      previewHooks={chat ? { 'data-activity-preview': '' } : { 'data-activity-new': '' }}
      time={time}
      timeHooks={{ 'data-activity-time': '' }}
      // A missed due time reads in bad.
      timeBad={bad}
      tag={tag}
      tagHooks={{ 'data-activity-scope-tag': '' }}
      {...(tappable
        ? {
            onPress: () => {
              rememberThisCard();
              onOpenGroup(group, openEntry);
            },
            // Named by the card's own title, unread dot and preview (ListCard).
            press: { 'data-activity-lead': '' },
          }
        : {})}
    />
  );
  if (chat) return card;
  const line = (entry: ActivityItem): ReactElement => (
    <EntryLine
      key={entry.id}
      entry={entry}
      nowMs={nowMs}
      timeZone={timeZone}
      side={side}
      onOpen={onOpenEntry}
    />
  );
  // The grid cell: the head, then its lines on the head's title column.
  return (
    <div data-activity-card-cell="" className="flex min-w-0 flex-col">
      {card}
      {lines.length > 0 ? (
        <div
          data-activity-lines=""
          className={cn('flex min-w-0 flex-col pb-2', LIST_CARD_SUB_INSET)}
        >
          {lines.slice(0, ACTIVITY_LINES_SHOWN).map(line)}
          {rest.rendered ? (
            <div
              ref={rest.ref}
              id={restId}
              data-activity-lines-rest=""
              className="flex min-w-0 flex-col"
            >
              {lines.slice(ACTIVITY_LINES_SHOWN).map(line)}
            </div>
          ) : null}
          {hidden > 0 ? (
            <PressableRow
              data-activity-more=""
              aria-expanded={open}
              aria-controls={restId}
              aria-label={open ? 'Show less' : `Show ${hidden} more updates`}
              onClick={() => setOpen((was) => !was)}
              className={textRole('label', 'flex items-center text-fg-2')}
            >
              {open ? 'Show less' : moreLabel(hidden)}
            </PressableRow>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
