// A plan item's comments as a chat thread, drawn by chat's own parts so plan
// items, concepts, bank ideas and a post item's Plan notes look, feel and work
// exactly like a chat thread (CLAUDE.md "Work chat (Slack way)"): chat's
// grouping (same sender within 5 min, a day pill between days), chat's
// MessageBubble per comment (everyone on the left, no bubbles, square photo 32
// + name + clock time on a group head), chat's swipe core (right = Reply; left
// rubber-bands: plan comments have no delete), chat's long-press / right-click
// MessageActionMenu, a clock while pending and "Not sent" + Retry on a failed
// own send, chat's @mention names. Creators-only notes carry a lock line.
// Emoji reactions as chat's (9 Nov 2026): the menu's quick row and "+", the
// laptop hover smiley, the chips under the text; one batched
// plan_item_comment_reactions read per thread, after paint, again whenever
// the comments refresh.
// Also the @ helpers the comment box uses: who can be tagged (never me;
// agency side only on a creators-only note or a plan not shared with the
// client), and which tagged people a creators-only note blocks.
//
// Pure helpers carry the logic; the components only draw. No reads on paint: author
// names and photos come from the members this session already holds
// (peekWorkspaceMembers), never a request on paint. Tokens only.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { openPersonCardFrom } from '@/components/ui/PersonTrigger';
import { ICON_SIZE, IconLock } from '@/components/ui/icons';
import { tintTarget } from '@/components/ui/SearchHighlight';
import { useToast } from '@/components/ui/toast';
import { useOpenPersonDm } from '@/components/ui/use-open-person-dm';
import { cancelPendingLongPressesWithin, useLongPress } from '@/components/ui/useLongPress';
import { useChatLayout, type ChatLayout } from '@/components/chat/chat-type';
import { MessageActionMenu } from '@/components/chat/MessageActionMenu';
import {
  DayPill,
  MessageBubble,
  createRowHold,
  isLinkTarget,
  paintRowSwipe,
  profileNameOf,
  rowSwipeCanTrigger,
  threadRows,
  type BubbleMentions,
  type BubblePointerHandlers,
  type BubbleSwipe,
  type RowHold,
} from '@/components/chat/MessageBubble';
import { PRESIGN_ENABLED, sharedCardPresignCache } from '@/components/chat/PostCard';
import { TEAM_ONLY_LABEL } from '@/components/chat/plan-card';
import type { ChatProfile } from '@/lib/chat-reads';
import { setPrivateReplyDraft } from '@/lib/chat/drafts';
import { startChatMembers } from '@/lib/chat/open-members';
import {
  filterMentionMembers,
  isFormerMember,
  mentionIds,
  personAvatar,
  rememberMentionNames,
  resolveMentionText,
  resolvePersonMentionText,
  type MentionMember,
} from '@/lib/chat/mentions';
import type { CommentVisibility, PlanAudience } from '@/lib/chat/plans';
import type { PrivateReplyDraft } from '@/lib/chat/private-reply';
import { createSwipeReplyController, type SwipeReplyController } from '@/lib/chat/swipe-reply';
import { SENDER_GROUP_MS, breaksRun, type ThreadMessage } from '@/lib/chat/thread';
import { COPY_FAILED, copyText } from '@/lib/clipboard';
import { planItemFocusHref } from '@/lib/focus-target';
import { canReplyPrivately, planCommentPrivateReplyDraft } from '@/lib/reply-privately';
import { supabase } from '@/lib/supabase';
import { useCoarsePointer, useHoverPointer, usePrefersReducedMotion } from '@/lib/use-is-laptop';
import { peekWorkspaceMembers, type WorkspaceMembersData } from '@/lib/workspace-members';
import { useReactions, type ReactionsApi } from '@/lib/reactions/use-reactions';
import { whoReactedFromRows } from '@/lib/reactions/reads';
import type { ReactionSummary } from '@/lib/reactions/model';

