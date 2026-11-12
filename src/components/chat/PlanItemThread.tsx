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
import type { ReactElement, ReactNode } from 'react';
import { openPersonCardFrom } from '@/components/ui/PersonTrigger';
import { ICON_SIZE, IconLock } from '@/components/ui/icons';
import { PAGE_BLEED } from '@/components/ui/layout';
import { cn } from '@/lib/cn';
import { useToast } from '@/components/ui/toast';
import { useOpenPersonDm } from '@/components/ui/use-open-person-dm';
import { useChatLayout, type ChatLayout } from '@/components/chat/chat-type';
import { MessageActionMenu } from '@/components/chat/MessageActionMenu';
import {
  DateLine,
  profileNameOf,
  threadRows,
  type BubbleMentions,
} from '@/components/chat/MessageBubble';
import { ThreadCommentRow } from '@/components/chat/ThreadCommentRow';
import { THREAD_REPLY_PLACEHOLDER } from '@/components/chat/MessageThread';
import { RepliesRow, RepliesSeparatorRow } from '@/components/chat/ThreadRail';
import {
  CommentForwardLayer,
  CommentThreadLayer,
  useCommentThreadStick,
} from '@/components/comments/CommentThreadLayer';
import { toCommentFileAttachments, type CommentFile } from '@/components/comments/comment-files';
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
import type { MessageAttachment } from '@/lib/chat/attachments';
import { canForwardComment } from '@/lib/chat/forward-comment';
import {
  planRepliesInfo,
  setPlanCommentThreadRead,
  type CommentVisibility,
  type PlanAudience,
} from '@/lib/chat/plans';
import { THREAD_TITLE } from '@/lib/chat/thread-rail';
import { repliesLabel } from '@/lib/chat/thread-signals';
import type { PrivateReplyDraft } from '@/lib/chat/private-reply';
import { SENDER_GROUP_MS, breaksRun, type ThreadMessage } from '@/lib/chat/thread';
import { COPY_FAILED, copyText } from '@/lib/clipboard';
import { planItemFocusHref } from '@/lib/focus-target';
import { canReplyPrivately, planCommentPrivateReplyDraft } from '@/lib/reply-privately';
import { supabase } from '@/lib/supabase';
import { rowWhen } from '@/lib/time';
import { generateTraceId } from '@/lib/trace';
import { useCoarsePointer, useHoverPointer, usePrefersReducedMotion } from '@/lib/use-is-laptop';
import { peekWorkspaceMembers, type WorkspaceMembersData } from '@/lib/workspace-members';
import { useReactions, type ReactionsApi } from '@/lib/reactions/use-reactions';
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
  /** The main comment this one replies to (one level); null or absent on a main comment. */
  parentId?: string | null;
  /** A recorded comment's files: asset version ids as stored. */
  attachmentIds?: readonly string[] | null;
  /** A pending own send's files (local until the upload lands). */
  localAttachments?: MessageAttachment[];
  /** A main comment: my read point on its thread (null: never opened). */
  readAt?: string | null;
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

/** The thread reply box's hint (chat's word), for the screen's reply box. */
export { THREAD_REPLY_PLACEHOLDER };

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

const NO_FILES: ReadonlyMap<string, CommentFile> = new Map();

/**
 * A plan comment as a chat ThreadMessage, so chat's own bubble draws it: a
 * recorded row is 'sent', a pending own one 'sending' (the clock), a failed
 * own one 'failed' ("Not sent" + Retry, or its refusal with Delete only).
 * Files are post comments' (the batched asset_versions read, `files`; a
 * pending send's local files as picked); no cards or quotes; reactions come
 * from the thread's batched read (none on a pending one). Pure.
 */
export function planCommentMessage(
  c: ShownComment,
  reactions: readonly ReactionSummary[] = NO_REACTIONS,
  files: ReadonlyMap<string, CommentFile> = NO_FILES,
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
    attachments: c.localAttachments ?? toCommentFileAttachments(c.attachmentIds ?? null, files),
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
  /** Opened inside the thread view: no Reply there (CLAUDE.md "Thread view"). */
  inThread?: boolean;
}

