// One message row of a chat thread (MessageBubble) and the pure pieces it is
// drawn from: the bubble meta, the failed-send line, the tombstone, @mention
// rendering, the swipe icons and paint, the row hold, the day pill and the
// thread's row grouping (threadRows). Moved out of MessageThread.tsx as a pure
// move (no behaviour change) so the Plan item thread draws with chat's own
// bubble without pulling the whole chat thread module (its composer, tasks,
// status strip and info sheets) into the Plan route. MessageThread imports and
// re-exports these, so every importer keeps its path.

import { PHONE_PAD_FLUSH } from '@/components/ui/layout';
import { stripFormat } from '@srtdio/comments';
import {
  Fragment,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type Ref,
  type ReactElement,
  type ReactNode,
} from 'react';
import {
  ALL_MENTION,
  isFormerMember,
  isUnconfirmedMember,
  withFormer,
  knownMentionName,
  mentionHandle,
  mentionIds,
  mentionLabel,
  mentionsAll,
  resolveMentionText,
  splitMentions,
  type NameOf,
} from '@/lib/chat/mentions';
import { currentOrigin, firstExternalUrl } from '@/lib/chat/message-links';
import { renderBodyLinks, renderMessageBody, renderRich } from '@/components/chat/message-body';
import { Avatar } from '@/components/ui/Avatar';
import { LinkPreviewCard } from '@/components/ui/LinkPreviewCard';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { PressableRow } from '@/components/ui/PressableRow';
import { PersonTrigger } from '@/components/ui/PersonTrigger';
import type { PersonCardHint } from '@/lib/person-card';
import { ReactionChips, type ReactionChipsProps } from '@/components/ui/ReactionChips';
import {
  ICON_SIZE,
  IconAlertTriangle,
  IconBan,
  IconChevronDown,
  IconClock,
  IconForward,
  IconReply,
  IconSmile,
  IconTickDouble,
  IconTickSingle,
  IconTrash,
} from '@/components/ui/icons';
import { useLongPress } from '@/components/ui';
import { ActionMenu } from '@/components/ui/ActionMenu';
import { cn } from '@/lib/cn';
import type { ChatProfile } from '@/lib/chat-reads';
import { breaksRun, deletedMessageLabel, type ThreadMessage } from '@/lib/chat/thread';
import { classifyAttachment, splitAlbum } from '@/lib/chat/attachments';
import { civilDay, formatTime, threadWhen } from '@/lib/time';
import {
  BUBBLE_BODY_TYPE,
  BUBBLE_META_TYPE,
  BUBBLE_PAD,
  SENDER_NAME_TYPE,
  SENDER_TIME_TYPE,
  BUBBLE_SHAPE,
  DATE_LINE_TYPE,
  MESSAGE_AVATAR_ROLE,
  MESSAGE_PHOTO_COL,
  MESSAGE_PHOTO_GAP,
  NO_TOUCH_SELECT,
  sized,
  TICK_ICON_BOX,
  type ChatLayout,
  type ChatSize,
} from '@/components/chat/chat-type';
import { SWIPE_REST, type SwipeFrame, type SwipeSide } from '@/lib/chat/swipe-reply';
import type { PresignCache } from '@/lib/asset-presign';
import { paintSwipe } from '@/lib/motion';
import { FilesRemovedLine, MessageAttachments } from '@/components/chat/MessageAttachments';
import { SharedPostCards } from '@/components/chat/PostCard';
import { ChatCardOwn } from '@/components/ui/ChatCard';
import { RailElbow, RailThrough, RailTick } from '@/components/chat/ThreadRail';
import { PostRefChip, type PostRefPost } from '@/components/chat/PostRefChip';
import { SharedBriefCards } from '@/components/chat/BriefCard';
import { SharedPlanCards } from '@/components/chat/PlanCard';
import { SharedIdeaCards } from '@/components/chat/PlanItemCard';
import { SelectCheckbox } from '@/components/chat/SelectCheckbox';
import { quoteMedia, ReplyQuoteBox } from '@/components/chat/ReplyQuote';
import {
  privateReplyHeader,
  privateReplyPreview,
  type PrivateReply,
  type PrivateReplyDraft,
} from '@/lib/chat/private-reply';
import { dayPillLabel, withDaySeparators, type ThreadItem } from '@/components/chat/day-separators';
import { collapseTaskRun, type TaskEvent, type TaskLine } from '@/lib/chat/tasks';
import { SavedFromLabel, type SavedFromWiring } from '@/components/chat/NotesBits';
import { FORWARDED_LABEL, type SelectionRole } from '@/lib/chat/forward';
import { type RailRole, type RowGeometry } from '@/lib/chat/thread-rail';
import { highlightNodes } from '@/components/ui/SearchHighlight';

/** Pointer handlers on a bubble: the long-press and swipe-to-reply controllers, composed. */
export interface BubblePointerHandlers {
  onPointerDown: (event: PointerEvent<HTMLElement>) => void;
  onPointerMove: (event: PointerEvent<HTMLElement>) => void;
  /** The release event ends the swipe's flick window at its own timeStamp. */
  onPointerUp: (event?: PointerEvent<HTMLElement>) => void;
  onPointerCancel: () => void;
}

/**
 * A row's swipe (touch and pen): right = Reply, left = Delete. The whole row
 * (full width, not only the bubble) is the grab area: `handlers` go on the
 * <li>, the bubble is what slides. Absent pieces leave that part off (a unit
 * test passes {} to see the icons and the bubble's marks alone).
 */
export interface BubbleSwipe {
  /** The reply arrow behind the bubble's left edge. */
  iconRef?: Ref<HTMLSpanElement>;
  /** The bin behind the bubble's right edge. */
  deleteIconRef?: Ref<HTMLSpanElement>;
  /** The swipe controller's pointer handlers, on the row. */
  handlers?: BubblePointerHandlers;
  /** True (once) when a click is the tail of a swipe: the row swallows it. */
  consumeClick?: () => boolean;
}

/**
 * The row's grab area: the swipe handlers, the vertical-pan touch-action (the
 * list keeps scrolling, a horizontal move is the swipe's) and the swallowed
 * click that trails a swipe. Empty without handlers.
 */
function rowSwipeProps(swipe: BubbleSwipe | undefined): {
  'data-swipe-row'?: string;
  onPointerDown?: BubblePointerHandlers['onPointerDown'];
  onPointerMove?: BubblePointerHandlers['onPointerMove'];
  onPointerUp?: BubblePointerHandlers['onPointerUp'];
  onPointerCancel?: BubblePointerHandlers['onPointerCancel'];
  onClickCapture?: (event: MouseEvent) => void;
} {
  const handlers = swipe?.handlers;
  if (handlers === undefined) return {};
  const consume = swipe?.consumeClick;
  return {
    'data-swipe-row': '',
    ...handlers,
    onClickCapture: (event) => {
      // Pointer capture sends a swipe's trailing click to the row: it does nothing.
      if (consume?.() === true) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
  };
}

/** The row's touch-action while it swipes: vertical pans and pinch stay the browser's. */
export const SWIPE_ROW_TOUCH = 'touch-pan-y touch-pinch-zoom';

/**
 * The swipe-to-reply icon: sits behind the bubble's resting left edge and is
 * revealed as the bubble slides right. 32px circle, panel-3 idle, accent when
 * armed (data-armed). Scale and opacity (0 to 1 over 0 to 64px) are painted
 * per frame by MessageRow; at rest the classes hold it at scale 0, opacity 0.
 * The release spring is set inline with the bubble's. No other motion.
 */
export function SwipeReplyIcon(props: {
  iconRef?: Ref<HTMLSpanElement> | undefined;
}): ReactElement {
  return (
    <span
      ref={props.iconRef}
      aria-hidden="true"
      data-swipe-icon=""
      className="pointer-events-none absolute inset-y-0 left-0 my-auto flex h-8 w-8 scale-0 items-center justify-center rounded-full bg-panel-3 text-fg-2 opacity-0 data-[armed]:bg-accent data-[armed]:text-accent-fg"
    >
      <IconReply size={ICON_SIZE.nav} />
    </span>
  );
}

/**
 * The swipe-to-delete bin: the reply icon's mirror, behind the bubble's
 * resting right edge and revealed as the bubble slides left. 32px circle,
 * bad ink on panel-3 idle, accent when armed (data-armed), the same as a task
 * row's bin. Painted per frame by paintRowSwipe; at rest the classes hold it
 * at scale 0, opacity 0.
 */
export function SwipeDeleteIcon(props: {
  iconRef?: Ref<HTMLSpanElement> | undefined;
}): ReactElement {
  return (
    <span
      ref={props.iconRef}
      aria-hidden="true"
      data-swipe-delete-icon=""
      className="pointer-events-none absolute inset-y-0 right-0 my-auto flex h-8 w-8 scale-0 items-center justify-center rounded-full bg-panel-3 text-bad opacity-0 data-[armed]:bg-accent data-[armed]:text-accent-fg"
    >
      <IconTrash size={ICON_SIZE.nav} />
    </span>
  );
}

/**
 * The row's swipe: the bubble slides by the frame (its side picks the way),
 * the icon on the revealed side follows the progress and the other one rests.
 * `iconShown` false (a way that cannot trigger: the rubber band) keeps both
 * icons at rest. Style writes only, no layout reads.
 */
export function paintRowSwipe(
  bubble: HTMLElement | null,
  replyIcon: HTMLElement | null,
  deleteIcon: HTMLElement | null,
  frame: SwipeFrame,
  iconShown: boolean,
): void {
  const left = frame.side === 'left';
  const active = left ? deleteIcon : replyIcon;
  const idle = left ? replyIcon : deleteIcon;
  paintSwipe(bubble, iconShown ? active : null, frame, frame.side);
  if (!iconShown) paintSwipe(null, active, SWIPE_REST);
  paintSwipe(null, idle, SWIPE_REST);
}

/**
 * Whether a swipe that way may fire on this row. Right (Reply) on every live
 * recorded message; left (Delete) only where the long-press menu offers
 * Delete (`canDelete`, the same rule). A tombstone takes neither: the row
 * rubber-bands and nothing opens. Pure.
 */
export function rowSwipeCanTrigger(
  side: SwipeSide,
  message: ThreadMessage,
  canDelete: ((message: ThreadMessage) => boolean) | undefined,
): boolean {
  if (message.deleted === true) return false;
  if (side === 'right') return true;
  return canDelete?.(message) === true;
}

/**
 * Whether a keydown on a focused bubble (or channel row) opens its action menu:
 * Enter or Space on the element itself, or Shift+F10 / the ContextMenu key. Keys
 * bubbling up from a control inside (quoted reply, reaction badge) are ignored.
 */
export function keyOpensMenu(event: {
  key: string;
  shiftKey: boolean;
  target: unknown;
  currentTarget: unknown;
}): boolean {
  if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) return true;
  if (event.target !== event.currentTarget) return false;
  return event.key === 'Enter' || event.key === ' ';
}

export function isTranscribable(
  message: Pick<ThreadMessage, 'attachments' | 'state' | 'deleted'>,
): boolean {
  const [only] = message.attachments;
  return (
    message.state === 'sent' &&
    message.deleted !== true &&
    message.attachments.length === 1 &&
    only !== undefined &&
    only.mime.startsWith('audio/')
  );
}