/** A comment shown in the thread: a recorded row, or a pending own one. */
export interface ShownComment {
  id: string;
  authorUserId: string | null;
  authorName: string;
  /** The viewer wrote it (a pending one always). */
  mine: boolean;
  body: string;
  visibility: CommentVisibility;
  createdAt: string;
  pending: boolean;
  /** authorName is the author's real name (their name read answered), not a fallback. */
  authorKnown?: boolean;
  /** A pending own comment whose write failed: "Not sent" + Retry (chat's look). */
  failed?: boolean;
  /** A failed write the server refused for good: shown with Delete only, never Retry. */
  refusal?: string;
}

/** Where a plan comment's Reply privately points: the plan, the item, its title. */
export interface PlanReplyPrivatelyTarget {
  planId: string;
  itemId: string;
  /** The plan item title the screen shows. */
  whereLabel: string;
}

/**
 * Whether a plan comment offers Reply privately: a recorded comment by someone
 * else whose name is known and who is still a member (`former` when the held
 * members or the name registry say they left). Pure.
 */
export function showPlanReplyPrivately(
  comment: Pick<ShownComment, 'authorUserId' | 'authorName' | 'mine' | 'pending' | 'authorKnown'>,
  me: string | null,
  former: boolean,
): boolean {
  if (comment.mine || comment.pending || comment.authorKnown !== true) return false;
  return canReplyPrivately({
    authorUserId: comment.authorUserId,
    me,
    authorName: comment.authorName,
    former,
  });
}

/** Whether the held members (when held) or the name registry say this person left. */
function authorLeft(
  held: WorkspaceMembersData | null,
  workspaceId: string | null,
  userId: string | null,
): boolean {
  if (userId === null) return false;
  if (isFormerMember(workspaceId, userId)) return true;
  if (held === null) return false;
  return !held.rows.some((r) => r.user_id === userId && r.active === true && r.removed_at === null);
}

/** Comments this close together from one author are one run: chat's own group gap. */
export const PLAN_RUN_GAP_MS = SENDER_GROUP_MS;

/** The roles on the agency side (Creators); everyone else is an approver. */
const AGENCY_ROLES = new Set(['owner', 'admin', 'agency']);

/** The one line when an approver cannot be tagged (picker, box, server refusal toast). */
export const MENTION_TEAM_NOTE =
  "Approvers can't see creators-only notes, so they can't be tagged here.";

/** One thread row: a day line or a comment with its place in its run. */
export type PlanThreadRow =
  | { kind: 'day'; key: string; label: string }
  | { kind: 'comment'; comment: ShownComment; head: boolean; tail: boolean };

/** Whether `next` starts a new run after `prev`: chat's breaksRun (author, 5 min gap). Pure. */
export function breaksPlanRun(
  prev: Pick<ShownComment, 'authorUserId' | 'mine' | 'createdAt'> | undefined,
  next: Pick<ShownComment, 'authorUserId' | 'mine' | 'createdAt'>,
): boolean {
  return breaksRun(prev === undefined ? undefined : runOf(prev), runOf(next));
}

/** The fields chat's breaksRun reads, from a comment. Pure. */
function runOf(
  c: Pick<ShownComment, 'authorUserId' | 'mine' | 'createdAt'>,
): Pick<ThreadMessage, 'mine' | 'senderUserId' | 'time'> {
  const t = Date.parse(c.createdAt);
  return { mine: c.mine, senderUserId: c.authorUserId, time: Number.isFinite(t) ? t : 0 };
}

/**
 * The thread's rows in order, from chat's own threadRows: a day pill before
 * the first comment and before every comment on a new calendar day (device
 * zone), then each comment with head (first of its run) and tail (last of its
 * run). A day pill ends a run. `timeZone` is for tests. Pure.
 */
export function planThreadRows(
  comments: readonly ShownComment[],
  nowMs: number,
  timeZone?: string,
): PlanThreadRow[] {
  const byId = new Map(comments.map((c) => [c.id, c]));
  const rows: PlanThreadRow[] = [];
  for (const row of threadRows(
    comments.map((c) => planCommentMessage(c)),
    nowMs,
    timeZone,
  )) {
    if (row.kind === 'day') rows.push(row);
    if (row.kind !== 'message') continue;
    const comment = byId.get(row.message.id);
    if (comment === undefined) continue;
    rows.push({ kind: 'comment', comment, head: row.head, tail: row.tail });
  }
  return rows;
}