/** The open thread: its main comment, a reply a link landed on, and whether the box takes focus. */
interface OpenThread {
  rootId: string;
  focusId: string | null;
  focus: boolean;
}

/** Whether a comment is recorded (not a pending or failed own send). Pure. */
function recorded(c: Pick<ShownComment, 'pending' | 'failed'>): boolean {
  return !c.pending && c.failed !== true;
}

/** Main comments (parent null) and each one's replies, both in the order given. Pure. */
export function planCommentLists(comments: readonly ShownComment[]): {
  mains: ShownComment[];
  replies: Map<string, ShownComment[]>;
} {
  const mains: ShownComment[] = [];
  const replies = new Map<string, ShownComment[]>();
  for (const c of comments) {
    const root = c.parentId ?? null;
    if (root === null) {
      mains.push(c);
      continue;
    }
    const list = replies.get(root);
    if (list) list.push(c);
    else replies.set(root, [c]);
  }
  return { mains, replies };
}

/**
 * One comment row: chat's shared ThreadCommentRow (the same row post and
 * brief comments draw). In the main list a tap opens the thread (keyboard
 * down on touch) and a right swipe is the explicit Reply (the box takes
 * focus); in the thread view neither (no reply gesture there). A left swipe
 * rubber-bands (plan comments cannot be deleted). Pending and failed rows
 * never swipe (chat's rule).
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
  onTapOpen?: (() => void) | undefined;
  onRetry: ((id: string) => void) | undefined;
  onDiscard: ((id: string) => void) | undefined;
  reactions: ReactionsApi;
  threadPlace?: 'root' | 'reply' | undefined;
  /** The "Creators only" line on a team note (the page and the top of its thread). */
  teamLine: boolean;
}): ReactElement {
  const c = props.comment;
  return (
    <ThreadCommentRow
      message={props.message}
      head={props.head}
      tail={props.tail}
      afterLabel={props.afterLabel}
      profiles={props.profiles}
      workspaceId={props.workspaceId}
      me={props.me}
      layout={props.layout}
      highlighted={props.highlighted}
      hoverMenu={props.hoverMenu}
      coarsePointer={props.coarsePointer}
      reducedMotion={props.reducedMotion}
      personSource={props.personSource}
      mentions={props.mentions}
      onOpenMenu={(anchor, reactionsOnly) => props.onOpenMenu(c, anchor, reactionsOnly)}
      onReply={props.onReply}
      onTapOpen={props.onTapOpen}
      onRetry={props.onRetry}
      onDiscard={props.onDiscard}
      reactions={props.reactions}
      threadPlace={props.threadPlace}
      // A thread's rows say their day ("Yesterday at 11:27 AM"), as chat's threads do.
      timeLabel={props.threadPlace !== undefined ? 'day' : undefined}
      rowData={{
        'data-plan-comment-id': c.id,
        'data-plan-comment': c.visibility,
        'data-plan-comment-side': c.mine ? 'own' : 'other',
        'data-plan-run-head': props.head ? '' : undefined,
        'data-plan-run-tail': props.tail ? '' : undefined,
        'data-plan-comment-highlight': props.highlighted ? '' : undefined,
      }}
      {...(props.teamLine && c.visibility === 'team' ? { topLine: <TeamOnlyLine /> } : {})}
    />
  );
}

/**
 * The open comment's long-press menu: chat's MessageActionMenu with the rows
 * a plan comment has (the quick reactions and "+", Reply, Copy link, Copy
 * text, Reply privately, and a failed own send's Delete). No Forward, Tasks,
 * Mark unread, Edit or Delete: plan comments store none of those. Reply opens
 * the comment's thread; inside the thread view there is no Reply. Mounted
 * only while open, so its hooks never run on paint.
 */