/** A voice note alone (no text, cards or other files): it takes the text-bubble layout. */
export function isVoiceOnly(
  message: Pick<ThreadMessage, 'body' | 'attachments' | 'sharedPostIds' | 'sharedBriefIds'>,
): boolean {
  const [only] = message.attachments;
  return (
    message.attachments.length === 1 &&
    only !== undefined &&
    classifyAttachment(only.mime) === 'audio' &&
    message.body.trim() === '' &&
    message.sharedPostIds.length === 0 &&
    message.sharedBriefIds.length === 0
  );
}

/**
 * The body element of the one bubble whose text is being selected: only it
 * takes selection and the native callout. Every other bubble, the row and the
 * list stay NO_TOUCH_SELECT (a select-text child inside select-none, as the
 * voice transcript does).
 */
export const SELECTING_TEXT_BODY = 'select-text [-webkit-touch-callout:default]';

/** The message carries at least one image: its bubble renders the album layout. */
export function hasAlbum(message: Pick<ThreadMessage, 'attachments'>): boolean {
  return message.attachments.some((a) => classifyAttachment(a.mime) === 'image');
}

/**
 * A bubble's post chip when it replies to a card message outside that card's
 * thread (a card that is itself a reply heads no thread) and the post is in
 * the thread's batch. A reply without a chip keeps its quote: a plain parent,
 * a post the viewer cannot see, or (a live row only; page rows wait for their
 * chips) a post still being read. Tapping it jumps to the card.
 */
export type BubbleChip = {
  kind: 'chip';
  post: PostRefPost;
  onTap: () => void;
};

/** What a bubble's cards and chip hand back to the thread. */
export interface BubblePostRefs {
  chip?: BubbleChip | undefined;
  /** Hold on a card or the sheet's "Talk about". */
  onTalkAbout?: ((postId: string, messageId: string) => void) | undefined;
  /** Inside the gesture that ends a Talk about: focus the composer (decision 128). */
  onTalkAboutFocus?: (() => void) | undefined;
}

/**
 * What a bubble hands its post cards. While selecting, no talkAbout: a hold on
 * a card is the row's hold (it toggles the row), never "talk about this post".
 */
export function cardRefsFor(
  messageId: string,
  selection: RowSelection | undefined,
  postRefs: BubblePostRefs | undefined,
): {
  messageId: string;
  onTalkAbout: BubblePostRefs['onTalkAbout'];
  onTalkAboutFocus: BubblePostRefs['onTalkAboutFocus'];
} {
  return {
    messageId,
    onTalkAbout: selection === undefined ? postRefs?.onTalkAbout : undefined,
    onTalkAboutFocus: selection === undefined ? postRefs?.onTalkAboutFocus : undefined,
  };
}

/** Selection-mode state for one row, when selection mode is on. */
export interface RowSelection {
  role: SelectionRole;
  checked: boolean;
  onToggle: () => void;
}

/**
 * A bubble's Reply privately quote: the in-bubble reply quote's look, headed
 * "<Full name> · <where>" (the held profile, else the workspace's remembered
 * name), over one line of their words. With onOpen the box is a 44px button to
 * where it points (privateReplyHref); otherwise it is static.
 */
function PrivateReplyQuote(props: {
  reply: PrivateReply;
  profiles: Map<string, ChatProfile>;
  workspaceId: string | null;
  layout: ChatLayout;
  onOpen?: ((reply: PrivateReply) => void) | undefined;
  className?: string;
}): ReactElement {
  const { reply, profiles, workspaceId } = props;
  const author =
    profiles.get(reply.authorUserId)?.displayName ??
    knownMentionName(workspaceId, reply.authorUserId) ??
    'Member';
  const onOpen = props.onOpen;
  return (
    <ReplyQuoteBox
      author={privateReplyHeader(author, reply.whereLabel)}
      preview={resolveMentionText(
        privateReplyPreview(reply.excerpt),
        profileNameOf(profiles, workspaceId),
      )}
      inBubble={props.layout}
      oneLine
      {...(onOpen !== undefined ? { onJump: () => onOpen(reply) } : {})}
      {...(props.className !== undefined ? { className: props.className } : {})}
    />
  );
}

export function senderName(message: ThreadMessage, profiles: Map<string, ChatProfile>): string {
  if (message.mine) return 'You';
  const profile = message.senderUserId !== null ? profiles.get(message.senderUserId) : undefined;
  return profile?.displayName ?? 'Unknown';
}

/** L1: the group head's name: own messages show the viewer's own name (never "You"). */
function headerName(message: ThreadMessage, profiles: Map<string, ChatProfile>): string {
  const profile = message.senderUserId !== null ? profiles.get(message.senderUserId) : undefined;
  return profile?.displayName ?? (message.mine ? 'You' : 'Unknown');
}

/** Whether a meta has nothing to draw ("edited", time and status all absent). Pure. */
export function metaIsEmpty(meta: BubbleMeta): boolean {
  return !meta.edited && meta.time === '' && metaTick(meta.status) === null;
}

/**
 * L1 (8 Nov 2026): the group head carries the clock time (and on own messages
 * the send state) on its name line, so the in-body meta keeps only "edited"
 * and, on a continuation row, the send state. Pure.
 */
export function bodyMetaOf(meta: BubbleMeta, head: boolean): BubbleMeta {
  return { time: '', edited: meta.edited, status: head ? null : meta.status };
}

function senderAvatarProps(
  message: ThreadMessage,
  profiles: Map<string, ChatProfile>,
): { src: string } | Record<string, never> {
  const profile = message.senderUserId !== null ? profiles.get(message.senderUserId) : undefined;
  return profile?.avatarUrl != null ? { src: profile.avatarUrl } : {};
}

/**
 * The one timestamp a message's time label and aria-label both read: the server
 * createdAt; while createdAt is absent, the estimated server time of an
 * unrecorded own send's tap, else the Agora time (provisional).
 */
export function messageTimeSource(
  message: Pick<ThreadMessage, 'createdAt' | 'time' | 'estimatedMs'>,
): string | number {
  if (message.createdAt !== '') return message.createdAt;
  return message.estimatedMs ?? message.time;
}

/**
 * A bubble's spoken time for its aria-label: the server time on the viewer's
 * clock ("2:05 PM"; `timeZone` is for tests) once recorded, 'Sending' while the record write is in
 * flight or retrying, and 'Not sent' once the background retries gave up.
 */
export function bubbleTimeLabel(message: ThreadMessage, timeZone?: string): string {
  if (message.state === 'sending') return 'Sending';
  if (message.state === 'failed') return message.filesMissing === true ? FILES_MISSING : 'Not sent';
  const time = formatTime(messageTimeSource(message), timeZone);
  return isEdited(message) ? `${EDITED_LABEL}, ${time}` : time;
}

/** The muted label an edited message shows (before its time). */
export const EDITED_LABEL = 'edited';

/** Whether a message shows the "edited" label: a live message whose body was edited. */
export function isEdited(message: Pick<ThreadMessage, 'editedAt' | 'deleted'>): boolean {
  return message.deleted !== true && message.editedAt != null;
}

/** The status of a send whose picked files did not survive a reload. */
export const FILES_MISSING = 'Photos not sent';

/** The tick state a bubble's meta shows; null draws no glyph. */
export type BubbleStatus = 'sending' | 'failed' | 'files-missing' | 'delivered' | 'read';

/**
 * A bubble's status glyph: a clock while sending and an alert once failed (any
 * message), else a single tick (delivered) or double tick (read) on every own
 * DM message.
 */
export function bubbleStatus(
  message: Pick<ThreadMessage, 'mine' | 'state' | 'status' | 'filesMissing'>,
  opts: { showTicks: boolean },
): BubbleStatus | null {
  if (message.state === 'sending') return 'sending';
  if (message.state === 'failed') return message.filesMissing === true ? 'files-missing' : 'failed';
  if (!message.mine || !opts.showTicks) return null;
  return message.status === 'read' ? 'read' : 'delivered';
}

/** What every bubble shows at its bottom-right: "edited", the time, the tick. */
export interface BubbleMeta {
  time: string;
  edited: boolean;
  status: BubbleStatus | null;
}

/**
 * A message's in-bubble meta: the clock time ("2:05 PM") on the viewer's clock.
 * formatTime (absolute): a bubble already sits under its day pill, so it
 * always shows its clock time. `timeZone` is for tests. Pure.
 */
export function bubbleMeta(
  message: ThreadMessage,
  timeZone: string | undefined,
  opts: { showTicks: boolean },
): BubbleMeta {
  return {
    time: formatTime(messageTimeSource(message), timeZone),
    edited: isEdited(message),
    status: bubbleStatus(message, opts),
  };
}

/** The statuses the meta draws a glyph for; a failed send's alert sits outside the bubble. */
export type MetaTick = 'sending' | 'delivered' | 'read';

/** The spoken name of each meta glyph. */
const STATUS_LABEL: Record<MetaTick, string> = {
  sending: 'Sending',
  delivered: 'Delivered',
  read: 'Read',
};

/** The meta glyph a status draws; null for a failed send (its alert is outside). */
export function metaTick(status: BubbleStatus | null): MetaTick | null {
  return status === 'sending' || status === 'delivered' || status === 'read' ? status : null;
}

/**
 * The 20x12 status glyph: clock (sending), single tick (delivered), double tick
 * in the read token (read). currentColor otherwise, so it takes the meta ink at
 * full strength (or the media pill's white).
 */
export function MetaGlyph({ status }: { status: MetaTick }): ReactElement {
  return (
    <span
      role="img"
      aria-label={STATUS_LABEL[status]}
      data-tick={status}
      className={cn(
        TICK_ICON_BOX,
        'inline-flex items-center justify-center',
        status === 'read' && 'text-tick-read',
      )}
    >
      {status === 'sending' ? <IconClock size={ICON_SIZE.text} /> : null}
      {status === 'delivered' ? <IconTickSingle /> : null}
      {status === 'read' ? <IconTickDouble /> : null}
    </span>
  );
}

/**
 * The failed send's alert: a "!" in a triangle in the bad token, drawn on the
 * page background beside the bubble (5.05:1 light, 5.83:1 dark).
 */
export function FailedGlyph(): ReactElement {
  return (
    <span data-failed-glyph="" className="flex">
      <IconAlertTriangle size={ICON_SIZE.tray} />
    </span>
  );
}

/** The meta's inner run: "edited", time, glyph. Shared by the meta and its spacer. */
function metaParts(meta: BubbleMeta): ReactElement {
  const tick = metaTick(meta.status);
  return (
    <>
      {meta.edited ? <span data-edited="">{EDITED_LABEL}</span> : null}
      {meta.time !== '' ? (
        <span aria-hidden="true" className="font-mono">
          {meta.time}
        </span>
      ) : null}
      {tick !== null ? <MetaGlyph status={tick} /> : null}
    </>
  );
}

/**
 * Where a bubble's meta sits: after its text (inline), on a pill over a bare
 * image album (pill), or in its own right-aligned row under everything else
 * (row: voice, files, cards, and media with a caption). A card-only message
 * (the card is the bubble) draws it inside its last card's time slot (card).
 */
export type MetaPlacement = 'inline' | 'pill' | 'row' | 'card';

/** The meta's ink on the bubble: the own or peer meta token, at full strength. */
function metaInk(mine: boolean): string {
  return mine ? 'text-bubble-meta-own' : 'text-bubble-meta';
}

/** Each placement's position: two overlays at the bottom-right, the row in flow. */
const META_POSITION: Record<MetaPlacement, string> = {
  inline: 'pointer-events-none absolute bottom-1 right-2 inline-flex',
  pill: 'pointer-events-none absolute bottom-3 right-3 inline-flex rounded-full bg-[color:var(--media-meta-bg)] px-2 py-px text-media-meta lit-media',
  row: 'pointer-events-none mt-1 flex justify-end',
  // Inside ui/ChatCard's bottom-trailing time slot, which places and inks it.
  card: 'pointer-events-none inline-flex',
};