/** The picker's people from a members read: active members with a profile. Pure. */
export function planMentionMembers(
  data: Pick<WorkspaceMembersData, 'rows' | 'profiles'>,
): MentionMember[] {
  const seen = new Set<string>();
  const out: MentionMember[] = [];
  for (const row of data.rows) {
    if (row.active !== true || row.removed_at !== null || seen.has(row.user_id)) continue;
    seen.add(row.user_id);
    const profile = data.profiles.get(row.user_id);
    out.push({
      userId: row.user_id,
      displayName: profile?.displayName ?? 'Member',
      avatarUrl: profile?.avatarUrl ?? null,
      username: profile?.username ?? null,
      role: row.role,
    });
  }
  return out;
}

/** Whether a person is on the agency side (Creators). Pure. */
export function isAgencySide(member: Pick<MentionMember, 'role'>): boolean {
  return member.role !== null && AGENCY_ROLES.has(member.role);
}

/**
 * Whether only the agency side can be tagged: a creators-only note, or a plan
 * not shared with the client (approvers cannot see either). Pure.
 */
export function mentionsRestricted(visibility: CommentVisibility, audience: PlanAudience): boolean {
  return visibility === 'team' || audience === 'team';
}

/** The people the picker offers: never me; agency side only when restricted. Pure. */
export function taggableMembers(
  members: readonly MentionMember[],
  selfId: string | null,
  restricted: boolean,
): MentionMember[] {
  return members.filter((m) => m.userId !== selfId && (!restricted || isAgencySide(m)));
}

/**
 * The picker rows for a query (filterMentionMembers' order) and whether an
 * approver matching the query was left out (the note line shows then). Pure.
 */
export function planPickerRows(
  members: readonly MentionMember[],
  query: string,
  selfId: string | null,
  restricted: boolean,
): { rows: MentionMember[]; hiddenApprovers: boolean } {
  const all = filterMentionMembers(members, query, selfId);
  const rows = restricted ? all.filter(isAgencySide) : all;
  return { rows, hiddenApprovers: rows.length < all.length };
}

/**
 * The tagged people a restricted note cannot carry: every token in the body
 * whose member is an approver. Unknown people are left to the server. Pure.
 */
export function blockedMentions(
  body: string,
  members: readonly MentionMember[] | null,
  restricted: boolean,
): string[] {
  if (!restricted || members === null) return [];
  const byId = new Map(members.map((m) => [m.userId.toLowerCase(), m]));
  return mentionIds(body).filter((id) => {
    const m = byId.get(id.toLowerCase());
    return m !== undefined && !isAgencySide(m);
  });
}

/**
 * Which keys the open @ picker takes (chat's composer rule): Up / Down move,
 * Enter or Tab picks (Enter never sends while it is open), Escape closes. Null
 * for any other key and during IME composition. Pure.
 */
export function mentionKeyAction(
  key: string,
  isComposing: boolean,
): 'up' | 'down' | 'pick' | 'close' | null {
  if (isComposing) return null;
  if (key === 'ArrowUp') return 'up';
  if (key === 'ArrowDown') return 'down';
  if (key === 'Enter' || key === 'Tab') return 'pick';
  if (key === 'Escape') return 'close';
  return null;
}

/** Whether a comment write was refused for its mentions. Pure. */
export function isInvalidMention(message: string): boolean {
  return /invalid_mention/.test(message);
}

/**
 * The workspace's people for the @ picker. Nothing loads on paint: `load` (the
 * box's focus, or the first "@") answers from the held members, else joins the
 * one shared members read (startChatMembers). Never throws.
 */
