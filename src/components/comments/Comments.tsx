import { Fragment, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import { dispatchInductionDid, INDUCTION_KEYS } from '@/lib/induction';
import { IconButton } from '@/components/ui/IconButton';
import { LinkButton } from '@/components/ui/LinkButton';
import { LinkPreviewCard } from '@/components/ui/LinkPreviewCard';
import { UnsafeLinkButton } from '@/components/ui/UnsafeLinkSheet';
import { checkLink } from '@/lib/links/safety';
import { parseExternalLink } from '@/lib/links';
import { firstExternalUrl } from '@/lib/chat/message-links';
import { glowById, highlightNodes, SearchWordsContext } from '@/components/ui/SearchHighlight';
import { IconCheck, IconCopy, IconMore } from '@/components/ui/icons';
import { LoadError } from '@/components/ui/LoadError';
import { roleLabel } from '@/components/pages/settings/members-data';
import { MenuPopover } from '@/components/shell/MenuPopover';
import { Avatar } from '@/components/ui/Avatar';
import { cn } from '@/lib/cn';
import { COPY_FAILED, copyText } from '@/lib/clipboard';
import { relativeLong, relativeShort, shortDate } from '@/lib/relative-time';
import { UNDO_WINDOW_MS, useUndoableAction } from '@/lib/use-undoable-action';
import { useOptionalToast } from '@/components/ui/toast';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { friendlyCommentError } from '@/components/comments/comment-errors';
import { MessageAttachments } from '@/components/chat/MessageAttachments';
import { useCommentAttachments } from '@/lib/chat/use-chat-attachments';
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
import { commentResolve, DOMAIN_ERROR_CODES } from '@srtdio/rpc';
import type { DomainErrorCode } from '@srtdio/rpc';
import type { Json } from '@srtdio/schemas';
import { classifyAttachment, type MessageAttachment } from '@/lib/chat/attachments';
import { CommentComposer } from '@/components/comments/CommentComposer';
import { SlotComposer } from '@/components/comments/SlotComposer';
import type { CheckpointPoint } from '@/components/comments/SlotComposer';
import { ImageLightbox } from '@/components/ui/ImageLightbox';
import { useMentionCandidates } from '@/components/comments/useMentionCandidates';
import type { MentionCandidate } from '@/components/comments/useMentionCandidates';
import {
  resolveMentionHandle,
  resolveName,
  type CommentProfile,
} from '@/components/comments/commentProfiles';
import {
  deserializeMentions,
  knownMentionName,
  serializeMentions,
  type MentionPick,
} from '@/lib/chat/mentions';
import { FORMER_MEMBER, personAvatar, personName, resolvePeople } from '@/lib/people-names';

/**
 * A mention as it reads in a comment: "@username", or "@Former member" for
 * someone who is not a current member. Nothing renders for it until the batched
 * name read answers (null), so no placeholder ever paints. Never a raw token.
 */
function mentionDisplay(name: string | null): string {
  return name === null ? '' : `@${name}`;
}
import {
  buildResolveArgs,
  friendlyPointFreezeError,
  friendlyResolveError,
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
  /** The comment the onboarding guide teaches replying on (the first caption
   *  highlight's): its Reply and reply Post carry the guide's keys. */
  guideReplyCommentId?: string | null;
  /**
   * Posts: the "Comments" header row (open-count chip + the Open / All filter).
   * Briefs keep their own heading and pass nothing.
   */
  showHeader?: boolean;
  /** Rendered under the header, above the list (the post's CheckpointStrip). */
  belowHeader?: ReactNode;
  /** Live open / resolved top-level thread counts (checkpoints included), lifted
   *  once loaded and on every change, optimistic resolves included. Lets the page
   *  render its "{n} open comments" chip and the creator's resubmit gate. */
  onCountsChange?: (counts: CommentCounts) => void;
}

/** Open vs resolved top-level threads, as the header reads them. */
export interface CommentCounts {
  open: number;
  resolved: number;
}

/** The one failure copy for a one-tap Resolve (or its Undo) that did not land. */
export const RESOLVE_FAILED_COPY = "Couldn't do that. Try again.";

/** The Comments header line: "{n} open · {m} resolved". Pure. */
export function commentCountsText(counts: CommentCounts): string {
  return `${counts.open} open · ${counts.resolved} resolved`;
}

/** The top-level thread filter: open threads only, or every thread. */
export type CommentFilter = 'open' | 'all';

/**
 * Top-level threads by resolved state; replies follow their thread. 'all' keeps
 * every thread, 'open' keeps the unresolved ones (a tombstone root counts as
 * whatever its resolved state says). Pure.
 */
export function filterThreads(threads: readonly ThreadRoot[], filter: CommentFilter): ThreadRoot[] {
  if (filter === 'all') return [...threads];
  return threads.filter((thread) => thread.comment.resolved_at === null);
}

/** The open-count chip's number: live, unresolved top-level threads. Pure. */
export function openThreadCount(threads: readonly ThreadRoot[]): number {
  return threads.filter((thread) => !thread.tombstone && thread.comment.resolved_at === null)
    .length;
}

/** The resolved half of the header count: live, resolved top-level threads. Pure. */
export function resolvedThreadCount(threads: readonly ThreadRoot[]): number {
  return threads.filter((thread) => !thread.tombstone && thread.comment.resolved_at !== null)
    .length;
}

/** Stable DOM id for a comment row, so a caption highlight can scroll to it. */
export function commentDomId(commentId: string): string {
  return `comment-${commentId}`;
}

/**
 * Filter a comment's attachments to its images and locate the clicked one among
 * them. Returns the image list plus the clicked image's index (0 when the id is
 * not found but images exist; an all-files comment yields an empty list). The
 * shared ImageLightbox is images-only, so callers pass the filtered list. Pure.
 */
export function commentImageNav(
  attachments: MessageAttachment[],
  clickedAssetId: string,
): { images: MessageAttachment[]; index: number } {
  const images = attachments.filter((a) => classifyAttachment(a.mime) === 'image');
  const found = images.findIndex((a) => a.assetId === clickedAssetId);
  return { images, index: found >= 0 ? found : 0 };
}

/**
 * The caption quote inside one comment (T9): a quoted line with a left rule in
 * fg-2, above the body. Live (current copy) is a button whose tap flashes the
 * caption mark; stale is inert and reads "copy changed" with the version it was
 * made on. Absent annotation (every brief comment) renders nothing, so the
 * brief path is byte-unchanged.
 */
export function annotationChip(
  commentId: string,
  annotation: CommentAnnotation | undefined,
  onClick?: (commentId: string) => void,
): ReactNode {
  if (annotation === undefined) return null;
  if (annotation.stale) {
    return (
      <div
        data-caption-quote="stale"
        className="mb-2 min-w-0 border-l-2 border-border pl-3 text-sm text-fg-2"
      >
        <span className="block text-[11px] text-fg-3">
          copy changed · v{annotation.versionNumber}
        </span>
        {annotation.quote !== '' ? (
          <span className="block [overflow-wrap:anywhere]">{annotation.quote}</span>
        ) : null}
      </div>
    );
  }
  return (
    <button
      type="button"
      data-caption-quote="live"
      onClick={() => onClick?.(commentId)}
      className="mb-2 flex w-full min-h-[44px] min-w-0 items-start gap-2 border-l-2 border-border-strong pl-3 text-left text-sm text-fg-2 transition-colors hover:text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      <sup className="shrink-0 text-[10px] font-semibold text-annotation-line">{annotation.n}</sup>
      <span className="min-w-0 [overflow-wrap:anywhere]">{annotation.quote}</span>
    </button>
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
 * accent-styled "@username" run (the bare uuid is never shown). An id that is not
 * a current member renders "@Former member". Surrounding text is returned
 * verbatim so the caller's whitespace-pre-wrap preserves the original layout.
 */
function pushBodyText(
  nodes: ReactNode[],
  text: string,
  keyBase: string,
  words: readonly string[],
  card: { url: string | null },
): void {
  // A search jump's words (the shared highlight); without them the runs stay plain strings.
  const plain = (run: string): ReactNode =>
    words.length === 0 ? (
      run
    ) : (
      <Fragment key={`${keyBase}-h${nodes.length}`}>{highlightNodes(run, words)}</Fragment>
    );
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(URL_TOKEN)) {
    const start = m.index ?? 0;
    let href = m[0];
    const trail = href.match(URL_TRAILING);
    const suffix = trail !== null ? trail[0] : '';
    if (suffix !== '') href = href.slice(0, href.length - suffix.length);
    if (start > last) nodes.push(plain(text.slice(last, start)));
    // The raw URL never reaches the screen: LinkButton labels it with the domain
    // only. align-middle keeps the inline-flex button sitting on the text run's
    // baseline; it renders nothing at all when the token is not a usable URL.
    // The link that gets the preview card (CommentLinkCard) is shown there
    // instead, once; every other link stays a LinkButton.
    if (card.url !== null && href === card.url) card.url = null;
    else nodes.push(<CommentLink key={`${keyBase}-u${i}`} url={href} />);
    if (suffix !== '') nodes.push(suffix);
    i += 1;
    last = start + m[0].length;
  }
  if (last < text.length) nodes.push(plain(text.slice(last)));
}

/** One inline comment link: LinkButton, or the warning button when it is unsafe. */
function CommentLink(props: { url: string }): ReactNode {
  const verdict = checkLink(props.url);
  const link = parseExternalLink(props.url);
  if (verdict.verdict === 'unsafe' && link !== null) {
    return (
      <UnsafeLinkButton
        url={link.href}
        reasons={verdict.reasons}
        domain={link.domain}
        className="align-middle"
      />
    );
  }
  return <LinkButton url={props.url} className="align-middle" />;
}

export function renderCommentBody(
  body: string,
  nameOf: (id: string) => string | null,
  words: readonly string[] = [],
  cardUrl: string | null = null,
): ReactNode[] {
  const nodes: ReactNode[] = [];
  const card = { url: cardUrl };
  let last = 0;
  let key = 0;
  for (const match of body.matchAll(MENTION_TOKEN)) {
    const start = match.index ?? 0;
    if (start > last) pushBodyText(nodes, body.slice(last, start), `t${key}`, words, card);
    const id = (match[1] ?? '').toLowerCase();
    const label = mentionDisplay(nameOf(id));
    nodes.push(
      <span key={`m-${key}`} className="font-medium text-accent">
        {words.length === 0 ? label : highlightNodes(label, words)}
      </span>,
    );
    key += 1;
    last = start + match[0].length;
  }
  if (last < body.length) pushBodyText(nodes, body.slice(last), `t${key}`, words, card);
  return nodes;
}

/**
 * The preview card for a comment's first external link (WhatsApp rule), below
 * the text. Comments carry no per-comment flag, so there is no X: the card
 * always shows. Links to this app's own pages get none.
 */
export function CommentLinkCard(props: { body: string }): ReactNode {
  const url = firstExternalUrl(props.body);
  return url !== null ? (
    <LinkPreviewCard key={url} url={url} className="mt-1.5 w-full max-w-[360px]" />
  ) : null;
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

/** A checkpoint's VISIBLE state. Only two words exist on screen: "Open" and
 *  "Resolved". The DB keeps its richer columns (accepted_at, unaccepted_at, ...)
 *  untouched; display maps them down: resolved_at null -> 'open', anything
 *  resolved (confirmed or not) -> 'resolved'. */
export type CheckpointState = 'open' | 'resolved';
export function checkpointState(row: Pick<CommentRow, 'resolved_at'>): CheckpointState {
  return row.resolved_at === null ? 'open' : 'resolved';
}

/** The state label text + design tokens for one comment or checkpoint row, the
 *  same on both sides: muted "Open" (borrowing the neutral raised surface, as
 *  open has no soft token) or success "Resolved". */
export interface CheckpointLabel {
  text: string;
  className: string;
}
export function checkpointStateLabel(state: CheckpointState): CheckpointLabel {
  return state === 'open'
    ? { text: 'Open', className: 'bg-panel-3 text-fg-3' }
    : { text: 'Resolved', className: 'bg-good-soft text-good' };
}

/** The one-tap "Resolve" is live only for an agency member on an open point.
 *  Every other case is a passive indicator. */
export function tickInteractive(state: CheckpointState, isClient: boolean): boolean {
  return !isClient && state === 'open';
}

/** The passive tick fills once the point is resolved, for either side. */
export function tickFilled(state: CheckpointState): boolean {
  return state === 'resolved';
}

/** "Not done" (the client un-resolves, then must say why) shows only to a client
 *  on a resolved point. An agency member never sees it. */
export function showCheckpointNotDone(state: CheckpointState, isClient: boolean): boolean {
  return isClient && state === 'resolved';
}

/** The pushback reason prompt. Un-resolving without saying why is the failure
 *  mode "Not done" exists to prevent, so the reply composer opens pre-filled with
 *  this line. No em-dash (user-facing string). */
export const PUSHBACK_SEED = 'This point has gone back to the creators. What is still off? ';

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

/** The clock time of an edit: "2:14 pm" on the same day, else the calendar date
 *  ("Jun 11"). Unparseable input yields '' so nothing raw is shown. */
export function editedTime(ts: string, now: Date): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return '';
  if (date.toDateString() !== now.toDateString()) return shortDate(ts, now);
  const hours = date.getHours();
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours % 12 === 0 ? 12 : hours % 12}:${minutes} ${hours < 12 ? 'am' : 'pm'}`;
}

/** The "edited <time>" marker shared by comments and ledger points, or null when
 *  it was never edited. */
export function pointEditedMarker(editedAt: string | null, now: Date): string | null {
  return editedAt === null ? null : `edited ${editedTime(editedAt, now)}`.trimEnd();
}

/** Reply drafts per thread, kept for as long as the page is open (they survive
 *  the panel remounting, never a reload). Keyed by entity + thread root. */
const replyDrafts = new Map<string, string>();

/** True when a reply draft holds text the person typed beyond its seed. */
export function replyHasTypedText(draft: string | undefined, seed: string): boolean {
  if (draft === undefined) return false;
  const typed = draft.trim();
  return typed !== '' && typed !== seed.trim();
}

/** Show the optimistic delete: a hidden id reads as soft-deleted, so a root with
 *  live replies becomes a tombstone and everything else drops out. */
export function applyHidden(
  rows: readonly CommentRow[],
  hidden: ReadonlySet<string>,
  now: string,
): CommentRow[] {
  if (hidden.size === 0) return [...rows];
  return rows.map((row) =>
    hidden.has(row.id) && row.deleted_at === null ? { ...row, deleted_at: now } : row,
  );
}

/** The plain text copied to the clipboard: the stored body with each @[uuid]
 *  token resolved to its "@username" display form (or "@Former member"), reusing
 *  the profile map already built for rendering. */
export function commentCopyText(body: string, nameOf: (id: string) => string | null): string {
  return body.replace(MENTION_TOKEN, (_match, id: string) =>
    mentionDisplay(nameOf(id.toLowerCase())),
  );
}

/**
 * A stored body as the edit box shows it: every `@[uuid]` token reads "@username"
 * (never a raw token) and becomes a pick, so serializeMentions turns it back into
 * the same token on save. A token whose id does not resolve stays a pick too, so
 * an edit never drops a mention.
 */
export function editableBody(
  body: string,
  handleOf: (id: string) => string | null,
): { text: string; picks: MentionPick[] } {
  return deserializeMentions(
    body,
    (id) => handleOf(id) ?? undefined,
    () => false,
  );
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
 *  "Not done" beneath a resolved checkpoint row. */
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
  guideReplyCommentId = null,
  showHeader = false,
  belowHeader,
  onCountsChange,
}: CommentsProps) {
  const newTrace = useNewTrace();
  // The Open / All thread filter (posts' header); All by default.
  const [filter, setFilter] = useState<CommentFilter>('all');
  const { canAttach, presignEnabled, presignCache, uploadFile } = useCommentAttachments();
  // Members for the @-mention picker; resolved once and shared by both composers.
  const { candidates } = useMentionCandidates(workspaceId);

  const [comments, setComments] = useState<CommentRow[]>([]);
  // Every checkpoint for this post, loaded whole in one query so none paginates
  // away; merged with the paginated `comments` below (de-duped, newest-first).
  const [checkpoints, setCheckpoints] = useState<CommentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  // An older page failed: the loaded list stays, a Retry sits at the bottom.
  const [moreError, setMoreError] = useState(false);
  // Deleted comments/points hidden while their Undo window runs.
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set());
  // The thread whose reply composer is asking "Discard reply?".
  const [discardFor, setDiscardFor] = useState<string | null>(null);
  const undoable = useUndoableAction();

  const [profiles, setProfiles] = useState<Map<string, CommentProfile>>(new Map());
  const [attachmentMime, setAttachmentMime] = useState<Map<string, string>>(new Map());
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);

  const [replyOpen, setReplyOpen] = useState<Set<string>>(new Set());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editBody, setEditBody] = useState('');
  // The edit box shows "@username"; these picks turn each back into its token on save.
  const [editPicks, setEditPicks] = useState<MentionPick[]>([]);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [copyFailed, setCopyFailed] = useState(false);
  // The comment (thread root or checkpoint) whose reopen / "Not done" request is
  // in flight; null when idle. A one-tap Resolve is optimistic and never waits.
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  // The bottom "Resolved" + Undo strip after a one-tap Resolve.
  const toast = useOptionalToast();
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

  // Stale-response guard: each page-0 load takes a new sequence number and only
  // the latest one applies, so overlapping refetches never resolve
  // last-write-wins. Unmount stops every in-flight load from setting state.
  const page0Seq = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Fetch a single page. page 0 replaces the list (mount + post-submit refetch);
  // later pages append. A full page (exactly PAGE_SIZE) implies there may be more.
  const loadPage = useCallback(
    async (nextPage: number): Promise<void> => {
      const seq = nextPage === 0 ? ++page0Seq.current : null;
      const stale = (): boolean => !mounted.current || (seq !== null && seq !== page0Seq.current);
      if (nextPage === 0) {
        setLoading(true);
        setLoadError(false);
      } else {
        setLoadingMore(true);
        setMoreError(false);
      }
      const result = await listComments(supabase, {
        workspace_id: workspaceId,
        entity_type: entityType,
        entity_id: entityId,
        page: nextPage,
      });
      if (stale()) return;
      if (!result.ok) {
        if (nextPage === 0) {
          setLoading(false);
          setLoadError(true);
        } else {
          setLoadingMore(false);
          setMoreError(true);
        }
        return;
      }
      // One extra query, only on a page-zero load: every checkpoint for the post,
      // so none is paginated out of reach. Posts only (checkpoints never exist on
      // a brief); a failed read keeps whatever was already shown.
      if (nextPage === 0 && entityType === 'post') {
        const checkpointRows = await fetchCheckpoints(supabase, workspaceId, entityId);
        if (stale()) return;
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

  // Deep-link focus (email, search): once the targeted comment lands in the
  // loaded list, scroll it to the centre and tint it for 2s, exactly once per
  // distinct id. Best-effort: an id not present (wrong entity, deleted, or
  // beyond page 0) simply never fires, so the parent opens with no error.
  const flashedCommentId = useRef<string | null>(null);
  const glowCleanup = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (focusCommentId === undefined || focusCommentId === null || focusCommentId === '') return;
    if (flashedCommentId.current === focusCommentId) return;
    if (!merged.some((c) => c.id === focusCommentId)) return;
    flashedCommentId.current = focusCommentId;
    glowCleanup.current?.();
    glowCleanup.current = glowById(commentDomId(focusCommentId));
  }, [merged, focusCommentId]);
  useEffect(() => () => glowCleanup.current?.(), []);
  // A search jump's words: coloured in every comment body until the screen unmounts.
  const searchWords = useContext(SearchWordsContext);

  // Resolve author + mention names in one batched read through the shared name
  // registry (users + workspace_members, one .in() each): a current member reads
  // their full name (@username in a mention), anyone else "Former member". The
  // attempted set dedupes ids; a failed read clears them so the next pass retries.
  const attemptedProfiles = useRef<Set<string>>(new Set());
  useEffect(() => {
    const needed: string[] = [];
    for (const comment of merged) {
      for (const id of [comment.author_user_id, ...parseMentions(comment.body)]) {
        if (!attemptedProfiles.current.has(id)) {
          attemptedProfiles.current.add(id);
          needed.push(id);
        }
      }
    }
    if (needed.length === 0) return;
    let active = true;
    void resolvePeople(supabase, workspaceId, needed).then((ok) => {
      if (!ok) for (const id of needed) attemptedProfiles.current.delete(id);
      const fetched = new Map<string, CommentProfile>();
      for (const id of needed) {
        const name = personName(workspaceId, id);
        if (name === undefined) continue;
        fetched.set(id, {
          displayName: name,
          avatarUrl: personAvatar(workspaceId, id),
          username: name === FORMER_MEMBER ? null : (knownMentionName(workspaceId, id) ?? null),
        });
      }
      if (active && fetched.size > 0) {
        setProfiles((prev) => new Map([...prev, ...fetched]));
      }
    });
    return () => {
      active = false;
    };
  }, [merged, workspaceId]);

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

  const nameOf = useCallback((id: string): string | null => resolveName(profiles, id), [profiles]);
  // Mentions inside a body read as @username; author lines keep the full name.
  const handleOf = useCallback(
    (id: string): string | null => resolveMentionHandle(profiles, id),
    [profiles],
  );
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
    if (!result.ok) return { ok: false, error: friendlyCommentError(result.error) };
    const parentId = options.parentCommentId;
    if (parentId !== null) replyDrafts.delete(draftKey(parentId));
    // The guide's reply landed: it moves on even if a phone lost the tap.
    if (parentId !== null && parentId === guideReplyCommentId) {
      dispatchInductionDid(INDUCTION_KEYS.postReplyPost);
    }
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
    if (!result.ok) return { ok: false, error: friendlyCommentError(result.error) };
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
    const result = await runEditComment(
      supabase,
      commentId,
      serializeMentions(editBody, editPicks),
      newTrace(),
    );
    if (!result.ok) {
      setRowError({
        id: commentId,
        message: isPoint
          ? friendlyPointFreezeError(result.error, target, 'edit')
          : friendlyCommentError(result.error),
      });
      return;
    }
    setEditingId(null);
    setEditBody('');
    await loadPage(0);
  }

  // Delete hides the row at once behind an Undo toast. The soft-delete RPC runs
  // only once the window closes; Undo shows the row again and sends nothing.
  function handleDelete(commentId: string): void {
    setRowError(null);
    const target = merged.find((c) => c.id === commentId) ?? null;
    const isPoint = target !== null && target.ledger_seq !== null;
    const unhide = (): void =>
      setHiddenIds((prev) => {
        if (!prev.has(commentId)) return prev;
        const next = new Set(prev);
        next.delete(commentId);
        return next;
      });
    setHiddenIds((prev) => new Set(prev).add(commentId));
    undoable.run({
      label: isPoint ? 'Point deleted' : 'Comment deleted',
      commit: async () => {
        const result = await runDeleteComment(supabase, commentId, newTrace());
        if (!result.ok) {
          unhide();
          setRowError({
            id: commentId,
            message: isPoint
              ? friendlyPointFreezeError(result.error, target, 'delete')
              : friendlyCommentError(result.error),
          });
          return;
        }
        await loadPage(0);
        unhide();
      },
      revert: unhide,
    });
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
      setRowError({ id: comment.id, message: friendlyCommentError(result.error) });
      return;
    }
    await loadPage(0);
  }

  // Flip one row's resolved_at in place (both the paged list and the always-loaded
  // checkpoints) so a one-tap Resolve, its Undo, or a revert paints at once.
  function patchResolvedAt(commentId: string, resolvedAt: string | null): void {
    const patch = (rows: CommentRow[]): CommentRow[] =>
      rows.some((row) => row.id === commentId)
        ? rows.map((row) => (row.id === commentId ? { ...row, resolved_at: resolvedAt } : row))
        : rows;
    setComments(patch);
    setCheckpoints(patch);
  }

  // The existing resolve RPC for either kind of row: a checkpoint goes through
  // comment_resolve with no note; a plain thread through the comments package
  // wrapper. Both carry an explicit trace. True when the write landed.
  async function sendResolve(comment: CommentRow, resolved: boolean): Promise<boolean> {
    if (comment.ledger_seq !== null) {
      const result = await commentResolve(
        supabase,
        buildResolveArgs({ commentId: comment.id, resolved, traceId: newTrace() }),
      );
      return result.ok;
    }
    const result = await resolveComment(supabase, { commentId: comment.id, resolved }, newTrace());
    return result.ok;
  }

  // One-tap Resolve: no box, note, sheet or confirm. The row flips to Resolved
  // at once (optimistic) while the RPC runs, and the bottom strip offers "Undo"
  // for UNDO_WINDOW_MS. Undo flips the row back and sends resolved=false (after
  // the first write settles, so the two never race). A failure on either leg
  // reverts and shows the one inline line, once.
  function handleOneTapResolve(comment: CommentRow): void {
    const prior = comment.resolved_at;
    const optimistic = new Date().toISOString();
    setRowError(null);
    patchResolvedAt(comment.id, optimistic);
    const sent = sendResolve(comment, true).catch(() => false);
    let undone = false;
    const stripId =
      toast?.show({
        title: 'Resolved',
        action: {
          label: 'Undo',
          onPress: () => {
            undone = true;
            patchResolvedAt(comment.id, prior);
            void sent.then(async (landed) => {
              if (!landed) return;
              const reopened = await sendResolve(comment, false).catch(() => false);
              if (!mounted.current) return;
              if (!reopened) {
                patchResolvedAt(comment.id, optimistic);
                setRowError({ id: comment.id, message: RESOLVE_FAILED_COPY });
              }
            });
          },
        },
        durationMs: UNDO_WINDOW_MS,
        kind: 'undo',
      }) ?? null;
    // No page-0 refetch on success: the optimistic row is already right, and a
    // reload would flash the skeleton under the strip.
    void sent.then((landed) => {
      if (!mounted.current || undone || landed) return;
      if (stripId !== null) toast?.dismiss(stripId);
      patchResolvedAt(comment.id, prior);
      setRowError({ id: comment.id, message: RESOLVE_FAILED_COPY });
    });
  }

  async function handleCopy(comment: CommentRow): Promise<void> {
    const ok = await copyText(commentCopyText(comment.body, handleOf));
    setCopyFailed(!ok);
    setCopiedId(comment.id);
    window.setTimeout(() => {
      setCopiedId((current) => (current === comment.id ? null : current));
    }, 2000);
  }

  function draftKey(commentId: string): string {
    return `${entityType}:${entityId}:${commentId}`;
  }

  function replySeedFor(comment: CommentRow): string {
    return checkpointReplySeed(pushbackSeeds.has(comment.id), comment, currentUserId, candidates);
  }

  // Reply / Cancel. Cancelling with typed text asks "Discard reply?" first; an
  // untouched (or seed-only) draft just closes.
  function onReplyButton(comment: CommentRow): void {
    const id = comment.id;
    if (
      replyOpen.has(id) &&
      replyHasTypedText(replyDrafts.get(draftKey(id)), replySeedFor(comment))
    ) {
      setDiscardFor(id);
      return;
    }
    if (replyOpen.has(id)) replyDrafts.delete(draftKey(id));
    toggleReply(id);
  }

  function renderReplyComposer(comment: CommentRow): ReactNode {
    const key = draftKey(comment.id);
    return (
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
          {...(comment.id === guideReplyCommentId
            ? { submitAnchor: INDUCTION_KEYS.postReplyPost }
            : {})}
          autoFocus
          initialBody={replyDrafts.get(key) ?? replySeedFor(comment)}
          onBodyChange={(body) => replyDrafts.set(key, body)}
        />
      </div>
    );
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

  function startEdit(comment: CommentRow): void {
    setEditingId(comment.id);
    const shown = editableBody(comment.body, handleOf);
    setEditBody(shown.text);
    setEditPicks(shown.picks);
    setRowError(null);
  }

  const displayed = useMemo(
    () => applyHidden(merged, hiddenIds, new Date().toISOString()),
    [merged, hiddenIds],
  );
  const threads = buildThreads(displayed);
  // The header's Open / All filter applies to top-level threads; replies follow
  // their thread. The open count is over every thread, whatever the filter.
  const openCount = openThreadCount(threads);
  const resolvedCount = resolvedThreadCount(threads);
  const groups = groupThreads(filterThreads(threads, filter));
  const isClient = viewerIsClient === true;

  // Lift the live counts to the page once loaded and on every change (an
  // optimistic one-tap Resolve included), so its chip and gate never lag.
  useEffect(() => {
    if (loading || loadError) return;
    onCountsChange?.({ open: openCount, resolved: resolvedCount });
  }, [loading, loadError, openCount, resolvedCount, onCountsChange]);

  // The author's workspace role label ("Creator", "Approver") from the same
  // members read the mention picker uses; null until it loads or for someone gone.
  function roleOf(userId: string): string | null {
    const role = candidates.find((candidate) => candidate.id === userId)?.role;
    return role === undefined || role === '' ? null : roleLabel(role);
  }

  // The visible Copy for one comment (T9), own and others' alike, with its
  // inline "Copied" / "Couldn't copy" status beside it.
  function copyControl(comment: CommentRow): ReactNode {
    return (
      <>
        <Button
          size="sm"
          variant="ghost"
          className="min-h-[44px] min-w-[44px]"
          aria-label="Copy comment"
          onClick={() => void handleCopy(comment)}
        >
          <IconCopy size={16} />
          Copy
        </Button>
        {copiedId === comment.id ? (
          <span role="status" className="text-xs text-fg-3">
            {copyFailed ? COPY_FAILED : 'Copied'}
          </span>
        ) : null}
      </>
    );
  }

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
      // '' only until the batched read answers (a gone person reads "Former member").
      comment.legacy_author_name ?? nameOf(comment.author_user_id) ?? '';
    const authorAvatarUrl =
      comment.legacy_author_name !== null ? null : avatarOf(comment.author_user_id);
    const editing = editingId === comment.id;

    // T9: one header line (avatar, name, role label, time); Copy lives in the
    // visible action row for every comment, so the kebab holds only the
    // author-only Edit / Delete. Every menu row closes the popover and calls
    // the existing handler.
    const closeMenu = (): void => setMenuOpenId(null);
    const role = comment.legacy_author_name !== null ? null : roleOf(comment.author_user_id);

    return (
      <>
        <div className="mb-1 flex min-w-0 items-center gap-2">
          <Avatar
            name={authorName}
            size={isReply ? 'sm' : 'md'}
            {...(authorAvatarUrl !== null && authorAvatarUrl !== undefined
              ? { src: authorAvatarUrl }
              : {})}
          />
          <span className="truncate text-xs font-medium text-fg">{authorName}</span>
          {role !== null ? (
            <span data-comment-role="" className="shrink-0 text-[11px] text-fg-3">
              {role}
            </span>
          ) : null}
          {comment.edited_at !== null ? (
            <span className="shrink-0 text-[11px] text-fg-3">
              {pointEditedMarker(comment.edited_at, new Date())}
            </span>
          ) : null}
          <span aria-hidden className="text-fg-3">
            ·
          </span>
          <span className="shrink-0 text-xs text-fg-3 tabular-nums">
            {relativeLong(comment.created_at, new Date())}
          </span>
          {!editing && pointMenuMode(actions) === 'menu' ? (
            <div className="relative ml-auto shrink-0">
              <IconButton
                label="Comment actions"
                onClick={() =>
                  setMenuOpenId((current) => (current === comment.id ? null : comment.id))
                }
              >
                <IconMore size={20} />
              </IconButton>
              <MenuPopover open={menuOpenId === comment.id} onClose={closeMenu} align="right">
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
                      handleDelete(comment.id);
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
            {annotationChip(
              comment.id,
              annotationsByCommentId?.[comment.id],
              onAnnotationChipClick,
            )}
            {comment.body.trim() !== '' ? (
              <p className="text-sm leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere] text-fg">
                {renderCommentBody(
                  comment.body,
                  handleOf,
                  searchWords,
                  firstExternalUrl(comment.body),
                )}
              </p>
            ) : null}
            <CommentLinkCard body={comment.body} />
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
            {isReply && actions.canCopy ? (
              <div className="mt-1 flex min-h-[44px] items-center gap-2">
                {copyControl(comment)}
              </div>
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
              data-induction={
                comment.id === guideReplyCommentId ? INDUCTION_KEYS.postCommentReply : undefined
              }
              onClick={() => onReplyButton(comment)}
            >
              {isReplyOpen ? 'Cancel' : 'Reply'}
            </Button>
          ) : null}
          {showResolve && !tombstone ? (
            <Button
              size="sm"
              variant="ghost"
              className="min-h-[44px] min-w-[44px]"
              disabled={isResolving}
              onClick={() =>
                isResolved ? void handleResolve(comment, false) : handleOneTapResolve(comment)
              }
            >
              {isResolving ? 'Saving' : isResolved ? 'Reopen' : 'Resolve'}
            </Button>
          ) : null}
          {!tombstone ? copyControl(comment) : null}
          {footRight !== undefined ? <span className="ml-auto">{footRight}</span> : null}
        </div>

        {renderReplyList(replies, (reply) => renderCommentCard(reply, true))}

        {isReplyOpen ? renderReplyComposer(comment) : null}
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
        {tombstone ? null : isResolved ? (
          <div
            data-comment-state="resolved"
            className="mb-2 flex items-center gap-1.5 text-xs font-medium text-good"
          >
            <IconCheck size={14} />
            Resolved
          </div>
        ) : (
          <div data-comment-state="open" className="mb-2 text-xs font-medium text-fg-3">
            Open
          </div>
        )}

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
  // Only two states show: Open and Resolved. An agency member gets a one-tap
  // "Resolve" on an open point (no note, no confirm; Undo lives in the bottom
  // strip); every other case is a passive tick. A client gets the quiet
  // "Not done" beneath a resolved point. The per-point reply affordance is the
  // existing thread tail.
  function renderBatchItem(group: { authorId: string; threads: ThreadRoot[] }): ReactNode {
    const first = group.threads[0]?.comment;
    if (first === undefined) return null;
    const authorName = first.legacy_author_name ?? nameOf(first.author_user_id) ?? '';
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
            const label = checkpointStateLabel(state);
            const live = !tombstone && tickInteractive(state, isClient);
            const filled = tickFilled(state);
            const busy = resolvingId === comment.id;
            const notDone = !tombstone && showCheckpointNotDone(state, isClient);
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
                    soft success (resolved). Colour only. */}
                <span
                  aria-hidden
                  className={cn(
                    'w-0.5 shrink-0 self-stretch rounded-full',
                    state === 'open' ? 'bg-border' : 'bg-good opacity-60',
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
                              state === 'resolved' ? 'text-fg-2' : 'text-fg',
                            )}
                          >
                            {renderCommentBody(
                              comment.body,
                              handleOf,
                              searchWords,
                              firstExternalUrl(comment.body),
                            )}
                            {editedMarker !== null ? (
                              <span className="ml-1.5 text-[11px] text-fg-3">{editedMarker}</span>
                            ) : null}
                          </p>
                          <CommentLinkCard body={comment.body} />
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
                              {copyFailed ? COPY_FAILED : 'Copied'}
                            </span>
                          ) : null}
                        </>
                      )}
                    </div>
                    {/* T9: Copy is visible on every live point; the kebab holds
                        only the author-only Edit / Delete. */}
                    {!editing && actions.canCopy ? (
                      <div className="shrink-0">
                        <IconButton
                          label="Copy text"
                          className="opacity-70"
                          onClick={() => void handleCopy(comment)}
                        >
                          <IconCopy size={18} />
                        </IconButton>
                      </div>
                    ) : null}
                    {!editing && pointMenuMode(actions) === 'menu' ? (
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
                                handleDelete(comment.id);
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
                        data-induction={
                          comment.id === guideReplyCommentId
                            ? INDUCTION_KEYS.postCommentReply
                            : undefined
                        }
                        onClick={() => onReplyButton(comment)}
                      >
                        {replyOpen.has(comment.id) ? 'Cancel' : 'Reply'}
                      </Button>
                    ) : null}
                    {live ? (
                      <button
                        type="button"
                        aria-label={`Resolve checkpoint ${seq}`}
                        onClick={() => handleOneTapResolve(comment)}
                        // axis: background-color on hover only; the tick fill motion
                        // (opacity + translateY) lives inside tickCircle.
                        className="ml-auto flex h-11 min-h-[44px] min-w-[44px] items-center justify-center gap-1.5 rounded-md px-1.5 text-sm font-medium text-good transition-colors duration-fast hover:bg-panel-3 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                      >
                        {tickCircle(false, true)}
                        <span>Resolve</span>
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

                  {notDone ? (
                    <div className="flex items-center gap-3 pl-7">
                      <QuietTextButton
                        disabled={busy}
                        onClick={() => void handleCheckpointNotDone(comment)}
                      >
                        {busy ? 'Saving' : 'Not done'}
                      </QuietTextButton>
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
                    {!tombstone && replyOpen.has(comment.id) ? renderReplyComposer(comment) : null}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      </li>
    );
  }

  // The root composer sits at the END of the list (not fixed), so reading comes
  // first and writing follows it.
  const composer =
    viewerIsClient === true && entityType === 'post' ? (
      <SlotComposer onSubmit={handleCreateBatch} canAttach={canAttach} uploadFile={uploadFile} />
    ) : (
      <CommentComposer
        onSubmit={(body, options) => handleCreate(body, { ...options, parentCommentId: null })}
        members={candidates}
        canAttach={canAttach}
        uploadFile={uploadFile}
        placeholder="Write a comment"
      />
    );

  const filterButton = (value: CommentFilter, label: string): ReactNode => (
    <button
      type="button"
      aria-pressed={filter === value}
      onClick={() => setFilter(value)}
      className={cn(
        'inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md px-3 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
        filter === value ? 'bg-panel-3 text-fg' : 'text-fg-2 hover:bg-panel-2 hover:text-fg',
      )}
    >
      {label}
    </button>
  );

  return (
    <div className="flex flex-col gap-4">
      {showHeader ? (
        <div data-comments-header="" className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-fg">Comments</h3>
          {!loading && !loadError && openCount + resolvedCount > 0 ? (
            <span data-open-count="" className="text-xs tabular-nums text-fg-3">
              {commentCountsText({ open: openCount, resolved: resolvedCount })}
            </span>
          ) : null}
          <div role="group" aria-label="Show comments" className="ml-auto flex items-center">
            {filterButton('open', 'Open')}
            {filterButton('all', 'All')}
          </div>
        </div>
      ) : null}
      {belowHeader}

      {loading ? (
        <div aria-busy="true" className="flex flex-col gap-3">
          <span className="sr-only">Loading comments</span>
          {[0, 1, 2].map((row) => (
            <div
              key={row}
              aria-hidden
              className="rounded-xl border border-border bg-panel-2 px-4 py-3"
            >
              <div className="flex items-center gap-2">
                <div className="h-8 w-8 animate-pulse rounded-full bg-panel-3" />
                <div className="h-3 w-24 animate-pulse rounded bg-panel-3" />
              </div>
              <div className="mt-3 h-3 w-full animate-pulse rounded bg-panel-3" />
              <div className="mt-2 h-3 w-2/3 animate-pulse rounded bg-panel-3" />
            </div>
          ))}
        </div>
      ) : loadError ? (
        <LoadError title="comments" onRetry={() => void loadPage(0)} />
      ) : threads.length === 0 ? (
        <div className="rounded-xl border border-border bg-panel-2 px-4 py-8 text-center text-sm text-fg-3">
          No comments yet
        </div>
      ) : groups.length === 0 ? (
        <div className="rounded-xl border border-border bg-panel-2 px-4 py-8 text-center text-sm text-fg-3">
          No open comments
        </div>
      ) : (
        <ul className="flex flex-col gap-3">
          {groups.map((group) =>
            group.kind === 'batch' ? renderBatchItem(group) : renderThreadItem(group.thread),
          )}
        </ul>
      )}

      {!loading && !loadError && moreError ? (
        <div
          role="alert"
          className="flex items-center gap-3 rounded-md border border-bad px-3 py-2 text-sm text-bad"
        >
          <span>Couldn&apos;t load older comments.</span>
          <Button
            size="lg"
            variant="ghost"
            className="ml-auto min-w-[44px]"
            disabled={loadingMore}
            onClick={() => void loadPage(page + 1)}
          >
            {loadingMore ? 'Loading' : 'Retry'}
          </Button>
        </div>
      ) : null}

      {!loading && !loadError && !moreError && hasMore ? (
        <Button
          size="lg"
          className="self-start"
          disabled={loadingMore}
          onClick={() => void loadPage(page + 1)}
        >
          {loadingMore ? 'Loading' : 'Load more'}
        </Button>
      ) : null}

      <div data-comments-composer="">{composer}</div>

      {discardFor !== null ? (
        <ConfirmDialog
          title="Discard reply?"
          message="Your reply has not been sent."
          confirmLabel="Discard"
          cancelLabel="Keep editing"
          destructive
          onConfirm={() => {
            const id = discardFor;
            setDiscardFor(null);
            replyDrafts.delete(draftKey(id));
            toggleReply(id);
          }}
          onCancel={() => setDiscardFor(null)}
        />
      ) : null}

      {lightbox !== null ? (
        <ImageLightbox
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