/**
 * The meta itself. Inline sits at the bubble's bottom-right beside the text's
 * spacer; pill sits over a bare album on the translucent dark pill in white;
 * row is its own right-aligned line inside the bubble, below the content, so it
 * never overlaps it. Inline and row take the bubble's meta ink. Opacity-free,
 * no motion.
 */
export function BubbleMetaView(props: {
  meta: BubbleMeta;
  mine: boolean;
  placement: MetaPlacement;
  className?: string | undefined;
}): ReactElement {
  return (
    <span
      data-meta={props.placement}
      data-status={props.meta.status ?? undefined}
      className={cn(
        'shrink-0 items-center gap-1 whitespace-nowrap',
        BUBBLE_META_TYPE,
        META_POSITION[props.placement],
        // A card's time slot inks it (own card: on-bubble ink; peer: fg-3).
        props.placement !== 'pill' && props.placement !== 'card' && metaInk(props.mine),
        props.className,
      )}
    >
      {metaParts(props.meta)}
    </span>
  );
}

/**
 * The invisible inline spacer at the end of a bubble's text: the meta's own
 * width (same parts, same type) plus a gap. A short last line keeps the meta
 * beside it; a full one pushes the spacer, and so the meta, to its own line.
 */
export function MetaSpacer({ meta }: { meta: BubbleMeta }): ReactElement {
  return (
    <span
      aria-hidden="true"
      data-meta-spacer=""
      className={cn(
        'pointer-events-none invisible inline-flex shrink-0 select-none items-center gap-1 whitespace-nowrap pl-3 align-baseline',
        BUBBLE_META_TYPE,
      )}
    >
      {metaParts(meta)}
    </span>
  );
}

/**
 * The line under a failed own bubble ("Not sent" / "Photos not sent"), its own
 * role="status" element so it is announced; its alert (Retry) sits beside the
 * bubble and stays a plain button.
 */
export function FailedLine({ status }: { status: 'failed' | 'files-missing' }): ReactElement {
  return (
    <span role="status" data-failed={status} className={cn('text-bad', BUBBLE_META_TYPE)}>
      {status === 'failed' ? 'Not sent' : FILES_MISSING}
    </span>
  );
}

/**
 * Any failed own send (never recorded), with or without files (FB5): "Not
 * sent" with Delete beside it (and Retry unless it was refused for good), and
 * Delete in its menu. Delete drops the bubble, its outbox entry and its local
 * files. A send whose files were lost to a reload keeps its own Remove. Pure.
 */
export function canDiscardFailed(
  message: Pick<ThreadMessage, 'mine' | 'state' | 'filesMissing'>,
): boolean {
  return message.mine && message.state === 'failed' && message.filesMissing !== true;
}

/**
 * Whether a failed own send offers Retry: not when the server or the upload
 * Worker refused it for good (a permanent class: too large, unsupported type,
 * contents mismatch, virus, other non-retryable 4xx). Pure.
 */
export function canRetryFailed(message: Pick<ThreadMessage, 'refusal'>): boolean {
  return message.refusal === undefined;
}

/** The failed line's text actions: the shared 44px Button, the bad token for Delete. */
const FAILED_ACTION_CLASS = 'min-w-11';

/**
 * The line under a failed own text send: "Not sent" (announced), then Retry
 * and Delete beside it. Hook-free.
 */
export function FailedActions(props: {
  onRetry?: () => void;
  onDelete?: () => void;
  /** A permanent refusal's reason in plain words: shown, and Retry is never offered. */
  refusal?: string;
}): ReactElement {
  const refused = props.refusal !== undefined;
  return (
    <div data-failed-actions="" className="flex flex-wrap items-center justify-end gap-1">
      <FailedLine status="failed" />
      {refused ? (
        <span data-failed-reason="" className={cn('text-fg-2', BUBBLE_META_TYPE)}>
          {props.refusal}
        </span>
      ) : null}
      {props.onRetry !== undefined && !refused ? (
        <Button
          type="button"
          variant="link"
          data-failed-line-retry=""
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            props.onRetry?.();
          }}
          className={FAILED_ACTION_CLASS}
        >
          Retry
        </Button>
      ) : null}
      {props.onDelete !== undefined ? (
        <PressableRow
          inline
          type="button"
          data-failed-delete=""
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            props.onDelete?.();
          }}
          // A PressableRow, not a ghost Button: the bad ink and 8px sides need
          // no override of a Button variant.
          className={cn(
            FAILED_ACTION_CLASS,
            'flex h-11 items-center justify-center px-2 text-base font-medium text-bad',
          )}
        >
          Delete
        </PressableRow>
      ) : null}
    </div>
  );
}

/** Where a bubble sits in its run and which size table draws it. */
export interface BubbleShape {
  mine: boolean;
  /** First bubble of its run. */
  head: boolean;
  /** Last bubble of its run. */
  tail: boolean;
  layout: ChatLayout;
}

/**
 * The sender-side tail corner. Touch: 18px radius, the 4px corner at the
 * bottom on the last bubble of a run. Laptop: 12px radius, the square corner
 * at the top on the first bubble of a run; later bubbles are fully rounded.
 */
export function bubbleCorners(shape: BubbleShape): string {
  // L1: no bubble, no tail; the radius is the media frame's (an album's corners).
  return sized(BUBBLE_SHAPE, shape.layout);
}

/**
 * The bubble shell: own on the bubble-own fill (the accent in light, a deeper
 * accent in dark so accent-fg ink clears 4.5:1), peer on panel-2, no border.
 * The radius, padding and tail corner come from the layout's size table. A
 * sending bubble keeps full strength (its clock says it is sending).
 */
export function bubbleClass(
  state: BubbleShape & {
    failed: boolean;
    voiceOnly: boolean;
    /** Image album: 3px padding around the album, at least 240px wide. */
    album?: boolean;
    /**
     * A card-only message: the card IS the bubble (ui/ChatCard draws the fill,
     * radius and light), so this shell keeps only the bubble's behaviour (the
     * press, the focus line on the card's radius, the menu and reactions): no
     * padding, no fill, no light, no tail.
     */
    card?: boolean;
  },
): string {
  if (state.card === true) {
    return cn(
      'group/bubble relative min-w-0 max-w-full focus-visible:lit-focus',
      NO_TOUCH_SELECT,
      sized(BUBBLE_SHAPE, state.layout),
      state.failed && 'border border-bad lit-bad',
    );
  }
  return cn(
    // L1 (8 Nov 2026): no bubble. Text sits on the page in fg, no fill, no
    // tail, no padding; own and peer messages draw the same. max-w-full keeps
    // a nowrap line (the Reply privately quote) inside the column; a 284px
    // plan card shrinks to fit a narrow phone column.
    'group/bubble relative min-w-0 max-w-full text-fg focus-visible:lit-focus',
    NO_TOUCH_SELECT,
    state.album === true && 'min-w-60',
    // A voice note keeps its own player frame (a hairline card).
    state.voiceOnly &&
      cn('min-w-56 border border-border', bubbleCorners(state), sized(BUBBLE_PAD, state.layout)),
  );
}

/**
 * A deleted message: one grey line in the message layout (L1, no bubble shell
 * or light) in secondary ink
 * (fg-3). Its text takes the body size (italic) and its time the normal meta
 * (TombstoneBubble). One height always: one line, never wrapping (the label
 * truncates), the time in flow on the right, so it is exactly as tall as a
 * one-line text bubble. Focusable for its one-row menu (Delete for me).
 */
export function tombstoneClass(shape: BubbleShape): string {
  return cn(
    // L1: one grey italic line in the message layout; no bubble.
    'relative flex min-w-0 max-w-full items-center gap-2 whitespace-nowrap rounded-lg text-fg-3 focus-visible:lit-focus',
    NO_TOUCH_SELECT,
    sized(BUBBLE_BODY_TYPE, shape.layout),
  );
}

/** The tombstone's one menu row. */
export const DELETE_FOR_ME_ROW = 'Delete for me';

/**
 * A tombstone's bubble and its one-row menu (ui/ActionMenu: a sheet on a
 * phone, a popover on a laptop): long-press, right-click, Shift+F10 or the
 * ContextMenu key open "Delete for me". Without `onDeleteForMe` it is inert.
 */
