import { useState } from 'react';
import { stripFormat } from '@srtdio/comments';
import { itemIn, rememberCard, useMoveOnMount } from '@/lib/motion';
import { useGrowBackIntoCard } from '@/lib/motion/pages';
import type { ComponentType, ReactElement, ReactNode } from 'react';
import { Avatar } from '@/components/ui/Avatar';
import { ListCard, LIST_CARD_UNREAD_DOT, type ListCardPicture } from '@/components/ui/ListCard';
import { PostPlaceholder, postPlaceholderKind } from '@/components/ui/PostPlaceholder';
import { ActionMenu, ActionMenuTrigger, type ActionMenuItem } from '@/components/ui/ActionMenu';
import { splitAllMentions } from '@/lib/chat/mentions';
import { Thumbnail } from '@/components/media';
import type { PresignCache } from '@/lib/asset-presign';
import {
  ICON_SIZE,
  IconActivity,
  IconAlarmClock,
  IconBan,
  IconBriefs,
  IconCalendarClock,
  IconEdit,
  IconFile,
  IconPlan,
  IconRotateCcw,
  IconTaskSquare,
  IconTickSingle,
  type IconProps,
} from '@/components/ui/icons';
import { ActivityRowMenu } from '@/components/pages/activity/ActivityRowMenu';
import { useMenuGesture } from '@/components/ui/useLongPress';
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
  groupOpenEntry,
  isSnoozed,
  isChatMention,
  isWelcome,
  opensNothing,
  segmentSelfMentions,
  upcomingChat,
  upcomingTag,
  welcomeTitle,
  type ActivityItem,
  type AlertInfo,
  type SnoozeKind,
  type UpcomingItem,
} from '@/components/pages/activity/data';
import { ONLY_YOU_LABEL, alertDisplayTime } from '@/lib/inbox/alerts';
import { formatSendLabel } from '@/lib/chat/scheduled';
import type { ViewerSide } from '@/lib/chat/viewer-role';
import { formatWhen } from '@/lib/time';

