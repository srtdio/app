import { stripFormat } from '@srtdio/comments';
import { DUR_BASE_MS, EASE, itemIn, play, rememberCard, useMoveOnMount } from '@/lib/motion';
import { TOUCH_ROLL } from '@/lib/motion/moves';
import {
  cutPreview,
  PREVIEW_LESS,
  PREVIEW_MORE,
  type PreviewCut,
} from '@/components/pages/activity/preview-cut';
import { useGrowBackIntoCard } from '@/lib/motion/pages';
import {
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { Avatar } from '@/components/ui/Avatar';
import { ALL_MARK } from '@/lib/chat/mentions';
import { Button } from '@/components/ui/Button';
import { ListCard, LIST_CARD_UNREAD_DOT, type ListCardPicture } from '@/components/ui/ListCard';
import { PostPlaceholder, postPlaceholderKind } from '@/components/ui/PostPlaceholder';
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
  entryActionLine,
  entryLine,
  isChatMention,
  isChatRow,
  isThreadStarted,
  THREAD_STARTED_EVENT,
  isWelcome,
  opensNothing,
  welcomeTitle,
  type ActivityItem,
  type AlertInfo,
} from '@/components/pages/activity/data';
import { alertDisplayTime } from '@/lib/inbox/alerts';
import type { ViewerSide } from '@/lib/chat/viewer-role';
import { formatAgo } from '@/lib/time';
import { linkRuns } from '@/lib/catch-up/text';

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
  /** The row's tap: mark the item's unread entries read and open `entry`
   *  (the item's newest entry) at its exact place. */
  onOpenGroup: (group: ActivityItem[], entry: ActivityItem) => void;
  /** The signed-in user's resolved display name, used to accent their own @name
   *  inside a mention preview; null when it has not resolved yet. */
  selfName: string | null;
  /** The viewer's side: a plan_opened alert reads "shared with you" for a client. */
  side?: ViewerSide;
  /** A row a live refresh just added: it slides up into place (never sideways). */
  entering?: boolean;
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
export type ActivityKind = 'Mention' | 'Thread' | 'Post' | 'Brief' | 'Plan' | 'Idea' | 'Reminder';

/**
 * What one entry is, in one word: a reminder (a task's missed due time), a
 * mention (a comment's or a chat's), an idea (an idea bank alert), a plan
 * (plan alerts, plan items, plan events), a brief, a post. A chat message, an invite, a file or the welcome
 * row names none. Pure.
 */