function TombstoneBubble(props: {
  className: string;
  label: string;
  onDeleteForMe?: (() => void) | undefined;
  /** The row's swipe slides this box (a rubber band: nothing fires on a tombstone). */
  sliderRef?: Ref<HTMLDivElement> | undefined;
  children: ReactNode;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const onDeleteForMe = props.onDeleteForMe;
  const enabled = onDeleteForMe !== undefined;
  const press = useLongPress(() => {
    if (enabled) setOpen(true);
  });
  const bubble = (
    <div
      ref={props.sliderRef}
      data-bubble=""
      data-tombstone=""
      data-testid="tombstone"
      role="group"
      aria-label={props.label}
      className={cn(props.className, enabled && 'focus-visible:lit-focus')}
      {...(enabled
        ? {
            tabIndex: 0,
            'aria-haspopup': 'menu' as const,
            ...press.handlers,
            onContextMenu: (event: { preventDefault: () => void }) => {
              event.preventDefault();
              press.cancel();
              setOpen(true);
            },
            onKeyDown: (event: { key: string; shiftKey: boolean; preventDefault: () => void }) => {
              if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
              event.preventDefault();
              setOpen(true);
            },
          }
        : {})}
    >
      {props.children}
    </div>
  );
  if (onDeleteForMe === undefined) return bubble;
  return (
    <>
      {bubble}
      <ActionMenu
        title="Message actions"
        trigger={null}
        open={open}
        onOpenChange={setOpen}
        items={[
          {
            id: 'delete-for-me',
            label: DELETE_FOR_ME_ROW,
            icon: IconTrash,
            tone: 'danger',
            onSelect: onDeleteForMe,
          },
        ]}
      />
    </>
  );
}

/**
 * A link card in a message. Touch (12 Nov 2026): on the message's text column
 * (64 on a phone, no pull: rows have no bubble now), 4 under the name like a
 * stacked line; on a phone it fills the column to the 16 right edge, like a
 * post or plan card (CHAT_CARD_WIDTH). Laptop: as before.
 */
const LINK_CARD_INSET: ChatSize = {
  touch: 'mt-1 mb-2 w-64 max-w-full max-md:w-full',
  laptop: '-mx-1 -mt-1 mb-2 w-64 max-w-[calc(100%+8px)]',
};

/** Cancel the native default (the touch contextmenu on rows). */
export function preventDefault(event: { preventDefault: () => void }): void {
  event.preventDefault();
}

/**
 * Selection mode's static check column: every row (tombstones included, so
 * the sides stay aligned) makes room for the 44px circle at its left. No
 * transition: the column appears at once.
 */
export const SELECTION_ROW_OFFSET = 'relative pl-15';

/** Where the check circle (or lock) sits: the row's left column, vertically centred. */
export const SELECTION_CHECK_SLOT = 'absolute left-4 top-1/2 flex -translate-y-1/2';

/** A checked row's layer: the one selected look (lit-selected) across the full row, never opacity. */
export const SELECTED_ROW_TINT =
  'pointer-events-none absolute inset-0 -z-raised border-y lit-selected';

/** What a bubble needs to make its @mentions tappable. */
export interface BubbleMentions {
  /** The DM's other person (kept for the row memo; their mention opens the card too). */
  peerUserId: string | null;
  /** Open the shared person card for the mentioned person, anchored to the tapped name. */
  onOpen: (hint: PersonCardHint, el: HTMLElement) => void;
}

/** How one body draws its mentions. */
export interface MentionRenderContext {
  nameOf: NameOf;
  viewerUserId: string | null;
  /** Absent: every mention is inert (selection mode, previews). */
  mentions?: BubbleMentions | undefined;
  /**
   * Whether this message mentions me (mentionsMe): only then does a token of
   * me or "@all" sit on the mention-of-me tint. Absent is the same as false.
   */
  mentionedMe?: boolean;
  /** A search jump's words: matched words in the text runs draw as <mark>. */
  highlight?: readonly string[];
}

/**
 * Whether a message mentions me, for the "mentioned you" tint: its stored
 * mentions (server-expanded, "@all" recipients included) list my id. A forward
 * (mentions null) never does. A live row not read from Postgres yet reads as
 * the server will store it: not a forward, and my token, or "@all" in a group.
 * My own messages never do. Pure.
 */
export function mentionsMe(
  message: Pick<ThreadMessage, 'body' | 'mine' | 'mentions' | 'forwarded'>,
  viewerUserId: string | null,
  isGroup: boolean,
): boolean {
  if (viewerUserId === null || message.mine) return false;
  const me = viewerUserId.toLowerCase();
  if (message.mentions !== undefined) return message.mentions?.includes(me) === true;
  if (message.forwarded === true) return false;
  return mentionIds(message.body).includes(me) || (isGroup && mentionsAll(message.body));
}

/**
 * A mention's ink in a message, always bold: accent-hover (others' mentions,
 * unchanged). L8 (8 Nov 2026): a mention of me is the bold name in ink (fg) on
 * a stronger tint, fg at 12%, inline, no outline; the radius is rounded-sm
 * (6, the highlight token: there is no 4px radius token). `mine` is kept for
 * callers; with no own bubble since L1 every row passes false. Tokens only, so
 * light and dark stay at parity.
 */
/**
 * A message head's name line. From 768 up: one block line that truncates
 * whole. Under 768: a baseline row, so the name is the part that gives way.
 */
export const SENDER_LINE_CLASS =
  'block min-w-0 max-w-full truncate max-md:flex max-md:items-baseline';
/** The name's box in that row (the person trigger stays inline inside it): it shrinks and ends in "…". */
export const SENDER_NAME_GIVES = 'max-md:min-w-0 max-md:truncate';

export const MENTION_ME_PEER = 'bg-fg/[.12] text-fg';

export function mentionClass(mine: boolean, self: boolean): string {
  return cn(
    'whitespace-nowrap font-semibold',
    self ? cn('rounded-sm px-1', MENTION_ME_PEER) : mine ? 'text-accent-fg' : 'text-accent-hover',
  );
}

/**
 * A 44x44 hit area centred on the inline name, without changing the line box:
 * the PressableRow is 44 tall (its min-h), inline-flex with the name centred,
 * and -13px margins top and bottom keep its line share at 18px (under the 19
 * and 22px body lines); the pseudo element keeps the 44px width floor.
 */
const MENTION_HIT =
  "relative inline-flex -my-3 items-center before:absolute before:left-1/2 before:top-1/2 before:h-11 before:w-full before:min-w-11 before:-translate-x-1/2 before:-translate-y-1/2 before:content-['']";

/**
 * The thread's mention name lookup: the batched profiles, then this
 * workspace's mention registry. A former member (read without an active
 * membership) resolves to nothing, so their mention reads "@Former member"
 * and is inert; one whose membership read failed (unconfirmed) or whose name is
 * not loaded yet renders nothing extra, until a read confirms them.
 */
/** A loaded profile's mention handle (@username, else name); undefined when not loaded. */
function mentionHandleOf(profile: ChatProfile | undefined): string | undefined {
  return profile === undefined ? undefined : mentionHandle(profile);
}

export function profileNameOf(
  profiles: Map<string, ChatProfile>,
  workspaceId: string | null,
): NameOf {
  return withFormer(
    (userId) =>
      isFormerMember(workspaceId, userId) || isUnconfirmedMember(workspaceId, userId)
        ? undefined
        : (mentionHandleOf(profiles.get(userId)) ?? knownMentionName(workspaceId, userId)),
    workspaceId,
  );
}

/**
 * A message body with its @[uuid] tokens drawn as "@Name" (never the raw
 * token); the text between keeps renderMessageBody's links. A mention of a
 * person (me, the DM's other person and a former member included) is a button
 * that opens the shared person card; "@all" and a name not resolved yet stay inert.
 */
export function renderBodyWithMentions(
  body: string,
  mine: boolean,
  ctx: MentionRenderContext,
): ReactNode[] {
  const highlight = ctx.highlight ?? [];
  // No mention: exactly the plain renderer's runs (formatting included).
  if (splitMentions(body).every((segment) => segment.kind === 'text')) {
    return renderMessageBody(body, mine, currentOrigin(), highlight);
  }
  // Blocks, then formatting, are the outer layers; mentions and links render
  // inside each styled segment, so *hey @[id]* is a bold mention and a list
  // item can hold one.
  return renderRich(body, (text) => mentionRuns(text, mine, ctx, highlight));
}

/** One styled segment's text: mention tokens as "@Name", links between. */
function mentionRuns(
  text: string,
  mine: boolean,
  ctx: MentionRenderContext,
  highlight: readonly string[],
): ReactNode[] {
  return splitMentions(text).map((segment, i) => {
    if (segment.kind === 'text') {
      return (
        <Fragment key={`part-${i}`}>
          {renderBodyLinks(segment.text, mine, currentOrigin(), highlight)}
        </Fragment>
      );
    }
    const id = segment.userId;
    const everyone = id === ALL_MENTION;
    const self = id === ctx.viewerUserId;
    // The tint follows the stored mentions (mentionedMe), never the token alone:
    // "@all" or my name is a mention of me only when the message mentions me.
    const tint = !mine && ctx.mentionedMe === true && (self || everyone);
    const name = mentionLabel(id, ctx.nameOf);
    // A searched word inside the mention is marked too (the shared highlight).
    const label = highlight.length > 0 ? highlightNodes(name, highlight) : name;
    const open = ctx.mentions;
    // A confirmed former member opens the card in its "no longer here" state; a
    // name not resolved yet (an empty label) has no one to show.
    const former = ctx.nameOf.former?.(id) === true;
    const known = ctx.nameOf(id) !== undefined || former;
    if (open === undefined || everyone || !known) {
      return (
        <span key={`part-${i}`} data-mention={id} className={mentionClass(mine, tint)}>
          {label}
        </span>
      );
    }
    return (
      <PressableRow
        key={`part-${i}`}
        inline
        type="button"
        data-mention={id}
        data-msg-link=""
        data-person-trigger={id}
        onClick={(event: MouseEvent<HTMLElement>) => {
          event.stopPropagation();
          open.onOpen({ userId: id, ...(former ? { former: true } : {}) }, event.currentTarget);
        }}
        className={cn(mentionClass(mine, false), MENTION_HIT)}
      >
        {/* My own mention keeps its highlight on the name; the control keeps its radius. */}
        {tint ? <span className={mentionClass(mine, true)}>{label}</span> : label}
      </PressableRow>
    );
  });
}

/** Whether a pointer went down on a link in the body: the link handles the tap. */
export function isLinkTarget(target: unknown): boolean {
  return (
    typeof Element !== 'undefined' &&
    target instanceof Element &&
    target.closest('[data-msg-link]') !== null
  );
}

/** Message body text on the layout's type scale; the ink comes from the bubble (fg or accent-fg). */
export function bodyText(layout: ChatLayout): string {
  return cn('whitespace-pre-wrap [overflow-wrap:anywhere]', sized(BUBBLE_BODY_TYPE, layout));
}

/**
 * Where a bubble's meta goes: after the text of a text-only message (inline),
 * on the pill over a bare image album (images only: no caption, no files, no
 * cards), else in its own row under the content (voice, files, cards, and any
 * media with a caption). Videos render as file rows, so they take the row. Pure.
 */
export function metaPlacement(
  message: Pick<ThreadMessage, 'body' | 'attachments' | 'sharedPostIds' | 'sharedBriefIds'> &
    Partial<Pick<ThreadMessage, 'sharedPlanIds' | 'sharedPlanItemIds'>>,
): MetaPlacement {
  const hasBody = message.body.trim() !== '';
  const hasCards =
    message.sharedPostIds.length > 0 ||
    message.sharedBriefIds.length > 0 ||
    (message.sharedPlanIds ?? []).length > 0 ||
    (message.sharedPlanItemIds ?? []).length > 0;
  if (hasCards) return 'row';
  if (message.attachments.length === 0) return hasBody ? 'inline' : 'row';
  const { images, others } = splitAlbum(message.attachments);
  return !hasBody && images.length > 0 && others.length === 0 ? 'pill' : 'row';
}

/** The kinds of shared card a message carries, in the order the bubble draws them. */
export type CardKind = 'post' | 'brief' | 'plan' | 'idea';

/** The last card kind a message draws (its time goes in that group's last card); null for none. Pure. */
export function lastCardKind(
  message: Pick<ThreadMessage, 'sharedPostIds' | 'sharedBriefIds'> &
    Partial<Pick<ThreadMessage, 'sharedPlanIds' | 'sharedPlanItemIds'>>,
): CardKind | null {
  if ((message.sharedPlanItemIds ?? []).length > 0) return 'idea';
  if ((message.sharedPlanIds ?? []).length > 0) return 'plan';
  if (message.sharedBriefIds.length > 0) return 'brief';
  if (message.sharedPostIds.length > 0) return 'post';
  return null;
}

/**
 * A card-only message: shared cards and nothing else the bubble would draw
 * around them (no text, files, reply or private-reply quote, Forwarded or
 * saved-from line, removed-files line, or post chip). Its card IS
 * the bubble: no wrapper bubble fill, and its time and tick sit inside the
 * last card (ui/ChatCard's time slot). Pure.
 */
export function isCardOnly(
  message: Pick<
    ThreadMessage,
    | 'body'
    | 'attachments'
    | 'sharedPostIds'
    | 'sharedBriefIds'
    | 'reply'
    | 'forwarded'
    | 'privateReply'
    | 'removedFiles'
  > &
    Partial<Pick<ThreadMessage, 'sharedPlanIds' | 'sharedPlanItemIds'>>,
  around: { chip: boolean },
): boolean {
  return (
    lastCardKind(message) !== null &&
    message.body.trim() === '' &&
    message.attachments.length === 0 &&
    message.reply === null &&
    message.privateReply == null &&
    message.forwarded !== true &&
    message.removedFiles === undefined &&
    !around.chip
  );
}

/** The small chevron in a bubble's top-right corner (laptop hover). */
function ChevronGlyph(): ReactElement {
  return <IconChevronDown size={ICON_SIZE.inline} />;
}

/** The smiley beside a bubble (laptop hover): opens the reactions row. */
function SmileyGlyph(): ReactElement {
  return <IconSmile size={ICON_SIZE.control} />;
}

/**
 * A failed own send's alert: a 44x44 hit area outside the bubble on the side
 * away from the tail (left of own bubbles), vertically centred on it, the "!"
 * in the bad token on the page background.
 */
/** On a PressableRow (inline): 44 tall, a 44px width floor, the glyph centred in bad. */
export const FAILED_RETRY_CLASS =
  'absolute left-full top-1/2 ml-1 flex h-11 min-w-11 -translate-y-1/2 items-center justify-center text-bad';

/**
 * A row's piece of the rail (none for a left root card no member follows yet,
 * which still sits shifted) and its geometry; absent off threads and while
 * selecting.
 */
export interface RowRail {
  role: RailRole | null;
  geometry: RowGeometry;
}

/** How far a row's tick reaches up: through the row's own top padding. */
function railTop(head: boolean, afterLabel: boolean): string {
  if (!head) return '-top-0.5';
  return afterLabel ? 'top-0' : '-top-3';
}

/**
 * The root's rail reaches down to the row's bottom edge: past the bubble's box
 * through the reaction chip row under it when there is one (8 + the 32 pill + 8).
 */
function railBottom(hasReactions: boolean): string {
  return hasReactions ? '-bottom-12' : 'bottom-0';
}

/**
 * A row's left side on the rail: its padding (shifted 14px for a member or a
 * left root card, 29px for the thread view's root), a positioning box for the
 * through line, and on a right-aligned row the size container the tick
 * measures its reach against in CSS. Off the rail: today's padding.
 */
export function railRowClass(rail: RowRail | undefined, mine: boolean): string {
  if (rail === undefined) return 'px-4';
  return cn('relative pr-4', rail.geometry.padLeft, mine && '[container-type:inline-size]');
}

/** The rail piece a row's target carries: a tick for a member, the elbow for a root card. */
function railPiece(
  rail: RowRail & { role: RailRole },
  edge: { head: boolean; afterLabel: boolean; hasReactions: boolean },
): ReactElement {
  return rail.role === 'root' ? (
    <RailElbow reach={rail.geometry.reach} bottom={railBottom(edge.hasReactions)} />
  ) : (
    <RailTick reach={rail.geometry.reach} top={railTop(edge.head, edge.afterLabel)} />
  );
}

/**
 * The bubble with its rail target box: on the rail the bubble sits in a
 * positioning box (never transformed by a swipe) that carries the tick or
 * elbow at the bubble's middle; off it, the bubble alone.
 */
function withRailBox(
  bubble: ReactElement,
  rail: RowRail | undefined,
  edge: { head: boolean; afterLabel: boolean; hasReactions: boolean },
): ReactElement {
  const role = rail?.role ?? null;
  if (rail === undefined || role === null || rail.geometry.target !== 'bubble') return bubble;
  return (
    <div data-rail-target="" className="relative min-w-0 max-w-full">
      {railPiece({ ...rail, role }, edge)}
      {bubble}
    </div>
  );
}

/** The sender photo, carrying the member's tick on the rail (a group run head). */
function withRailPhoto(
  photo: ReactElement,
  rail: RowRail | undefined,
  edge: { head: boolean; afterLabel: boolean; hasReactions: boolean },
): ReactElement {
  const role = rail?.role ?? null;
  if (rail === undefined || role === null || rail.geometry.target !== 'photo') return photo;
  return (
    <span data-rail-target="" className="relative flex shrink-0">
      {railPiece({ ...rail, role }, edge)}
      {photo}
    </span>
  );
}

/**
 * One message row in the thread. Own messages (`message.mine`) right-align on
 * the solid accent, no avatar and no sender name. Peer messages left-align; in a
 * group the run head carries the avatar + sender name above the bubble, while
 * tucked replies reserve an aligned gutter. Every bubble carries its meta at the
 * bottom-right inside it ("edited", the time, and on own messages the tick),
 * after the text (an invisible spacer keeps the last line clear of it), as a
 * pill over a bare album, or in its own row under other content. A failed own
 * send reads "Not sent" under the bubble with a 44px red alert (Retry) beside
 * it, away from the tail; reactions sit under the message as ui/ReactionChips
 * on its text column (8 below it), the smiley pill last.
 * On a laptop (fine pointer) a chevron fades in at the bubble's top-right and a
 * smiley beside it; touch keeps long-press and swipe. Rows in a run sit 2px
 * apart, runs 10px. Pure and hook-free: long-press wiring is owned by the
 * MessageRow wrapper and passed in via `press`, so the unit test can call this
 * directly. All colours are design tokens, so light and dark stay at parity.
 */
/** What inside a bubble keeps its own tap: controls, media, links, mentions, cards, chips. */
export const BUBBLE_TAP_KEEP =
  'button, a, input, textarea, select, label, [role="button"], [role="link"], [role="menuitem"], audio, video, img, [data-msg-link], [data-mention], [data-post-card], [data-plan-card], [data-brief-card], [data-idea-card], [data-card], [data-voice-note], [data-voice-control], [data-chip], [contenteditable="true"]';

/** A bubble click opens its thread: not consumed, not selecting, not on a kept child or selected text. */
export function bubbleTapOpens(input: {
  event: { defaultPrevented: boolean; target: EventTarget | null; currentTarget: EventTarget };
  selecting: boolean;
  onTapOpen: (() => void) | undefined;
}): boolean {
  const { event } = input;
  if (event.defaultPrevented || input.selecting || input.onTapOpen === undefined) return false;
  const target = event.target as Element | null;
  const keep = typeof target?.closest === 'function' ? target.closest(BUBBLE_TAP_KEEP) : null;
  if (keep !== null && keep !== event.currentTarget) return false;
  const picked = typeof window !== 'undefined' ? window.getSelection?.()?.toString() : '';
  return picked === undefined || picked === '';
}

export function MessageBubble(props: {
  message: ThreadMessage;
  /** Notes only: a saved copy's "Saved from" line replaces "Forwarded". */
  savedFrom?: SavedFromWiring | null;
  /** A search jump's words; absent or [] draws no marks. */
  searchWords?: readonly string[];
  profiles: Map<string, ChatProfile>;
  cache: PresignCache;
  presignEnabled: boolean;
  showTicks: boolean;
  isGroup: boolean;
  head: boolean;
  /** Last bubble of its run: the touch tail corner. */
  tail: boolean;
  /** Directly under a DateLine, which carries the gap: no top padding. */
  afterLabel?: boolean;
  /** For tests: the zone the meta time renders in (the app passes none: device zone). */
  timeZone?: string | undefined;
  /** The size table (touch or laptop) the bubble is drawn with. */
  layout: ChatLayout;
  /** The viewer's user id: a quote of their own deleted message reads "You deleted". */
  viewerUserId?: string | undefined;
  /** Tappable @mentions; absent draws them inert. */
  mentions?: BubbleMentions | undefined;
  /** The open workspace: mention names resolve from its registry only. */
  workspaceId?: string | null | undefined;
  /** The in-bubble meta; computed from the message when absent. */
  meta?: BubbleMeta;
  /** The reaction chips' taps (toggle, the drawer, who reacted); absent: the chips draw inert. */
  reactionChips?: BubbleReactionChips | undefined;
  onRetry?: (messageId: string) => void;
  /** Deletes this failed own send (the "Not sent" line's Delete). */
  onDiscard?: (messageId: string) => void;
  /** A tombstone's one menu row: hide it for the viewer (Delete for me); absent: inert. */
  onDeleteForMe?: (() => void) | undefined;
  /** Cancels this own send while its files upload (the UploadRing's stop square). */
  onCancelUpload?: (messageId: string) => void;
  onJumpToMessage?: (messageId: string) => void;
  /** A Reply privately quote tapped: open where it points; absent: the quote is static. */
  onOpenPrivateReply?: (reply: PrivateReply) => void;
  /** Present while selection mode is on. */
  selection?: RowSelection;
  /**
   * The menu's Select is active on this bubble: its body alone takes text
   * selection and the native callout; no hold, menu, swipe or key-open.
   */
  selectingText?: boolean;
  /** Tap on an album tile: open the thread's image viewer at that index. */
  onOpenImage?: (index: number) => void;
  /** The post chip and the cards' talk-about / thread hooks. */
  postRefs?: BubblePostRefs | undefined;
  /** A member of a card's thread: the rail stands in for its quote and chip (selection too). */
  threadMember?: boolean | undefined;
  /**
   * The thread view's rows (9 Nov 2026): 'root' on laptop = 40 photo with the
   * name over the time beside it and the text full width below on the 16
   * gutter; 'root' on phone (12 Nov 2026) = a normal head row (36 photo, the
   * name line, text on the 64 column), still carrying the add-reaction key;
   * 'reply' = 32 photo, 12 to the name and text (x60), 16 between heads.
   * Absent: the main chat's row (photo 32, 8 gap), unchanged.
   */
  threadPlace?: 'root' | 'reply' | undefined;
  /**
   * The head's time (10 Nov 2026): 'clock' ("2:54 PM", default, every chat
   * and thread view) or 'day' (threadWhen 'relative', "Yesterday at 12:17 PM";
   * the Threads list's first message of each day). Ignored when `meta` is passed.
   */
  timeLabel?: 'clock' | 'day' | undefined;
  /** The row's piece of the thread rail; absent off the rail and while selecting. */
  rail?: RowRail | undefined;
  /** A voice-only bubble: the voice note right below from the same sender. */
  nextVoiceId?: string | null | undefined;
  /** The group sender card's source (PersonSourceContext, read by the row); absent: none. */
  personSource?: ((message: ThreadMessage) => PrivateReplyDraft | null) | null | undefined;
  /** A received voice-only bubble: run tap-to-transcribe (the Transcribe link). */
  onTranscribe?: (() => void) | undefined;
  /** The quoted message when it is loaded in the thread (the quote reads its media). */
  quoted?: ThreadMessage | undefined;
  bubbleRef?: Ref<HTMLDivElement>;
  /** The row; in selection mode its taps and holds are the selection gesture's. */
  rowRef?: Ref<HTMLLIElement>;
  /** A tap on the body opens the thread; absent when reply is blocked or selecting. */
  onTapOpen?: (() => void) | undefined;
  /** Swipe right to reply, left to delete (touch and pen); off while selecting. */
  swipe?: BubbleSwipe;
  /**
   * Extra data-* hooks on the row (a plan comment's ids and marks); chat's own
   * hooks win over them. Absent: none (chat passes none).
   */
  rowData?: { [hook: `data-${string}`]: string | undefined } | undefined;
  /**
   * One line at the top inside the bubble, above the body (a plan note's
   * "Creators only"). Absent: none (chat passes none).
   */
  topLine?: ReactNode;
  /**
   * One line at the end inside the bubble, under the body (a comment's task
   * tag). Absent: none (chat passes none).
   */
  bottomLine?: ReactNode;
  press?: {
    handlers: BubblePointerHandlers;
    onContextMenu: (event: MouseEvent) => void;
    consumeClick: () => boolean;
    /** A coarse (touch-first) pointer: the row suppresses the native contextmenu. */
    coarse?: boolean;
    /** Keyboard open (Enter / Space / Shift+F10), anchored to the bubble. */
    onKeyOpen: () => void;
    /** Fine pointer only: the in-bubble chevron, opening the full menu. */
    onMore?: () => void;
    /** Fine pointer only: the smiley beside the bubble, opening the reactions row. */
    onReact?: () => void;
  };
}): ReactElement {
  const { message, profiles, cache, presignEnabled, showTicks, isGroup, head, tail } = props;
  // Ideas: the row's own ids (the open bundle's rows carry them too).
  const sharedIdeaIds = message.sharedPlanItemIds ?? NO_PLAN_IDS;
  // Notes: a saved copy names its source instead of "Forwarded".
  const savedFrom = props.savedFrom ?? null;
  const savedLine =
    savedFrom !== null && message.forwarded === true ? savedFrom.lineFor(message) : null;
  const { bubbleRef, press, timeZone, layout } = props;
  const mine = message.mine;
  const reply = message.reply;
  const name = senderName(message, profiles);
  // L1: everyone on the left. Every group head (own included, DMs and notes
  // too) carries the 32 square photo and the name + time line; a
  // continuation keeps the photo's gutter so its body aligns under the first.
  const showMeta = head;
  const gutter = !head;
  // The thread view's root (always its list's first row, so a head) and replies.
  // rootPlace is the root's behaviour (the add-reaction key, the chips' end
  // spacing); rootStack is its stacked geometry, laptop only: on phone the
  // root is a normal head row on the message family's 64 text column.
  const rootPlace = props.threadPlace === 'root' && head;
  const rootStack = rootPlace && layout === 'laptop';
  const replyPlace = props.threadPlace === 'reply';
  const hasReactions = message.reactions.length > 0;
  // The chips take a reaction: a recorded row, wired, not in selection mode.
  const canReactChips =
    props.reactionChips !== undefined && props.selection === undefined && message.state === 'sent';
  // Thread polish 2: a thread's main message always shows the add-reaction
  // key, even with no reactions (a deleted root is a tombstone: none).
  const rootAddKey = rootPlace && canReactChips && message.deleted !== true;
  const failed = message.state === 'failed';
  const selection = props.selection;
  const voiceOnly = isVoiceOnly(message);
  const album = hasAlbum(message);
  // Album bubbles pad 3px around the album; the rest keeps the text inset.
  // Phone (12 Nov 2026): no side inset, so what sits above photos starts on
  // the message text column (64) with the name.
  const albumInset = cn('px-2 pt-1', PHONE_PAD_FLUSH);
  const hasBody = message.body.trim() !== '';
  const sharedPlanIds = message.sharedPlanIds ?? NO_PLAN_IDS;
  const hasCards =
    message.sharedPostIds.length > 0 ||
    message.sharedBriefIds.length > 0 ||
    sharedPlanIds.length > 0 ||
    sharedIdeaIds.length > 0;
  const textOnly =
    message.body.trim() !== '' &&
    message.attachments.length === 0 &&
    message.sharedPostIds.length === 0 &&
    message.sharedBriefIds.length === 0 &&
    sharedPlanIds.length === 0 &&
    sharedIdeaIds.length === 0;
  const clockMeta = props.meta ?? bubbleMeta(message, timeZone, { showTicks });
  const fullMeta =
    props.meta === undefined && props.timeLabel === 'day' && clockMeta.time !== ''
      ? {
          ...clockMeta,
          time: threadWhen(messageTimeSource(message), 'relative', new Date(), timeZone),
        }
      : clockMeta;
  // The name line carries the time (and own send state) on a head.
  const meta = bodyMetaOf(fullMeta, head);
  const metaEmpty = metaIsEmpty(meta);
  const placement = metaPlacement(message);
  // Selecting this bubble's text: the native selection owns its gestures.
  const textSelect = selection === undefined && props.selectingText === true;
  const pressOn = selection === undefined && !textSelect;
  const onMore = pressOn ? press?.onMore : undefined;
  const onReact = pressOn && message.state === 'sent' ? press?.onReact : undefined;
  // Only a recorded message takes a reply: sending and failed bubbles never swipe.
  const swipe = pressOn && message.state === 'sent' ? props.swipe : undefined;
  const chip = props.postRefs?.chip;
  const cardRefs = cardRefsFor(message.id, selection, props.postRefs);
  // A card-only message: the card IS the bubble (the shell below keeps only
  // the bubble's behaviour), and the time and tick sit inside its last card.
  const cardOnly = isCardOnly(message, {
    chip: props.threadMember !== true && chip?.kind === 'chip' && message.parentDeleted !== true,
  });
  const lastCard = cardOnly ? lastCardKind(message) : null;
  const cardPlace = (kind: CardKind): { inBubble: boolean; cardMeta?: ReactNode } =>
    !cardOnly
      ? { inBubble: true }
      : kind === lastCard
        ? {
            inBubble: false,
            ...(metaEmpty
              ? {}
              : { cardMeta: <BubbleMetaView meta={meta} mine={false} placement="card" /> }),
          }
        : { inBubble: false };
  // An own send still uploading can be stopped with the ring's stop square; once
  // recorded, refused or missing its files it cannot.
  const onCancelUpload = props.onCancelUpload;
  const cancelUpload =
    mine &&
    message.state === 'sending' &&
    message.filesMissing !== true &&
    onCancelUpload !== undefined
      ? () => onCancelUpload(message.id)
      : undefined;
  const column = cn('flex min-w-0 flex-1 flex-col items-start gap-1');
  const shape: BubbleShape = { mine: false, head, tail, layout };
  const selecting = selection !== undefined;
  // The sender's photo and name open the person card (never while selecting:
  // a tap there toggles the row).
  const senderId = !selecting && !mine ? message.senderUserId : null;
  const senderAvatar = senderAvatarProps(message, profiles);
  const personSource = props.personSource ?? null;
  const asPerson = (
    node: ReactElement,
    display: 'inline' | 'block',
    className?: string,
  ): ReactElement =>
    senderId !== null ? (
      <PersonTrigger
        userId={senderId}
        {...(className !== undefined ? { className } : {})}
        name={profiles.has(senderId) ? name : null}
        avatarUrl={profiles.get(senderId)?.avatarUrl ?? null}
        display={display}
        {...(personSource !== null ? { source: () => personSource(message) } : {})}
      >
        {node}
      </PersonTrigger>
    ) : (
      node
    );
  const headTick = mine ? metaTick(fullMeta.status) : null;
  const senderLine = rootStack ? null : showMeta ? (
    // One block line, its parts inline: the name trigger stays an inline
    // control in running text (its hit area is the trigger's 44 box), and the
    // whole line truncates. Phone (12 Nov 2026): the parts sit on one
    // baseline as a row, so a long name gives way with "…" and the time
    // ("Today at 8:00 AM") and the tick are never cut.
    <span data-sender-line="" className={SENDER_LINE_CLASS}>
      {/* The row item that gives way; the name trigger inside it stays an
          inline control in running text (never a block-level button). */}
      <span data-sender-name-box="" className={SENDER_NAME_GIVES}>
        {asPerson(
          <span data-sender-name="" className={cn('text-fg', sized(SENDER_NAME_TYPE, layout))}>
            {headerName(message, profiles)}
          </span>,
          'inline',
        )}
      </span>
      {fullMeta.time !== '' ? (
        <span
          aria-hidden="true"
          data-sender-time=""
          className={cn('ml-2 text-fg-3 max-md:shrink-0', SENDER_TIME_TYPE)}
        >
          {fullMeta.time}
        </span>
      ) : null}
      {headTick !== null ? (
        <span className="ml-1 inline-flex align-middle text-fg-3 max-md:shrink-0 max-md:self-center">
          <MetaGlyph status={headTick} />
        </span>
      ) : null}
    </span>
  ) : null;
  // The rail is never drawn while selecting: the row keeps today's place.
  const rail = selecting ? undefined : props.rail;
  const railEdge = {
    head,
    afterLabel: props.afterLabel === true,
    hasReactions: hasReactions || rootAddKey,
  };
  const threadMember = props.threadMember === true;
  const rowClass = cn(
    'group flex items-start',
    // Photo to text: 12 touch, 8 laptop (the message family).
    sized(MESSAGE_PHOTO_GAP, layout),
    railRowClass(rail, false),
    NO_TOUCH_SELECT,
    head ? (props.afterLabel === true ? 'pt-0' : replyPlace ? 'pt-4' : 'pt-3') : 'pt-1',
    // Thread view, laptop only: the root stacks its head over the full-width
    // text (head-to-text step 8); on phone it is a head row like any other.
    // Replies sit 12 from the photo.
    rootStack ? 'relative flex-col items-stretch gap-2' : 'flex-row',
    replyPlace && 'gap-3',
    // Selection mode: a static 44px check column at the left of every row.
    selecting && SELECTION_ROW_OFFSET,
  );
  const photo = rootStack ? (
    // The thread view's root head, laptop only: 40 photo, 12 to the name over the time.
    <div data-thread-root-head="" className="flex min-w-0 items-center gap-3">
      {asPerson(
        <Avatar name={headerName(message, profiles)} {...senderAvatar} role="row" decorative />,
        'block',
      )}
      <span className="flex min-w-0 flex-col">
        <span data-sender-line="" className="block min-w-0 max-w-full truncate">
          {asPerson(
            <span data-sender-name="" className={cn('text-fg', sized(SENDER_NAME_TYPE, layout))}>
              {headerName(message, profiles)}
            </span>,
            'inline',
          )}
        </span>
        {fullMeta.time !== '' ? (
          <span
            aria-hidden="true"
            data-sender-time=""
            className={cn('block truncate text-fg-3', SENDER_TIME_TYPE)}
          >
            {fullMeta.time}
            {headTick !== null ? (
              <span className="ml-1 inline-flex align-middle">
                <MetaGlyph status={headTick} />
              </span>
            ) : null}
          </span>
        ) : null}
      </span>
    </div>
  ) : showMeta ? (
    withRailPhoto(
      asPerson(
        <Avatar
          name={headerName(message, profiles)}
          {...senderAvatar}
          role={MESSAGE_AVATAR_ROLE[layout]}
          decorative
        />,
        'block',
      ),
      // The phone thread root is a head row now, but it never drew a photo
      // rail piece (its stacked head had none): it still draws none.
      rootPlace ? undefined : rail,
      railEdge,
    )
  ) : null;
  // Rows never show the native menu or callout on a touch-first device.
  const rowContextMenu = press?.coarse === true ? preventDefault : undefined;
  if (message.deleted === true) {
    // A tombstone keeps its side, meta and run grouping; nothing else.
    const tombMeta: BubbleMeta = { time: head ? '' : fullMeta.time, edited: false, status: null };
    // A tombstone rubber-bands under a swipe either way; nothing fires.
    const tombSwipe = selecting ? undefined : props.swipe;
    return (
      <li
        {...props.rowData}
        ref={props.rowRef}
        data-msg-id={message.id}
        data-state={message.state}
        data-deleted=""
        data-thread-root={rootPlace ? '' : undefined}
        className={cn(rowClass, tombSwipe?.handlers !== undefined && SWIPE_ROW_TOUCH)}
        onContextMenu={selecting ? undefined : rowContextMenu}
        {...rowSwipeProps(tombSwipe)}
      >
        {rail?.role === 'middle' ? <RailThrough /> : null}
        {photo}
        {gutter ? (
          <span
            data-photo-spacer=""
            className={cn(sized(MESSAGE_PHOTO_COL, layout), 'shrink-0')}
            aria-hidden="true"
          />
        ) : null}
        <div className={column}>
          {senderLine}
          {withRailBox(
            <TombstoneBubble
              label={`${mine ? 'Your message' : `Message from ${name}`}, deleted, ${bubbleTimeLabel(message, timeZone)}`}
              className={tombstoneClass(shape)}
              onDeleteForMe={selecting ? undefined : props.onDeleteForMe}
              sliderRef={tombSwipe !== undefined ? bubbleRef : undefined}
            >
              <IconBan size={ICON_SIZE.inline} className="shrink-0" />
              {/* One line: the label truncates, never wraps; the time sits in flow on its right.
                  pr-1: the italic's last letter leans past its box; the 4 keeps
                  it inside the clip, so "deleted" never loses its "d". */}
              <span
                data-tombstone-label=""
                className={cn(
                  'min-w-0 truncate whitespace-nowrap pr-1 italic',
                  sized(BUBBLE_BODY_TYPE, layout),
                )}
              >
                {deletedMessageLabel({ mine })}
              </span>
              {metaIsEmpty(tombMeta) ? null : (
                <BubbleMetaView
                  meta={tombMeta}
                  mine={false}
                  placement="inline"
                  className="static ml-2"
                />
              )}
            </TombstoneBubble>,
            rail,
            railEdge,
          )}
        </div>
      </li>
    );
  }
  const checked = selection?.checked === true;
  const parentDeleted = message.parentDeleted === true;
  const spacer = placement === 'inline' && !metaEmpty ? <MetaSpacer meta={meta} /> : null;
  // Files the sender removed: one line where they were (never on a tombstone,
  // which returned above). Above the caption of media, at the files' spot, or
  // above the text when nothing is left beside it.
  const removedLine =
    message.removedFiles !== undefined ? (
      <FilesRemovedLine counts={message.removedFiles} mine={false} layout={layout} />
    ) : null;
  const hasAttachments = message.attachments.length > 0;
  const quotedMine =
    reply !== null && reply.authorUserId !== null && reply.authorUserId === props.viewerUserId;
  // A div: a list or quote in the body is a block (never inside a p).
  const body = (
    <div
      data-msg-body=""
      data-selecting-text={textSelect ? '' : undefined}
      className={cn(bodyText(layout), textSelect && SELECTING_TEXT_BODY)}
    >
      {renderBodyWithMentions(message.body, false, {
        nameOf: profileNameOf(profiles, props.workspaceId ?? null),
        viewerUserId: props.viewerUserId ?? null,
        // Inert while selecting: a mention is plain "@Name" text in the selection.
        mentions: pressOn ? props.mentions : undefined,
        mentionedMe: mentionsMe(message, props.viewerUserId ?? null, isGroup),
        highlight: props.searchWords ?? [],
      })}
      {spacer}
    </div>
  );
  // Only the first external link gets a card (WhatsApp rule), above the text.
  // Links to this app's own pages keep their in-app link and get no card.
  const cardUrl = hasBody ? firstExternalUrl(message.body) : null;
  const linkCard =
    cardUrl !== null ? (
      <LinkPreviewCard
        key={cardUrl}
        url={cardUrl}
        tone="in"
        className={sized(LINK_CARD_INSET, layout)}
      />
    ) : null;
  return (
    <li
      {...props.rowData}
      ref={props.rowRef}
      data-msg-id={message.id}
      data-state={message.state}
      data-selection={selection?.role}
      data-checked={checked ? '' : undefined}
      data-thread-root={rootPlace ? '' : undefined}
      className={cn(
        rowClass,
        checked && 'isolate',
        // The whole row is the swipe's grab area (own rows as freely as others').
        swipe?.handlers !== undefined && SWIPE_ROW_TOUCH,
      )}
      // Selection mode: the whole row is the target, owned by the selection
      // gesture (createSelectionGesture, attached to this row): a tap anywhere
      // (bubble, blank space, the circle) toggles, and nothing inside opens
      // (links, media, cards, voice, chips); a long-press toggles too.
      // Selecting text: the browser's own menu and callout (laptop right-click).
      {...(!pressOn ? {} : { onContextMenu: rowContextMenu })}
      {...rowSwipeProps(swipe)}
    >
      {checked ? (
        <span aria-hidden="true" data-selected-tint="" className={SELECTED_ROW_TINT} />
      ) : null}
      {selection?.role === 'selectable' ? (
        <SelectCheckbox
          checked={selection.checked}
          onToggle={selection.onToggle}
          className={SELECTION_CHECK_SLOT}
        />
      ) : null}
      {rail?.role === 'middle' ? <RailThrough /> : null}
      {photo}
      {gutter ? (
        <span
          data-photo-spacer=""
          className={cn(sized(MESSAGE_PHOTO_COL, layout), 'shrink-0')}
          aria-hidden="true"
        />
      ) : null}
      <div className={cn('relative', column)}>
        {senderLine}
        {swipe !== undefined ? <SwipeReplyIcon iconRef={swipe.iconRef} /> : null}
        {swipe !== undefined ? <SwipeDeleteIcon iconRef={swipe.deleteIconRef} /> : null}
        {withRailBox(
          <div
            ref={bubbleRef}
            data-bubble=""
            data-own={mine ? '' : undefined}
            data-swipe-reply={swipe !== undefined ? '' : undefined}
            role="group"
            tabIndex={0}
            aria-label={`${mine ? 'Your message' : `Message from ${name}`}, ${bubbleTimeLabel(message, timeZone)}`}
            {...(pressOn ? press?.handlers : {})}
            onContextMenu={pressOn ? press?.onContextMenu : undefined}
            onKeyDown={(e: KeyboardEvent<HTMLDivElement>) => {
              if (!pressOn || press === undefined || !keyOpensMenu(e)) return;
              e.preventDefault();
              press.onKeyOpen();
            }}
            onClickCapture={(e) => {
              // The click that trails a long-press or a swipe does nothing more.
              if (press?.consumeClick()) {
                e.preventDefault();
                e.stopPropagation();
              }
            }}
            onClick={(e) => {
              if (
                !bubbleTapOpens({
                  event: e,
                  selecting: selecting || textSelect,
                  onTapOpen: props.onTapOpen,
                })
              )
                return;
              props.onTapOpen?.();
            }}
            className={cn(
              bubbleClass({ ...shape, failed, voiceOnly, album, card: cardOnly }),
              // The browser keeps vertical pans (the list scrolls); a horizontal
              // move is left to the swipe controller.
              swipe !== undefined && SWIPE_ROW_TOUCH,
            )}
          >
            <div className={album ? cn(albumInset, 'empty:hidden') : 'contents'}>
              {message.forwarded === true ? (
                savedFrom !== null ? (
                  savedLine !== null ? (
                    <SavedFromLabel line={savedLine} mine={false} onOpen={savedFrom.onOpen} />
                  ) : null
                ) : (
                  <ForwardedLabel mine={false} />
                )
              ) : null}
              {props.topLine ?? null}
            </div>
            {/* L1: no own fill, so every card draws the same flat card on both sides. */}
            <ChatCardOwn value={false}>
              <div data-bubble-content="" className="contents">
                {threadMember ? null : chip?.kind === 'chip' && !parentDeleted ? (
                  <PostRefChip
                    post={chip.post}
                    onTap={chip.onTap}
                    className={album ? 'mx-2' : '-mb-2 -mt-2'}
                  />
                ) : (chip === undefined || parentDeleted) && reply !== null ? (
                  <ReplyQuoteBox
                    author={
                      reply.authorUserId !== null
                        ? (profiles.get(reply.authorUserId)?.displayName ?? 'Member')
                        : 'Member'
                    }
                    preview={
                      parentDeleted
                        ? deletedMessageLabel({ mine: quotedMine })
                        : resolveMentionText(
                            stripFormat(reply.preview),
                            profileNameOf(profiles, props.workspaceId ?? null),
                          )
                    }
                    deleted={parentDeleted}
                    inBubble={layout}
                    media={parentDeleted ? null : quoteMedia(props.quoted)}
                    thumbSource={{ cache, presignEnabled }}
                    onJump={() => props.onJumpToMessage?.(reply.id)}
                    className={album ? 'mx-2 mb-1 mt-1' : 'mb-1'}
                  />
                ) : null}
                {message.privateReply != null ? (
                  <PrivateReplyQuote
                    reply={message.privateReply}
                    profiles={profiles}
                    workspaceId={props.workspaceId ?? null}
                    layout={layout}
                    onOpen={props.onOpenPrivateReply}
                    className={album ? 'mx-2 mb-1 mt-1' : 'mb-1'}
                  />
                ) : null}
                {textOnly ? (
                  <>
                    {removedLine}
                    {linkCard}
                    {body}
                  </>
                ) : voiceOnly ? (
                  <>
                    {removedLine}
                    <MessageAttachments
                      attachments={message.attachments}
                      cache={cache}
                      presignEnabled={presignEnabled}
                      onCancelUpload={cancelUpload}
                      voice={{
                        messageId: message.id,
                        // L1: no own fill behind the player, so it takes the received look.
                        mine: false,
                        sender: { name, ...senderAvatarProps(message, profiles) },
                        nextVoiceId: props.nextVoiceId ?? null,
                        // The time sits in the note's last row (Transcribe row / length row).
                        meta: metaEmpty ? null : (
                          <BubbleMetaView meta={meta} mine={false} placement={placement} />
                        ),
                        ...(props.onTranscribe !== undefined && isTranscribable(message)
                          ? { onTranscribe: props.onTranscribe }
                          : {}),
                      }}
                    />
                  </>
                ) : album ? (
                  <>
                    <MessageAttachments
                      attachments={message.attachments}
                      cache={cache}
                      presignEnabled={presignEnabled}
                      album
                      albumCorners={bubbleCorners(shape)}
                      onCancelUpload={cancelUpload}
                      caption={
                        removedLine !== null || hasBody ? (
                          <>
                            {removedLine}
                            {hasBody ? body : null}
                          </>
                        ) : undefined
                      }
                      onImageClick={(_attachment, index) => props.onOpenImage?.(index)}
                    />
                    {hasCards ? (
                      <div className="flex flex-col px-2 pb-1">
                        <SharedPostCards postIds={message.sharedPostIds} {...cardRefs} />
                        <SharedBriefCards briefIds={message.sharedBriefIds} />
                        <SharedPlanCards planIds={sharedPlanIds} senderName={name} />
                        <SharedIdeaCards ideaIds={sharedIdeaIds} />
                      </div>
                    ) : null}
                  </>
                ) : (
                  <>
                    {hasAttachments ? null : removedLine}
                    {hasBody ? linkCard : null}
                    {hasBody ? body : null}
                    {hasAttachments ? removedLine : null}
                    <MessageAttachments
                      attachments={message.attachments}
                      cache={cache}
                      presignEnabled={presignEnabled}
                      onCancelUpload={cancelUpload}
                    />
                    <SharedPostCards
                      postIds={message.sharedPostIds}
                      {...cardRefs}
                      {...cardPlace('post')}
                    />
                    <SharedBriefCards briefIds={message.sharedBriefIds} {...cardPlace('brief')} />
                    <SharedPlanCards
                      planIds={sharedPlanIds}
                      senderName={name}
                      {...cardPlace('plan')}
                    />
                    <SharedIdeaCards ideaIds={sharedIdeaIds} {...cardPlace('idea')} />
                  </>
                )}
              </div>
            </ChatCardOwn>
            {props.bottomLine ?? null}
            {voiceOnly || cardOnly || metaEmpty ? null : (
              <BubbleMetaView
                meta={meta}
                mine={false}
                placement={placement}
                className={placement === 'row' && album ? 'px-2 pb-1' : undefined}
              />
            )}
            {failed && mine && message.filesMissing !== true && canRetryFailed(message) ? (
              <PressableRow
                inline
                type="button"
                data-failed-retry=""
                aria-label="Retry sending"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  props.onRetry?.(message.id);
                }}
                // On the rail the tick runs into the alert: the page fill keeps the "!" clear of it.
                className={cn(FAILED_RETRY_CLASS, rail?.role != null && 'bg-bg')}
              >
                <FailedGlyph />
              </PressableRow>
            ) : null}
            {onMore !== undefined ? (
              <PressableRow
                inline
                type="button"
                data-more=""
                aria-label="Message options"
                aria-haspopup="menu"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  onMore();
                }}
                className={cn(
                  'pointer-events-none absolute right-0 top-0 z-raised flex h-11 min-w-11 items-start justify-end rounded-tr-[inherit] opacity-0 focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover/bubble:pointer-events-auto group-hover/bubble:opacity-100',
                )}
              >
                <span
                  aria-hidden="true"
                  data-more-glyph=""
                  className={cn(
                    'flex w-10 items-start justify-end rounded-tr-[inherit] bg-gradient-to-l from-50%',
                    // On a card (the card is the bubble) the glyph's visible
                    // edge comes in to the card's 12px content edge.
                    cardOnly ? 'pr-2' : 'pr-1',
                    'from-bg text-fg-3',
                  )}
                >
                  <ChevronGlyph />
                </span>
              </PressableRow>
            ) : null}
          </div>,
          rail,
          railEdge,
        )}
        {fullMeta.status === 'failed' && mine && canDiscardFailed(message) ? (
          <FailedActions
            {...(message.refusal !== undefined ? { refusal: message.refusal } : {})}
            {...(props.onRetry !== undefined ? { onRetry: () => props.onRetry?.(message.id) } : {})}
            {...(props.onDiscard !== undefined
              ? { onDelete: () => props.onDiscard?.(message.id) }
              : {})}
          />
        ) : fullMeta.status === 'failed' || fullMeta.status === 'files-missing' ? (
          <FailedLine status={fullMeta.status} />
        ) : null}
        {hasReactions || rootAddKey ? (
          // On the text column, 8 under the message (the column's 4 + 4) and
          // 8 over the next row, so the pills' 44 taps never meet its first
          // line's (a mention's); the thread root's ends on the strip's 12.
          // A thread's main message always carries the smiley key (rootAddKey).
          <ReactionChips
            className={rootPlace ? 'mt-1' : 'mb-2 mt-1'}
            reactions={message.reactions}
            onToggle={(emoji) => props.reactionChips?.onToggle(emoji)}
            onPick={(emoji) => props.reactionChips?.onPick(emoji)}
            canReact={canReactChips}
            addWhenEmpty={rootAddKey}
            who={props.reactionChips?.who}
            {...(props.reactionChips?.onWho !== undefined && selection === undefined
              ? { onWho: props.reactionChips.onWho }
              : {})}
          />
        ) : null}
      </div>
      {onReact !== undefined ? (
        <IconButton
          type="button"
          label="React to message"
          data-react=""
          aria-haspopup="menu"
          onClick={onReact}
          className={cn(
            'shrink-0 self-center text-fg-3 opacity-0 focus-visible:opacity-100 group-hover:opacity-100',
            // An own row's tick passes under the smiley; the page fill keeps the glyph clear.
            rail?.role != null && mine && 'bg-bg',
            // The thread root's stack (laptop): the smiley rides its head line, out of the flow.
            rootStack && 'absolute right-4 top-3',
          )}
        >
          <SmileyGlyph />
        </IconButton>
      ) : textSelect && press?.onReact !== undefined && message.state === 'sent' ? (
        // The smiley's room stays while selecting text, so the row never
        // changes size (a pinned list would re-pin and scroll it away).
        <span
          aria-hidden="true"
          data-react-slot=""
          className={cn('h-11 w-11 shrink-0', rootStack && 'absolute right-4 top-3')}
        />
      ) : null}
      {failed && mine && message.filesMissing === true ? (
        <IconButton
          label="Remove message"
          className="shrink-0 self-center text-bad hover:bg-bad-soft hover:text-bad"
          onClick={() => props.onRetry?.(message.id)}
        >
          <IconTrash size={ICON_SIZE.nav} />
        </IconButton>
      ) : null}
    </li>
  );
}