export function usePlanMentionMembers(
  me: string | null,
  workspaceId: string | null,
): { members: MentionMember[] | null; load: () => void } {
  const [members, setMembers] = useState<MentionMember[] | null>(null);
  const [asked, setAsked] = useState(false);
  useEffect(() => {
    setMembers(null);
    setAsked(false);
  }, [me, workspaceId]);
  useEffect(() => {
    if (!asked || members !== null || me === null || workspaceId === null) return;
    const held = peekWorkspaceMembers(me, workspaceId);
    if (held !== null) {
      const list = planMentionMembers(held);
      rememberMentionNames(workspaceId, list);
      setMembers(list);
      return;
    }
    let active = true;
    void startChatMembers(supabase, me, workspaceId).then((data) => {
      if (!active || data.error !== null) return;
      const list = planMentionMembers(data);
      rememberMentionNames(workspaceId, list);
      setMembers(list);
    });
    return () => {
      active = false;
    };
  }, [asked, members, me, workspaceId]);
  return { members, load: () => setAsked(true) };
}

/** Chat's empty reactions, one array for every comment (rows never re-allocate it). */
const NO_REACTIONS: readonly ReactionSummary[] = [];
const NO_IDS: string[] = [];

/**
 * A plan comment as a chat ThreadMessage, so chat's own bubble draws it: a
 * recorded row is 'sent', a pending own one 'sending' (the clock), a failed
 * own one 'failed' ("Not sent" + Retry, or its refusal with Delete only).
 * Plan comments carry no files, cards or quotes; reactions come from the
 * thread's batched read (none on a pending one). Pure.
 */
export function planCommentMessage(
  c: ShownComment,
  reactions: readonly ReactionSummary[] = NO_REACTIONS,
): ThreadMessage {
  const time = Date.parse(c.createdAt);
  return {
    id: c.id,
    senderUserId: c.authorUserId,
    body: c.body,
    createdAt: c.createdAt,
    time: Number.isFinite(time) ? time : 0,
    provisionalTime: c.pending,
    mine: c.mine,
    attachments: [],
    sharedPostIds: NO_IDS,
    sharedBriefIds: NO_IDS,
    reply: null,
    state: c.failed === true ? 'failed' : c.pending ? 'sending' : 'sent',
    status: 'sent',
    reactions: reactions as ThreadMessage['reactions'],
    ...(c.failed === true && c.refusal !== undefined ? { refusal: c.refusal } : {}),
  };
}

/**
 * The profiles chat's bubble reads (name, photo, @handle): the members this
 * session already holds, then each author whose real name the comment read
 * answered (photo from the mention registry). An author with no known name is
 * left out, so the bubble names them as chat does and the person card opens
 * without a name. No read. Pure.
 */
export function planCommentProfiles(
  comments: readonly ShownComment[],
  held: Pick<WorkspaceMembersData, 'profiles'> | null,
  workspaceId: string | null,
): Map<string, ChatProfile> {
  const out = new Map<string, ChatProfile>(held?.profiles ?? []);
  for (const c of comments) {
    const id = c.authorUserId;
    if (id === null || out.has(id) || c.authorKnown !== true) continue;
    out.set(id, {
      userId: id,
      displayName: c.authorName,
      avatarUrl: personAvatar(workspaceId, id),
    });
  }
  return out;
}

/** What the long-press menu offers on one comment (chat's rules, minus what plans lack). Pure. */
export function planCommentMenu(input: {
  comment: Pick<ShownComment, 'body' | 'pending' | 'failed' | 'mine'>;
  canReply: boolean;
  canLink: boolean;
  replyPrivately: boolean;
}): {
  reply: boolean;
  copy: boolean;
  copyLink: boolean;
  replyPrivately: boolean;
  discard: boolean;
} {
  const recorded = !input.comment.pending && input.comment.failed !== true;
  return {
    reply: input.canReply && recorded,
    copy: input.comment.body.trim() !== '',
    copyLink: input.canLink && recorded,
    replyPrivately: input.replyPrivately && recorded,
    discard: input.comment.mine && input.comment.failed === true,
  };
}

/** The "Creators only" line inside a creators-only note's bubble. */
function TeamOnlyLine(): ReactElement {
  return (
    <span
      data-plan-comment-team=""
      className="mb-1 inline-flex items-center gap-1 text-sm text-warn"
    >
      <IconLock size={ICON_SIZE.inline} />
      {TEAM_ONLY_LABEL}
    </span>
  );
}

