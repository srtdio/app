// Post and brief comments as a chat with threads (11 Nov 2026). Every row,
// gesture, menu, replies row, thread frame and composer is chat's own part:
//
//   * rows: chat's ThreadCommentRow (MessageBubble, swipe core, long-press /
//     right-click, laptop hover keys), grouped by chat's threadRows (same
//     sender within 5 min, a day pill between days);
//   * menu: chat's MessageActionMenu (reactions, Add to Tasks = the comment's
//     To-do, Edit, Copy text, Copy link, Reply privately, Delete last);
//   * replies: chat's RepliesRow under a comment with replies (photos,
//     "N replies", last reply time, unread dot), never inline;
//   * thread: chat's ThreadViewFrame (phone: over the post with "<"; laptop:
//     the side panel), the root (threadPlace 'root'), chat's "N replies"
//     strip (RepliesSeparatorRow), flat replies, ThreadViewFill, and chat's
//     Composer docked with chat's "Reply" hint;
//   * composer: chat's Composer in flow at the end of the list.
//
// A tap on a comment, a right swipe or "N replies" opens its thread with the
// reply box ready. No action bar, no Reply word, no checkpoints, no ticks, no
// pins. The only differences from chat are props on chat's parts: the page
// gutter (rows bleed -mx-4 so photos sit on GUTTER), the caption quote chip
// (topLine / quoteStrip), the task tag (bottomLine), the tray tiles a comment
// can store (Photos, File, Assets) and no voice note (a comment keeps no
// note length or waveform).
//
// Unread: the viewer's read point rides the comments read (COMMENT_SELECT's
// comment_thread_reads embed); comment_thread_read_set runs fire and forget
// when a thread opens and when a reply lands while it is open. Notifications
// are the server's (comment_create: every active member), untouched here.

import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactElement, ReactNode, RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Composer } from '@/components/chat/Composer';
import { MessageActionMenu } from '@/components/chat/MessageActionMenu';
import {
  DayPill,
  profileNameOf,
  threadRows,
  type BubbleMentions,
} from '@/components/chat/MessageBubble';
import { THREAD_REPLY_PLACEHOLDER } from '@/components/chat/MessageThread';
import { RepliesRow, RepliesSeparatorRow } from '@/components/chat/ThreadRail';
import { ThreadViewFill, ThreadViewFrame } from '@/components/chat/ThreadView';
import { ThreadCommentRow } from '@/components/chat/ThreadCommentRow';
import { isAgencySide, usePlanMentionMembers } from '@/components/chat/PlanItemThread';
import { useChatLayout } from '@/components/chat/chat-type';
import { useInduction } from '@/components/induction/InductionProvider';
import { CommentTaskSheet } from '@/components/comments/CommentTaskSheet';
import { CommentTaskTag } from '@/components/comments/CommentTaskTag';
import { friendlyCommentError } from '@/components/comments/comment-errors';
import {
  commentForwardFiles,
  fetchCommentFiles,
  idsToRead,
  toCommentFileAttachments,
  type CommentFile,
} from '@/components/comments/comment-files';
import { ForwardPicker } from '@/components/chat/ForwardPicker';
import { LoadError } from '@/components/ui/LoadError';
import { ClearButton } from '@/components/ui/Button';
import { PressableRow } from '@/components/ui/PressableRow';
import { PAGE_BLEED } from '@/components/ui/layout';
import { Text, textRole } from '@/components/ui/Text';
import { openPersonCardFrom } from '@/components/ui/PersonTrigger';
import { SearchWordsContext } from '@/components/ui/SearchHighlight';
import { SidePanel } from '@/components/ui/SidePanel';
import { Bone } from '@/lib/motion';
import { useOptionalToast, useToast } from '@/components/ui/toast';
import { useOpenPersonDm, useRosterSafe } from '@/components/ui/use-open-person-dm';
import { cn } from '@/lib/cn';
import type { MessageAttachment } from '@/lib/chat/attachments';
import { setPrivateReplyDraft } from '@/lib/chat/drafts';
import { canForwardComment, forwardComment } from '@/lib/chat/forward-comment';
import { isFormerMember, resolveMentionText, resolvePersonMentionText } from '@/lib/chat/mentions';
import { newMessageId } from '@/lib/chat/message-id';
import type { PrivateReplyDraft } from '@/lib/chat/private-reply';
import { sendMessageRecord } from '@/lib/chat/record';
import { repliesLabel } from '@/lib/chat/thread-signals';
import {
  distanceFromBottom,
  intentAfterScroll,
  newRowsAction,
  openingIntent,
  sizeChangeAction,
  type ScrollSource,
} from '@/lib/chat/stick-to-bottom';
import type { ThreadMessage } from '@/lib/chat/thread';
import { useCommentAttachments } from '@/lib/chat/use-chat-attachments';
import type { ChatProfile } from '@/lib/chat-reads';
import { COPY_FAILED, copyText } from '@/lib/clipboard';
import { commentTaskTag, isAgencyRole, taskStateOf, taskTitleFrom } from '@/lib/comment-tasks';
import {
  FOCUS_FAILED_COPY,
  FOCUS_MISSING_COPY,
  FOCUS_READ_RETRY_MS,
  commentFocusHref,
  useFocusTarget,
} from '@/lib/focus-target';
import { dispatchInductionDid, INDUCTION_KEYS } from '@/lib/induction';
import { logger } from '@/lib/logger';
import { mark } from '@/lib/perf-marks';
import { FORMER_MEMBER, personAvatar, personName, resolvePeople } from '@/lib/people-names';
import { useReactions, type ReactionsApi } from '@/lib/reactions/use-reactions';
import type { ReactionSummary } from '@/lib/reactions/model';
import { canReplyPrivately, commentPrivateReplyDraft } from '@/lib/reply-privately';
import { useSession } from '@/lib/session-context';
import { supabase } from '@/lib/supabase';
import { rowWhen } from '@/lib/time';
import { useNewTrace } from '@/lib/trace-context';
import { useUndoableAction } from '@/lib/use-undoable-action';
import {
  useCoarsePointer,
  useHoverPointer,
  useIsLaptop,
  usePrefersReducedMotion,
} from '@/lib/use-is-laptop';
import { peekWorkspaceMembers, useMentionCandidates } from '@/lib/workspace-members';
import {
  createComment,
  deleteComment,
  editComment,
  getCommentsByIds,
  isInvalidMention,
  listComments,
  parseMentions,
  setCommentThreadRead,
  type Client,
  type CommentEntityType,
  type CommentRow,
  type CommentTaskEmbed,
  type Result,
} from '@srtdio/comments';
import { DOMAIN_ERROR_CODES, type DomainErrorCode } from '@srtdio/rpc';
import type { Json } from '@srtdio/schemas';

// ---------------------------------------------------------------------------
// Props and words
// ---------------------------------------------------------------------------

/** One caption highlight as its comment shows it (posts only): the quote chip. */
export interface CommentAnnotation {
  quote: string;
  /** Made on an older version: inert, "copy changed · vN". */
  stale: boolean;
  versionNumber: number;
}

/** A caption selection waiting in the comment box (posts only). */
export interface CaptionQuote {
  /** Stable per selection (start:end), so the box knows a new one. */
  key: string;
  quote: string;
}

export interface CommentsProps {
  workspaceId: string;
  entityType: CommentEntityType;
  entityId: string;
  /** Caption highlights keyed by comment id; absent on briefs. */
  annotationsByCommentId?: Record<string, CommentAnnotation>;
  /** A live quote chip tapped: the page jumps to the caption highlight. */
  onAnnotationChipClick?: (commentId: string) => void;
  /** Bumped by the page (a decision, a live event) to re-read silently. */
  refreshSignal?: number;
  /** A linked comment: a top-level one scrolls into view, a reply opens its thread. */
  focusCommentId?: string | null;
  /** A fresh value per link so the same comment linked twice lands twice. */
  focusRequestKey?: string | null;
  /** Posts: the stage. On a draft the @ picker offers Creators only. */
  postStage?: string;
  /** The post or brief title: the thread's subtitle and the box's expanded title. */
  whereLabel?: string;
  /** The comment the tour teaches on (the first caption highlight's). */
  guideReplyCommentId?: string | null;
  /** A caption selection dropped into the comment box; null: none. */
  captionQuote?: CaptionQuote | null;
  /** The box's quote chip closed (its X). */
  onCaptionQuoteCancel?: () => void;
  /** A comment carrying the caption quote landed: the page anchors it. */
  onCaptionQuoteSent?: (commentId: string, quote: CaptionQuote) => void;
  /** The viewer may write top-level comments (an Approver on a draft may not). */
  canComment?: boolean;
  /** The page already read the viewer's role: Creator side (To-do, task names). Absent: from the members. */
  viewerIsAgency?: boolean;
}