/** A bubble's reaction chip taps: toggle mine, the drawer's pick, who reacted. */
export interface BubbleReactionChips {
  onToggle: (emoji: string) => void;
  onPick: (emoji: string) => void;
  who?: ReactionChipsProps['who'];
  /** Phone long-press on a chip: the thread's own who-reacted sheet. */
  onWho?: (emoji: string) => void;
}

/** The small "Forwarded" line above a forwarded message's body (own and incoming). */
export function ForwardedLabel(props: { mine?: boolean } = {}): ReactElement {
  return (
    <span
      data-forwarded=""
      className={cn(
        'mb-1 flex items-center gap-1 text-sm',
        props.mine === true ? 'text-accent-fg' : 'text-fg-2',
      )}
    >
      <IconForward size={ICON_SIZE.inline} />
      {FORWARDED_LABEL}
    </span>
  );
}

/** One rendered row of the thread list, grouped once before the first paint. */
export type ThreadRow =
  | { kind: 'day'; key: string; label: string }
  | { kind: 'message'; message: ThreadMessage; head: boolean; tail: boolean; meta: BubbleMeta }
  | TaskThreadRow;

/** A task change line; `label` is its plain name, as day pills carry theirs. */
type TaskThreadRow = { kind: 'task'; key: string; label: string; line: TaskLine };