/** Where Copy link points: the plan (null for a bank idea) and the item. */
export interface PlanCommentLinkTarget {
  planId: string | null;
  itemId: string;
}

/** One open long-press menu: the comment and the bubble's rect (the laptop smiley: its reactions row alone). */
interface OpenMenu {
  comment: ShownComment;
  anchor: DOMRect | null;
  reactionsOnly?: boolean;
}

/**
 * One comment row: chat's MessageRow wiring on chat's MessageBubble. Swipe
 * right replies (the one swipe core); a left swipe rubber-bands (plan
 * comments cannot be deleted, so nothing fires). A hold (touch) or right-click
 * (laptop), Enter / Space / Shift+F10, or the laptop chevron opens the menu.
 * Pending and failed rows never swipe (chat's rule).
 */
function PlanCommentRow(props: {
  comment: ShownComment;
  message: ThreadMessage;
  head: boolean;
  tail: boolean;
  afterLabel: boolean;
  profiles: Map<string, ChatProfile>;
  workspaceId: string | null;
  me: string | null;
  layout: ChatLayout;
  highlighted: boolean;
  hoverMenu: boolean;
  coarsePointer: boolean;
  reducedMotion: boolean;
  personSource: (message: ThreadMessage) => PrivateReplyDraft | null;
  mentions: BubbleMentions;
  onOpenMenu: (comment: ShownComment, anchor: DOMRect | null, reactionsOnly?: boolean) => void;
  onReply: (() => void) | undefined;
  onRetry: ((id: string) => void) | undefined;
  onDiscard: ((id: string) => void) | undefined;
  reactions: ReactionsApi;
}): ReactElement {
  const bubbleRef = useRef<HTMLDivElement>(null);
  const iconRef = useRef<HTMLSpanElement>(null);
  const deleteIconRef = useRef<HTMLSpanElement>(null);
  const rowRef = useRef<HTMLLIElement>(null);
  const swipeIconShownRef = useRef(true);
  const latest = useRef(props);
  latest.current = props;
  const bubbleRect = (): DOMRect | null => bubbleRef.current?.getBoundingClientRect() ?? null;
  const swipeRef = useRef<SwipeReplyController | null>(null);
  const { handlers, consumeClickSuppression, cancel, clearClickSuppression } = useLongPress(
    () => rowHold.hold(),
    { ignoreMouse: true },
  );
  const open = (anchor: DOMRect | null): void => {
    clearClickSuppression();
    latest.current.onOpenMenu(latest.current.comment, anchor);
  };
  const rowHoldRef = useRef<RowHold | null>(null);
  rowHoldRef.current ??= createRowHold({
    selection: () => undefined,
    coarse: () => latest.current.coarsePointer,
    openMenu: () => open(bubbleRect()),
    cancelTimer: () => cancel(),
    cancelSwipe: () => swipeRef.current?.cancel(),
    swiping: () => swipeRef.current?.swiping() === true,
  });
  const rowHold = rowHoldRef.current;
  swipeRef.current ??= createSwipeReplyController({
    direction: 'both',
    onReply: () => latest.current.onReply?.(),
    canTrigger: (side) => {
      // Right replies where a Reply is wired; left never fires (no delete for plan comments).
      const ok =
        side === 'right' &&
        latest.current.onReply !== undefined &&
        rowSwipeCanTrigger(side, latest.current.message, undefined);
      swipeIconShownRef.current = ok;
      return ok;
    },
    onFrame: (frame) =>
      paintRowSwipe(
        bubbleRef.current,
        iconRef.current,
        deleteIconRef.current,
        frame,
        swipeIconShownRef.current,
      ),
    onStart: (pointerId) => {
      cancel();
      const scope = rowRef.current ?? bubbleRef.current;
      if (scope !== null) cancelPendingLongPressesWithin(scope);
      window.getSelection()?.removeAllRanges();
      if (pointerId === undefined) return;
      try {
        scope?.setPointerCapture(pointerId);
      } catch {
        // The pointer is already gone; the gesture ends on its own.
      }
    },
    enabled: () => latest.current.message.state === 'sent',
    reducedMotion: () => latest.current.reducedMotion,
  });
  const swipe = swipeRef.current;
  useEffect(() => () => swipe.dispose(), [swipe]);
  // A deep link's arrival: chat's jump tint on the row (after paint, no read on paint).
  useEffect(() => {
    const row = rowRef.current;
    if (!props.highlighted || row === null) return;
    return tintTarget(row);
  }, [props.highlighted]);
  const pointer: BubblePointerHandlers = {
    onPointerDown: (e) => {
      rowHold.pointerDown();
      if (!isLinkTarget(e.target)) handlers.onPointerDown(e);
    },
    onPointerMove: (e) => handlers.onPointerMove(e),
    onPointerUp: () => handlers.onPointerUp(),
    onPointerCancel: () => handlers.onPointerCancel(),
  };
  const rowSwipeRef = useRef<BubbleSwipe | null>(null);
  rowSwipeRef.current ??= {
    iconRef,
    deleteIconRef,
    handlers: {
      onPointerDown: (e) => swipe.handlers.onPointerDown(e),
      onPointerMove: (e) => swipe.handlers.onPointerMove(e),
      onPointerUp: (e) => swipe.handlers.onPointerUp(e),
      onPointerCancel: () => swipe.handlers.onPointerCancel(),
    },
    consumeClick: () => swipe.consumeClickSuppression(),
  };
  const c = props.comment;
  return (
    <MessageBubble
      message={props.message}
      profiles={props.profiles}
      cache={sharedCardPresignCache()}
      presignEnabled={PRESIGN_ENABLED}
      showTicks={false}
      isGroup
      head={props.head}
      tail={props.tail}
      afterLabel={props.afterLabel}
      layout={props.layout}
      viewerUserId={props.me ?? undefined}
      mentions={props.mentions}
      workspaceId={props.workspaceId}
      personSource={props.personSource}
      bubbleRef={bubbleRef}
      rowRef={rowRef}
      swipe={rowSwipeRef.current}
      rowData={{
        'data-plan-comment-id': c.id,
        'data-plan-comment': c.visibility,
        'data-plan-comment-side': c.mine ? 'own' : 'other',
        'data-plan-run-head': props.head ? '' : undefined,
        'data-plan-run-tail': props.tail ? '' : undefined,
        'data-plan-comment-highlight': props.highlighted ? '' : undefined,
      }}
      {...(c.visibility === 'team' ? { topLine: <TeamOnlyLine /> } : {})}
      press={{
        handlers: pointer,
        onContextMenu: rowHold.contextMenu,
        consumeClick: () => {
          const held = consumeClickSuppression();
          const swiped = swipe.consumeClickSuppression();
          return held || swiped;
        },
        coarse: props.coarsePointer,
        onKeyOpen: () => open(bubbleRect()),
        ...(props.hoverMenu
          ? {
              onMore: () => open(bubbleRect()),
              onReact: () => {
                clearClickSuppression();
                latest.current.onOpenMenu(latest.current.comment, bubbleRect(), true);
              },
            }
          : {}),
      }}
      {...(props.onRetry !== undefined ? { onRetry: props.onRetry } : {})}
      {...(props.onDiscard !== undefined ? { onDiscard: props.onDiscard } : {})}
      reactionChips={{
        onToggle: (emoji) => props.reactions.toggle(c.id, emoji),
        onPick: (emoji) => props.reactions.pick(c.id, emoji),
        who: {
          targetId: c.id,
          viewerId: props.me,
          load: () =>
            whoReactedFromRows(supabase, {
              rows: props.reactions.rowsOf(c.id),
              workspaceId: props.workspaceId,
              known: (id) => props.profiles.get(id),
            }),
        },
      }}
    />
  );
}