/** The comment box's hint (unchanged). */
export const COMMENT_PLACEHOLDER = 'Write a comment';
/** The thread's title when it has no card (chat's word). */
export const THREAD_TITLE = 'Thread';
/** The toast when comment_create rejects a mention (an Approver on a draft post). */
export const DRAFT_MENTION_TOAST = "Clients can't see drafts. Tag them once it's in Review.";
/** The zero state (unchanged words). */
export const COMMENTS_EMPTY = 'Comments show up here.';
/** The Undo strip's word after a delete (unchanged). */
export const COMMENT_DELETED = 'Comment deleted';
/** The read cap per page (comments never page on screen: every page reads). */
export const COMMENTS_READ_PAGE = 1000;

/** The row's data hook, so a link finds a comment in either list. */
export function commentRowSelector(commentId: string): string {
  return `[data-comment-id="${commentId}"]`;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** The top-level comments in chat order (oldest first) and each one's live replies. */
export interface CommentLists {
  roots: CommentRow[];
  replies: Map<string, CommentRow[]>;
}

/**
 * Split a flat read into chat's two lists. Roots: top-level comments, oldest
 * first; a deleted root stays (its tombstone line and RepliesRow) only while
 * it has a live reply. Replies: live ones, oldest first; a deleted reply is
 * dropped. `hidden` (a delete's Undo window) drops rows as if deleted. Pure.
 */
export function commentLists(
  rows: readonly CommentRow[],
  hidden: ReadonlySet<string> = new Set(),
): CommentLists {
  const replies = new Map<string, CommentRow[]>();
  for (const row of rows) {
    if (row.parent_comment_id === null || row.deleted_at !== null || hidden.has(row.id)) continue;
    const list = replies.get(row.parent_comment_id);
    if (list) list.push(row);
    else replies.set(row.parent_comment_id, [row]);
  }
  for (const list of replies.values())
    list.sort((a, b) => a.created_at.localeCompare(b.created_at));
  const roots = rows
    .filter((row) => row.parent_comment_id === null)
    .filter((row) => {
      const gone = row.deleted_at !== null || hidden.has(row.id);
      return !gone || (replies.get(row.id)?.length ?? 0) > 0;
    })
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  return { roots, replies };
}

/**
 * Whether a thread is unread for me: a reply by someone else newer than my
 * read point; with no read point, any reply by someone else. Pure.
 */
export function threadUnread(
  readAt: string | null | undefined,
  replies: readonly Pick<CommentRow, 'author_user_id' | 'created_at'>[],
  me: string | null,
): boolean {
  const at = readAt ?? null;
  return replies.some(
    (r) => r.author_user_id !== me && (at === null || r.created_at.localeCompare(at) > 0),
  );
}

/** Up to 3 latest distinct repliers, the latest last (chat's RepliesRow photos, newest next to the count). Pure. */
export function latestRepliers(replies: readonly Pick<CommentRow, 'author_user_id'>[]): string[] {
  const out: string[] = [];
  for (let i = replies.length - 1; i >= 0 && out.length < 3; i -= 1) {
    const id = replies[i]?.author_user_id;
    if (id !== undefined && !out.includes(id)) out.push(id);
  }
  return out.reverse();
}

const NO_IDS: string[] = [];
const NO_REACTIONS: readonly ReactionSummary[] = [];

/** A recorded comment as chat's ThreadMessage (chat's bubble draws it). Pure. */
export function commentMessage(
  row: CommentRow,
  me: string | null,
  files: ReadonlyMap<string, CommentFile>,
  reactions: readonly ReactionSummary[] = NO_REACTIONS,
): ThreadMessage {
  const time = Date.parse(row.created_at);
  return {
    id: row.id,
    senderUserId: row.legacy_author_name !== null ? null : row.author_user_id,
    body: row.deleted_at !== null ? '' : row.body,
    createdAt: row.created_at,
    time: Number.isFinite(time) ? time : 0,
    provisionalTime: false,
    mine: me !== null && row.author_user_id === me && row.legacy_author_name === null,
    attachments:
      row.deleted_at !== null ? [] : toCommentFileAttachments(row.attachment_asset_ids, files),
    sharedPostIds: NO_IDS,
    sharedBriefIds: NO_IDS,
    reply: null,
    state: 'sent',
    status: 'sent',
    reactions: reactions as ThreadMessage['reactions'],
    editedAt: row.edited_at,
    deleted: row.deleted_at !== null,
    mentions: row.mentions !== null ? parseMentions(row.body) : null,
  };
}

/** One own send still on its way (or failed): chat's clock, then "Not sent" + Retry. */
export interface PendingComment {
  localId: string;
  parentId: string | null;
  body: string;
  attachments: MessageAttachment[];
  createdAt: string;
  failed: boolean;
  refusal?: string;
  quote: CaptionQuote | null;
}

/** A pending own comment as chat's ThreadMessage. Pure. */
export function pendingMessage(p: PendingComment, me: string | null): ThreadMessage {
  const time = Date.parse(p.createdAt);
  return {
    id: p.localId,
    senderUserId: me,
    body: p.body,
    createdAt: p.createdAt,
    time: Number.isFinite(time) ? time : 0,
    provisionalTime: true,
    mine: true,
    attachments: p.attachments,
    sharedPostIds: NO_IDS,
    sharedBriefIds: NO_IDS,
    reply: null,
    state: p.failed ? 'failed' : 'sending',
    status: 'sent',
    reactions: [],
    ...(p.failed && p.refusal !== undefined ? { refusal: p.refusal } : {}),
  };
}

/** What chat's menu offers on one comment (today's rules; hide what a person can't do). Pure. */
export function commentMenuOffer(input: {
  row: Pick<
    CommentRow,
    | 'author_user_id'
    | 'legacy_author_name'
    | 'deleted_at'
    | 'task_state'
    | 'body'
    | 'attachment_asset_ids'
  >;
  me: string | null;
  viewerIsAgency: boolean;
}): {
  react: boolean;
  todo: boolean;
  edit: boolean;
  copy: boolean;
  copyLink: boolean;
  delete: boolean;
  /** Forward to chats: a live comment with text or at least one file. */
  forward: boolean;
} {
  const live = input.row.deleted_at === null;
  const own =
    live &&
    input.row.legacy_author_name === null &&
    input.me !== null &&
    input.row.author_user_id === input.me;
  return {
    react: live,
    todo: live && input.viewerIsAgency && taskStateOf(input.row.task_state) === null,
    edit: own,
    copy: live && input.row.body.trim() !== '',
    copyLink: live,
    delete: own,
    forward: canForwardComment({
      sent: true,
      deleted: !live,
      body: input.row.body,
      fileCount: input.row.attachment_asset_ids?.length ?? 0,
    }),
  };
}

/**
 * A reply to a reply starts with @Name (the server keeps one level, so it posts
 * to the same thread): the replied-to author's token, never mine, never a
 * legacy author. Pure.
 */
export function replyMentionSeed(
  target: Pick<CommentRow, 'author_user_id' | 'legacy_author_name'> | null,
  me: string | null,
): string {
  if (target === null || target.legacy_author_name !== null || target.author_user_id === me)
    return '';
  return `@[${target.author_user_id}] `;
}

/** The row a landed write shows at once (comment_create returns only the id). Pure. */
export function localCommentRow(params: {
  id: string;
  workspaceId: string;
  entityType: CommentEntityType;
  entityId: string;
  authorUserId: string;
  body: string;
  attachmentVersionIds: readonly string[];
  parentCommentId: string | null;
  nowIso: string;
}): CommentRow {
  const mentions = parseMentions(params.body);
  return {
    accepted_at: null,
    accepted_by: null,
    asked_at: null,
    asked_by: null,
    attachment_asset_ids: [...params.attachmentVersionIds],
    author_user_id: params.authorUserId,
    body: params.body,
    closed_at: null,
    closed_by: null,
    created_at: params.nowIso,
    deleted_at: null,
    edited_at: null,
    entity_id: params.entityId,
    entity_type: params.entityType,
    id: params.id,
    ledger_batch_id: null,
    ledger_seq: null,
    legacy_author_email: null,
    legacy_author_name: null,
    mentions: mentions.length > 0 ? mentions : null,
    parent_comment_id: params.parentCommentId,
    resolution_note: null,
    resolved_at: null,
    resolved_by: null,
    resolved_version_id: null,
    sent_back_at: null,
    sent_back_by: null,
    task_state: null,
    unaccepted_at: null,
    unaccepted_by: null,
    workspace_id: params.workspaceId,
    comment_tasks: null,
    thread_read_at: null,
  };
}

/** Put landed rows into a list (replacing any with the same id). Pure. */
export function upsertRows(
  rows: readonly CommentRow[],
  added: readonly CommentRow[],
): CommentRow[] {
  const ids = new Set(added.map((row) => row.id));
  return [...added, ...rows.filter((row) => !ids.has(row.id))];
}

// ---------------------------------------------------------------------------
// The Pipeline's reason path (pages/pipeline/stage-reason.ts, a tab page out
// of this change's files) still writes an Approver's reason through
// comment_batch_create; nothing on the post or brief screens calls it.
// ---------------------------------------------------------------------------

export interface CheckpointPoint {
  body: string;
  attachment_version_ids?: string[];
}

export interface CheckpointRow {
  id: string;
  seq: number;
}

export interface CreateCommentBatchParams {
  workspaceId: string;
  postId: string;
  points: CheckpointPoint[];
  traceId: string;
}

export function buildBatchArgs(params: CreateCommentBatchParams): {
  p_workspace_id: string;
  p_post_id: string;
  p_points: Json;
  p_trace_id: string;
} {
  return {
    p_workspace_id: params.workspaceId,
    p_post_id: params.postId,
    p_points: params.points as unknown as Json,
    p_trace_id: params.traceId,
  };
}

export function parseBatchRows(data: unknown): CheckpointRow[] {
  if (!Array.isArray(data)) return [];
  const rows: CheckpointRow[] = [];
  for (const item of data) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
    const { id, seq } = item as { id?: unknown; seq?: unknown };
    if (typeof id === 'string' && typeof seq === 'number') rows.push({ id, seq });
  }
  return rows;
}

