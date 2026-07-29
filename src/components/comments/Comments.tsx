import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Textarea';
import { IconButton } from '@/components/ui/IconButton';
import { IconCheck, IconCopy, IconMore } from '@/components/ui/icons';
import { MenuPopover } from '@/components/shell/MenuPopover';
import { Avatar } from '@/components/ui/Avatar';
import { cn } from '@/lib/cn';
import { relativeLong, relativeShort } from '@/lib/relative-time';
import { MessageAttachments } from '@/components/chat/MessageAttachments';
import { useChatAttachments } from '@/lib/chat/use-chat-attachments';
import { supabase } from '@/lib/supabase';
import { useNewTrace } from '@/lib/trace-context';
import {
  createComment,
  deleteComment,
  editComment,
  listComments,
  parseMentions,
  resolveComment,
  PAGE_SIZE,
} from '@srtdio/comments';
import type {
  Client,
  CommentEntityType,
  CommentRow,
  CreateCommentInput,
  Result,
} from '@srtdio/comments';
import { checkpointAccept, commentResolve, DOMAIN_ERROR_CODES } from '@srtdio/rpc';
import type { DomainErrorCode } from '@srtdio/rpc';
import type { Json } from '@srtdio/schemas';
import type { MessageAttachment } from '@/lib/chat/attachments';
import { CommentComposer } from '@/components/comments/CommentComposer';
import { SlotComposer } from '@/components/comments/SlotComposer';
import type { CheckpointPoint } from '@/components/comments/SlotComposer';
import { CommentImageLightbox, commentImageNav } from '@/components/comments/CommentImageLightbox';
import { useMentionCandidates } from '@/components/comments/useMentionCandidates';
import type { MentionCandidate } from '@/components/comments/useMentionCandidates';
import { flashNode } from '@/components/comments/flash-node';
import {
  EX_MEMBER_LABEL,
  fetchCommentProfiles,
  resolveName,
  type CommentProfile,
} from '@/components/comments/commentProfiles';
import {
  buildResolveArgs,
  friendlyAcceptError,
  friendlyPointFreezeError,
  friendlyResolveError,
  MAX_NOTE_CHARS,
  NOTE_PLACEHOLDER,
  noteRevealClass,
  tickCircle,
} from '@/components/pages/pcs/checkpoint-controls';

/** One caption_span annotation as it reads on a comment row. Optional surface:
 *  posts pass it, briefs never do, so the chips are post-only by construction. */
export interface CommentAnnotation {
  n: number;
  quote: string;
  stale: boolean;
  versionNumber: number;
}

interface CommentsProps {
  workspaceId: string;
  entityType: CommentEntityType;
  entityId: string;
  /** Caption annotations keyed by comment id; absent on briefs (no chips). */
  annotationsByCommentId?: Record<string, CommentAnnotation>;
  /** Click a live chip; PostDetailPage scrolls to and flashes the highlight. */
  onAnnotationChipClick?: (commentId: string) => void;
  /** Bumped by the parent (e.g. after an annotate) to refetch page 0. */
  refreshSignal?: number;
  /** Email deep-link target: once this comment is present in the loaded list it
   *  is scrolled to and flashed exactly once (per distinct id). */
  focusCommentId?: string | null;
  /** True when the viewer's workspace role is 'client'. Gates ONLY the
   *  top-level composer on posts, which becomes the checkpoint SlotComposer
   *  (comment_batch_create). Replies (any role), the agency composer, and the
   *  brief mount (which never passes this) keep CommentComposer unchanged. */
  viewerIsClient?: boolean;
}

/** Stable DOM id for a comment row, so a caption highlight can scroll to it. */
export function commentDomId(commentId: string): string {
  return `comment-${commentId}`;
}

/**
 * The caption-annotation chip for one comment row. Live (current copy) renders
 * as a clickable amber chip with its quote; stale renders greyed and inert as
 * "copy changed" with the version it was made on. Absent annotation (every
 * brief comment) renders nothing, so the brief path is byte-unchanged.
 */
export function annotationChip(
  commentId: string,
  annotation: CommentAnnotation | undefined,
  onClick?: (commentId: string) => void,
): ReactNode {
  if (annotation === undefined) return null;
  if (annotation.stale) {
    return (
      <div className="mt-2 min-w-0">
        <span className="flex w-fit max-w-full min-w-0 items-center gap-1.5 rounded-md border border-border bg-panel-3 px-2.5 py-1 text-xs text-fg-3">
          <span className="font-medium shrink-0">copy changed · v{annotation.versionNumber}</span>
          {annotation.quote !== '' ? (
            <span className="min-w-0 truncate">{annotation.quote}</span>
          ) : null}
        </span>
      </div>
    );
  }
  return (
    <div className="mt-2 min-w-0">
      <button
        type="button"
        onClick={() => onClick?.(commentId)}
        className="flex w-fit max-w-full min-w-0 min-h-[44px] items-center gap-1.5 rounded-md border border-annotation-line bg-annotation-bg px-2.5 py-1 text-xs text-fg hover:opacity-90"
      >
        <sup className="shrink-0 text-[10px] font-semibold text-annotation-line">
          {annotation.n}
        </sup>
        <span className="min-w-0 truncate">{annotation.quote}</span>
      </button>
    </div>
  );
}

// Format a stored timestamp as a localized date and time. Falls back to the raw
// value if it is somehow unparseable so nothing is silently dropped.
function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

// ---------------------------------------------------------------------------
// Pure thread / render helpers (unit-tested without a DOM)
// ---------------------------------------------------------------------------

/** A top-level comment with its live replies. `tombstone` is true when the root
 *  itself is soft-deleted but kept because at least one live reply remains. */
export interface ThreadRoot {
  comment: CommentRow;
  replies: CommentRow[];
  tombstone: boolean;
}

/**
 * Group a flat, newest-first list into one-level threads. Roots are comments
 * with no parent; replies are grouped under their parent and shown oldest-first.
 * Deleted replies are dropped (a reply has no sub-replies, so a deleted one is
 * never a tombstone). A deleted root is kept as a tombstone only while it still
 * has a live reply; a deleted root with no live reply is omitted entirely.
 */
export function buildThreads(rows: readonly CommentRow[]): ThreadRoot[] {
  const repliesByParent = new Map<string, CommentRow[]>();
  for (const row of rows) {
    if (row.parent_comment_id !== null) {
      const list = repliesByParent.get(row.parent_comment_id);
      if (list) list.push(row);
      else repliesByParent.set(row.parent_comment_id, [row]);
    }
  }

  const threads: ThreadRoot[] = [];
  for (const row of rows) {
    if (row.parent_comment_id !== null) continue;
    const liveReplies = (repliesByParent.get(row.id) ?? [])
      .filter((reply) => reply.deleted_at === null)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
    const deleted = row.deleted_at !== null;
    if (deleted && liveReplies.length === 0) continue;
    threads.push({ comment: row, replies: liveReplies, tombstone: deleted });
  }
  return threads;
}

/** A comment may be edited / deleted only by its author, and only while live. */
export function canModifyComment(
  comment: Pick<CommentRow, 'author_user_id' | 'deleted_at' | 'legacy_author_name'>,
  currentUserId: string | null,
): boolean {
  if (comment.legacy_author_name !== null) return false;
  return (
    currentUserId !== null &&
    comment.author_user_id === currentUserId &&
    comment.deleted_at === null
  );
}

/**
 * The seed body for a reply composer: pre-tag the comment's author so the reply
 * opens with "@Author ". Guards mean we never tag an ex-member (legacy) author,
 * never tag yourself, and only seed when the author is in the mention candidate
 * list so the @[uuid] token resolves to a name. Otherwise the seed is empty and
 * the composer mounts blank exactly as before.
 */