/**
 * The open comment's long-press menu: chat's MessageActionMenu with the rows
 * a plan comment has (the quick reactions and "+", Reply, Copy link, Copy
 * text, Reply privately, and a failed own send's Delete). No Forward, Tasks,
 * Mark unread, Edit or Delete: plan comments store none of those. Mounted only while open, so
 * its hooks never run on paint.
 */
function PlanCommentMenu(props: {
  menu: OpenMenu;
  me: string | null;
  workspaceId: string | null;
  profiles: Map<string, ChatProfile>;
  held: WorkspaceMembersData | null;
  replyPrivately: PlanReplyPrivatelyTarget | null;
  linkTo: PlanCommentLinkTarget | null;
  onReply: (() => void) | undefined;
  onDiscard: ((id: string) => void) | undefined;
  onClose: () => void;
  reactions: ReactionsApi;
}): ReactElement {
  const toast = useToast();
  const openDm = useOpenPersonDm();
  const c = props.menu.comment;
  const authorId = c.authorUserId;
  const draft =
    props.replyPrivately !== null &&
    authorId !== null &&
    showPlanReplyPrivately(c, props.me, authorLeft(props.held, props.workspaceId, authorId))
      ? planCommentPrivateReplyDraft({
          commentId: c.id,
          authorUserId: authorId,
          authorName: c.authorName,
          excerpt: resolvePersonMentionText(c.body, props.workspaceId),
          whereLabel: props.replyPrivately.whereLabel,
          planId: props.replyPrivately.planId,
          itemId: props.replyPrivately.itemId,
        })
      : null;
  const offer = planCommentMenu({
    comment: c,
    canReply: props.onReply !== undefined,
    canLink: props.linkTo !== null,
    replyPrivately: draft !== null,
  });
  const nameOf = profileNameOf(props.profiles, props.workspaceId);
  return (
    <MessageActionMenu
      open
      onClose={props.onClose}
      anchor={props.menu.anchor}
      mine={c.mine}
      currentReaction={props.reactions.of(c.id).find((r) => r.mine)?.emoji ?? null}
      canReact={!c.pending && c.failed !== true}
      reactionsOnly={props.menu.reactionsOnly === true}
      canCopy={offer.copy}
      onCopy={() => {
        void copyText(resolveMentionText(c.body, nameOf)).then((ok) =>
          toast.show({ title: ok ? 'Message copied' : COPY_FAILED }),
        );
      }}
      onReact={(emoji) => {
        if (!c.pending && c.failed !== true) props.reactions.toggle(c.id, emoji);
      }}
      onReply={() => {
        if (offer.reply) props.onReply?.();
      }}
      canCopyLink={offer.copyLink}
      onCopyLink={() => {
        const to = props.linkTo;
        if (to === null) return;
        const href = planItemFocusHref({ planId: to.planId, itemId: to.itemId, commentId: c.id });
        void copyText(`${window.location.origin}${href}`).then((ok) =>
          toast.show({ title: ok ? 'Link copied' : COPY_FAILED }),
        );
      }}
      canReplyPrivately={offer.replyPrivately}
      replyPrivatelyName={c.authorName}
      onReplyPrivately={() => {
        if (draft === null || authorId === null) return;
        openDm(authorId, { beforeOpen: (channelId) => setPrivateReplyDraft(channelId, draft) });
      }}
      canDelete={offer.discard && props.onDiscard !== undefined}
      failedSend={offer.discard}
      onDelete={() => props.onDiscard?.(c.id)}
    />
  );
}