function PlanCommentMenu(props: {
  menu: OpenMenu;
  me: string | null;
  workspaceId: string | null;
  profiles: Map<string, ChatProfile>;
  held: WorkspaceMembersData | null;
  replyPrivately: PlanReplyPrivatelyTarget | null;
  linkTo: PlanCommentLinkTarget | null;
  onReply: ((comment: ShownComment) => void) | undefined;
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
  const canReply =
    props.onReply !== undefined && props.menu.inThread !== true && (c.parentId ?? null) === null;
  const offer = planCommentMenu({
    comment: c,
    canReply,
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
      canReact={recorded(c)}
      reactionsOnly={props.menu.reactionsOnly === true}
      canCopy={offer.copy}
      onCopy={() => {
        void copyText(resolveMentionText(c.body, nameOf)).then((ok) =>
          toast.show({ title: ok ? 'Message copied' : COPY_FAILED }),
        );
      }}
      onReact={(emoji) => {
        if (recorded(c)) props.reactions.toggle(c.id, emoji);
      }}
      onReply={() => {
        if (offer.reply) props.onReply?.(c);
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
 * The comments as a chat with threads (12 Nov 2026), drawn by the parts post
 * comments use: main comments only (parent null) as chat's family rows under
 * the shared DateLine, each with chat's RepliesRow (photos, "N replies", the
 * last reply's time, the unread dot) when it has replies; a tap, a right
 * swipe or the replies row opens the thread in the shared CommentThreadLayer
 * (ThreadViewFrame, "Thread" + the item's title, the main comment with its
 * add-reaction key, chat's "N replies" strip, the replies, the reply box from
 * `replyBox`). It opens at the latest reply, keyboard down on touch unless an
 * explicit Reply. My read point moves (fire and forget) when a thread opens
 * and when a reply lands while it is open. `held` is the session's members,
 * read synchronously, never fetched here.
 */
export function PlanItemThread(props: {
  /** Every comment: main comments and replies (oldest first), pending own sends last. */
  comments: readonly ShownComment[];
  workspaceId: string | null;
  me: string | null;
  highlightedId?: string | null;
  /** Offer Reply privately on others' comments, pointing here. Absent: never. */
  replyPrivately?: PlanReplyPrivatelyTarget | null;
  /** A failed own comment's Retry; absent: no Retry. */
  onRetry?: (id: string) => void;
  /** A failed own comment's Delete (it never left the device); absent: none. */
  onDiscard?: (id: string) => void;
  /** Where Copy link points; absent: no Copy link. */
  linkTo?: PlanCommentLinkTarget | null;
  /** Comment files by version id (the screen's one batched read). */
  files?: ReadonlyMap<string, CommentFile>;
  /** The thread's sub-line: the item's title. */
  threadSubtitle?: string;
  /** The open thread's reply box (chat's Composer); absent: threads do not open. */
  replyBox?: (root: ShownComment, focus: boolean) => ReactNode;
  /** A linked reply: its thread opens at it (once per id). */
  openReplyId?: string | null;
}): ReactElement {
  const layout = useChatLayout();
  const hoverMenu = useHoverPointer();
  const coarsePointer = useCoarsePointer();
  const reducedMotion = usePrefersReducedMotion();
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const [thread, setThread] = useState<OpenThread | null>(null);
  const [forwardFor, setForwardFor] = useState<ShownComment | null>(null);
  // Local read points, so an opened thread's dot goes at once (no wait for the write).
  const [readNow, setReadNow] = useState<Map<string, string>>(new Map());
  const files = props.files ?? NO_FILES;
  const held =
    props.me !== null && props.workspaceId !== null
      ? peekWorkspaceMembers(props.me, props.workspaceId)
      : null;
  const profiles = planCommentProfiles(props.comments, held, props.workspaceId);
  const nameOf = profileNameOf(profiles, props.workspaceId);
  // The recorded comments' reactions (replies too): one batched read after
  // paint, again whenever the comments refresh (the screen's own read).
  const reactionIds = useMemo(
    () => props.comments.filter(recorded).map((c) => c.id),
    [props.comments],
  );
  const reactions = useReactions({
    kind: 'plan-comment',
    ids: reactionIds,
    epoch: props.comments,
    me: props.me,
  });
  const lists = useMemo(() => planCommentLists(props.comments), [props.comments]);
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

  // ---- threads -----------------------------------------------------------
  const canThread = props.replyBox !== undefined;
  const markRead = (rootId: string): void => {
    setReadNow((prev) => new Map(prev).set(rootId, new Date().toISOString()));
    // Fire and forget: never awaited on a paint or tap path.
    setPlanCommentThreadRead(supabase, rootId, generateTraceId());
  };
  const openThread = (rootId: string, focus: boolean, focusId: string | null = null): void => {
    if (!canThread) return;
    setThread({ rootId, focus, focusId });
    markRead(rootId);
  };
  const openRootId = thread?.rootId ?? null;
  const openReplies = openRootId !== null ? (lists.replies.get(openRootId) ?? []) : [];
  const openRecorded = openReplies.filter(recorded);
  const newestOpenReply = openRecorded[openRecorded.length - 1]?.id ?? null;
  const openOwnPending = openReplies.filter((c) => c.pending).length;
  const threadScrollRef = useRef<HTMLDivElement>(null);
  useCommentThreadStick({
    scrollRef: threadScrollRef,
    rootId: openRootId,
    landing: (thread?.focusId ?? null) !== null,
    rowsKey: `${openReplies.length}:${newestOpenReply ?? ''}:${openOwnPending}`,
    ownPending: openOwnPending,
  });
  // A reply landing while the thread is open moves the read point too.
  const seenNewest = useRef<string | null>(null);
  useEffect(() => {
    if (openRootId === null) {
      seenNewest.current = null;
      return;
    }
    if (newestOpenReply === null || seenNewest.current === newestOpenReply) return;
    const first = seenNewest.current === null;
    seenNewest.current = newestOpenReply;
    if (!first) markRead(openRootId);
  }, [openRootId, newestOpenReply]);
  // A link to a reply opens its thread at that reply, once per id.
  const landedReply = useRef<string | null>(null);
  const linkedReply =
    props.openReplyId != null ? props.comments.find((c) => c.id === props.openReplyId) : undefined;
  const linkedRoot = linkedReply?.parentId ?? null;
  useEffect(() => {
    const id = props.openReplyId ?? null;
    if (id === null || linkedRoot === null || landedReply.current === id) return;
    landedReply.current = id;
    openThread(linkedRoot, false, id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.openReplyId, linkedRoot]);

  const messageOf = (c: ShownComment): ThreadMessage =>
    planCommentMessage(c, reactions.of(c.id), files);
  const displayName = (id: string): string =>
    profiles.get(id)?.displayName ??
    props.comments.find((c) => c.authorUserId === id)?.authorName ??
    '';

  const rowProps = {
    profiles,
    workspaceId: props.workspaceId,
    me: props.me,
    layout,
    hoverMenu,
    coarsePointer,
    reducedMotion,
    personSource,
    mentions,
    onOpenMenu: openMenu,
    onRetry: props.onRetry,
    onDiscard: props.onDiscard,
    reactions,
  };

  // ---- the main list ------------------------------------------------------
  const rows = planThreadRows(lists.mains, Date.now());
  const items: ReactElement[] = [];
  let afterLabel = false;
  for (const row of rows) {
    if (row.kind === 'day') {
      afterLabel = true;
      items.push(<DateLine key={row.key} label={row.label} layout={layout} />);
      continue;
    }
    const comment = row.comment;
    const under = afterLabel;
    afterLabel = false;
    const canOpen = canThread && recorded(comment);
    items.push(
      <PlanCommentRow
        key={comment.id}
        {...rowProps}
        comment={comment}
        message={messageOf(comment)}
        head={row.head}
        tail={row.tail}
        afterLabel={under}
        highlighted={props.highlightedId === comment.id}
        // A tap opens the thread with the keyboard down on touch; swipe right
        // is the explicit Reply (the reply box takes focus).
        onTapOpen={canOpen ? () => openThread(comment.id, !coarsePointer) : undefined}
        onReply={canOpen ? () => openThread(comment.id, true) : undefined}
        teamLine
      />,
    );
    const replies = (lists.replies.get(comment.id) ?? []).filter(recorded);
    if (replies.length === 0) continue;
    const info = planRepliesInfo(
      replies.map((r) => ({ author_user_id: r.authorUserId, created_at: r.createdAt })),
      readNow.get(comment.id) ?? comment.readAt ?? null,
      props.me,
    );
    items.push(
      <RepliesRow
        key={`replies:${comment.id}`}
        label={repliesLabel(info.count)}
        repliers={info.repliers.map((id) => {
          const src = profiles.get(id)?.avatarUrl;
          return { id, name: displayName(id), ...(src != null ? { src } : {}) };
        })}
        time={info.lastAt !== null ? rowWhen(info.lastAt) : ''}
        unread={info.unread}
        coarse={coarsePointer}
        onOpen={() => openThread(comment.id, !coarsePointer)}
      />,
    );
  }

  // ---- the open thread ----------------------------------------------------
  const root = openRootId !== null ? lists.mains.find((c) => c.id === openRootId) : undefined;
  let threadLayer: ReactElement | null = null;
  if (thread !== null && root !== undefined && props.replyBox !== undefined) {
    const replies = lists.replies.get(root.id) ?? [];
    const recordedCount = replies.filter(recorded).length;
    const byId = new Map(replies.map((c) => [c.id, c]));
    const forward = canForwardComment({
      sent: recorded(root),
      deleted: false,
      body: root.body,
      fileCount: root.attachmentIds?.length ?? 0,
    });
    threadLayer = (
      <CommentThreadLayer
        title={THREAD_TITLE}
        subtitle={
          props.threadSubtitle !== undefined && props.threadSubtitle !== ''
            ? props.threadSubtitle
            : undefined
        }
        rootId={root.id}
        scrollRef={threadScrollRef}
        scrollerData={{ 'data-plan-comment-thread': '' }}
        onRetry={() => undefined}
        onClosed={() => setThread(null)}
        onClose={() => setThread(null)}
        rows={
          <>
            <PlanCommentRow
              {...rowProps}
              comment={root}
              message={messageOf(root)}
              head
              tail
              afterLabel={false}
              highlighted={false}
              onReply={undefined}
              threadPlace="root"
              teamLine
            />
            <RepliesSeparatorRow
              label={recordedCount > 0 ? repliesLabel(recordedCount) : null}
              through={false}
              coarse={coarsePointer}
              family="chat"
              className="mb-2 mt-3"
              actions={{
                ...(forward ? { onForward: () => setForwardFor(root) } : {}),
                onMore: (el: HTMLElement) =>
                  setMenu({
                    comment: root,
                    anchor: el.getBoundingClientRect(),
                    reactionsOnly: false,
                    inThread: true,
                  }),
              }}
            />
            {threadRows(
              replies.map((c) => messageOf(c)),
              Date.now(),
              undefined,
              { days: false },
            ).map((r, i) => {
              if (r.kind !== 'message') return null;
              const c = byId.get(r.message.id);
              if (c === undefined) return null;
              return (
                <PlanCommentRow
                  key={c.id}
                  {...rowProps}
                  comment={c}
                  message={r.message}
                  head={r.head}
                  tail={r.tail}
                  // The first reply sits under the strip, which carries the gap (chat's afterStrip).
                  afterLabel={i === 0}
                  highlighted={thread.focusId === c.id}
                  onReply={undefined}
                  threadPlace="reply"
                  teamLine={false}
                />
              );
            })}
          </>
        }
        composer={props.replyBox(root, thread.focus)}
      />
    );
  }

  return (
    <>
      <ul data-plan-thread="" className={cn(PAGE_BLEED, 'flex flex-col')}>
        {items}
      </ul>
      {threadLayer}
      {menu !== null ? (
        <PlanCommentMenu
          menu={menu}
          me={props.me}
          workspaceId={props.workspaceId}
          profiles={profiles}
          held={held}
          replyPrivately={props.replyPrivately ?? null}
          linkTo={props.linkTo ?? null}
          onReply={
            canThread ? (c) => (recorded(c) ? openThread(c.id, true) : undefined) : undefined
          }
          onDiscard={props.onDiscard}
          onClose={() => setMenu(null)}
          reactions={reactions}
        />
      ) : null}
      {forwardFor !== null ? (
        <CommentForwardLayer
          body={() => resolveMentionText(forwardFor.body, nameOf)}
          attachmentIds={forwardFor.attachmentIds ?? []}
          files={files}
          newTrace={generateTraceId}
          onClose={() => setForwardFor(null)}
        />
      ) : null}
    </>
  );
}