export function replySeed(
  comment: Pick<CommentRow, 'author_user_id' | 'legacy_author_name'>,
  currentUserId: string | null,
  candidates: readonly MentionCandidate[],
): string {
  return comment.legacy_author_name === null &&
    comment.author_user_id !== currentUserId &&
    candidates.some((c) => c.id === comment.author_user_id)
    ? `@[${comment.author_user_id}] `
    : '';
}

const MENTION_TOKEN = /@\[([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\]/gi;
const URL_TOKEN = /https?:\/\/[^\s<]+/gi;
const URL_TRAILING = /[.,;:!?)\]}'"]+$/;

/**
 * Render a comment body, replacing every @[uuid] mention token with an inline,
 * accent-styled "@Name" run (the bare uuid is never shown). An id that no longer
 * resolves to a member renders "@(ex-member)". Surrounding text is returned
 * verbatim so the caller's whitespace-pre-wrap preserves the original layout.
 */
function pushBodyText(nodes: ReactNode[], text: string, keyBase: string): void {
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(URL_TOKEN)) {
    const start = m.index ?? 0;
    let href = m[0];
    const trail = href.match(URL_TRAILING);
    const suffix = trail !== null ? trail[0] : '';
    if (suffix !== '') href = href.slice(0, href.length - suffix.length);
    if (start > last) nodes.push(text.slice(last, start));
    nodes.push(
      <a
        key={`${keyBase}-u${i}`}
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-accent underline underline-offset-2 [overflow-wrap:anywhere]"
      >
        {href}
      </a>,
    );
    if (suffix !== '') nodes.push(suffix);
    i += 1;
    last = start + m[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
}

export function renderCommentBody(
  body: string,
  nameOf: (id: string) => string | null,
): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const match of body.matchAll(MENTION_TOKEN)) {
    const start = match.index ?? 0;
    if (start > last) pushBodyText(nodes, body.slice(last, start), `t${key}`);
    const id = (match[1] ?? '').toLowerCase();
    const name = nameOf(id);
    nodes.push(
      <span key={`m-${key}`} className="font-medium text-accent">
        @{name ?? EX_MEMBER_LABEL}
      </span>,
    );
    key += 1;
    last = start + match[0].length;
  }
  if (last < body.length) pushBodyText(nodes, body.slice(last), `t${key}`);
  return nodes;
}

/** The tombstone line for a soft-deleted root. Author-only delete means the
 *  deleter is the author; name it when it resolves, else stay anonymous. */
export function tombstoneText(
  comment: Pick<CommentRow, 'author_user_id' | 'deleted_at' | 'created_at' | 'legacy_author_name'>,
  nameOf: (id: string) => string | null,
): string {
  const when = formatTimestamp(comment.deleted_at ?? comment.created_at);
  const who = comment.legacy_author_name ?? nameOf(comment.author_user_id);
  return who !== null ? `Deleted by ${who} · ${when}` : `Comment deleted · ${when}`;
}

/** Map a comment's stored version ids to renderable attachments. The mime is
 *  resolved from a batched asset_versions read so image vs file dispatch is
 *  correct; an unresolved mime renders as a file chip. */
export function toCommentAttachments(
  versionIds: readonly string[] | null,
  mimeById: ReadonlyMap<string, string>,
): MessageAttachment[] {
  return (versionIds ?? []).map((id) => ({
    assetId: id,
    name: '',
    mime: mimeById.get(id) ?? '',
  }));
}

/**
 * The always-open replies list under a thread root. Replies are permanent:
 * rendered whenever the thread has at least one live reply, with no expander
 * gate and no interaction required. Zero replies renders nothing at all (no
 * empty <ul> container). Each reply keeps its stable per-row DOM id so a
 * deep-link can scroll to it. `renderReply` is the caller's card renderer.
 */