/** The label a task line row carries. */
export const TASK_LINE_LABEL = 'Task change';

type ThreadListItem = ThreadItem | TaskThreadRow;

/**
 * Messages and task changes in one time order with the day pills: each run of
 * consecutive changes (no message between them) is split by day and collapsed
 * (collapseTaskRun); a change at the same instant as a message sits after it.
 * Pure.
 */
export function withTaskLines(
  messages: readonly ThreadMessage[],
  events: readonly TaskEvent[],
  nowMs: number,
  timeZone?: string,
): ThreadListItem[] {
  const items: ThreadListItem[] = [];
  let current: string | null = null;
  const dayOf = (ms: number): void => {
    if (!(Number.isFinite(ms) && ms > 0)) return;
    const day = civilDay(ms, timeZone);
    if (day === current) return;
    current = day;
    items.push({ kind: 'day', key: `day-${day}`, label: dayPillLabel(day, nowMs, timeZone) });
  };
  const flush = (run: TaskEvent[]): void => {
    let k = 0;
    while (k < run.length) {
      const first = run[k];
      if (first === undefined) break;
      const day = civilDay(Date.parse(first.createdAt), timeZone);
      let end = k;
      while (end + 1 < run.length) {
        const next = run[end + 1];
        if (next === undefined || civilDay(Date.parse(next.createdAt), timeZone) !== day) break;
        end += 1;
      }
      dayOf(Date.parse(first.createdAt));
      for (const line of collapseTaskRun(run.slice(k, end + 1))) {
        const lead = line.kind === 'one' ? line.event : line.events[0];
        items.push({ kind: 'task', key: `task-${lead?.id ?? k}`, label: TASK_LINE_LABEL, line });
      }
      k = end + 1;
    }
  };
  let e = 0;
  messages.forEach((message, index) => {
    const run: TaskEvent[] = [];
    if (Number.isFinite(message.time) && message.time > 0) {
      while (e < events.length) {
        const event = events[e];
        if (event === undefined || !(Date.parse(event.createdAt) < message.time)) break;
        run.push(event);
        e += 1;
      }
    }
    flush(run);
    dayOf(message.time);
    items.push({ kind: 'message', message, index });
  });
  flush(events.slice(e));
  return items;
}