/**
 * The comments as a chat thread, drawn by chat's own parts: chat's grouping
 * (threadRows: same sender within 5 min, a day pill between days), chat's
 * MessageBubble per comment (everyone on the left, square photo 32 + name +
 * clock time on a group head), chat's swipe (right = Reply), long-press /
 * right-click MessageActionMenu, clock while pending and "Not sent" + Retry
 * on a failed own send, and chat's @mention names. `held` is the session's
 * members, read synchronously, never fetched here.
 */
export function PlanItemThread(props: {
  comments: readonly ShownComment[];
  workspaceId: string | null;
  me: string | null;
  highlightedId?: string | null;
  /** Offer Reply privately on others' comments, pointing here. Absent: never. */
  replyPrivately?: PlanReplyPrivatelyTarget | null;
  /** Reply (swipe right, the menu's Reply): focus the box. Absent: no Reply. */
  onReply?: () => void;
  /** A failed own comment's Retry; absent: no Retry. */
  onRetry?: (id: string) => void;
  /** A failed own comment's Delete (it never left the device); absent: none. */
  onDiscard?: (id: string) => void;
  /** Where Copy link points; absent: no Copy link. */
  linkTo?: PlanCommentLinkTarget | null;
}): ReactElement {
  const layout = useChatLayout();
  const hoverMenu = useHoverPointer();
  const coarsePointer = useCoarsePointer();
  const reducedMotion = usePrefersReducedMotion();
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const held =
    props.me !== null && props.workspaceId !== null
      ? peekWorkspaceMembers(props.me, props.workspaceId)
      : null;
  const profiles = planCommentProfiles(props.comments, held, props.workspaceId);
  // The recorded comments' reactions: one batched read after paint, again
  // whenever the comments refresh (the screen's own read; no new channel).
  const reactionIds = useMemo(
    () => props.comments.filter((c) => !c.pending && c.failed !== true).map((c) => c.id),
    [props.comments],
  );
  const reactions = useReactions({
    kind: 'plan-comment',
    ids: reactionIds,
    epoch: props.comments,
    me: props.me,
  });
  const rows = planThreadRows(props.comments, Date.now());
  const latest = useRef({ props, held });
  latest.current = { props, held };
  // Stable for the thread's life (they read the latest props at tap time).
  const personSource = useRef((message: ThreadMessage): PrivateReplyDraft | null => {
    const { props: p, held: h } = latest.current;
    const target = p.replyPrivately ?? null;
    const c = p.comments.find((x) => x.id === message.id);
    const authorId = c?.authorUserId ?? null;
    if (c === undefined || target === null || authorId === null) return null;
    if (!showPlanReplyPrivately(c, p.me, authorLeft(h, p.workspaceId, authorId))) return null;
    return planCommentPrivateReplyDraft({
      commentId: c.id,
      authorUserId: authorId,
      authorName: c.authorName,
      excerpt: resolvePersonMentionText(c.body, p.workspaceId),
      whereLabel: target.whereLabel,
      planId: target.planId,
      itemId: target.itemId,
    });
  }).current;
  // A mention tap opens the one person card, anchored to the tapped name.
  const mentions = useRef<BubbleMentions>({
    peerUserId: null,
    onOpen: (hint, el) => openPersonCardFrom(el, hint),
  }).current;
  const openMenu = useRef(
    (comment: ShownComment, anchor: DOMRect | null, reactionsOnly?: boolean): void => {
      setMenu({ comment, anchor, reactionsOnly: reactionsOnly === true });
    },
  ).current;
  // Reply focuses the box inside the tap; the menu closes after (runMenuItem).
  const onReply = props.onReply;
  let afterLabel = false;
  return (
    <>
      <ul data-plan-thread="" className="-mx-4 flex flex-col">
        {rows.map((row) => {
          if (row.kind === 'day') {
            afterLabel = true;
            return <DayPill key={row.key} label={row.label} layout={layout} />;
          }
          const comment = row.comment;
          const under = afterLabel;
          afterLabel = false;
          return (
            <PlanCommentRow
              key={comment.id}
              comment={comment}
              message={planCommentMessage(comment, reactions.of(comment.id))}
              head={row.head}
              tail={row.tail}
              afterLabel={under}
              profiles={profiles}
              workspaceId={props.workspaceId}
              me={props.me}
              layout={layout}
              highlighted={props.highlightedId === comment.id}
              hoverMenu={hoverMenu}
              coarsePointer={coarsePointer}
              reducedMotion={reducedMotion}
              personSource={personSource}
              mentions={mentions}
              onOpenMenu={openMenu}
              onReply={onReply}
              onRetry={props.onRetry}
              onDiscard={props.onDiscard}
              reactions={reactions}
            />
          );
        })}
      </ul>
      {menu !== null ? (
        <PlanCommentMenu
          menu={menu}
          me={props.me}
          workspaceId={props.workspaceId}
          profiles={profiles}
          held={held}
          replyPrivately={props.replyPrivately ?? null}
          linkTo={props.linkTo ?? null}
          onReply={onReply}
          onDiscard={props.onDiscard}
          onClose={() => setMenu(null)}
          reactions={reactions}
        />
      ) : null}
    </>
  );
}