export function activityKind(item: ActivityItem): ActivityKind | undefined {
  const alert = item.alert ?? null;
  if (isWelcome(item)) return undefined;
  if (item.eventType === 'task_due') return 'Reminder';
  if (item.eventType === MENTION_EVENT_TYPE || isChatMention(item)) return 'Mention';
  // A thread start wears the chat mention's tag, in its own word.
  if (isThreadStarted(item)) return 'Thread';
  if (alert?.kind === 'bank') return 'Idea';
  if (
    alert?.kind === 'plan' ||
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
 * The row's ONE grey tag on line 2: what the item is (activityKind: Mention,
 * Thread, Post, Brief, Plan, Idea, Reminder). None for the welcome row or a
 * kindless entry. Pure.
 */
export function activityCardTag(group: readonly ActivityItem[]): string | undefined {
  const lead = group[0];
  return lead !== undefined ? activityKind(lead) : undefined;
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
 * A one-entry row's preview text (line 2) when it is plain text: the comment,
 * the alert's second line, the files a delete also took, the welcome's line;
 * else ''. A mention's preview is drawn (its @name accented) by the row. Pure.
 */
export function activityPreviewText(group: readonly ActivityItem[]): string {
  const lead = group[0];
  if (lead === undefined) return '';
  const alert = lead.alert ?? null;
  if (alert !== null) return alertBody(alert) ?? '';
  if (isWelcome(lead)) return WELCOME_BODY;
  if (lead.eventType === 'assets_deleted') {
    // The first file by name, then the others ("deck.pdf · Also hero.png and teaser.mov").
    const first = lead.filenames?.[0];
    const others = deletedFilesBody(lead);
    if (first === undefined) return others ?? '';
    return others !== null ? `${first} · ${others}` : first;
  }
  return entryBodyText(lead) ?? '';
}

/**
 * The cleaned comment or message text an entry carries (the preview Activity
 * has always shown): a comment, mention, plan comment, the first point of a
 * checkpoint batch, a thread start's reply. Mentions are already names (the
 * read resolves them), formatting is stripped. Null for an entry without a
 * body. Pure; the one helper behind every row preview.
 */
export function entryBodyText(entry: ActivityItem): string | null {
  if (entry.body === null || entry.body.trim() === '') return null;
  if (entry.eventType === MENTION_EVENT_TYPE || isThreadStarted(entry)) {
    return stripFormat(entry.body);
  }
  const hasBody =
    entry.eventType === 'comment' ||
    entry.eventType === 'checkpoints_added' ||
    entry.eventType === 'plan_comment';
  return hasBody ? stripFormat(cardBodyLine(entry)) : null;
}

/** What a line says when its comment was deleted (muted; the line still opens the spot). */
export const COMMENT_DELETED = 'Comment deleted';

/**
 * One entry's words: a body-carrying entry reads its comment text, folded to
 * one line with links shortened (host/…/last part); a deleted comment reads
 * "Comment deleted" (muted); every other entry keeps its entryLine wording.
 * Pure.
 */
export function entryLineText(
  entry: ActivityItem,
  side: ViewerSide = 'unknown',
): { actor: string; text: string; muted: boolean } {
  const { actor, text } = entryLine(entry, side);
  if (entry.bodyGone === true) return { actor, text: COMMENT_DELETED, muted: true };
  const body = entryBodyText(entry);
  if (body === null) return { actor, text, muted: false };
  const oneLine = linkRuns(body)
    .map((run) => (run.kind === 'link' ? run.label : run.text))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  return { actor, text: oneLine !== '' ? oneLine : text, muted: false };
}

/**
 * An item row's preview (line 2): its newest entry, "<actor>: <text>" when it
 * carries a comment or message (or the comment was deleted), else its whole
 * action line ("Maya approved Watch launch"). Pure.
 */
export function itemPreviewText(entry: ActivityItem, side: ViewerSide = 'unknown'): string {
  const { actor, text, muted } = entryLineText(entry, side);
  if (muted || entryBodyText(entry) !== null) return `${actor}: ${text}`;
  return entryActionLine(entry, side);
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

/** "N new" after an item's name (only while 2+ of its entries are unread). Pure. */
export function newLabel(n: number): string {
  return `${n} new`;
}

/** The fewest unread entries that show "N new" (one unread is the dot alone). */
export const NEW_CHIP_MIN = 2;

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
 * The unread entries of an item that count toward "N new": own actions left
 * out. Pure.
 */
export function unreadEntries(group: readonly ActivityItem[]): ActivityItem[] {
  return group.filter((entry) => entry.own !== true && entry.readAt === null);
}

/**
 * The "N new" chip (Activity twins Plan, 10 Nov 2026): ink, the primary
 * Button's own fill and text tokens (bg-accent / text-accent-fg: ink with
 * white text in light, white with ink text in dark), no border, rounded-full,
 * medium. Density by <html data-density>: Compact 16 / Cozy 18 / Calm 20 high
 * (Cozy: the 16 box plus 1 above and below, box-content), text 11 / 11 / 12.
 * Sides 6 / 7 / 8 (named padding). Flat (10 Nov 2026): no lit-badge, so no
 * shine and no shadow. Not a button; never truncates.
 */
export const ACTIVITY_NEW_CHIP =
  'box-content inline-flex h-4 shrink-0 items-center rounded-full bg-accent px-new-chip-cozy py-px text-xs font-medium text-accent-fg compact:box-border compact:px-new-chip-compact calm:box-border calm:h-5 calm:px-2 calm:text-sm';

/** Line 1 of an item row: the name (truncates first), then "N new" 8 after it. */
function itemTitleNode(name: string, unread: number): ReactNode {
  if (unread < NEW_CHIP_MIN) return name;
  return (
    <span data-activity-title="" className="flex min-w-0 items-center gap-2">
      <span data-activity-name="" className="min-w-0 truncate">
        {name}
      </span>
      <span data-activity-new-chip="" className={ACTIVITY_NEW_CHIP}>
        {newLabel(unread)}
      </span>
    </span>
  );
}

/**
 * One item as one ui/ListCard row, exactly as Plan and Chat use it (Activity
 * twins Plan, 10 Nov 2026): the density row (Compact 60 / Cozy 72 / Calm 80).
 * - A chat row (isChatRow, or a chat task alert), and a row with no item
 *   (deleted files, an invite, the welcome row): the who-did-what title
 *   ("Priya mentioned you"), its preview, its tag; no "N new".
 * - Every other item (post, brief, plan, plan item, idea): its name, then
 *   "N new" while 2+ of its entries are unread; line 2 the newest entry's
 *   line and the kind tag (Post / Brief / Plan / Idea).
 * Time: the newest entry. The unread dot while anything is unread. A tap opens
 * the newest entry at its exact place and marks the item's entries read.
 */
export function ActivityCard({
  group,
  nowMs,
  timeZone,
  cache,
  presignEnabled,
  onOpenGroup,
  side = 'unknown',
  entering = false,
}: ActivityCardProps) {
  // itemIn (docs/motion.md): a live-added row renders in place and rises
  // 8 px over its final state on its first frame. Y only, never a fade.
  // growFromCard: a tap remembers this row so the page grows out of it, and
  // Back grows the page back into it.
  const growKey = group[0]?.entityId ?? '';
  const cardRef = useGrowBackIntoCard<HTMLElement>(growKey);
  useMoveOnMount(cardRef, (el) => itemIn(el), entering);
  const [lines, setLines] = useState<1 | 2>(1);
  const lead = group[0];
  if (lead === undefined) return null;
  const chat = isChatRow(lead) || lead.alert?.kind === 'task' || !hasItem(lead);
  const newest = newestEntry(group) ?? lead;
  const alert = lead.alert ?? null;
  const unread = unreadEntries(group).length;
  const name = chat ? activityCardTitle(group, side) : itemCardTitle(lead, side);
  // The preview is plain text (@mentions included), up to 2 lines, cut at a
  // whole word with "… more" (Part 6, 10 Nov 2026).
  const previewText: string = chat
    ? lead.eventType === MENTION_EVENT_TYPE && lead.body !== null
      ? stripFormat(lead.body).replaceAll(ALL_MARK, '')
      : activityPreviewText(group)
    : itemPreviewText(newest, side);
  const tappable = !opensNothing(newest, side);
  const titleText = !chat && unread >= NEW_CHIP_MIN ? `${name}, ${newLabel(unread)}` : name;
  // The row's one link is named by its title, the FULL preview and Unread.
  const rowName = [titleText, previewText, groupHasUnread(group) ? 'Unread' : '']
    .filter((part) => part !== '')
    .join(', ');

  return (
    <ListCard
      rootRef={cardRef}
      surface={{
        'data-activity-event': lead.eventType,
        'data-activity-id': lead.id,
        'data-activity-row': chat ? 'chat' : 'item',
        ...(entering ? { 'data-activity-entering': '' } : {}),
      }}
      picture={activityPicture(lead, newest, cache, presignEnabled, name)}
      {...(alert !== null
        ? { pictureHooks: { 'data-activity-alert-icon': alert.kind } }
        : lead.entityType === PLAN_ITEM_ENTITY
          ? { pictureHooks: { 'data-activity-plan-icon': '' } }
          : {})}
      title={chat ? name : itemTitleNode(name, unread)}
      unread={groupHasUnread(group)}
      preview={
        previewText === '' ? undefined : (
          <ActivityPreview rowId={lead.id} text={previewText} onLines={setLines} />
        )
      }
      previewLines={lines}
      previewHooks={{ 'data-activity-preview': '' }}
      time={entryAgo(newest, nowMs, timeZone)}
      timeHooks={{ 'data-activity-time': '' }}
      // A missed due time reads in bad.
      timeBad={lead.eventType === 'task_due'}
      tag={activityCardTag(group)}
      tagHooks={{ 'data-activity-scope-tag': '' }}
      {...(tappable
        ? {
            onPress: () => {
              if (growKey !== '') rememberCard(growKey, cardRef.current);
              onOpenGroup(group, newest);
            },
            press: { 'data-activity-lead': '', 'aria-label': rowName },
          }
        : {})}
    />
  );
}

/** Rows unfolded with "more", by row id: in memory for the session, gone on reload. */
const unfoldedRows = new Set<string>();

/** The preview's own font, measured on a canvas (no layout read per word). */
function textMeasure(el: Element): ((s: string) => number) | null {
  if (typeof document === 'undefined') return null;
  const ctx = document.createElement('canvas').getContext('2d');
  if (ctx === null) return null;
  const style = getComputedStyle(el);
  ctx.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  return (s: string) => ctx.measureText(s).width;
}

/**
 * An Activity row's preview (Part 6, locked 9 Nov 2026): first painted as the
 * one truncated line, then measured once per width (ResizeObserver on the
 * preview box) and cut to 2 lines at a whole word with a muted "… more".
 * "more" unfolds THIS row in place (" less" folds it); both stop the tap, so
 * the row never opens from them. Tells the row how many lines it takes.
 */
function ActivityPreview({
  rowId,
  text,
  onLines,
}: {
  rowId: string;
  text: string;
  onLines: (lines: 1 | 2) => void;
}): ReactElement {
  const ref = useRef<HTMLSpanElement>(null);
  const [cut, setCut] = useState<PreviewCut | null>(null);
  const [open, setOpen] = useState(() => unfoldedRows.has(rowId));
  useLayoutEffect(() => {
    const box = ref.current?.parentElement ?? null;
    if (box === null || typeof ResizeObserver === 'undefined') return undefined;
    const measure = textMeasure(box);
    if (measure === null) return undefined;
    let width = -1;
    const run = (): void => {
      const next = Math.floor(box.clientWidth);
      if (next === width || next <= 0) return;
      width = next;
      // 1px under the box: canvas and layout round apart by a hair.
      setCut(cutPreview(text, next - 1, measure));
    };
    const observer = new ResizeObserver(run);
    observer.observe(box);
    return () => observer.disconnect();
  }, [text]);
  const lines: 1 | 2 = (open && cut?.cut === true) || cut?.lines === 2 ? 2 : 1;
  useLayoutEffect(() => onLines(lines), [lines, onLines]);
  const toggle = (event: MouseEvent<HTMLButtonElement>): void => {
    event.preventDefault();
    event.stopPropagation();
    const next = !open;
    if (next) unfoldedRows.add(rowId);
    else unfoldedRows.delete(rowId);
    setOpen(next);
    // Y only, never a fade; instant under Reduce Motion (play).
    play(
      ref.current?.parentElement,
      TOUCH_ROLL,
      [{ transform: 'translateY(-4px)' }, { transform: 'none' }],
      {
        duration: DUR_BASE_MS,
        easing: EASE.enter,
      },
    );
  };
  const marker = (label: string): ReactElement => (
    <Button
      type="button"
      variant="ghost"
      aria-expanded={open}
      data-activity-preview-toggle={open ? 'less' : 'more'}
      onClick={toggle}
      onPointerDown={(event) => event.stopPropagation()}
      className={PREVIEW_TOGGLE}
    >
      {label}
    </Button>
  );
  // The text sits straight in the preview box; a hidden anchor finds the box.
  const anchor = <span ref={ref} aria-hidden="true" className="hidden" />;
  if (open && cut !== null && cut.cut) {
    return (
      <>
        {text.replace(/\s+/g, ' ').trim()}
        {marker(PREVIEW_LESS)}
        {anchor}
      </>
    );
  }
  if (cut !== null && cut.cut) {
    return (
      <>
        {cut.text}
        {marker(PREVIEW_MORE)}
        {anchor}
      </>
    );
  }
  return (
    <>
      {text}
      {anchor}
    </>
  );
}

/** "… more" / " less": fg-3 words in the line, a 44 x 44 hit centred on them (::before). */
const PREVIEW_TOGGLE =
  'pointer-events-auto relative inline h-auto min-h-0 min-w-0 rounded-none px-0 align-baseline text-md font-normal text-fg-3 hover:text-fg-2 before:absolute before:left-1/2 before:top-1/2 before:h-11 before:w-11 before:-translate-x-1/2 before:-translate-y-1/2';