/**
 * The thread's render list: day pills, then runs. A run is consecutive messages
 * from one sender with no day pill and no 10-minute gap between neighbours; its
 * first message is the head, its last the tail. There are no time rows: every
 * message row carries its own meta (time on the viewer's clock, "edited", and
 * the tick) for inside its bubble. Pure, so the list is grouped in one pass and
 * never re-groups after painting.
 */
export function threadRows(
  messages: readonly ThreadMessage[],
  nowMs: number,
  /** For tests; the app passes undefined (the viewer's device zone). */
  timeZone: string | undefined,
  /**
   * `days: false` (the thread view): one run of replies, no day pills (and no
   * task lines). `taskEvents`: the chat's task changes for the loaded window,
   * oldest first; a task line ends a message run.
   */
  opts: { showTicks?: boolean; days?: boolean; taskEvents?: readonly TaskEvent[] } = {},
): ThreadRow[] {
  const events = opts.days === false ? [] : (opts.taskEvents ?? []);
  const items: ThreadListItem[] =
    opts.days === false
      ? messages.map((message, index) => ({ kind: 'message' as const, message, index }))
      : events.length > 0
        ? withTaskLines(messages, events, nowMs, timeZone)
        : withDaySeparators(messages, nowMs, timeZone);
  const showTicks = opts.showTicks === true;
  const rows: ThreadRow[] = [];
  items.forEach((item, k) => {
    if (item.kind !== 'message') {
      rows.push(item);
      return;
    }
    const { message, index } = item;
    const prev = messages[index - 1];
    const next = messages[index + 1];
    // A day pill or a task line between neighbours ends the run.
    const afterDay = items[k - 1] !== undefined && items[k - 1]?.kind !== 'message';
    const beforeDay = items[k + 1] !== undefined && items[k + 1]?.kind !== 'message';
    const head = afterDay || breaksRun(prev, message);
    const tail = next === undefined || beforeDay || breaksRun(message, next);
    rows.push({
      kind: 'message',
      message,
      head,
      tail,
      meta: bubbleMeta(message, timeZone, { showTicks }),
    });
  });
  return rows;
}