export async function runCreateCommentBatch(
  client: Client,
  params: CreateCommentBatchParams,
): Promise<Result<CheckpointRow[]>> {
  const args = buildBatchArgs(params);
  const { data, error } = await client.rpc('comment_batch_create', args);
  if (error) {
    const known = (DOMAIN_ERROR_CODES as readonly string[]).includes(error.message);
    return {
      ok: false,
      error: {
        code: known ? (error.message as DomainErrorCode) : 'unknown',
        message: error.message,
      },
    };
  }
  return { ok: true, data: parseBatchRows(data) };
}

// ---------------------------------------------------------------------------
// Small parts (slots handed to chat's parts)
// ---------------------------------------------------------------------------

/**
 * The caption quote chip (posts): an fg rail, the quote, no number. Live: a
 * tap jumps to the caption highlight. Stale: inert, "copy changed · vN".
 */
function QuoteChip(props: {
  annotation: CommentAnnotation;
  onOpen: (() => void) | undefined;
}): ReactElement {
  const a = props.annotation;
  if (a.stale) {
    return (
      <span
        data-caption-quote="stale"
        className={textRole(
          'body',
          'mb-2 block min-w-0 border-l-rail border-border pl-3 text-fg-2',
        )}
      >
        <span className={textRole('meta', 'block')}>copy changed · v{a.versionNumber}</span>
        {a.quote !== '' ? <span className="block [overflow-wrap:anywhere]">{a.quote}</span> : null}
      </span>
    );
  }
  return (
    <PressableRow
      type="button"
      flat
      data-caption-quote="live"
      onClick={props.onOpen}
      className={textRole(
        'body',
        'mb-2 flex min-w-0 items-start border-l-rail border-fg pl-3 text-fg-2 mv-tint hover:text-fg',
      )}
    >
      <span className="min-w-0 [overflow-wrap:anywhere]">{a.quote}</span>
    </PressableRow>
  );
}