export function renderReplyList(
  replies: readonly CommentRow[],
  renderReply: (reply: CommentRow) => ReactNode,
): ReactNode {
  if (replies.length === 0) return null;
  return (
    <ul className="mt-3 flex flex-col gap-3 border-l border-border pl-4">
      {replies.map((reply) => (
        <li key={reply.id} id={commentDomId(reply.id)}>
          {renderReply(reply)}
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Checkpoint batches in the thread (feedback ledger)
// ---------------------------------------------------------------------------

/** One rendered item of the thread list: a plain one-level thread, or a run of
 *  consecutive checkpoint threads from the same author (collapsed into one card). */
export type ThreadGroup =
  | { kind: 'single'; thread: ThreadRoot }
  | { kind: 'batch'; authorId: string; threads: ThreadRoot[] };

/**
 * Collapse consecutive TOP-LEVEL checkpoint threads (ledger_seq not null) from
 * the SAME author into one card; every other thread passes through unchanged.
 * Only adjacency in the newest-first list groups, so two runs from the same
 * author separated by an ordinary comment stay separate. Points inside a card
 * are ordered by created_at descending (newest send on top) with ledger_seq
 * ascending as the tie-breaker so points from one send read in order.
 */
export function groupThreads(threads: readonly ThreadRoot[]): ThreadGroup[] {
  const groups: ThreadGroup[] = [];
  for (const thread of threads) {
    const authorId = thread.comment.ledger_seq !== null ? thread.comment.author_user_id : null;
    const last = groups[groups.length - 1];
    if (
      authorId !== null &&
      last !== undefined &&
      last.kind === 'batch' &&
      last.authorId === authorId
    ) {
      last.threads.push(thread);
    } else if (authorId !== null) {
      groups.push({ kind: 'batch', authorId, threads: [thread] });
    } else {
      groups.push({ kind: 'single', thread });
    }
  }
  for (const group of groups) {
    if (group.kind === 'batch') {
      group.threads.sort((a, b) => {
        const byTime = b.comment.created_at.localeCompare(a.comment.created_at);
        return byTime !== 0 ? byTime : (a.comment.ledger_seq ?? 0) - (b.comment.ledger_seq ?? 0);
      });
    }
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Checkpoint state + controls in the feed (derived from columns, never stored)
// ---------------------------------------------------------------------------

/** A checkpoint's live state, read straight off its columns:
 *  resolved_at null -> 'open' (the agency owes work); resolved and unconfirmed ->
 *  'client_turn' (the agency marked it done, it awaits the client); accepted ->
 *  'confirmed'. Confirmed requires resolved, so an agency reopen (resolved_at back
 *  to null) drops a confirmed point straight to 'open'. */
export type CheckpointState = 'open' | 'client_turn' | 'confirmed';
export function checkpointState(
  row: Pick<CommentRow, 'resolved_at' | 'accepted_at'>,
): CheckpointState {
  if (row.resolved_at === null) return 'open';
  return row.accepted_at !== null ? 'confirmed' : 'client_turn';
}

/** The state label text + design tokens for one checkpoint row. The wording turns
 *  on the viewer's side; the tokens pair a foreground with its matching soft
 *  background so the label reads as a chip: muted (open), accent (client's turn),
 *  or success (confirmed). Open has no dedicated soft token, so it borrows the
 *  neutral raised surface (panel-3). */
export interface CheckpointLabel {
  text: string;
  className: string;
}
export function checkpointStateLabel(state: CheckpointState, isClient: boolean): CheckpointLabel {
  switch (state) {
    case 'open':
      return { text: isClient ? 'With agency' : 'Open', className: 'bg-panel-3 text-fg-3' };
    case 'client_turn':
      return {
        text: isClient ? 'Your turn' : 'With client',
        className: 'bg-accent-soft text-accent',
      };
    case 'confirmed':
      return { text: 'Confirmed', className: 'bg-good-soft text-good' };
  }
}

/** The tick is a live control only for the actor whose turn it is: the agency
 *  while the point is open, the client while it is resolved-and-unconfirmed.
 *  Every other case is a passive indicator. */
export function tickInteractive(state: CheckpointState, isClient: boolean): boolean {
  return isClient ? state === 'client_turn' : state === 'open';
}

/** The passive tick's fill: the agency's tick fills once the point is resolved;
 *  the client's fills once they have confirmed. */
export function tickFilled(state: CheckpointState, isClient: boolean): boolean {
  return isClient ? state === 'confirmed' : state !== 'open';
}

/** "Not done" (the client un-resolves, then must say why) shows only on the
 *  client's turn; "Undo" (the client withdraws a confirmation) only once
 *  confirmed. An agency member sees neither. */
export function showCheckpointNotDone(state: CheckpointState, isClient: boolean): boolean {
  return isClient && state === 'client_turn';
}
export function showCheckpointUndo(state: CheckpointState, isClient: boolean): boolean {
  return isClient && state === 'confirmed';
}

/** The withdrawal record shows only when a confirmation was withdrawn: the point
 *  is the client's turn again (resolved, unconfirmed) AND an unaccepted stamp
 *  exists. An agency un-tick returns the point to 'open', so this stays false
 *  there; a point that simply never was confirmed has no unaccepted stamp. */
export function showCheckpointWithdrawal(
  row: Pick<CommentRow, 'resolved_at' | 'accepted_at' | 'unaccepted_at'>,
): boolean {
  return checkpointState(row) === 'client_turn' && row.unaccepted_at !== null;
}

/** The one-line withdrawal record, naming the withdrawing member through the same
 *  chain the rest of the file uses (ex-member fallback when the id no longer
 *  resolves to a member). */
export function checkpointWithdrawalText(unacceptedAt: string, name: string | null): string {
  return `Confirmation withdrawn by ${name ?? EX_MEMBER_LABEL} · ${relativeLong(
    unacceptedAt,
    new Date(),
  )}`;
}

/** The pushback reason prompt. Un-resolving without saying why is the failure
 *  mode "Not done" exists to prevent, so the reply composer opens pre-filled with
 *  this line. No em-dash (user-facing string). */
export const PUSHBACK_SEED = 'This point has gone back to the agency. What is still off? ';

/** The seed body for a checkpoint's reply composer: the pushback prompt after a
 *  "Not done", otherwise the ordinary author pre-tag. */
export function checkpointReplySeed(
  pushback: boolean,
  comment: Pick<CommentRow, 'author_user_id' | 'legacy_author_name'>,
  currentUserId: string | null,
  candidates: readonly MentionCandidate[],
): string {
  return pushback ? PUSHBACK_SEED : replySeed(comment, currentUserId, candidates);
}

/** Merge the always-loaded checkpoints into the paginated list, de-duped by id
 *  and re-sorted newest-first. Only non-checkpoint comments paginate, so a
 *  checkpoint that fell beyond page zero is still present and its controls stay
 *  reachable. */
export function mergeCheckpoints(
  paged: readonly CommentRow[],
  checkpoints: readonly CommentRow[],
): CommentRow[] {
  const seen = new Set(paged.map((row) => row.id));
  const merged = [...paged, ...checkpoints.filter((row) => !seen.has(row.id))];
  return merged.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

/** Which row actions a comment offers. Copy is harmless and shown on every live
 *  comment; edit / delete stay author-only; a tombstone offers nothing. */
export interface CommentActions {
  canCopy: boolean;
  canEdit: boolean;
  canDelete: boolean;
}

export function commentActions(
  comment: Pick<CommentRow, 'author_user_id' | 'deleted_at' | 'legacy_author_name'>,
  currentUserId: string | null,
  tombstone: boolean,
): CommentActions {
  if (tombstone) return { canCopy: false, canEdit: false, canDelete: false };
  const mine = canModifyComment(comment, currentUserId);
  return { canCopy: true, canEdit: mine, canDelete: mine };
}

/** Which row-action control a point offers. 'menu' when edit or delete is
 *  available (the full kebab popover); else 'copy' when only copy remains (a
 *  direct copy button, no overflow menu for a single item); else 'none'. This is
 *  deliberately not an author check: a frozen point returns canCopy true with
 *  canEdit/canDelete false even for its own author, so it gets the direct copy
 *  button too. */
export type PointMenuMode = 'none' | 'copy' | 'menu';
export function pointMenuMode(actions: CommentActions): PointMenuMode {
  if (actions.canEdit || actions.canDelete) return 'menu';
  return actions.canCopy ? 'copy' : 'none';
}

/** The server caps a ledger point body at 50 whitespace-separated words; the
 *  editor mirrors the cap so an over-long point surfaces inline instead of
 *  bouncing off a raw invalid_payload. */
export const POINT_WORD_CAP = 50;

/** Count whitespace-separated words the way the point procs do (btrim, then split
 *  on runs of whitespace); an empty or all-whitespace body is zero. */
export function pointWordCount(body: string): number {
  const trimmed = body.trim();
  return trimmed === '' ? 0 : trimmed.split(/\s+/).length;
}

/** A ledger point is frozen against edit/delete once it is confirmed (accepted_at)
 *  or locked by post approval (closed_at); the proc raises checkpoint_frozen either
 *  way, so the affordance is hidden to match. */
export function isPointFrozen(point: Pick<CommentRow, 'accepted_at' | 'closed_at'>): boolean {
  return point.accepted_at !== null || point.closed_at !== null;
}

/** Row actions for a ledger point: the ordinary authorship gate (commentActions ->
 *  canModifyComment), with Edit and Delete additionally withheld once the point is
 *  frozen. Copy stays available in every state; replies are unaffected. */
export function pointActions(
  point: Pick<
    CommentRow,
    'author_user_id' | 'deleted_at' | 'legacy_author_name' | 'accepted_at' | 'closed_at'
  >,
  currentUserId: string | null,
  tombstone: boolean,
): CommentActions {
  const base = commentActions(point, currentUserId, tombstone);
  if (isPointFrozen(point)) return { canCopy: base.canCopy, canEdit: false, canDelete: false };
  return base;
}

/** The "edited · <when>" marker for a ledger point, or null when it was never
 *  edited. Reuses relativeLong (the same helper the card uses for created_at), so no
 *  date library is added. */
export function pointEditedMarker(editedAt: string | null, now: Date): string | null {
  return editedAt === null ? null : `edited · ${relativeLong(editedAt, now)}`;
}

/** The plain text copied to the clipboard: the stored body with each @[uuid]
 *  token resolved to its "@Name" display form (or "@(ex-member)"), reusing the
 *  profile map already built for rendering. */
export function commentCopyText(body: string, nameOf: (id: string) => string | null): string {
  return body.replace(
    MENTION_TOKEN,
    (_match, id: string) => `@${nameOf(id.toLowerCase()) ?? EX_MEMBER_LABEL}`,
  );
}

/** Copy text to the clipboard; never throws when the clipboard is unavailable. */
export async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Write action helpers (one trace per action; mind the wrapper asymmetry)
// ---------------------------------------------------------------------------

export interface CreateCommentParams {
  workspaceId: string;
  entityType: CommentEntityType;
  entityId: string;
  body: string;
  attachmentVersionIds: string[];
  parentCommentId: string | null;
  traceId: string;
}

/** Build the createComment input; the trace rides INSIDE the input object. */
export function buildCreateInput(params: CreateCommentParams): CreateCommentInput {
  return {
    workspace_id: params.workspaceId,
    entity_type: params.entityType,
    entity_id: params.entityId,
    body: params.body,
    attachment_asset_ids: params.attachmentVersionIds,
    parent_comment_id: params.parentCommentId,
    trace_id: params.traceId,
  };
}

/** editComment takes its traceId POSITIONALLY (not inside the input). */
export function runEditComment(
  client: Client,
  commentId: string,
  body: string,
  traceId: string,
): Promise<Result<string>> {
  return editComment(client, { commentId, body }, traceId);
}

/** deleteComment takes its traceId POSITIONALLY (not inside the input). */
export function runDeleteComment(
  client: Client,
  commentId: string,
  traceId: string,
): Promise<Result<string>> {
  return deleteComment(client, { commentId }, traceId);
}

/** One created checkpoint as comment_batch_create returns it. */
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

/** Build the comment_batch_create args; the trace rides as p_trace_id, exactly
 *  as the comment_create proc receives it through the createComment wrapper. */
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

/** Defensive parse of the proc's jsonb reply into typed {id, seq} rows; a
 *  malformed element is dropped rather than thrown on. */
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

/** Call comment_batch_create with comment_create's error mapping: a raised
 *  domain code maps to itself, anything else to 'unknown', both carrying the
 *  raw message the panel surfaces. */
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

/** Batched mime read so the renderer can dispatch image vs file (no N+1).
 *  Exported for the FeedbackLedger, which renders the same attachments. */
export async function fetchAttachmentMime(
  client: Client,
  versionIds: readonly string[],
): Promise<Map<string, string>> {
  const ids = Array.from(new Set(versionIds.filter((id) => id !== '')));
  const mimeById = new Map<string, string>();
  if (ids.length === 0) return mimeById;
  const { data, error } = await client.from('asset_versions').select('id, mime_type').in('id', ids);
  if (error || data === null) return mimeById;
  for (const row of data) mimeById.set(row.id, row.mime_type ?? '');
  return mimeById;
}

/** Load EVERY checkpoint (ledger_seq set, top-level) for one post in ONE query,
 *  regardless of pagination, so a checkpoint on a long post never falls out of
 *  reach and its controls stay live. Soft-deleted checkpoints ride along so a
 *  tombstone still renders; only non-checkpoint comments paginate. Returns [] on
 *  error, matching the file's other best-effort reads (never null). */
export async function fetchCheckpoints(
  client: Client,
  workspaceId: string,
  entityId: string,
): Promise<CommentRow[]> {
  const { data, error } = await client
    .from('comments')
    .select('*')
    .eq('workspace_id', workspaceId)
    .eq('entity_type', 'post')
    .eq('entity_id', entityId)
    .not('ledger_seq', 'is', null)
    .is('parent_comment_id', null)
    .order('created_at', { ascending: false });
  if (error || data === null) return [];
  return data;
}

/** A quiet text control: reads as plain text but carries a 44px minimum touch
 *  target from invisible padding, not a visible box. Drives the client's
 *  "Not done" / "Undo" beneath a checkpoint row. */
function QuietTextButton({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}): ReactNode {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="inline-flex min-h-[44px] min-w-[44px] items-center text-sm text-fg-2 underline-offset-2 hover:text-fg hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50"
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Read + create comments on one entity (a post or a brief). Renders a flat,
 * newest-first list grouped into one-level threads: each root shows its
 * replies (always open), attachments, and (for the caller's own comments)
 * edit / delete. A soft-deleted root with a live reply renders as a
 * tombstone so the thread stays intact. The brief mount passes only
 * workspaceId / entityType / entityId, so every richer affordance degrades
 * gracefully there.
 */
export function Comments({
  workspaceId,
  entityType,
  entityId,
  annotationsByCommentId,
  onAnnotationChipClick,
  refreshSignal,
  focusCommentId,
  viewerIsClient,
}: CommentsProps) {
  const newTrace = useNewTrace();
  const { canAttach, presignEnabled, presignCache, uploadFile } = useChatAttachments();
  // Members for the @-mention picker; resolved once and shared by both composers.
  const { candidates } = useMentionCandidates(workspaceId);

  const [comments, setComments] = useState<CommentRow[]>([]);
  // Every checkpoint for this post, loaded whole in one query so none paginates
  // away; merged with the paginated `comments` below (de-duped, newest-first).
  const [checkpoints, setCheckpoints] = useState<CommentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const [profiles, setProfiles] = useState<Map<string, CommentProfile>>(new Map());
  const [attachmentMime, setAttachmentMime] = useState<Map<string, string>>(new Map());
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);

  const [replyOpen, setReplyOpen] = useState<Set<string>>(new Set());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editBody, setEditBody] = useState('');
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  // The comment (thread root or checkpoint) whose resolve/accept request is in
  // flight; null when idle. Shared by the single-thread resolve and every
  // checkpoint tick / "Not done" / "Undo".
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  // Agency tick flow on a checkpoint: the row whose resolution-note composer is
  // open, its draft, and the one-frame entrance flag for the reveal motion.
  const [noteForId, setNoteForId] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState('');
  const [noteEntered, setNoteEntered] = useState(false);
  // Checkpoints whose reply composer was opened by a client "Not done"; their
  // composer seeds with the pushback prompt so the client says what is still off.
  const [pushbackSeeds, setPushbackSeeds] = useState<Set<string>>(new Set());
  // The comment whose per-row actions popover is open (kebab); null when closed.
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  // The open image lightbox: the clicked comment's image list + current index,
  // or null when closed. Images reuse the same PresignCache (a cache hit).
  const [lightbox, setLightbox] = useState<{ images: MessageAttachment[]; index: number } | null>(
    null,
  );

  // Current user id is server-trusted (the session), never a prop. It gates the
  // edit / delete affordances; the procs re-check auth.uid() regardless.
  useEffect(() => {
    let active = true;
    void supabase.auth.getSession().then(({ data }) => {
      if (active) setCurrentUserId(data.session?.user.id ?? null);
    });
    return () => {
      active = false;
    };
  }, []);

  // Fetch a single page. page 0 replaces the list (mount + post-submit refetch);
  // later pages append. A full page (exactly PAGE_SIZE) implies there may be more.
  const loadPage = useCallback(
    async (nextPage: number): Promise<void> => {
      if (nextPage === 0) {
        setLoading(true);
        setLoadError(null);
      } else {
        setLoadingMore(true);
      }
      const result = await listComments(supabase, {
        workspace_id: workspaceId,
        entity_type: entityType,
        entity_id: entityId,
        page: nextPage,
      });
      if (!result.ok) {
        if (nextPage === 0) {
          setLoading(false);
          setLoadError(result.error.message);
        } else {
          setLoadingMore(false);
          setLoadError(result.error.message);
        }
        return;
      }
      // One extra query, only on a page-zero load: every checkpoint for the post,
      // so none is paginated out of reach. Posts only (checkpoints never exist on
      // a brief); a failed read keeps whatever was already shown.
      if (nextPage === 0 && entityType === 'post') {
        const checkpointRows = await fetchCheckpoints(supabase, workspaceId, entityId);
        setCheckpoints(checkpointRows);
      }
      setComments((prev) => (nextPage === 0 ? result.data : [...prev, ...result.data]));
      setPage(nextPage);
      setHasMore(result.data.length === PAGE_SIZE);
      if (nextPage === 0) setLoading(false);
      else setLoadingMore(false);
    },
    [workspaceId, entityType, entityId],
  );

  // The rendered list: the always-loaded checkpoints merged into the paginated
  // comments, de-duped by id and newest-first. Only non-checkpoint comments
  // paginate; a checkpoint beyond page zero is still here.
  const merged = useMemo(() => mergeCheckpoints(comments, checkpoints), [comments, checkpoints]);

  useEffect(() => {
    void loadPage(0);
  }, [loadPage]);

  // A refreshSignal bump (e.g. a new caption annotation posted on the parent)
  // refetches page 0. The mount load above already covers the initial value, so
  // only an actual change reloads; an unset prop never reloads.
  const lastSignal = useRef(refreshSignal);
  useEffect(() => {
    if (refreshSignal === undefined) return;
    if (lastSignal.current === refreshSignal) return;
    lastSignal.current = refreshSignal;
    void loadPage(0);
  }, [refreshSignal, loadPage]);

  // Email deep-link focus: once the targeted comment lands in the loaded list,
  // scroll to and flash its row exactly once per distinct id. Best-effort: an id
  // not present (wrong entity, deleted, or beyond page 0) simply never fires.
  const flashedCommentId = useRef<string | null>(null);
  useEffect(() => {
    if (focusCommentId === undefined || focusCommentId === null || focusCommentId === '') return;
    if (flashedCommentId.current === focusCommentId) return;
    if (!merged.some((c) => c.id === focusCommentId)) return;
    flashedCommentId.current = focusCommentId;
    flashNode(commentDomId(focusCommentId));
  }, [merged, focusCommentId]);

  // Resolve author + mention display names in one batched read. The attempted
  // set dedupes ids and stops a missing (ex-member) id from refetching forever.
  const attemptedProfiles = useRef<Set<string>>(new Set());
  useEffect(() => {
    const needed: string[] = [];
    for (const comment of merged) {
      for (const id of [
        comment.author_user_id,
        ...parseMentions(comment.body),
        ...(comment.unaccepted_by !== null ? [comment.unaccepted_by] : []),
      ]) {
        if (!attemptedProfiles.current.has(id)) {
          attemptedProfiles.current.add(id);
          needed.push(id);
        }
      }
    }
    if (needed.length === 0) return;
    let active = true;
    void fetchCommentProfiles(supabase, needed).then((fetched) => {
      if (active && fetched.size > 0) {
        setProfiles((prev) => new Map([...prev, ...fetched]));
      }
    });
    return () => {
      active = false;
    };
  }, [merged]);

  // Resolve attachment mimes in one batched read (image vs file dispatch).
  const attemptedMime = useRef<Set<string>>(new Set());
  useEffect(() => {
    const needed: string[] = [];
    for (const comment of merged) {
      for (const id of comment.attachment_asset_ids ?? []) {
        if (!attemptedMime.current.has(id)) {
          attemptedMime.current.add(id);
          needed.push(id);
        }
      }
    }
    if (needed.length === 0) return;
    let active = true;
    void fetchAttachmentMime(supabase, needed).then((fetched) => {
      if (active && fetched.size > 0) {
        setAttachmentMime((prev) => new Map([...prev, ...fetched]));
      }
    });
    return () => {
      active = false;
    };
  }, [merged]);

  // One-frame entrance for the agency note composer reveal (opacity/translateY
  // only). Mirrors the ledger's note-reveal timing.
  useEffect(() => {
    if (noteForId === null || noteEntered) return;
    const raf = requestAnimationFrame(() => setNoteEntered(true));
    return () => cancelAnimationFrame(raf);
  }, [noteForId, noteEntered]);

  const nameOf = useCallback((id: string): string | null => resolveName(profiles, id), [profiles]);
  // Author avatar URL from the SAME profiles map the card already holds; no new
  // query. Absent member -> null, so the card keeps its initials fallback.
  const avatarOf = useCallback(
    (id: string): string | null => profiles.get(id)?.avatarUrl ?? null,
    [profiles],
  );

  async function handleCreate(
    body: string,
    options: {
      attachmentVersionIds: string[];
      parentCommentId: string | null;
    },
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const result = await createComment(
      supabase,
      buildCreateInput({
        workspaceId,
        entityType,
        entityId,
        body,
        attachmentVersionIds: options.attachmentVersionIds,
        parentCommentId: options.parentCommentId,
        traceId: newTrace(),
      }),
    );
    if (!result.ok) return { ok: false, error: result.error.message };
    const parentId = options.parentCommentId;
    if (parentId !== null) {
      setReplyOpen((prev) => {
        const next = new Set(prev);
        next.delete(parentId);
        return next;
      });
      setPushbackSeeds((prev) => {
        if (!prev.has(parentId)) return prev;
        const next = new Set(prev);
        next.delete(parentId);
        return next;
      });
    }
    await loadPage(0);
    return { ok: true };
  }

  // Write one checkpoint batch through comment_batch_create, sourcing the trace
  // the same way handleCreate does (one newTrace() per action). On success the
  // returned {id, seq} rows land in the thread the way a new comment renders
  // today: refetch page 0.
  async function handleCreateBatch(
    points: CheckpointPoint[],
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const result = await runCreateCommentBatch(supabase, {
      workspaceId,
      postId: entityId,
      points,
      traceId: newTrace(),
    });
    if (!result.ok) return { ok: false, error: result.error.message };
    await loadPage(0);
    return { ok: true };
  }

  async function handleSaveEdit(commentId: string): Promise<void> {
    const trimmed = editBody.trim();
    if (trimmed === '') return;
    setRowError(null);
    const target = merged.find((c) => c.id === commentId) ?? null;
    const isPoint = target !== null && target.ledger_seq !== null;
    // Points are capped at 50 words server-side; enforce it before submit so an
    // over-long edit surfaces inline rather than as a raw invalid_payload.
    if (isPoint && pointWordCount(editBody) > POINT_WORD_CAP) {
      setRowError({ id: commentId, message: `Points are limited to ${POINT_WORD_CAP} words.` });
      return;
    }
    const result = await runEditComment(supabase, commentId, editBody, newTrace());
    if (!result.ok) {
      setRowError({
        id: commentId,
        message: isPoint
          ? friendlyPointFreezeError(result.error, target, 'edit')
          : result.error.message,
      });
      return;
    }
    setEditingId(null);
    setEditBody('');
    await loadPage(0);
  }

  async function handleDelete(commentId: string): Promise<void> {
    setRowError(null);
    const target = merged.find((c) => c.id === commentId) ?? null;
    const isPoint = target !== null && target.ledger_seq !== null;
    const result = await runDeleteComment(supabase, commentId, newTrace());
    if (!result.ok) {
      setRowError({
        id: commentId,
        message: isPoint
          ? friendlyPointFreezeError(result.error, target, 'delete')
          : result.error.message,
      });
      return;
    }
    await loadPage(0);
  }

  // Toggle the thread-level resolved state on a root comment. Open to any active
  // member (the proc re-checks membership); a failed call surfaces as a row error
  // on the root and leaves the prior state untouched.
  async function handleResolve(comment: CommentRow, resolved: boolean): Promise<void> {
    setRowError(null);
    setResolvingId(comment.id);
    const result = await resolveComment(supabase, { commentId: comment.id, resolved }, newTrace());
    setResolvingId((current) => (current === comment.id ? null : current));
    if (!result.ok) {
      setRowError({ id: comment.id, message: result.error.message });
      return;
    }
    await loadPage(0);
  }

  async function handleCopy(comment: CommentRow): Promise<void> {
    const ok = await writeClipboard(commentCopyText(comment.body, nameOf));
    if (!ok) return;
    setCopiedId(comment.id);
    window.setTimeout(() => {
      setCopiedId((current) => (current === comment.id ? null : current));
    }, 2000);
  }

  function toggleReply(id: string): void {
    setReplyOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    // Closing a composer drops any pushback seed so a later manual reply opens
    // with the ordinary author pre-tag, not the stale reason prompt.
    setPushbackSeeds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }

  // Agency ticks a checkpoint done (resolved=true, with the optional note) or the
  // client un-resolves it (resolved=false). Same Result/DomainError handling and
  // refetch-on-success pattern as handleResolve: a failed call surfaces the mapped
  // friendly error on the row and leaves the prior state untouched.
  async function handleCheckpointResolve(
    comment: CommentRow,
    resolved: boolean,
    note?: string,
  ): Promise<void> {
    setRowError(null);
    setResolvingId(comment.id);
    const result = await commentResolve(
      supabase,
      buildResolveArgs({
        commentId: comment.id,
        resolved,
        traceId: newTrace(),
        ...(note !== undefined ? { note } : {}),
      }),
    );
    setResolvingId((current) => (current === comment.id ? null : current));
    if (!result.ok) {
      setRowError({ id: comment.id, message: friendlyResolveError(result.error) });
      return;
    }
    if (noteForId === comment.id) {
      setNoteForId(null);
      setNoteDraft('');
      setNoteEntered(false);
    }
    await loadPage(0);
  }

  // The client's "Not done": un-resolve, then open the reply composer seeded with
  // the pushback prompt so the point does not go back silently. On a failed
  // un-resolve nothing changes and the mapped error surfaces on the row.
  async function handleCheckpointNotDone(comment: CommentRow): Promise<void> {
    setRowError(null);
    setResolvingId(comment.id);
    const result = await commentResolve(
      supabase,
      buildResolveArgs({ commentId: comment.id, resolved: false, traceId: newTrace() }),
    );
    setResolvingId((current) => (current === comment.id ? null : current));
    if (!result.ok) {
      setRowError({ id: comment.id, message: friendlyResolveError(result.error) });
      return;
    }
    setPushbackSeeds((prev) => new Set(prev).add(comment.id));
    setReplyOpen((prev) => new Set(prev).add(comment.id));
    await loadPage(0);
  }

  // The client confirms (accepted=true) or withdraws (accepted=false) a resolved
  // checkpoint via checkpoint_accept, with the ledger's friendly-accept mapping.
  async function handleCheckpointAccept(comment: CommentRow, accepted: boolean): Promise<void> {
    setRowError(null);
    setResolvingId(comment.id);
    const result = await checkpointAccept(supabase, {
      p_comment_id: comment.id,
      p_accepted: accepted,
      p_trace_id: newTrace(),
    });
    setResolvingId((current) => (current === comment.id ? null : current));
    if (!result.ok) {
      setRowError({ id: comment.id, message: friendlyAcceptError(result.error) });
      return;
    }
    await loadPage(0);
  }

  function startEdit(comment: CommentRow): void {
    setEditingId(comment.id);
    setEditBody(comment.body);
    setRowError(null);
  }

  const threads = buildThreads(merged);
  const groups = groupThreads(threads);
  const isClient = viewerIsClient === true;

  function renderEditor(commentId: string): ReactNode {
    return (
      <div className="mt-2 flex flex-col gap-2">
        <textarea
          value={editBody}
          onChange={(event) => setEditBody(event.target.value)}
          aria-label="Edit comment body"
          className="w-full px-3 rounded-md border border-border bg-panel-2 text-fg text-sm placeholder:text-fg-3 outline-none focus:border-accent-line focus:ring-2 focus:ring-accent-soft min-h-[74px] py-2.5 h-auto"
        />
        <div className="flex items-center gap-2">
          <Button
            size="lg"
            variant="primary"
            className="min-w-[44px]"
            disabled={editBody.trim() === ''}
            onClick={() => void handleSaveEdit(commentId)}
          >
            Save
          </Button>
          <Button
            size="lg"
            variant="ghost"
            className="min-w-[44px]"
            onClick={() => {
              setEditingId(null);
              setEditBody('');
            }}
          >
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  function renderCommentCard(comment: CommentRow, isReply: boolean): ReactNode {
    // A reply is never a tombstone (deleted replies are filtered out) and roots
    // render their own tombstone, so the card itself is always a live comment.
    const actions = commentActions(comment, currentUserId, false);
    const attachments = toCommentAttachments(comment.attachment_asset_ids, attachmentMime);
    const authorName =
      comment.legacy_author_name ?? nameOf(comment.author_user_id) ?? EX_MEMBER_LABEL;
    const authorAvatarUrl =
      comment.legacy_author_name !== null ? null : avatarOf(comment.author_user_id);
    const editing = editingId === comment.id;

    // The per-row actions are collapsed behind a kebab; the gating is unchanged
    // (canCopy on any live comment, canEdit/canDelete author-only). Every menu
    // row closes the popover and calls the existing handler.
    const closeMenu = (): void => setMenuOpenId(null);

    return (
      <>
        <div className="mb-1 flex items-center gap-2">
          <Avatar
            name={authorName}
            size={isReply ? 'sm' : 'md'}
            {...(authorAvatarUrl !== null && authorAvatarUrl !== undefined
              ? { src: authorAvatarUrl }
              : {})}
          />
          <span className="text-xs font-medium text-fg-2">{authorName}</span>
          {comment.edited_at !== null ? (
            <span className="text-[11px] text-fg-3">edited</span>
          ) : null}
          <span className="ml-auto shrink-0 text-xs text-fg-3 tabular-nums">
            {relativeLong(comment.created_at, new Date())}
          </span>
          {!editing && pointMenuMode(actions) === 'copy' ? (
            <div className="shrink-0">
              <IconButton label="Copy text" onClick={() => void handleCopy(comment)}>
                <IconCopy size={18} />
              </IconButton>
            </div>
          ) : !editing && pointMenuMode(actions) === 'menu' ? (
            <div className="relative shrink-0">
              <IconButton
                label="Comment actions"
                onClick={() =>
                  setMenuOpenId((current) => (current === comment.id ? null : comment.id))
                }
              >
                <IconMore size={20} />
              </IconButton>
              <MenuPopover open={menuOpenId === comment.id} onClose={closeMenu} align="right">
                {actions.canCopy ? (
                  <button
                    type="button"
                    className="flex w-full min-h-[44px] items-center rounded-lg px-3 text-left text-sm text-fg hover:bg-panel-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                    onClick={() => {
                      closeMenu();
                      void handleCopy(comment);
                    }}
                  >
                    Copy text
                  </button>
                ) : null}
                {actions.canEdit ? (
                  <button
                    type="button"
                    className="flex w-full min-h-[44px] items-center rounded-lg px-3 text-left text-sm text-fg hover:bg-panel-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                    onClick={() => {
                      closeMenu();
                      startEdit(comment);
                    }}
                  >
                    Edit
                  </button>
                ) : null}
                {actions.canDelete ? (
                  <button
                    type="button"
                    className="flex w-full min-h-[44px] items-center rounded-lg px-3 text-left text-sm text-bad hover:bg-panel-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                    onClick={() => {
                      closeMenu();
                      void handleDelete(comment.id);
                    }}
                  >
                    Delete
                  </button>
                ) : null}
              </MenuPopover>
            </div>
          ) : null}
        </div>

        {editing ? (
          renderEditor(comment.id)
        ) : (
          <>
            {comment.body.trim() !== '' ? (
              <p className="text-sm leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere] text-fg">
                {renderCommentBody(comment.body, nameOf)}
              </p>
            ) : null}
            {attachments.length > 0 ? (
              <MessageAttachments
                attachments={attachments}
                cache={presignCache}
                presignEnabled={presignEnabled}
                onImageClick={(attachment) => {
                  const nav = commentImageNav(attachments, attachment.assetId);
                  if (nav.images.length > 0) setLightbox(nav);
                }}
              />
            ) : null}
            {annotationChip(
              comment.id,
              annotationsByCommentId?.[comment.id],
              onAnnotationChipClick,
            )}
            {copiedId === comment.id ? (
              <span role="status" className="mt-1.5 block text-xs text-fg-3">
                Comment copied
              </span>
            ) : null}
          </>
        )}

        {rowError !== null && rowError.id === comment.id ? (
          <div
            role="alert"
            className="mt-2 rounded-md border border-bad px-3 py-2 text-sm text-bad"
          >
            {rowError.message}
          </div>
        ) : null}
      </>
    );
  }

  // The shared tail of a top-level item: Reply, (optionally) the thread Resolve
  // toggle, the always-open replies list, and the reply composer.
  // Batch checkpoint points reuse it with showResolve=false: their tick state is
  // owned by the feedback ledger, but replies stay normal child comments.
  function renderThreadTail(
    comment: CommentRow,
    replies: CommentRow[],
    tombstone: boolean,
    showResolve: boolean,
    footRight?: ReactNode,
  ): ReactNode {
    const isReplyOpen = replyOpen.has(comment.id);
    const isResolved = comment.resolved_at !== null;
    const isResolving = resolvingId === comment.id;
    return (
      <>
        <div className="mt-2 flex min-h-[44px] items-center gap-2">
          {!tombstone ? (
            <Button
              size="sm"
              variant="ghost"
              className="min-h-[44px] min-w-[44px]"
              onClick={() => toggleReply(comment.id)}
            >
              {isReplyOpen ? 'Cancel' : 'Reply'}
            </Button>
          ) : null}
          {showResolve && !tombstone ? (
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto min-h-[44px] min-w-[44px]"
              disabled={isResolving}
              onClick={() => void handleResolve(comment, !isResolved)}
            >
              {isResolving ? 'Saving' : isResolved ? 'Reopen' : 'Resolve'}
            </Button>
          ) : null}
          {footRight !== undefined ? footRight : null}
        </div>

        {renderReplyList(replies, (reply) => renderCommentCard(reply, true))}

        {isReplyOpen ? (
          <div className="mt-3 border-l border-border pl-4">
            <CommentComposer
              onSubmit={(body, options) =>
                handleCreate(body, { ...options, parentCommentId: comment.id })
              }
              members={candidates}
              canAttach={canAttach}
              uploadFile={uploadFile}
              placeholder="Write a reply"
              submitLabel="Reply"
              autoFocus
              initialBody={checkpointReplySeed(
                pushbackSeeds.has(comment.id),
                comment,
                currentUserId,
                candidates,
              )}
            />
          </div>
        ) : null}
      </>
    );
  }

  // One plain one-level thread, exactly as before the ledger batches landed.
  function renderThreadItem({ comment, replies, tombstone }: ThreadRoot): ReactNode {
    // Thread-level resolved state lives on the root comment. A tombstone
    // root cannot be resolved/reopened (the proc rejects a deleted comment).
    const isResolved = comment.resolved_at !== null;
    return (
      <li
        key={comment.id}
        id={commentDomId(comment.id)}
        className={
          isResolved
            ? 'rounded-xl border border-good bg-panel-2 px-4 py-3 transition-shadow'
            : 'rounded-xl border border-border bg-panel-2 px-4 py-3 transition-shadow'
        }
      >
        {isResolved && !tombstone ? (
          <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-good">
            <IconCheck size={14} />
            Resolved
          </div>
        ) : null}

        {tombstone ? (
          <p className="text-xs italic text-fg-3">{tombstoneText(comment, nameOf)}</p>
        ) : (
          renderCommentCard(comment, false)
        )}

        {renderThreadTail(comment, replies, tombstone, true)}
      </li>
    );
  }

  // Consecutive checkpoints from one author, collapsed into a single card. The
  // header is just the author (avatar + name); each point is an "ask row" with a
  // number badge, the verbatim body, its live state label, and its tick control.
  // The tick is live for the actor whose turn it is (agency opens the note
  // composer then resolves; client confirms via checkpoint_accept); every other
  // case is a passive indicator. Beneath the row the client gets the quiet
  // "Not done" / "Undo" controls and any withdrawal record. The feedback ledger
  // still carries its own copy of these controls; a follow-up PR removes that
  // duplication. The per-point reply affordance is the existing thread tail.
  function renderBatchItem(group: { authorId: string; threads: ThreadRoot[] }): ReactNode {
    const first = group.threads[0]?.comment;
    if (first === undefined) return null;
    const authorName = first.legacy_author_name ?? nameOf(first.author_user_id) ?? EX_MEMBER_LABEL;
    const authorAvatarUrl =
      first.legacy_author_name !== null ? null : avatarOf(first.author_user_id);
    return (
      <li
        key={`batch-${group.authorId}`}
        className="rounded-xl border border-border bg-panel-2 px-4 py-3"
      >
        <div className="mb-2 flex items-center gap-2">
          <Avatar
            name={authorName}
            size="md"
            {...(authorAvatarUrl !== null && authorAvatarUrl !== undefined
              ? { src: authorAvatarUrl }
              : {})}
          />
          <span className="text-xs font-medium text-fg-2">{authorName}</span>
        </div>
        <ol className="flex flex-col">
          {group.threads.map(({ comment, replies, tombstone }, index) => {
            const attachments = toCommentAttachments(comment.attachment_asset_ids, attachmentMime);
            const seq = comment.ledger_seq ?? 0;
            const state = checkpointState(comment);
            const label = checkpointStateLabel(state, isClient);
            const live = !tombstone && tickInteractive(state, isClient);
            const filled = tickFilled(state, isClient);
            const busy = resolvingId === comment.id;
            const noteOpen = noteForId === comment.id;
            const withdrawn = !tombstone && showCheckpointWithdrawal(comment);
            const notDone = !tombstone && showCheckpointNotDone(state, isClient);
            const undo = !tombstone && showCheckpointUndo(state, isClient);
            const editing = editingId === comment.id;
            // Author-only edit/delete, hidden once the point is frozen (confirmed or
            // locked); Copy stays on every live point. The proc re-checks auth.uid().
            const actions = pointActions(comment, currentUserId, tombstone);
            const editedMarker = pointEditedMarker(comment.edited_at, new Date());
            return (
              <li
                key={comment.id}
                id={commentDomId(comment.id)}
                className={cn(
                  'flex min-h-[44px] gap-3 py-3',
                  index > 0 ? 'border-t border-border' : 'pt-0',
                )}
              >
                {/* Decorative state rail on the leading edge: neutral (open),
                    accent (client's turn), soft success (confirmed). Colour only. */}
                <span
                  aria-hidden
                  className={cn(
                    'w-0.5 shrink-0 self-stretch rounded-full',
                    state === 'open'
                      ? 'bg-border'
                      : state === 'client_turn'
                        ? 'bg-accent'
                        : 'bg-good opacity-60',
                  )}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-start gap-2">
                    <span
                      aria-hidden
                      className="w-5 shrink-0 pt-0.5 text-right font-mono text-xs tabular-nums text-fg-3"
                    >
                      {comment.ledger_seq}
                    </span>
                    <div className="min-w-0 flex-1">
                      {tombstone ? (
                        <p className="text-xs italic text-fg-3">{tombstoneText(comment, nameOf)}</p>
                      ) : editing ? (
                        renderEditor(comment.id)
                      ) : (
                        <>
                          <p
                            className={cn(
                              'text-sm leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]',
                              state === 'confirmed' ? 'text-fg-2' : 'text-fg',
                            )}
                          >
                            {renderCommentBody(comment.body, nameOf)}
                            {editedMarker !== null ? (
                              <span className="ml-1.5 text-[11px] text-fg-3">{editedMarker}</span>
                            ) : null}
                          </p>
                          {attachments.length > 0 ? (
                            <MessageAttachments
                              attachments={attachments}
                              cache={presignCache}
                              presignEnabled={presignEnabled}
                              onImageClick={(attachment) => {
                                const nav = commentImageNav(attachments, attachment.assetId);
                                if (nav.images.length > 0) setLightbox(nav);
                              }}
                            />
                          ) : null}
                          {copiedId === comment.id ? (
                            <span role="status" className="mt-1.5 block text-xs text-fg-3">
                              Comment copied
                            </span>
                          ) : null}
                        </>
                      )}
                    </div>
                    {!editing && pointMenuMode(actions) === 'copy' ? (
                      <div className="shrink-0">
                        <IconButton
                          label="Copy text"
                          className="opacity-70"
                          onClick={() => void handleCopy(comment)}
                        >
                          <IconCopy size={18} />
                        </IconButton>
                      </div>
                    ) : !editing && pointMenuMode(actions) === 'menu' ? (
                      <div className="relative shrink-0">
                        <IconButton
                          label="Point actions"
                          className="opacity-70"
                          onClick={() =>
                            setMenuOpenId((current) => (current === comment.id ? null : comment.id))
                          }
                        >
                          <IconMore size={18} />
                        </IconButton>
                        <MenuPopover
                          open={menuOpenId === comment.id}
                          onClose={() => setMenuOpenId(null)}
                          align="right"
                        >
                          {actions.canCopy ? (
                            <button
                              type="button"
                              className="flex w-full min-h-[44px] items-center rounded-lg px-3 text-left text-sm text-fg hover:bg-panel-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                              onClick={() => {
                                setMenuOpenId(null);
                                void handleCopy(comment);
                              }}
                            >
                              Copy text
                            </button>
                          ) : null}
                          {actions.canEdit ? (
                            <button
                              type="button"
                              className="flex w-full min-h-[44px] items-center rounded-lg px-3 text-left text-sm text-fg hover:bg-panel-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                              onClick={() => {
                                setMenuOpenId(null);
                                startEdit(comment);
                              }}
                            >
                              Edit
                            </button>
                          ) : null}
                          {actions.canDelete ? (
                            <button
                              type="button"
                              className="flex w-full min-h-[44px] items-center rounded-lg px-3 text-left text-sm text-bad hover:bg-panel-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                              onClick={() => {
                                setMenuOpenId(null);
                                void handleDelete(comment.id);
                              }}
                            >
                              Delete
                            </button>
                          ) : null}
                        </MenuPopover>
                      </div>
                    ) : null}
                  </div>

                  {/* Meta row: state chip, timestamp, Reply, flexible spacer, tick.
                      One row, aligned to the point-text column. */}
                  <div className="mt-2 flex items-center gap-2 pl-7">
                    <span
                      className={cn(
                        'inline-flex shrink-0 items-center whitespace-nowrap rounded-md px-2 py-0.5 text-[11px] font-semibold uppercase tracking-[0.06em]',
                        label.className,
                      )}
                    >
                      {label.text}
                    </span>
                    <span className="whitespace-nowrap font-mono text-[11px] tabular-nums text-fg-3">
                      {relativeShort(comment.created_at, new Date())}
                    </span>
                    {!tombstone ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="min-h-[44px] min-w-[44px]"
                        onClick={() => toggleReply(comment.id)}
                      >
                        {replyOpen.has(comment.id) ? 'Cancel' : 'Reply'}
                      </Button>
                    ) : null}
                    {live ? (
                      <button
                        type="button"
                        disabled={busy}
                        aria-label={
                          isClient ? `Confirm checkpoint ${seq}` : `Mark checkpoint ${seq} done`
                        }
                        onClick={() => {
                          if (isClient) {
                            void handleCheckpointAccept(comment, true);
                            return;
                          }
                          // Agency: open the resolution-note composer; Mark done then
                          // calls comment_resolve(true) with the note.
                          setRowError(null);
                          setNoteDraft('');
                          setNoteEntered(false);
                          setNoteForId(comment.id);
                        }}
                        // axis: background-color on hover only; the tick fill motion
                        // (opacity + translateY) lives inside tickCircle.
                        className="ml-auto flex h-11 w-11 items-center justify-center rounded-md transition-colors duration-fast hover:bg-panel-3 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50"
                      >
                        {tickCircle(false, true)}
                      </button>
                    ) : (
                      <span
                        aria-hidden
                        className="ml-auto flex h-11 w-11 items-center justify-center"
                      >
                        {tickCircle(filled)}
                      </span>
                    )}
                  </div>

                  {withdrawn && comment.unaccepted_at !== null ? (
                    <p className="pl-7 text-xs text-fg-3">
                      {checkpointWithdrawalText(
                        comment.unaccepted_at,
                        comment.unaccepted_by !== null ? nameOf(comment.unaccepted_by) : null,
                      )}
                    </p>
                  ) : null}

                  {noteOpen ? (
                    // axis: opacity + translateY only (noteRevealClass); no translateX,
                    // rotate, or scale.
                    <div
                      className={cn('mt-2 flex flex-col gap-2 pl-7', noteRevealClass(noteEntered))}
                    >
                      <Textarea
                        autoFocus
                        autoGrow
                        rows={1}
                        maxLength={MAX_NOTE_CHARS}
                        aria-label={`Resolution note for checkpoint ${seq}`}
                        placeholder={NOTE_PLACEHOLDER}
                        value={noteDraft}
                        disabled={busy}
                        onChange={(event) => setNoteDraft(event.target.value)}
                        style={{ minHeight: '44px' }}
                      />
                      <div className="flex items-center gap-2">
                        <Button
                          size="lg"
                          variant="primary"
                          disabled={busy}
                          onClick={() => void handleCheckpointResolve(comment, true, noteDraft)}
                        >
                          {busy ? 'Saving' : 'Mark done'}
                        </Button>
                        <Button
                          size="lg"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => {
                            setNoteForId(null);
                            setNoteDraft('');
                            setNoteEntered(false);
                          }}
                        >
                          Cancel
                        </Button>
                        <span className="ml-auto text-xs tabular-nums text-fg-3">
                          {noteDraft.length}/{MAX_NOTE_CHARS}
                        </span>
                      </div>
                    </div>
                  ) : null}

                  {notDone || undo ? (
                    <div className="flex items-center gap-3 pl-7">
                      {notDone ? (
                        <QuietTextButton
                          disabled={busy}
                          onClick={() => void handleCheckpointNotDone(comment)}
                        >
                          {busy ? 'Saving' : 'Not done'}
                        </QuietTextButton>
                      ) : null}
                      {undo ? (
                        <QuietTextButton
                          disabled={busy}
                          onClick={() => void handleCheckpointAccept(comment, false)}
                        >
                          {busy ? 'Saving' : 'Undo'}
                        </QuietTextButton>
                      ) : null}
                    </div>
                  ) : null}

                  {rowError !== null && rowError.id === comment.id ? (
                    <div
                      role="alert"
                      className="ml-7 mt-2 rounded-md border border-bad px-3 py-2 text-sm text-bad"
                    >
                      {rowError.message}
                    </div>
                  ) : null}

                  <div className="pl-7">
                    {renderReplyList(replies, (reply) => renderCommentCard(reply, true))}
                    {!tombstone && replyOpen.has(comment.id) ? (
                      <div className="mt-3 border-l border-border pl-4">
                        <CommentComposer
                          onSubmit={(body, options) =>
                            handleCreate(body, { ...options, parentCommentId: comment.id })
                          }
                          members={candidates}
                          canAttach={canAttach}
                          uploadFile={uploadFile}
                          placeholder="Write a reply"
                          submitLabel="Reply"
                          autoFocus
                          initialBody={checkpointReplySeed(
                            pushbackSeeds.has(comment.id),
                            comment,
                            currentUserId,
                            candidates,
                          )}
                        />
                      </div>
                    ) : null}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      </li>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {viewerIsClient === true && entityType === 'post' ? (
        <SlotComposer onSubmit={handleCreateBatch} canAttach={canAttach} uploadFile={uploadFile} />
      ) : (
        <CommentComposer
          onSubmit={(body, options) => handleCreate(body, { ...options, parentCommentId: null })}
          members={candidates}
          canAttach={canAttach}
          uploadFile={uploadFile}
        />
      )}

      {loading ? (
        <p className="text-sm text-fg-3">Loading comments</p>
      ) : loadError !== null ? (
        <div role="alert" className="rounded-md border border-bad px-3 py-2 text-sm text-bad">
          Could not load comments. {loadError}
        </div>
      ) : threads.length === 0 ? (
        <div className="rounded-xl border border-border bg-panel-2 px-4 py-8 text-center text-sm text-fg-3">
          No comments yet
        </div>
      ) : (
        <ul className="flex flex-col gap-3">
          {groups.map((group) =>
            group.kind === 'batch' ? renderBatchItem(group) : renderThreadItem(group.thread),
          )}
        </ul>
      )}

      {!loading && loadError === null && hasMore ? (
        <Button
          size="lg"
          className="self-start"
          disabled={loadingMore}
          onClick={() => void loadPage(page + 1)}
        >
          {loadingMore ? 'Loading' : 'Load more'}
        </Button>
      ) : null}

      {lightbox !== null ? (
        <CommentImageLightbox
          images={lightbox.images}
          index={lightbox.index}
          cache={presignCache}
          presignEnabled={presignEnabled}
          onIndexChange={(index) =>
            setLightbox((prev) => (prev !== null ? { ...prev, index } : prev))
          }
          onClose={() => setLightbox(null)}
        />
      ) : null}
    </div>
  );
}