/** One row's hold (long-press) and contextmenu decisions; see createRowHold. */
export interface RowHold {
  /** The long-press fired. */
  hold: () => void;
  /** The row's or bubble's contextmenu event. */
  contextMenu: (event: { preventDefault: () => void }) => void;
  /** A new gesture starts: nothing has fired yet. */
  pointerDown: () => void;
}

/**
 * The hold and contextmenu of one message row outside selection mode (there
 * the row's own gesture decides, see createSelectionGesture), framework-free
 * so the rules are unit-tested. A hold (long-press) opens the menu.
 * contextmenu always cancels the native one: on a touch-first pointer the hold
 * owns it (a contextmenu that beats the hold timer acts as the hold, once per
 * gesture); on a laptop right-click opens the menu as before, and does nothing
 * while selecting.
 */
export function createRowHold(deps: {
  selection: () => RowSelection | undefined;
  coarse: () => boolean;
  openMenu: () => void;
  cancelTimer: () => void;
  cancelSwipe: () => void;
  swiping: () => boolean;
}): RowHold {
  let holdFired = false;
  const hold = (): void => {
    holdFired = true;
    deps.cancelSwipe();
    deps.openMenu();
  };
  return {
    hold,
    contextMenu: (event) => {
      event.preventDefault();
      deps.cancelTimer();
      if (deps.swiping()) return;
      if (deps.coarse()) {
        if (!holdFired) hold();
        return;
      }
      if (deps.selection() === undefined) deps.openMenu();
    },
    pointerDown: () => {
      holdFired = false;
    },
  };
}

/**
 * One date line between messages ("Today", "Yesterday", "Fri 9 Oct"): the words
 * bold in fg ink on the photo column (the row's own 16 left pad) over a 1px
 * hairline that runs the list's full width. 16 above the words (0 as the first
 * row), 8 to the hairline, 12 to the next row (which keeps afterLabel, pt-0).
 * No pill, no centring, no motion.
 */
export function DateLine({ label, layout }: { label: string; layout: ChatLayout }): ReactElement {
  return (
    <li
      role="separator"
      aria-label={label}
      data-date-line=""
      className="flex flex-col pb-3 pt-4 first:pt-0"
    >
      <span data-date-rule="" className="block border-b border-border px-4 pb-2">
        <span
          data-date-label=""
          className={cn('block truncate text-fg', sized(DATE_LINE_TYPE, layout))}
        >
          {label}
        </span>
      </span>
    </li>
  );
}

/** No plan ids: one shared empty list, so a bubble's props stay stable. */
const NO_PLAN_IDS: string[] = [];