/** The comment box's waiting caption quote: the same chip, and Clear (a Tool). */
function BoxQuote(props: { quote: CaptionQuote; onCancel: () => void }): ReactElement {
  return (
    <div data-box-caption-quote="" className="flex min-w-0 items-center gap-2 px-3 pt-2">
      <span
        className={textRole(
          'body',
          'min-w-0 flex-1 border-l-rail border-fg pl-3 text-fg-2 [overflow-wrap:anywhere]',
        )}
      >
        {props.quote.quote}
      </span>
      <ClearButton data-box-caption-quote-clear="" onClick={props.onCancel} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// The component
// ---------------------------------------------------------------------------

interface OpenMenu {
  message: ThreadMessage;
  anchor: DOMRect | null;
  reactionsOnly: boolean;
}

interface OpenThread {
  rootId: string;
  /** A reply a link landed on: tinted once. */
  focusId: string | null;
  /** Ready the reply box (a tap, swipe, or "N replies"). */
  focus: boolean;
}

let pendingSeq = 0;

/**
 * A comment thread opens at the latest reply (Thread polish 1, 11 Nov 2026):
 * chat's stick-to-bottom decisions (src/lib/chat/stick-to-bottom.ts, no
 * second scroll core) on the thread's scroller. On open it is set in a layout
 * effect, before the first paint (a thread shorter than the pane stays at the
 * top: there is nothing to scroll). While the viewer is at the end it stays
 * there when a reply lands, they send, the reply box grows or the keyboard
 * opens (visualViewport); once they scroll up it never moves them. A linked
 * reply (focusId) owns the opening position. No await, timer or read.
 */
function useCommentThreadStick(input: {
  scrollRef: RefObject<HTMLDivElement>;
  rootId: string | null;
  landing: boolean;
  /** Changes when a reply lands (count and newest id). */
  rowsKey: string;
  /** This device's own sends still pending in the open thread. */
  ownPending: number;
}): void {
  const { scrollRef, rootId, landing, rowsKey, ownPending } = input;
  const intentRef = useRef(openingIntent());
  const programRef = useRef(false);
  const pin = useCallback((): void => {
    const el = scrollRef.current;
    if (el === null || distanceFromBottom(el) === 0) return;
    programRef.current = true;
    el.scrollTop = el.scrollHeight;
  }, [scrollRef]);
  // Open: at the end before the first paint.
  useLayoutEffect(() => {
    if (rootId === null) return;
    intentRef.current = landing ? false : openingIntent();
    if (intentRef.current) pin();
    // Only a new thread re-opens; a landing change inside it does not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootId, pin]);
  // A reply lands, or the viewer sends from this device (takes hold again).
  const ownRef = useRef(ownPending);
  useLayoutEffect(() => {
    const ownLocalSend = ownPending > ownRef.current;
    ownRef.current = ownPending;
    if (rootId === null) return;
    if (ownLocalSend) intentRef.current = true;
    if (newRowsAction({ intent: intentRef.current, flicking: false, ownLocalSend }) === 'pin') {
      pin();
    }
  }, [rowsKey, ownPending, rootId, pin]);
  // Size: the rows grow (pictures, chips), the pane shrinks (reply box, keyboard).
  useEffect(() => {
    const el = scrollRef.current;
    if (rootId === null || el === null) return;
    const onSize = (): void => {
      const action = sizeChangeAction({
        intent: intentRef.current,
        pendingJump: false,
        olderPageRestore: false,
        flicking: false,
      });
      if (action === 'pin') pin();
    };
    const onScroll = (): void => {
      const source: ScrollSource = programRef.current ? 'program' : 'user';
      programRef.current = false;
      intentRef.current = intentAfterScroll({
        intent: intentRef.current,
        source,
        distanceFromBottom: distanceFromBottom(el),
      });
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onSize) : null;
    observer?.observe(el);
    const list = el.firstElementChild;
    if (list !== null) observer?.observe(list);
    const viewport = typeof window !== 'undefined' ? window.visualViewport : null;
    viewport?.addEventListener('resize', onSize);
    return () => {
      el.removeEventListener('scroll', onScroll);
      observer?.disconnect();
      viewport?.removeEventListener('resize', onSize);
    };
  }, [rootId, scrollRef, pin]);
}

/**
 * Laptop, post page: the post column's right edge (px), read from the
 * comments' side column and the page grid's column gap; null when the
 * comments do not sit in a side column (brief page, embedded, one column),
 * so the thread panel keeps its default 380. A layout read, no wait.
 */
export function postColumnRightOf(from: Element | null): number | null {
  const side = from?.closest('[data-post-side]') ?? null;
  const grid = side?.parentElement ?? null;
  if (side === null || grid === null) return null;
  const style = getComputedStyle(grid);
  if (style.gridTemplateColumns.trim().split(/\s+/).length < 2) return null;
  return side.getBoundingClientRect().left - (Number.parseFloat(style.columnGap) || 0);
}

export function Comments(props: CommentsProps): ReactElement {
  const { workspaceId, entityType, entityId } = props;
  const newTrace = useNewTrace();
  const toast = useOptionalToast();
  const undoable = useUndoableAction();
  const layout = useChatLayout();
  const laptop = useIsLaptop();
  const hoverMenu = useHoverPointer();
  const coarsePointer = useCoarsePointer();
  const reducedMotion = usePrefersReducedMotion();
  const searchWords = useContext(SearchWordsContext);
  const { session } = useSession();
  const me = session?.user.id ?? null;
  const { canAttach, uploadFile } = useCommentAttachments();
  const entityKey = `${workspaceId}:${entityType}:${entityId}`;

  // ---- the read ----------------------------------------------------------
  const [rows, setRows] = useState<CommentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState<PendingComment[]>([]);
  const [files, setFiles] = useState<Map<string, CommentFile>>(new Map());
  const [reactionEpoch, setReactionEpoch] = useState(0);
  const seqRef = useRef(0);
  const loadedRef = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const loadAll = useCallback(async (): Promise<void> => {
    const seq = ++seqRef.current;
    const silent = loadedRef.current;
    if (!silent) {
      setLoading(true);
      setLoadError(false);
    }
    const out: CommentRow[] = [];
    for (let page = 0; ; page += 1) {
      const result = await listComments(supabase, {
        workspace_id: workspaceId,
        entity_type: entityType,
        entity_id: entityId,
        page,
        pageSize: COMMENTS_READ_PAGE,
      });
      if (!mounted.current || seq !== seqRef.current) return;
      if (!result.ok) {
        if (!silent) {
          setLoading(false);
          setLoadError(true);
        }
        return;
      }
      out.push(...result.data);
      if (result.data.length < COMMENTS_READ_PAGE) break;
    }
    mark('comments:rows-in');
    loadedRef.current = true;
    setRows((prev) =>
      upsertRows(
        out,
        prev.filter((r) => r.id.startsWith('focus:')),
      ),
    );
    setReactionEpoch((n) => n + 1);
    setLoading(false);
  }, [workspaceId, entityType, entityId]);

  useEffect(() => {
    loadedRef.current = false;
    setRows([]);
    setPending([]);
    setHidden(new Set());
    void loadAll();
  }, [loadAll]);

  const lastSignal = useRef(props.refreshSignal);
  useEffect(() => {
    if (props.refreshSignal === undefined || lastSignal.current === props.refreshSignal) return;
    lastSignal.current = props.refreshSignal;
    void loadAll();
  }, [props.refreshSignal, loadAll]);

  const refreshInBackground = useCallback((): void => {
    void loadAll().catch((error: unknown) => {
      logger.warn('comments: background refresh failed', {
        error: error instanceof Error ? error.message : 'thrown',
      });
    });
  }, [loadAll]);

  const patchRow = useCallback((id: string, change: (row: CommentRow) => CommentRow): void => {
    setRows((prev) => prev.map((row) => (row.id === id ? change(row) : row)));
  }, []);

  // Every comment file in one batched read (no N+1), after paint.
  const askedFiles = useRef<Set<string>>(new Set());
  useEffect(() => {
    const needed = idsToRead(
      rows.flatMap((r) => r.attachment_asset_ids ?? []),
      askedFiles.current,
    );
    if (needed.length === 0) return;
    for (const id of needed) askedFiles.current.add(id);
    void fetchCommentFiles(supabase, needed).then((fetched) => {
      if (fetched === null) {
        for (const id of needed) askedFiles.current.delete(id);
        return;
      }
      if (!mounted.current || fetched.size === 0) return;
      setFiles((prev) => new Map([...prev, ...fetched]));
    });
  }, [rows]);

  // ---- people ------------------------------------------------------------
  const mentionMembers = usePlanMentionMembers(me, workspaceId);
  const loadMembers = mentionMembers.load;
  useEffect(() => loadMembers(), [loadMembers]);
  const held = me !== null ? peekWorkspaceMembers(me, workspaceId) : null;
  const [namesPass, setNamesPass] = useState(0);
  const askedNames = useRef<Set<string>>(new Set());
  useEffect(() => {
    const need: string[] = [];
    for (const r of rows) {
      for (const id of [r.author_user_id, ...parseMentions(r.body)]) {
        if (held?.profiles.has(id) === true || askedNames.current.has(id)) continue;
        askedNames.current.add(id);
        need.push(id);
      }
    }
    if (need.length === 0) return;
    void resolvePeople(supabase, workspaceId, need).then((ok) => {
      if (!ok) for (const id of need) askedNames.current.delete(id);
      if (mounted.current) setNamesPass((n) => n + 1);
    });
  }, [rows, held, workspaceId]);
  const profiles = useMemo(() => {
    void namesPass;
    const out = new Map<string, ChatProfile>(held?.profiles ?? []);
    for (const r of rows) {
      const id = r.author_user_id;
      if (out.has(id)) continue;
      const name = r.legacy_author_name ?? personName(workspaceId, id);
      if (name === undefined) continue;
      out.set(id, { userId: id, displayName: name, avatarUrl: personAvatar(workspaceId, id) });
    }
    return out;
  }, [held, rows, workspaceId, namesPass]);
  const nameOf = profileNameOf(profiles, workspaceId);
  const displayName = useCallback(
    (id: string | null): string =>
      id === null
        ? FORMER_MEMBER
        : (profiles.get(id)?.displayName ?? personName(workspaceId, id) ?? ''),
    [profiles, workspaceId],
  );
  // My role from the members this session holds, else the @ picker's read
  // (already started after paint for mentions): no read of its own.
  const viewerIsAgency =
    props.viewerIsAgency ??
    isAgencyRole(
      me === null
        ? null
        : (held?.rows.find((r) => r.user_id === me && r.active === true)?.role ??
            mentionMembers.members?.find((m) => m.userId === me)?.role),
    );
  // On a draft post the @ picker offers Creators only (Approvers can't see drafts).
  const draftPost = entityType === 'post' && props.postStage === 'draft';
  const pickerMembers = useMemo(() => {
    const all = (mentionMembers.members ?? []).filter((m) => m.userId !== me);
    return draftPost ? all.filter(isAgencySide) : all;
  }, [mentionMembers.members, me, draftPost]);

  // ---- lists -------------------------------------------------------------
  const lists = useMemo(() => commentLists(rows, hidden), [rows, hidden]);
  const reactionIds = useMemo(
    () => rows.filter((r) => r.deleted_at === null).map((r) => r.id),
    [rows],
  );
  const reactions = useReactions({ kind: 'comment', ids: reactionIds, epoch: reactionEpoch, me });
  const rowById = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);
  const messageOf = useCallback(
    (row: CommentRow): ThreadMessage => commentMessage(row, me, files, reactions.of(row.id)),
    [me, files, reactions],
  );

  // ---- thread view -------------------------------------------------------
  const [thread, setThread] = useState<OpenThread | null>(null);
  const [replySeed, setReplySeed] = useState<{ rootId: string; seed: string } | null>(null);
  // Local read points, so an opened thread's dot goes at once (no wait for the write).
  const [readNow, setReadNow] = useState<Map<string, string>>(new Map());
  const markRead = useCallback(
    (rootId: string): void => {
      setReadNow((prev) => new Map(prev).set(rootId, new Date().toISOString()));
      // Fire and forget: never awaited on a paint or tap path.
      void setCommentThreadRead(supabase, rootId, newTrace());
    },
    [newTrace],
  );
  const openThread = useCallback(
    (rootId: string, focus: boolean, focusId: string | null = null): void => {
      setThread({ rootId, focus, focusId });
      markRead(rootId);
      if (rootId === props.guideReplyCommentId)
        dispatchInductionDid(INDUCTION_KEYS.postCommentReply);
    },
    [markRead, props.guideReplyCommentId],
  );
  const openRootId = thread?.rootId ?? null;
  const openReplies = openRootId !== null ? (lists.replies.get(openRootId) ?? []) : [];
  const newestOpenReply = openReplies[openReplies.length - 1]?.id ?? null;
  // The open thread lands at the latest reply and stays there (item 5).
  const threadScrollRef = useRef<HTMLDivElement>(null);
  const openOwnPending =
    openRootId !== null ? pending.filter((p) => p.parentId === openRootId).length : 0;
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
  }, [openRootId, newestOpenReply, markRead]);

  // ---- links -------------------------------------------------------------
  const focusId = props.focusCommentId ?? null;
  const [focusAbsent, setFocusAbsent] = useState<string | null>(null);
  const [focusFailed, setFocusFailed] = useState<string | null>(null);
  useEffect(() => {
    if (focusId === null || focusId === '' || loading) return;
    if (rowById.has(focusId)) return;
    let active = true;
    const read = (ids: string[]) =>
      getCommentsByIds(supabase, {
        workspace_id: workspaceId,
        entity_type: entityType,
        entity_id: entityId,
        ids,
      });
    void (async () => {
      let target = await read([focusId]);
      if (active && !target.ok) {
        await new Promise((resolve) => setTimeout(resolve, FOCUS_READ_RETRY_MS));
        if (active) target = await read([focusId]);
      }
      if (!active) return;
      if (!target.ok) {
        setFocusFailed(focusId);
        return;
      }
      const row = target.data[0];
      if (row === undefined || row.deleted_at !== null) {
        setFocusAbsent(focusId);
        return;
      }
      const found = [row];
      if (row.parent_comment_id !== null) {
        const root = await read([row.parent_comment_id]);
        if (!active) return;
        if (root.ok) found.push(...root.data);
      }
      setRows((prev) => upsertRows(prev, found));
    })();
    return () => {
      active = false;
    };
  }, [focusId, loading, rowById, workspaceId, entityType, entityId]);
  // A link to a reply opens the post, then its thread at that reply.
  const landedReply = useRef<string | null>(null);
  const focusRow = focusId !== null ? rowById.get(focusId) : undefined;
  const replyLink = focusRow?.parent_comment_id ?? null;
  useEffect(() => {
    if (focusId === null || replyLink === null) return;
    const key = `${props.focusRequestKey ?? focusId}`;
    if (landedReply.current === key) return;
    landedReply.current = key;
    openThread(replyLink, false, focusId);
  }, [focusId, replyLink, props.focusRequestKey, openThread]);
  const listRef = useRef<HTMLDivElement>(null);
  // Laptop, post page (item 6): the thread panel fills beside the post column
  // and takes the comments' place; elsewhere it stays the default 380.
  const postColumnRight = useCallback(() => postColumnRightOf(listRef.current), []);
  const [besidePost, setBesidePost] = useState(false);
  useLayoutEffect(() => {
    setBesidePost(laptop && openRootId !== null && postColumnRight() !== null);
  }, [laptop, openRootId, postColumnRight]);
  useFocusTarget({
    targetId: replyLink === null ? focusId : null,
    targetKey: props.focusRequestKey ?? null,
    findElement: (id) =>
      listRef.current?.querySelector<HTMLElement>(commentRowSelector(id)) ?? null,
    absent: focusId !== null && (focusAbsent === focusId || focusFailed === focusId),
    onMissing: (id) =>
      toast?.show({
        title: focusFailed === id ? FOCUS_FAILED_COPY : FOCUS_MISSING_COPY,
        tone: 'error',
      }),
  });

  // ---- writes ------------------------------------------------------------
  const sendPending = useCallback(
    async (p: PendingComment): Promise<void> => {
      const ids: string[] = [];
      const kept: MessageAttachment[] = [];
      for (const a of p.attachments) {
        if (a.assetId !== '') {
          ids.push(a.assetId);
          kept.push(a);
          continue;
        }
        const file = a.local?.file ?? null;
        if (file === null) continue;
        const up = await uploadFile(file);
        if (!up.ok) {
          setPending((prev) =>
            prev.map((x) => (x.localId === p.localId ? { ...x, failed: true } : x)),
          );
          return;
        }
        ids.push(up.versionId);
        kept.push({ ...a, assetId: up.versionId });
      }
      const result = await createComment(supabase, {
        workspace_id: workspaceId,
        entity_type: entityType,
        entity_id: entityId,
        parent_comment_id: p.parentId,
        body: p.body,
        attachment_asset_ids: ids,
        trace_id: newTrace(),
      });
      mark('comment:rpc:end');
      if (!mounted.current) return;
      if (!result.ok) {
        const draftRefusal = draftPost && isInvalidMention(result.error);
        if (draftRefusal) toast?.show({ title: DRAFT_MENTION_TOAST, tone: 'error' });
        setPending((prev) =>
          prev.map((x) =>
            x.localId === p.localId
              ? {
                  ...x,
                  failed: true,
                  ...(draftRefusal || result.error.code !== 'unknown'
                    ? {
                        refusal: friendlyCommentError(
                          result.error,
                          p.parentId !== null ? 'post the reply' : 'post the comment',
                        ),
                      }
                    : {}),
                }
              : x,
          ),
        );
        return;
      }
      setPending((prev) => prev.filter((x) => x.localId !== p.localId));
      if (me !== null) {
        setRows((prev) =>
          upsertRows(prev, [
            localCommentRow({
              id: result.data,
              workspaceId,
              entityType,
              entityId,
              authorUserId: me,
              body: p.body,
              attachmentVersionIds: ids,
              parentCommentId: p.parentId,
              nowIso: new Date().toISOString(),
            }),
          ]),
        );
        for (const a of kept) {
          if (a.mime === '') continue;
          setFiles((prev) =>
            prev.has(a.assetId)
              ? prev
              : new Map(prev).set(a.assetId, { name: a.name, mime: a.mime }),
          );
        }
      }
      mark('comment:painted');
      if (p.parentId === null) dispatchInductionDid(INDUCTION_KEYS.postCommentPost);
      else if (p.parentId === props.guideReplyCommentId)
        dispatchInductionDid(INDUCTION_KEYS.postReplyPost);
      if (p.quote !== null) props.onCaptionQuoteSent?.(result.data, p.quote);
      refreshInBackground();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      workspaceId,
      entityType,
      entityId,
      me,
      newTrace,
      uploadFile,
      draftPost,
      refreshInBackground,
      toast,
    ],
  );

  const queueSend = (
    parentId: string | null,
    text: string,
    attachments: MessageAttachment[],
  ): void => {
    const body = text.trim();
    if (body === '' && attachments.length === 0) return;
    const quote = parentId === null ? (props.captionQuote ?? null) : null;
    pendingSeq += 1;
    const p: PendingComment = {
      localId: `pending:${pendingSeq}`,
      parentId,
      body,
      attachments,
      createdAt: new Date().toISOString(),
      failed: false,
      quote,
    };
    if (quote !== null) props.onCaptionQuoteCancel?.();
    setPending((prev) => [...prev, p]);
    void sendPending(p);
  };
  const retry = (id: string): void => {
    const p = pending.find((x) => x.localId === id);
    if (p === undefined) return;
    const again = { ...p, failed: false };
    delete again.refusal;
    setPending((prev) => prev.map((x) => (x.localId === id ? again : x)));
    void sendPending(again);
  };
  const discard = (id: string): void => setPending((prev) => prev.filter((x) => x.localId !== id));

  const [editing, setEditing] = useState<{
    id: string;
    body: string;
    rootId: string | null;
  } | null>(null);
  const saveEdit = async (text: string): Promise<{ ok: true } | { ok: false; message: string }> => {
    if (editing === null) return { ok: true };
    const result = await editComment(supabase, { commentId: editing.id, body: text }, newTrace());
    if (!result.ok)
      return { ok: false, message: friendlyCommentError(result.error, 'edit the comment') };
    const editedAt = new Date().toISOString();
    patchRow(editing.id, (row) => ({ ...row, body: text, edited_at: editedAt }));
    setEditing(null);
    refreshInBackground();
    return { ok: true };
  };

  const remove = (id: string): void => {
    const unhide = (): void =>
      setHidden((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    setHidden((prev) => new Set(prev).add(id));
    undoable.run({
      label: COMMENT_DELETED,
      commit: async () => {
        const result = await deleteComment(supabase, { commentId: id }, newTrace());
        if (!result.ok) {
          unhide();
          toast?.show({
            title: friendlyCommentError(result.error, 'delete the comment'),
            tone: 'error',
          });
          return;
        }
        const deletedAt = new Date().toISOString();
        patchRow(id, (row) => ({ ...row, deleted_at: deletedAt }));
        unhide();
        refreshInBackground();
      },
      revert: unhide,
    });
  };

  // ---- menu and task -----------------------------------------------------
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const rootInputRef = useRef<HTMLTextAreaElement | null>(null);
  const [taskFor, setTaskFor] = useState<{ commentId: string; title: string } | null>(null);
  // Forward (the replies bar's key, the sheet's tile): chat's picker, mounted while open.
  const [forwardFor, setForwardFor] = useState<CommentRow | null>(null);

  const personSource = useCallback(
    (message: ThreadMessage): PrivateReplyDraft | null => {
      const row = rowById.get(message.id);
      if (row === undefined || message.mine || message.senderUserId === null) return null;
      const name = displayName(message.senderUserId);
      const ok = canReplyPrivately({
        authorUserId: message.senderUserId,
        me,
        authorName: name,
        former: isFormerMember(workspaceId, message.senderUserId),
      });
      if (!ok) return null;
      return commentPrivateReplyDraft({
        commentId: row.id,
        authorUserId: message.senderUserId,
        authorName: name,
        excerpt: resolvePersonMentionText(row.body, workspaceId),
        whereLabel: props.whereLabel ?? '',
        entityType,
        entityId,
      });
    },
    [rowById, displayName, me, workspaceId, props.whereLabel, entityType, entityId],
  );
  const mentions = useRef<BubbleMentions>({
    peerUserId: null,
    onOpen: (hint, el) => openPersonCardFrom(el, hint),
  }).current;

  // ---- rows --------------------------------------------------------------
  const annotationFor = (id: string): ReactNode => {
    const a = props.annotationsByCommentId?.[id];
    if (a === undefined) return undefined;
    const onOpen = props.onAnnotationChipClick;
    return (
      <QuoteChip annotation={a} onOpen={onOpen !== undefined ? () => onOpen(id) : undefined} />
    );
  };
  const tagFor = (row: CommentRow): ReactNode => {
    const tag = commentTaskTag({
      state: row.task_state,
      link: row.comment_tasks ?? null,
      viewerIsAgency,
      me,
      nameOf: (id) => profiles.get(id)?.displayName ?? null,
    });
    return tag !== null ? <CommentTaskTag tag={tag} /> : undefined;
  };

  const renderRow = (
    message: ThreadMessage,
    place: { head: boolean; tail: boolean; afterLabel: boolean; threadPlace?: 'root' | 'reply' },
    wiring: { onOpen: (() => void) | undefined; highlighted: boolean },
  ): ReactElement => {
    const row = rowById.get(message.id);
    const isPending = row === undefined;
    const own = row !== undefined && commentMenuOffer({ row, me, viewerIsAgency }).delete;
    return (
      <ThreadCommentRow
        key={message.id}
        message={message}
        head={place.head}
        tail={place.tail}
        afterLabel={place.afterLabel}
        threadPlace={place.threadPlace}
        profiles={profiles}
        workspaceId={workspaceId}
        me={me}
        layout={layout}
        highlighted={wiring.highlighted}
        hoverMenu={hoverMenu}
        coarsePointer={coarsePointer}
        reducedMotion={reducedMotion}
        personSource={personSource}
        mentions={mentions}
        onOpenMenu={(anchor, reactionsOnly) =>
          setMenu({ message, anchor, reactionsOnly: reactionsOnly === true })
        }
        onReply={wiring.onOpen}
        onDelete={own ? () => remove(message.id) : undefined}
        onTapOpen={wiring.onOpen}
        onRetry={isPending ? retry : undefined}
        onDiscard={isPending ? discard : undefined}
        reactions={reactions}
        rowData={{
          'data-comment-id': message.id,
          'data-comment-side': message.mine ? 'own' : 'other',
          ...(searchWords.length > 0 ? { 'data-search-words': '' } : {}),
          // The tour's "open the thread" step: the guide's comment (its root row).
          ...(place.threadPlace === undefined && message.id === props.guideReplyCommentId
            ? { 'data-induction': INDUCTION_KEYS.postCommentReply }
            : {}),
        }}
        topLine={
          row !== undefined && row.parent_comment_id === null ? annotationFor(row.id) : undefined
        }
        bottomLine={row !== undefined && row.deleted_at === null ? tagFor(row) : undefined}
      />
    );
  };

  const listMessages: ThreadMessage[] = [
    ...lists.roots.map(messageOf),
    ...pending.filter((p) => p.parentId === null).map((p) => pendingMessage(p, me)),
  ];
  const nowMs = Date.now();
  const mainRows: ReactElement[] = [];
  let afterLabel = false;
  for (const r of threadRows(listMessages, nowMs, undefined)) {
    if (r.kind === 'day') {
      afterLabel = true;
      mainRows.push(<DayPill key={r.key} label={r.label} layout={layout} />);
      continue;
    }
    if (r.kind !== 'message') continue;
    const message = r.message;
    const under = afterLabel;
    afterLabel = false;
    const root = rowById.get(message.id);
    const canOpen = root !== undefined && root.id.startsWith('pending:') === false;
    mainRows.push(
      renderRow(
        message,
        { head: r.head, tail: r.tail, afterLabel: under },
        {
          onOpen: canOpen ? () => openThread(message.id, true) : undefined,
          highlighted: focusId === message.id && replyLink === null,
        },
      ),
    );
    const replies = root !== undefined ? (lists.replies.get(root.id) ?? []) : [];
    if (root !== undefined && replies.length > 0) {
      const last = replies[replies.length - 1];
      const readAt = readNow.get(root.id) ?? root.thread_read_at ?? null;
      mainRows.push(
        <RepliesRow
          key={`replies:${root.id}`}
          label={repliesLabel(replies.length)}
          repliers={latestRepliers(replies).map((id) => {
            const src = profiles.get(id)?.avatarUrl;
            return { id, name: displayName(id), ...(src != null ? { src } : {}) };
          })}
          time={last !== undefined ? rowWhen(last.created_at) : ''}
          unread={threadUnread(readAt, replies, me)}
          coarse={coarsePointer}
          onOpen={() => openThread(root.id, true)}
        />,
      );
    }
  }

  const composerShared = {
    disabled: false,
    viewerUserId: me ?? undefined,
    ...(canAttach ? { uploadFile } : {}),
    tray: { tiles: ['photos', 'file', 'assets'] as const, trayId: `comments-${entityId}` },
    voice: false,
    mentions: {
      members: pickerMembers,
      ready: mentionMembers.members !== null,
      isGroup: false,
      selfId: me,
      nameOf,
    },
    expandTitle:
      props.whereLabel !== undefined && props.whereLabel !== '' ? props.whereLabel : undefined,
    onCancelEdit: () => setEditing(null),
  };
  const editingHere = (rootId: string | null) =>
    editing !== null && editing.rootId === rootId
      ? {
          editing: {
            messageId: editing.id,
            initialText: editing.body,
            hasOtherContent: (rowById.get(editing.id)?.attachment_asset_ids?.length ?? 0) > 0,
          },
          onEdit: saveEdit,
        }
      : {};

  const canComment = props.canComment !== false;
  const induction = useInduction();
  const replyStepUp =
    induction?.resolution.kind === 'step' &&
    induction.resolution.step.targets.includes(INDUCTION_KEYS.postCommentReply);
  // A caption quote dropped into the box: the box takes focus (inside the
  // Comment tap's commit, so the keyboard opens on a phone).
  const quoteKey = props.captionQuote?.key ?? null;
  useEffect(() => {
    if (quoteKey !== null) rootInputRef.current?.focus({ preventScroll: false });
  }, [quoteKey]);
  const captionQuote = props.captionQuote ?? null;

  const threadRoot = openRootId !== null ? rowById.get(openRootId) : undefined;

  return (
    <div
      ref={listRef}
      data-comments=""
      data-entity={entityType}
      // Laptop, post page: the open thread takes the comments' place (they stay
      // mounted and keep their scroll, hidden; the panel shows through).
      data-comments-covered={besidePost ? '' : undefined}
      className={besidePost ? 'invisible' : undefined}
      // The tour's "open the thread" step: its whole row is the target, so a
      // tap anywhere on it (the quote chip included) opens the thread. Only
      // while that step is up; otherwise the row is chat's.
      onClick={(e) => {
        const guide = props.guideReplyCommentId ?? null;
        if (guide === null || !replyStepUp || thread?.rootId === guide) return;
        const target = e.target as Element;
        const row = target.closest(commentRowSelector(guide));
        if (row !== null && row.closest('[data-comment-thread]') === null) openThread(guide, true);
      }}
    >
      {loading ? (
        <ul data-comments-loading="" aria-busy="true" className="flex flex-col gap-3 py-2">
          <li className="sr-only">Loading comments</li>
          {['w-48', 'w-36'].map((w) => (
            <li key={w} className="flex gap-3" aria-hidden="true">
              <Bone lit="lit-avatar" as="span" className="h-8 w-8 shrink-0 rounded-lg" />
              <span className="flex min-w-0 flex-1 flex-col gap-2">
                <Bone lit="flat" className="h-3 w-24 rounded" />
                <Bone lit="flat" className={cn('h-4 rounded', w)} />
              </span>
            </li>
          ))}
        </ul>
      ) : loadError ? (
        <LoadError title="comments" onRetry={() => void loadAll()} />
      ) : mainRows.length === 0 ? (
        <Text role="secondary" as="p" data-comments-empty="">
          {COMMENTS_EMPTY}
        </Text>
      ) : (
        <ul data-comments-list="" className={cn(PAGE_BLEED, 'flex flex-col')}>
          {mainRows}
        </ul>
      )}
      {canComment ? (
        <div data-comments-composer="" className="mt-6">
          <Composer
            key={`root:${entityKey}`}
            inputRef={rootInputRef}
            sendAnchor={INDUCTION_KEYS.postCommentPost}
            channelId={`comments:${entityKey}`}
            placeholder={COMMENT_PLACEHOLDER}
            onSend={(text, attachments) => queueSend(null, text, attachments)}
            {...composerShared}
            {...editingHere(null)}
            {...(captionQuote !== null
              ? {
                  quoteStrip: (
                    <BoxQuote
                      quote={captionQuote}
                      onCancel={() => props.onCaptionQuoteCancel?.()}
                    />
                  ),
                }
              : {})}
          />
        </div>
      ) : null}

      {thread !== null && threadRoot !== undefined
        ? (() => {
            const replies = lists.replies.get(threadRoot.id) ?? [];
            const replyMessages = [
              ...replies.map(messageOf),
              ...pending
                .filter((p) => p.parentId === threadRoot.id)
                .map((p) => pendingMessage(p, me)),
            ];
            const offer = commentMenuOffer({ row: threadRoot, me, viewerIsAgency });
            const frame = (
              <ThreadViewFrame
                title={THREAD_TITLE}
                subtitle={
                  props.whereLabel !== undefined && props.whereLabel !== ''
                    ? props.whereLabel
                    : undefined
                }
                selecting={false}
                onClosed={() => {
                  setThread(null);
                  setReplySeed(null);
                }}
              >
                <div
                  ref={threadScrollRef}
                  data-comment-thread={threadRoot.id}
                  className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
                >
                  {/* pb-3: 12 between the last row (its chips included) and the reply box. */}
                  <ul className="flex flex-col pb-3 pt-4">
                    {renderRow(
                      messageOf(threadRoot),
                      { head: true, tail: true, afterLabel: false, threadPlace: 'root' },
                      { onOpen: undefined, highlighted: false },
                    )}
                    <RepliesSeparatorRow
                      label={replies.length > 0 ? repliesLabel(replies.length) : null}
                      through={false}
                      coarse={coarsePointer}
                      family="chat"
                      className="mb-2 mt-3"
                      actions={{
                        ...(offer.todo
                          ? {
                              onTasks: () =>
                                setTaskFor({
                                  commentId: threadRoot.id,
                                  title: taskTitleFrom(resolveMentionText(threadRoot.body, nameOf)),
                                }),
                            }
                          : {}),
                        ...(offer.forward ? { onForward: () => setForwardFor(threadRoot) } : {}),
                        onMore: (el: HTMLElement) =>
                          setMenu({
                            message: messageOf(threadRoot),
                            anchor: el.getBoundingClientRect(),
                            reactionsOnly: false,
                          }),
                      }}
                    />
                    {threadRows(replyMessages, Date.now(), undefined, { days: false }).map(
                      (r, i) =>
                        r.kind === 'message'
                          ? renderRow(
                              r.message,
                              // The first reply sits under the strip, which carries the gap (chat's afterStrip).
                              {
                                head: r.head,
                                tail: r.tail,
                                afterLabel: i === 0,
                                threadPlace: 'reply',
                              },
                              { onOpen: undefined, highlighted: thread.focusId === r.message.id },
                            )
                          : null,
                    )}
                  </ul>
                </div>
                <ThreadViewFill loading={false} failed={false} onRetry={() => void loadAll()} />
                <div data-comment-thread-composer="">
                  <Composer
                    {...(threadRoot.id === props.guideReplyCommentId
                      ? { sendAnchor: INDUCTION_KEYS.postReplyPost }
                      : {})}
                    key={`thread:${threadRoot.id}:${replySeed?.rootId === threadRoot.id ? replySeed.seed : ''}`}
                    channelId={`comment-thread:${threadRoot.id}`}
                    placeholder={THREAD_REPLY_PLACEHOLDER}
                    focusOnMount={!coarsePointer}
                    focusForReply={thread.focus}
                    onSend={(text, attachments) => {
                      const seed = replySeed?.rootId === threadRoot.id ? replySeed.seed : '';
                      queueSend(
                        threadRoot.id,
                        seed !== '' && !text.startsWith('@') ? `${seed}${text}` : text,
                        attachments,
                      );
                      setReplySeed(null);
                    }}
                    {...composerShared}
                    {...editingHere(threadRoot.id)}
                  />
                </div>
              </ThreadViewFrame>
            );
            return laptop ? (
              <SidePanel
                open
                bare
                title={THREAD_TITLE}
                onClose={() => setThread(null)}
                fillBeside={postColumnRight}
              >
                {frame}
              </SidePanel>
            ) : (
              createPortal(
                <div data-comment-thread-layer="" className="fixed inset-0 z-sheet">
                  {frame}
                </div>,
                document.body,
              )
            );
          })()
        : null}

      {menu !== null ? (
        <CommentMenu
          menu={menu}
          row={rowById.get(menu.message.id) ?? null}
          me={me}
          viewerIsAgency={viewerIsAgency}
          reactions={reactions}
          nameOf={nameOf}
          entityType={entityType}
          entityId={entityId}
          inThread={thread !== null}
          personSource={personSource}
          onClose={() => setMenu(null)}
          onTodo={(row) =>
            setTaskFor({
              commentId: row.id,
              title: taskTitleFrom(resolveMentionText(row.body, nameOf)),
            })
          }
          onEdit={(row) =>
            setEditing({
              id: row.id,
              body: row.body,
              rootId: row.parent_comment_id ?? (thread !== null ? row.id : null),
            })
          }
          onDelete={(row) => remove(row.id)}
          onDiscard={discard}
          onForward={setForwardFor}
        />
      ) : null}

      {forwardFor !== null ? (
        <CommentForwardLayer
          row={forwardFor}
          files={files}
          nameOf={nameOf}
          newTrace={newTrace}
          onClose={() => setForwardFor(null)}
        />
      ) : null}

      {taskFor !== null ? (
        <CommentTaskLayer
          workspaceId={workspaceId}
          commentId={taskFor.commentId}
          title={taskFor.title}
          me={me}
          newTrace={newTrace}
          onClose={() => setTaskFor(null)}
          onCreated={(commentId, link) => {
            patchRow(commentId, (row) => ({ ...row, task_state: 'assigned', comment_tasks: link }));
            refreshInBackground();
          }}
          onExists={refreshInBackground}
        />
      ) : null}
    </div>
  );
}

/**
 * The open comment's long-press menu: chat's MessageActionMenu with what a
 * comment stores (reactions, Forward = one chat message with the comment's
 * text and files, Add to Tasks = To-do, Edit, Copy link, Copy text, Reply
 * privately, Delete last; a failed own send's Delete). No Reply (a tap opens
 * the thread), no Mark unread, no Save to notes. Mounted
 * only while open, so its hooks never run on paint.
 */
function CommentMenu(props: {
  menu: OpenMenu;
  row: CommentRow | null;
  me: string | null;
  viewerIsAgency: boolean;
  reactions: ReactionsApi;
  nameOf: ReturnType<typeof profileNameOf>;
  entityType: CommentEntityType;
  entityId: string;
  inThread: boolean;
  personSource: (message: ThreadMessage) => PrivateReplyDraft | null;
  onClose: () => void;
  onTodo: (row: CommentRow) => void;
  onEdit: (row: CommentRow) => void;
  onDelete: (row: CommentRow) => void;
  onDiscard: (localId: string) => void;
  onForward: (row: CommentRow) => void;
}): ReactElement {
  const toast = useToast();
  const openDm = useOpenPersonDm();
  const m = props.menu.message;
  const row = props.row;
  const failedSend = row === null && m.state === 'failed';
  const offer =
    row !== null
      ? commentMenuOffer({ row, me: props.me, viewerIsAgency: props.viewerIsAgency })
      : {
          react: false,
          todo: false,
          edit: false,
          copy: m.body.trim() !== '',
          copyLink: false,
          delete: false,
          forward: false,
        };
  const draft = row !== null ? props.personSource(m) : null;
  return (
    <MessageActionMenu
      open
      onClose={props.onClose}
      anchor={props.menu.anchor}
      mine={m.mine}
      currentReaction={props.reactions.of(m.id).find((r) => r.mine)?.emoji ?? null}
      canReact={offer.react}
      reactionsOnly={props.menu.reactionsOnly}
      canReply={false}
      onReply={() => undefined}
      canCopy={offer.copy}
      onCopy={() => {
        void copyText(resolveMentionText(m.body, props.nameOf)).then((ok) =>
          toast.show({ title: ok ? 'Message copied' : COPY_FAILED }),
        );
      }}
      onReact={(emoji) => {
        if (offer.react) props.reactions.toggle(m.id, emoji);
      }}
      canForward={offer.forward}
      onForward={() => {
        if (row !== null) props.onForward(row);
      }}
      canAddToTasks={offer.todo}
      onAddToTasks={() => {
        if (row !== null) props.onTodo(row);
      }}
      canEdit={offer.edit}
      onEdit={() => {
        if (row !== null) props.onEdit(row);
      }}
      canCopyLink={offer.copyLink}
      onCopyLink={() => {
        const href = commentFocusHref(props.entityType, props.entityId, m.id);
        void copyText(`${window.location.origin}${href}`).then((ok) =>
          toast.show({ title: ok ? 'Link copied' : COPY_FAILED }),
        );
      }}
      canReplyPrivately={draft !== null}
      replyPrivatelyName={draft?.authorName ?? ''}
      onReplyPrivately={() => {
        if (draft === null) return;
        openDm(draft.authorUserId, {
          beforeOpen: (channelId) => setPrivateReplyDraft(channelId, draft),
        });
      }}
      canDelete={offer.delete || failedSend}
      failedSend={failedSend}
      onDelete={() => {
        if (failedSend) props.onDiscard(m.id);
        else if (row !== null) props.onDelete(row);
      }}
    />
  );
}

/**
 * Forward a comment (Thread polish 2): chat's ForwardPicker, then one chat
 * message per picked chat with the comment's text and its files as stored
 * (forwardComment, shared with catch up). Mounted only while open; file
 * details the screen does not hold yet are read after Send, never on the tap.
 * Success and failure feedback are the picker's own.
 */
function CommentForwardLayer(props: {
  row: CommentRow;
  files: ReadonlyMap<string, CommentFile>;
  nameOf: ReturnType<typeof profileNameOf>;
  newTrace: () => string;
  onClose: () => void;
}): ReactElement {
  const roster = useRosterSafe();
  const { row } = props;
  return (
    <ForwardPicker
      historyStep
      open
      onClose={props.onClose}
      channels={roster}
      onSend={(chats) =>
        forwardComment({
          targets: chats,
          load: async () => {
            const attachments = await commentForwardFiles(
              supabase,
              row.attachment_asset_ids ?? [],
              props.files,
            );
            if (attachments === null) return null;
            return { body: resolveMentionText(row.body, props.nameOf), attachments };
          },
          send: (record) => sendMessageRecord({ client: supabase, ...record }),
          newId: newMessageId,
          newTrace: props.newTrace,
        })
      }
      onSent={props.onClose}
    />
  );
}

/** The To-do sheet (comment_task_create), mounted only while open; members read then. */
function CommentTaskLayer(props: {
  workspaceId: string;
  commentId: string;
  title: string;
  me: string | null;
  newTrace: () => string;
  onClose: () => void;
  onCreated: (commentId: string, link: CommentTaskEmbed) => void;
  onExists: () => void;
}): ReactElement {
  const { candidates } = useMentionCandidates(props.workspaceId);
  return (
    <CommentTaskSheet
      open
      onClose={props.onClose}
      workspaceId={props.workspaceId}
      commentId={props.commentId}
      initialTitle={props.title}
      me={props.me}
      candidates={candidates}
      newTrace={props.newTrace}
      onCreated={(link) => props.onCreated(props.commentId, link)}
      onExists={props.onExists}
    />
  );
}

/** For tests: the reply-to-reply seed builder's input from a row. */
export function replySeedFor(row: CommentRow | undefined, me: string | null): string {
  return replyMentionSeed(row ?? null, me);
}