interface ActivityCardProps {
  /** A digest group: one entry (solo) or several on the same entity (one card). */
  group: ActivityItem[];
  nowMs: number;
  /** The workspace zone the time reads in ("Yesterday" rolls over there). Absent: the device zone. */
  timeZone?: string | null | undefined;
  /** The page-owned presign cache, threaded into the picture. */
  cache: PresignCache;
  /** False when presigning is unconfigured: the picture shows the fallback. */
  presignEnabled: boolean;
  /** Open the thread: mark it read and navigate from `entry` (groupOpenEntry:
   *  the newest entry that links to a comment, else the lead). */
  onOpenGroup: (group: ActivityItem[], entry: ActivityItem) => void;
  /** Open a single entry (kept for callers; the card opens the group). */
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

/** The Activity type chips' names: the one tag a card carries. */
export type ActivityTag = 'Posts' | 'People' | 'Plans' | 'Briefs';

/** The scopes that name people (a DM, a group, the approvers). */
const PEOPLE_SCOPES: ReadonlySet<string> = new Set(['people', 'groups', 'clients']);

/**
 * The card's one tag, named as the type chips are: Plans (plan alerts, plan
 * items, plan events), Briefs (the briefs scope), Posts (a post), People (a
 * chat, a mention in a chat, an invite). A scheduled send went to its sender
 * alone: it reads "Only you". The welcome row has none. Pure.
 */
export function activityTag(item: ActivityItem): ActivityTag | typeof ONLY_YOU_LABEL | undefined {
  const alert = item.alert ?? null;
  if (alert !== null && (alert.kind === 'sent' || alert.kind === 'failed')) return ONLY_YOU_LABEL;
  if (isWelcome(item)) return undefined;
  if (
    alert?.kind === 'plan' ||
    alert?.kind === 'bank' ||
    item.entityType === PLAN_ITEM_ENTITY ||
    item.entityType === 'plan' ||
    (item.planId !== null && item.planId !== undefined)
  ) {
    return 'Plans';
  }
  if (item.scope === BRIEFS_SCOPE || item.entityType === 'brief') return 'Briefs';
  if (item.entityType === 'post' || item.scope === 'posts') return 'Posts';
  if (alert !== null || isChatMention(item) || PEOPLE_SCOPES.has(item.scope)) return 'People';
  return undefined;
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
    return deletedFilesBody(lead) ?? lead.filenames?.[0] ?? more;
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
  if (alert.kind === 'reminder' || item.eventType === 'task_due') return IconAlarmClock;
  if (alert.kind === 'sent') return IconTickSingle;
  if (alert.kind === 'failed') return IconCalendarClock;
  if (alert.kind === 'plan' || alert.kind === 'bank') return IconPlan;
  return IconTaskSquare;
}

/** The event types that are about a person: the picture is their photo. */
const PERSON_EVENTS: ReadonlySet<string> = new Set([MENTION_EVENT_TYPE, 'invite']);

/**
 * The picture (72): the thing the event is about (the post's picture, else
 * its "Aa" / play placeholder; the brief, plan or alert icon; the first
 * deleted file), or, for a mention or a person event, that person's photo.
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
  if (isWelcome(lead) && lead.welcome != null) {
    return {
      kind: 'image',
      node: <Avatar name={lead.welcome.workspaceName} role="profile" kind="group" decorative />,
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
          fallbackTile={<PostPlaceholder kind={placeholder} size={ICON_SIZE.picture} fill />}
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
              <IconFile size={ICON_SIZE.picture} />
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

/** A failed scheduled send's menu rows: Edit (opens its chat) and Retry. Pure. */
export function failedSendItems(
  lead: ActivityItem,
  onEdit: ((item: ActivityItem) => void) | undefined,
  onRetry: ((item: ActivityItem) => void) | undefined,
): ActionMenuItem[] {
  if (lead.alert?.kind !== 'failed') return [];
  return [
    ...(onEdit !== undefined
      ? [{ id: 'edit', label: 'Edit', icon: IconEdit, onSelect: () => onEdit(lead) }]
      : []),
    ...(onRetry !== undefined
      ? [{ id: 'retry', label: 'Retry', icon: IconRotateCcw, onSelect: () => onRetry(lead) }]
      : []),
  ];
}

/**
 * One digest group as one ui/ListCard: the picture (the thing, or the
 * person), the who-did-what title with the unread dot, the comment or alert
 * line as the preview, then the time (formatWhen, the workspace zone), the one
 * tag (Posts, People, Plans, Briefs) and the ⋯ (Mark as read, Snooze; a failed
 * send's Edit and Retry). A tap opens the group (the newest entry that links
 * to a comment, else the lead). A threaded group is one card ("+N more" when
 * it has no line of its own); its entries open from the page it lands on.
 */
export function ActivityCard({
  group,
  nowMs,
  timeZone,
  cache,
  presignEnabled,
  onOpenGroup,
  onSnooze,
  onMarkRead,
  selfName,
  side = 'unknown',
  onRetry,
  onEdit,
  entering = false,
}: ActivityCardProps) {
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
  // Long-press on touch and right-click on laptop open the card's ⋯ menu.
  const [menuOpen, setMenuOpen] = useState(false);
  const gesture = useMenuGesture(() => setMenuOpen(true));

  const lead = group[0];
  if (lead === undefined) return null;
  // The head opens the newest entry that links to a comment, else the lead.
  const openEntry = groupOpenEntry(group) ?? lead;
  const alert = lead.alert ?? null;
  const unread = groupHasUnread(group);
  const snoozed = isSnoozed(lead, nowMs);
  const actor = newestEntry(group) ?? lead;
  const title = activityCardTitle(group, side);
  const previewText = activityPreviewText(group);
  const preview: ReactNode =
    lead.eventType === MENTION_EVENT_TYPE && lead.body !== null
      ? mentionPreview(lead.body, selfName, isChatMention(lead))
      : previewText;
  const tappable = !opensNothing(lead, side);
  const tag = activityTag(lead);
  const time = formatWhen(
    alertDisplayTime(lead.eventType, lead.createdAt, lead.alert?.plan),
    new Date(nowMs),
    timeZone ?? undefined,
  );
  const bad = alert?.kind === 'failed' || lead.eventType === 'task_due';

  return (
    <ListCard
      rootRef={cardRef}
      surface={{
        'data-activity-event': lead.eventType,
        'data-activity-id': lead.id,
        ...(entering ? { 'data-activity-entering': '' } : {}),
        ...gesture.handlers,
        onClickCapture: (event) => {
          // The click that trails a long-press never also opens the card.
          if (!gesture.consumeClickSuppression()) return;
          event.preventDefault();
          event.stopPropagation();
        },
      }}
      picture={activityPicture(lead, actor, cache, presignEnabled, title)}
      {...(alert !== null
        ? { pictureHooks: { 'data-activity-alert-icon': alert.kind } }
        : lead.entityType === PLAN_ITEM_ENTITY
          ? { pictureHooks: { 'data-activity-plan-icon': '' } }
          : {})}
      // A failed send's lead and a missed due time read in bad.
      title={bad ? <span className="text-bad">{title}</span> : title}
      unread={unread}
      preview={preview}
      previewHooks={{ 'data-activity-preview': '' }}
      time={time}
      timeHooks={{ 'data-activity-time': '' }}
      tag={tag}
      tagHooks={
        tag === ONLY_YOU_LABEL
          ? { 'data-activity-only-you': '' }
          : { 'data-activity-scope-tag': '' }
      }
      menu={
        <div data-activity-menu="" className="flex">
          <ActivityRowMenu
            open={menuOpen}
            onOpenChange={setMenuOpen}
            snoozed={snoozed}
            unread={unread}
            extra={failedSendItems(lead, onEdit, onRetry)}
            onSnooze={(kind) => {
              for (const entry of group) onSnooze(entry, kind);
            }}
            onMarkRead={() => {
              for (const entry of group) if (entry.readAt === null) onMarkRead(entry);
            }}
          />
        </div>
      }
      {...(tappable
        ? {
            onPress: () => {
              rememberThisCard();
              onOpenGroup(group, openEntry);
            },
            press: {
              'aria-label': [title, unread ? 'Unread' : null, previewText || null]
                .filter((part): part is string => part !== null)
                .join(', '),
              'data-activity-lead': '',
            },
          }
        : {})}
    />
  );
}

/** A pending reminder's edit: the bell's "Change time" (the reminder sheet in change mode). */
export const CHANGE_TIME_LABEL = 'Change time';

/** An Upcoming row's Edit label: "Change time" on a reminder, "Edit" on a scheduled message. */
export function upcomingEditLabel(item: Pick<UpcomingItem, 'kind'>): string {
  return item.kind === 'reminder' ? CHANGE_TIME_LABEL : 'Edit';
}

/** An Upcoming card's menu rows: Edit (Change time on a reminder), then Cancel. Pure. */
export function upcomingMenuItems(
  item: UpcomingItem,
  onEdit: (item: UpcomingItem) => void,
  onCancel: (item: UpcomingItem) => void,
): ActionMenuItem[] {
  return [
    { id: 'edit', label: upcomingEditLabel(item), icon: IconEdit, onSelect: () => onEdit(item) },
    {
      id: 'cancel',
      label: 'Cancel',
      icon: IconBan,
      tone: 'danger',
      onSelect: () => onCancel(item),
    },
  ];
}

/**
 * One Upcoming row on ui/ListCard, like every Activity card: the alarm clock
 * (a reminder) or calendar clock (a scheduled message) as the picture, the
 * chat as the title, the message as the preview, the due time and the tag
 * (Reminder or Scheduled); the ⋯ holds Edit (Change time on a reminder) and
 * Cancel. Never unread. A tap opens the chat at the reminded message (a
 * scheduled message opens its chat). Hook-free.
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
  const chat = upcomingChat(item);
  return (
    <ListCard
      data-upcoming-row={item.kind}
      data-upcoming-id={item.id}
      picture={{
        kind: 'icon',
        icon: item.kind === 'reminder' ? IconAlarmClock : IconCalendarClock,
      }}
      title={chat}
      preview={stripFormat(item.preview)}
      time={formatSendLabel(new Date(item.dueAt), now)}
      timeHooks={{ 'data-upcoming-due': '' }}
      tag={upcomingTag(item)}
      tagHooks={{ 'data-upcoming-tag': '' }}
      onPress={() => onOpen(item)}
      press={{ 'aria-label': `Open ${chat}`, 'data-upcoming-open': '' }}
      menu={
        <ActionMenu
          title={chat}
          items={upcomingMenuItems(item, onEdit, onCancel)}
          trigger={
            <ActionMenuTrigger
              type="button"
              label={`Actions for ${chat}`}
              data-upcoming-more=""
              className="text-fg-3"
            />
          }
        />
      }
    />
  );
}
