import { mark } from '@/lib/perf-marks';
import {
  createContext,
  Fragment,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type {
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactElement,
  ReactNode,
} from 'react';
import { Button } from '@/components/ui/Button';
import { Chip } from '@/components/ui/Chip';
import { ErrorNote } from '@/components/ui/ErrorNote';
import { Textarea } from '@/components/ui/Textarea';
import { WritingBox } from '@/components/ui/WritingBox';
import { dispatchInductionDid, INDUCTION_KEYS } from '@/lib/induction';
import { IconButton } from '@/components/ui/IconButton';
import { LinkButton } from '@/components/ui/LinkButton';
import { LinkPreviewCard } from '@/components/ui/LinkPreviewCard';
import { PressableRow } from '@/components/ui/PressableRow';
import { UnsafeLinkButton } from '@/components/ui/UnsafeLinkSheet';
import { checkLink } from '@/lib/links/safety';
import { parseExternalLink } from '@/lib/links';
import { currentOrigin, firstExternalUrl } from '@/lib/chat/message-links';
import { renderRich, withTextLinks } from '@/components/chat/message-body';
import { highlightNodes, SearchWordsContext } from '@/components/ui/SearchHighlight';
import {
  FOCUS_FAILED_COPY,
  FOCUS_MISSING_COPY,
  FOCUS_READ_RETRY_MS,
  useFocusTarget,
} from '@/lib/focus-target';
import { IconChevronDown, IconReply, IconTrash, ICON_SIZE } from '@/components/ui/icons';
import { cancelPendingLongPressesWithin } from '@/components/ui/useLongPress';
import {
  createSwipeReplyController,
  SWIPE_REST,
  type SwipeReplyController,
} from '@/lib/chat/swipe-reply';
import { Text } from '@/components/ui/Text';
import {
  CHECKPOINT_HIT_CLASS,
  CheckpointCircle,
  checkpointCircleState,
  type CheckpointCircleState,
} from '@/components/comments/CheckpointCircle';
import {
  CommentActionBar,
  CommentTaskTag,
  REOPEN_LABEL,
  type ResolveHook,
} from '@/components/comments/CommentActionBar';
import { CommentTaskSheet } from '@/components/comments/CommentTaskSheet';
import {
  commentViewerTitle,
  fetchCommentFiles,
  idsToRead,
  toCommentFileAttachments,
  type CommentFile,
} from '@/components/comments/comment-files';
import { LoadError } from '@/components/ui/LoadError';
import { Avatar } from '@/components/ui/Avatar';
import { PersonTrigger } from '@/components/ui/PersonTrigger';
import { cn } from '@/lib/cn';
import { Bone, GlideItem, itemIn, itemOut, motionOff, paintSwipe } from '@/lib/motion';
import { formatAgo } from '@/lib/time';
import { isLaptopNow } from '@/lib/use-is-laptop';
import { useMinuteClock } from '@/components/ui/use-minute-clock';
import { useUndoableAction } from '@/lib/use-undoable-action';
import { UNDO_MS } from '@/lib/undo';
import { useBackGuard } from '@/lib/back-guard';
import { useOptionalToast } from '@/components/ui/toast';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { friendlyCommentError } from '@/components/comments/comment-errors';
import { errorText } from '@/lib/error-copy';
import { MessageAttachments } from '@/components/chat/MessageAttachments';
import { useCommentAttachments } from '@/lib/chat/use-chat-attachments';
import { logger } from '@/lib/logger';
import { supabase } from '@/lib/supabase';
import { useNewTrace } from '@/lib/trace-context';
import {
  COMMENT_SELECT,
  createComment,
  deleteComment,
  editComment,
  getCommentsByIds,
  isInvalidMention,
  listComments,
  parseMentions,
  resolveComment,
  stripFormat,
  withTaskEmbeds,
  PAGE_SIZE,
} from '@srtdio/comments';
import type {
  Client,
  CommentEntityType,
  CommentRow,
  CommentTaskEmbed,
  CreateCommentInput,
  Result,
} from '@srtdio/comments';
import { checkpointAccept, commentResolve, DOMAIN_ERROR_CODES } from '@srtdio/rpc';
import type { DomainErrorCode } from '@srtdio/rpc';
import type { Json } from '@srtdio/schemas';
import { classifyAttachment, type MessageAttachment } from '@/lib/chat/attachments';
import { CommentComposer } from '@/components/comments/CommentComposer';
import { commentMentionCandidates } from '@/components/comments/mention-scope';
import { SlotComposer } from '@/components/comments/SlotComposer';
import type { CheckpointPoint } from '@/components/comments/SlotComposer';
import { ImageLightbox } from '@/components/ui/ImageLightbox';
import { useMentionCandidates } from '@/lib/workspace-members';
import type { MentionCandidate } from '@/lib/workspace-members';
import {
  authorProfiles,
  backfillProfiles,
  resolveMentionHandle,
  resolveName,
  type CommentProfile,
} from '@/components/comments/commentProfiles';
import { READ_TIMEOUT_MS } from '@/lib/chat-reads';
import {
  deserializeMentions,
  knownMentionName,
  serializeMentions,
  type MentionPick,
} from '@/lib/chat/mentions';
import { FORMER_MEMBER, personAvatar, personName, resolvePeople } from '@/lib/people-names';
import { isFormerMember } from '@/lib/chat/mentions';
import { canReplyPrivately, commentPrivateReplyDraft } from '@/lib/reply-privately';
import type { PrivateReplyDraft } from '@/lib/chat/private-reply';
import {
  commentBar,
  commentTaskTag,
  isAgencyRole,
  resolveSlot,
  taskTitleFrom,
  type ResolveSlot,
} from '@/lib/comment-tasks';

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
} from '@/components/pages/pcs/checkpoint-controls';

/** One caption_span annotation as it reads on a comment row. Optional surface:
 *  posts pass it, briefs never do, so the chips are post-only by construction. */
export interface CommentAnnotation {
  n: number;
  quote: string;
  stale: boolean;
  versionNumber: number;
  /**
   * A photo pin: the slide it sits on, 1-based. Set, the row reads "On photo
   * {slide}" in its meta instead of the caption quote. Absent on a caption
   * highlight.
   */
  slide?: number;
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
  /** A linked comment (Activity, toast, email, search): read by id when it is
   *  not on page zero, then scrolled to and tinted once per distinct id
   *  (useFocusTarget). One toast when it is deleted or not visible. */
  focusCommentId?: string | null;
  /** A fresh value per link (e.g. per tap) so the same comment linked twice
   *  lands twice; defaults to the id. */
  focusRequestKey?: string | null;
  /** True when the viewer's workspace role is 'client'. Gates ONLY the
   *  top-level composer on posts, which becomes the checkpoint SlotComposer
   *  (comment_batch_create). Replies (any role), the agency composer, and the
   *  brief mount (which never passes this) keep CommentComposer unchanged. */
  viewerIsClient?: boolean;
  /** The comment the onboarding guide teaches replying on (the first caption
   *  highlight's): its Reply and reply Post carry the guide's keys. */
  guideReplyCommentId?: string | null;
  /**
   * Posts: the "Checkpoints" header row (the title + the Open / All filter). The
   * chips row under it (belowHeader) carries the one counter. Briefs keep their
   * own heading and pass nothing.
   */
  showHeader?: boolean;
  /** Rendered under the header, above the list (the post's CheckpointStrip). */
  belowHeader?: ReactNode;
  /** Live open / resolved top-level thread counts (checkpoints included), lifted
   *  once loaded and on every change, optimistic resolves included. Lets the page
   *  render its "{n} open checkpoints" pill and the creator's resubmit gate. */
  onCountsChange?: (counts: CommentCounts) => void;
  /**
   * Posts: the host's one checkpoint read (PostDetailPage), shared with the
   * CheckpointStrip. When set, Comments never reads the checkpoints itself: it
   * merges these rows and calls `reload` wherever it would have re-read them
   * (after its own writes, Retry). Absent (brief detail, chat, any other host):
   * Comments reads them itself after each page-zero load, exactly as before.
   */
  sharedCheckpoints?: SharedCheckpoints;
  /**
   * Posts: the post's stage. On a draft the @-mention picker does not offer
   * clients (they cannot see drafts). Briefs pass nothing.
   */
  postStage?: string;
  /**
   * The post or brief title the page already holds: the writing boxes'
   * expanded title, and the where label on the person card's quote (a tap on
   * a comment's author). Absent reads as this section's own heading.
   */
  whereLabel?: string;
}

/** The toast when comment_create rejects a mention (a client on a draft post). */
export const DRAFT_MENTION_TOAST = "Clients can't see drafts. Tag them once it's in Review.";

/** One checkpoint read owned by the host and shared by Comments and the strip. */
export interface SharedCheckpoints {
  /** Every checkpoint for the post as {@link fetchCheckpoints} reads it; null
   *  until the first read lands. */
  rows: readonly CommentRow[] | null;
  /** Re-run the host's read (resolves once it has landed). */
  reload: () => Promise<void>;
}

/** Open vs resolved top-level threads, as the header reads them. */
export interface CommentCounts {
  open: number;
  resolved: number;
}

/** The one failure copy for a one-tap Resolve (or its Undo) that did not land. */
export const RESOLVE_FAILED_COPY = errorText('resolve the checkpoint', null);
/** The one failure copy for a one-tap Confirm (or its Undo) that did not land. */
export const CONFIRM_FAILED_COPY = errorText('confirm the checkpoint', null);

/** A checkpoint's live state as the comments list shows it (optimistic taps included). */
export type LiveCheckpoint = Pick<CommentRow, 'resolved_at' | 'accepted_at'>;

/**
 * The list's live checkpoint state, keyed by comment id, for the strip under the
 * header. Null until the list has loaded (the strip then shows its own read).
 */
export const LiveCheckpointsContext = createContext<ReadonlyMap<string, LiveCheckpoint> | null>(
  null,
);

/** Checkpoint rows (ledger_seq set) to their live resolved / confirmed state. Pure. */
export function liveCheckpointMap(
  rows: readonly Pick<CommentRow, 'id' | 'ledger_seq' | 'resolved_at' | 'accepted_at'>[],
): ReadonlyMap<string, LiveCheckpoint> {
  const map = new Map<string, LiveCheckpoint>();
  for (const row of rows) {
    if (row.ledger_seq === null) continue;
    map.set(row.id, { resolved_at: row.resolved_at, accepted_at: row.accepted_at });
  }
  return map;
}

/** The checkpoint chips row's progress line: "{n} of {m} resolved". Pure. The
 *  chips row (CheckpointStrip) renders it beside the numbered chips; it is the
 *  section's only counter. */
export function checkpointProgressText(resolved: number, total: number): string {
  return `${resolved} of ${total} resolved`;
}

/** The post's top pill: "1 open checkpoint" / "{n} open checkpoints". Pure. */
export function openCheckpointsLabel(count: number): string {
  return `${count} open ${count === 1 ? 'checkpoint' : 'checkpoints'}`;
}

/** The section title on posts (replaces "Comments"). */
export const CHECKPOINTS_TITLE = 'Checkpoints';

/** The empty-list line: posts read in checkpoints, briefs keep comments. Pure. */
export function emptyListText(entityType: CommentEntityType, filter: CommentFilter): string {
  if (entityType === 'post') {
    return filter === 'open' ? 'Open checkpoints show up here.' : 'Checkpoints show up here.';
  }
  return filter === 'open' ? 'Open comments show up here.' : 'Comments show up here.';
}

/**
 * Layout added to the text row actions left (View earlier replies): a ghost
 * <Button>, a 44 tall, 44 wide minimum hit, with the visible word at meta size
 * so the line reads small. Every per-comment action lives on the comment's
 * action bar (CommentActionBar): Reply, Resolve, To-do, Edit, Delete.
 */
export const ROW_ACTION_CLASS = 'min-w-11 px-2 text-sm';

/** Resolve's accessible name on a thread's action bar: one tap resolves. */
export const CHECKPOINT_BOX_LABEL = 'Resolve';

/** The fold control over a thread's older replies. Pure. */
export function earlierRepliesLabel(count: number): string {
  return count === 1 ? 'View 1 earlier reply' : `View ${count} earlier replies`;
}

/** A checkpoint group's meta line: "{n} checkpoints · {time}". Pure. */
export function checkpointGroupMeta(count: number, time: string): string {
  return `${count} ${count === 1 ? 'checkpoint' : 'checkpoints'} · ${time}`;
}

/** A photo pin's row meta: "On photo {n}" (slide index, 1-based). Pure. */
export function onPhotoLabel(slide: number): string {
  return `On photo ${slide}`;
}

/** A resolved point's folded line: "{n} · {body first line}" (formatting and
 *  mentions flattened; the line itself truncates with an ellipsis). Pure. */
export function foldedPointText(
  seq: number,
  body: string,
  nameOf: (id: string) => string | null,
): string {
  const first =
    stripFormat(commentCopyText(body, nameOf))
      .split('\n')
      .find((line) => line.trim() !== '') ?? '';
  return `${seq} · ${first.trim()}`;
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

/** A linked row lands clear of a sticky bottom bar: the host sets
 *  --focus-inset-bottom (the post page's phone decision bar). */
export const COMMENT_ROW_SCROLL_CLASS = 'scroll-mb-[var(--focus-inset-bottom,0px)]';

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
 * What a comment row shows above its body for its annotation. A photo pin on
 * the current version reads "On photo {n}" in meta. A live caption quote is an
 * ink rail (border-l-rail fg) with the small numbered ink circle; its tap flashes
 * the caption mark. A stale one (either kind) is inert and reads "copy changed"
 * with the version it was made on. Absent annotation (every brief comment)
 * renders nothing. `circle` is the checkpoint's own circle state when the row
 * is a checkpoint, so the quote's circle never disagrees with the list's.
 */
export function annotationChip(
  commentId: string,
  annotation: CommentAnnotation | undefined,
  onClick?: (commentId: string) => void,
  circle: CheckpointCircleState = 'open',
): ReactNode {
  if (annotation === undefined) return null;
  if (annotation.stale) {
    return (
      <div
        data-caption-quote="stale"
        className="mb-2 min-w-0 border-l-rail border-border pl-3 text-base text-fg-2"
      >
        <span className="block text-xs text-fg-3">copy changed · v{annotation.versionNumber}</span>
        {annotation.quote !== '' ? (
          <span className="block [overflow-wrap:anywhere]">{annotation.quote}</span>
        ) : null}
      </div>
    );
  }
  if (annotation.slide !== undefined) {
    return (
      <Text role="meta" as="p" data-photo-pin="" className="mb-1">
        {onPhotoLabel(annotation.slide)}
      </Text>
    );
  }
  return (
    <PressableRow
      type="button"
      flat
      data-caption-quote="live"
      onClick={() => onClick?.(commentId)}
      className="mb-2 flex min-w-0 items-start gap-2 border-l-rail border-fg pl-3 text-base text-fg-2 mv-tint hover:text-fg"
    >
      <CheckpointCircle n={annotation.n} state={circle} size="inline" className="mt-1" />
      <span className="min-w-0 [overflow-wrap:anywhere]">{annotation.quote}</span>
    </PressableRow>
  );
}

// Format a stored timestamp in the app's one past-time format (formatAgo:
// "just now", "5m", "Yesterday", "Mon"). Falls back to the raw value if it is
// somehow unparseable so nothing is silently dropped.
function formatTimestamp(value: string, now: Date): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return formatAgo(value, now);
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

/**
 * A comment body (or a brief's objective / brand requirements): Slack blocks
 * and WhatsApp formatting outermost, then [text](url) links, mentions, links
 * and search marks inside each styled segment. A body with no formatting
 * renders exactly as before.
 */
export function renderCommentBody(
  body: string,
  nameOf: (id: string) => string | null,
  words: readonly string[] = [],
  cardUrl: string | null = null,
): ReactNode[] {
  // One card slot across segments: the card's link is shown there, once.
  const card = { url: cardUrl };
  return renderRich(
    body,
    withTextLinks((text) => commentRuns(text, nameOf, words, card), false, currentOrigin(), words),
  );
}

function commentRuns(
  body: string,
  nameOf: (id: string) => string | null,
  words: readonly string[],
  card: { url: string | null },
): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const match of body.matchAll(MENTION_TOKEN)) {
    const start = match.index ?? 0;
    if (start > last) pushBodyText(nodes, body.slice(last, start), `t${key}`, words, card);
    const id = (match[1] ?? '').toLowerCase();
    const name = nameOf(id);
    const label = mentionDisplay(name);
    const span = (
      <span key={`m-${key}`} className="font-medium text-accent">
        {words.length === 0 ? label : highlightNodes(label, words)}
      </span>
    );
    // A resolved mention opens the person card; one not read yet renders nothing to tap.
    nodes.push(
      name === null ? (
        span
      ) : (
        <PersonTrigger
          key={`m-${key}`}
          userId={id}
          {...(name === FORMER_MEMBER ? { former: true } : {})}
        >
          {span}
        </PersonTrigger>
      ),
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
export function CommentLinkCard(props: { body: string; url?: string | null }): ReactNode {
  // The row passes the url it already found for the body (one scan per row).
  const url = props.url !== undefined ? props.url : firstExternalUrl(props.body);
  return url !== null ? (
    <LinkPreviewCard key={url} url={url} className="mt-2 w-full max-w-sm" />
  ) : null;
}

interface TombstoneRow {
  author_user_id: string;
  deleted_at: string | null;
  created_at: string;
  legacy_author_name: string | null;
  /** Set on a checkpoint row. */
  ledger_seq?: number | null;
}

/** The tombstone line for a soft-deleted root. Author-only delete means the
 *  deleter is the author; name it when it resolves, else stay anonymous. A
 *  checkpoint row (ledger_seq set) reads "Checkpoint deleted". */
export function tombstoneText(
  comment: TombstoneRow,
  nameOf: (id: string) => string | null,
  now: Date = new Date(),
): string {
  const when = formatTimestamp(comment.deleted_at ?? comment.created_at, now);
  const who = comment.legacy_author_name ?? nameOf(comment.author_user_id);
  const noun =
    comment.ledger_seq !== undefined && comment.ledger_seq !== null ? 'Checkpoint' : 'Comment';
  return who !== null ? `Deleted by ${who} · ${when}` : `${noun} deleted · ${when}`;
}

/** How a thread's replies fold: only the latest shows until unfolded. */
export interface ReplyFold {
  /** True once "View {n} earlier replies" was tapped (or a link landed inside). */
  unfolded: boolean;
  /** Tap on "View {n} earlier replies". */
  onUnfold: () => void;
  /** The thread root, so the unfold's motion can find the rows it revealed. */
  rootId: string;
}

/** Which replies show for a fold state: all when unfolded, else only the latest. Pure. */
export function visibleReplies<T>(
  replies: readonly T[],
  unfolded: boolean,
): {
  shown: T[];
  hidden: number;
} {
  if (unfolded || replies.length <= 1) return { shown: [...replies], hidden: 0 };
  return { shown: replies.slice(-1), hidden: replies.length - 1 };
}

/**
 * The replies under a thread root, oldest first, on the root's text column:
 * no left rule and no indent beyond it. Folded, only the latest reply shows,
 * with "View {n} earlier replies" above it; the tap reveals the rest in place.
 * Without a fold every reply shows. Zero replies renders nothing at all. Each
 * reply keeps its stable per-row DOM id so a deep link can scroll to it (a
 * link to a folded reply unfolds its thread first). `renderReply` is the
 * caller's row renderer.
 */
export function renderReplyList(
  replies: readonly CommentRow[],
  renderReply: (reply: CommentRow) => ReactNode,
  fold?: ReplyFold,
): ReactNode {
  if (replies.length === 0) return null;
  const { shown, hidden } = visibleReplies(replies, fold === undefined || fold.unfolded);
  const earlier = fold !== undefined && fold.unfolded ? replies.slice(0, -1) : [];
  const latest = fold !== undefined && fold.unfolded ? replies.slice(-1) : shown;
  const item = (reply: CommentRow): ReactNode => (
    <li key={reply.id} id={commentDomId(reply.id)} className={COMMENT_ROW_SCROLL_CLASS}>
      {renderReply(reply)}
    </li>
  );
  return (
    // Each reply keeps 24 above it for its action bar (half above the row).
    <div data-replies="" className="mt-6 flex flex-col">
      {hidden > 0 && fold !== undefined ? (
        <Button
          type="button"
          variant="ghost"
          data-replies-more=""
          aria-expanded={false}
          className={cn(ROW_ACTION_CLASS, '-ml-2 self-start')}
          onClick={fold.onUnfold}
        >
          {earlierRepliesLabel(hidden)}
        </Button>
      ) : null}
      {earlier.length > 0 ? (
        <ul data-replies-earlier={fold?.rootId ?? ''} className="flex flex-col gap-6">
          {earlier.map(item)}
        </ul>
      ) : null}
      <ul className={cn('flex flex-col gap-6', earlier.length > 0 || hidden > 0 ? 'mt-6' : '')}>
        {latest.map(item)}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Checkpoint batches in the thread (feedback ledger)
// ---------------------------------------------------------------------------

/** One rendered item of the thread list: a plain one-level thread, or a run of
 *  consecutive checkpoint threads from the same author (one group, the author
 *  shown once above a numbered list). */
export type ThreadGroup =
  | { kind: 'single'; thread: ThreadRoot }
  | { kind: 'batch'; authorId: string; threads: ThreadRoot[] };

/**
 * Collapse consecutive TOP-LEVEL checkpoint threads (ledger_seq not null) from
 * the SAME author into one group; every other thread passes through unchanged.
 * Only adjacency in the newest-first list groups, so two runs from the same
 * author separated by an ordinary comment stay separate. Inside a group the
 * open points come first, then the resolved ones (they fold to one line at the
 * bottom), each in ledger_seq order. The number is the ledger_seq, so a point
 * never changes number when another is resolved, reopened or deleted.
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
        const done =
          Number(a.comment.resolved_at !== null) - Number(b.comment.resolved_at !== null);
        return done !== 0 ? done : (a.comment.ledger_seq ?? 0) - (b.comment.ledger_seq ?? 0);
      });
    }
  }
  return groups;
}

/** The newest send in a checkpoint group (its meta time). Pure. */
export function groupLatestAt(threads: readonly ThreadRoot[]): string {
  return threads.reduce(
    (latest, thread) => (thread.comment.created_at > latest ? thread.comment.created_at : latest),
    '',
  );
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

/** The checkbox's one-tap Resolve is live only for an agency member on an open
 *  checkpoint. Every other case is a passive box. */
export function tickInteractive(state: CheckpointState, isClient: boolean): boolean {
  return !isClient && state === 'open';
}

/** True once the approver has confirmed the point (accepted_at set). Confirmed
 *  requires resolved, so an agency reopen (resolved_at back to null) never reads
 *  as confirmed even with a stale accepted stamp. Pure. */
export function checkpointConfirmed(row: Pick<CommentRow, 'resolved_at' | 'accepted_at'>): boolean {
  return row.resolved_at !== null && row.accepted_at !== null;
}

/** The passive tick fills only once the point is resolved AND confirmed by the
 *  approver; a resolved point awaiting the Confirm shows the hollow tick. The
 *  state word stays "Resolved" either way. */
export function tickFilled(state: CheckpointState, confirmed: boolean): boolean {
  return state === 'resolved' && confirmed;
}

/** The approver's one-tap "Confirm" shows only to a client on a resolved point
 *  they have not confirmed yet. The creator never sees it. */
export function showCheckpointConfirm(
  state: CheckpointState,
  isClient: boolean,
  confirmed: boolean,
): boolean {
  return isClient && state === 'resolved' && !confirmed;
}

/** The person a checkpoint reply is aimed at: the checkpoint's author (Reply on
 *  the checkpoint) or a reply's author (Reply on a reply). */
export type ReplyTarget = Pick<CommentRow, 'author_user_id' | 'legacy_author_name'>;

/**
 * The seed body for a checkpoint's reply composer: only ever the @Name mention
 * of the person replied to (a reply's author when replying to a reply, else the
 * checkpoint's author). Nothing else is ever pre-filled. Pure.
 */
export function checkpointReplySeed(
  root: ReplyTarget,
  target: ReplyTarget | null,
  currentUserId: string | null,
  candidates: readonly MentionCandidate[],
): string {
  return replySeed(target ?? root, currentUserId, candidates);
}

/**
 * The server keeps one reply level: a reply to a reply posts to the checkpoint
 * root. The parent id for any reply inside a thread is therefore the root id,
 * whichever row (root or reply) the Reply was tapped on. Pure.
 */
export function replyParentId(tapped: Pick<CommentRow, 'id' | 'parent_comment_id'>): string {
  return tapped.parent_comment_id ?? tapped.id;
}

/**
 * Retarget an open reply draft to a new person: an untouched (seed-only) draft
 * becomes the new seed; typed text is kept with the new mention in front (the
 * old seed is dropped so only one @Name leads). Pure.
 */
export function retargetDraft(draft: string | undefined, oldSeed: string, newSeed: string): string {
  if (draft === undefined || !replyHasTypedText(draft, oldSeed)) return newSeed;
  const typed = oldSeed !== '' && draft.startsWith(oldSeed) ? draft.slice(oldSeed.length) : draft;
  return `${newSeed}${typed.trimStart()}`;
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

/** Which author-only actions a comment offers on its bar: Edit and Delete stay
 *  the author's; a tombstone offers nothing. */
export interface CommentActions {
  canEdit: boolean;
  canDelete: boolean;
}

export function commentActions(
  comment: Pick<CommentRow, 'author_user_id' | 'deleted_at' | 'legacy_author_name'>,
  currentUserId: string | null,
  tombstone: boolean,
): CommentActions {
  if (tombstone) return { canEdit: false, canDelete: false };
  const mine = canModifyComment(comment, currentUserId);
  return { canEdit: mine, canDelete: mine };
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
 *  frozen. Replies are unaffected. */
export function pointActions(
  point: Pick<
    CommentRow,
    'author_user_id' | 'deleted_at' | 'legacy_author_name' | 'accepted_at' | 'closed_at'
  >,
  currentUserId: string | null,
  tombstone: boolean,
): CommentActions {
  const base = commentActions(point, currentUserId, tombstone);
  if (isPointFrozen(point)) return { canEdit: false, canDelete: false };
  return base;
}

/** When an edit happened, in the app's one past-time format (formatAgo:
 *  "just now", "5m", "Yesterday", "Mon"). Unparseable input yields '' so
 *  nothing raw is shown. */
export function editedTime(ts: string, now: Date): string {
  return formatAgo(ts, now);
}

/** A ledger point's "edited <time>" marker (at the end of its body), or null
 *  when it was never edited. Comments and replies end in EDITED_MARKER instead. */
export function pointEditedMarker(editedAt: string | null, now: Date): string | null {
  return editedAt === null ? null : `edited ${editedTime(editedAt, now)}`.trimEnd();
}

/** Reply drafts per thread, kept for as long as the page is open (they survive
 *  the panel remounting, never a reload). Keyed by entity + thread root. */
const replyDrafts = new Map<string, string>();

/** The root composer's draft per post (or brief), kept the same way as
 *  replyDrafts: for as long as the page is open, never across a reload. Keyed
 *  by workspace + entity. */
const rootDrafts = new Map<string, string>();

/** True when a draft body holds anything but whitespace. Pure. */
export function draftHasText(draft: string | undefined): boolean {
  return draft !== undefined && draft.trim() !== '';
}

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

/**
 * The row a landed write shows at once, built from the known input and the id
 * the proc returned (comment_create returns only the id; comment_batch_create
 * {id, seq}). It is the same row the next page-zero read returns, bar the
 * server's timestamps, which that silent background read then swaps in. Pure.
 */
export function localCommentRow(params: {
  id: string;
  workspaceId: string;
  entityType: CommentEntityType;
  entityId: string;
  authorUserId: string;
  body: string;
  attachmentVersionIds: readonly string[];
  parentCommentId: string | null;
  /** The checkpoint number (comment_batch_create's seq); null on a plain comment. */
  ledgerSeq: number | null;
  nowIso: string;
}): CommentRow {
  const mentions = parseMentions(params.body);
  return {
    accepted_at: null,
    accepted_by: null,
    asked_at: null,
    asked_by: null,
    attachment_asset_ids:
      params.attachmentVersionIds.length > 0 ? [...params.attachmentVersionIds] : [],
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
    ledger_seq: params.ledgerSeq,
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
  };
}

/** Put landed rows into a list (replacing any with the same id), newest first. Pure. */
export function upsertRows(
  rows: readonly CommentRow[],
  added: readonly CommentRow[],
): CommentRow[] {
  const ids = new Set(added.map((row) => row.id));
  return [...added, ...rows.filter((row) => !ids.has(row.id))];
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
    .select(COMMENT_SELECT)
    .eq('workspace_id', workspaceId)
    .eq('entity_type', 'post')
    .eq('entity_id', entityId)
    .not('ledger_seq', 'is', null)
    .is('parent_comment_id', null)
    .order('created_at', { ascending: false });
  if (error || data === null) return [];
  return withTaskEmbeds(data);
}

/** A row's Reply on its action bar. */
interface RowReply {
  onReply: () => void;
  /** The row's reply composer is open (the root's Reply then closes it). */
  open?: boolean;
  /** The onboarding guide's anchor on the Reply it teaches. */
  induction?: string | undefined;
  /** A reply's Reply (aims at that reply's author). */
  toReply?: boolean;
}

/** A row's Resolve slot on its action bar. */
interface RowResolve {
  slot: ResolveSlot;
  label: string;
  hook: ResolveHook;
  busy?: boolean;
  onResolve: () => void;
}

/** What one row on the shared row template shows besides the comment itself. */
interface RowOptions {
  /** A reply: avatar 20 and name on one line, on the root's text column. */
  reply: boolean;
  /** A checkpoint point: its author shows once on the group, so no name line. */
  point: boolean;
  /** The fixed left column (44 wide): the root's avatar or the point's circle. */
  lead: ReactNode;
  actions: CommentActions;
  /** A resolved row's body reads in fg-2. */
  muted?: boolean;
  /** The bar's Reply; null when the row offers none. */
  replyAction: RowReply | null;
  /** The bar's Resolve slot; absent where resolving is not allowed. */
  resolve?: RowResolve;
  /** Under the row on the text column: replies and the reply composer. */
  below?: ReactNode;
  /** The checkpoint's circle state, so its caption quote circle matches. */
  circle?: CheckpointCircleState;
  /** A touch swipe right: exactly the row's Reply. Null rubber-bands (no Reply to give). */
  swipeReply?: (() => void) | null;
}

/** One thread (or checkpoint group) in the list: hairlines between, no card. */
export const THREAD_ITEM_CLASS = 'py-3';

/**
 * A plain thread's item: its root sits right on the top hairline so the root's
 * action bar rides ON that line, half above it; the 24 under every item is the
 * room the next item's bar takes (its 44 hit runs 22 above the line), so a bar
 * never covers the comment above, a title or a time.
 */
export const THREAD_BAR_ITEM_CLASS = 'pb-6';

/** An item whose first line carries no bar (a tombstone, a checkpoint group's
 *  author line): its own 12 above, and the same 24 under for the next bar. */
export const THREAD_TOMBSTONE_ITEM_CLASS = 'pt-3 pb-6';

/** The list keeps the same 24 above its first item, for that item's bar. */
export const THREAD_LIST_BAR_CLASS = 'pt-6';

/** The list inside the one comments card: threads split by hairlines. */
export const THREAD_LIST_CLASS = 'flex flex-col divide-y divide-border';

/** Briefs have no host section: the list closes its own flat section (flat
 *  look: no frame, no fill, a hairline under). Posts sit in the page's
 *  comments section (PostDetailPage), so the list adds none. */
export const OWN_CARD_CLASS = 'border-b border-border';

/** The fixed left column: the root avatar, the group avatar or the point circle. */
const LEAD_COLUMN_CLASS = 'flex w-11 shrink-0 justify-center';

/**
 * A row's lead and text columns sit 16 under the row's top edge, the room the
 * action bar takes there (it rides that edge, absolute, half above it), so the
 * bar never shares the name's line and never covers the name or the time.
 */
export const ROW_BAR_ROOM_CLASS = 'mt-4';

/** The " (edited)" marker at the end of an edited comment or reply body (Slack way). */
export const EDITED_MARKER = '(edited)';

/**
 * The swipe icons behind a comment row (the chat bubble's look): a 32 circle,
 * panel-3 idle, accent when armed (data-armed). Reply sits behind the row's
 * resting left edge, the bin behind its right edge. Scale and opacity are
 * painted per frame by paintSwipe; at rest the classes hold them at scale 0,
 * opacity 0.
 */
const SWIPE_ICON_CLASS =
  'pointer-events-none absolute inset-y-0 my-auto flex h-8 w-8 scale-0 items-center justify-center rounded-full bg-panel-3 opacity-0 data-[armed]:bg-accent data-[armed]:text-accent-fg';

/**
 * One comment or reply row on touch: swipe right = its Reply, swipe left = its
 * Delete (only where the row's bar offers Delete; the same UndoStrip path), the
 * one core (src/lib/chat/swipe-reply.ts) in 'both' ways. A way with nothing to
 * do rubber-bands and never fires. A mouse never swipes (the core ignores it),
 * so laptop is unchanged. Vertical moves stay the list's (touch-pan-y); the
 * press is the row's own until it moves 8px sideways, so taps on links,
 * mentions, pins, photos and the bar still land. No layout read per move:
 * frames are transforms painted by lib/motion. The wrapper clips sideways only
 * (overflow-x-clip, widened by 12 each side), so a slid row never makes
 * anything scroll and the bar riding half above the row is never cut.
 */
function CommentSwipeRow(props: {
  kind: 'root' | 'reply';
  /** False while the row is being edited. */
  enabled: boolean;
  onReply: (() => void) | null;
  onDelete: (() => void) | null;
  children: ReactNode;
}): ReactElement {
  const sliderRef = useRef<HTMLDivElement>(null);
  const replyIconRef = useRef<HTMLSpanElement>(null);
  const deleteIconRef = useRef<HTMLSpanElement>(null);
  const latest = useRef(props);
  latest.current = props;
  const swipeRef = useRef<SwipeReplyController | null>(null);
  if (swipeRef.current === null) {
    swipeRef.current = createSwipeReplyController({
      direction: 'both',
      onReply: () => latest.current.onReply?.(),
      onLeft: () => latest.current.onDelete?.(),
      canTrigger: (side) =>
        side === 'right' ? latest.current.onReply !== null : latest.current.onDelete !== null,
      onFrame: (frame) => {
        const left = frame.side === 'left';
        paintSwipe(
          sliderRef.current,
          left ? deleteIconRef.current : replyIconRef.current,
          frame,
          frame.side,
        );
        // The other way's icon stays at rest.
        paintSwipe(null, left ? replyIconRef.current : deleteIconRef.current, SWIPE_REST);
      },
      onStart: (pointerId) => {
        // A swipe never opens anything: end any hold pressed inside the row
        // (a person card's), drop the text selection the press started, and
        // keep the pointer on the row.
        if (sliderRef.current !== null) cancelPendingLongPressesWithin(sliderRef.current);
        window.getSelection()?.removeAllRanges();
        if (pointerId === undefined) return;
        try {
          sliderRef.current?.setPointerCapture(pointerId);
        } catch {
          // The pointer is already gone; the gesture ends on its own.
        }
      },
      enabled: () => latest.current.enabled,
      reducedMotion: motionOff,
    });
  }
  const swipe = swipeRef.current;
  useEffect(() => () => swipe.dispose(), [swipe]);
  return (
    <div data-comment-swipe="" className="relative -mx-3 overflow-x-clip px-3">
      {props.onReply !== null ? (
        <span
          ref={replyIconRef}
          aria-hidden="true"
          data-comment-swipe-icon="reply"
          className={cn(SWIPE_ICON_CLASS, 'left-3 text-fg-2')}
        >
          <IconReply size={ICON_SIZE.nav} />
        </span>
      ) : null}
      {props.onDelete !== null ? (
        <span
          ref={deleteIconRef}
          aria-hidden="true"
          data-comment-swipe-icon="delete"
          className={cn(SWIPE_ICON_CLASS, 'right-3 text-bad')}
        >
          <IconTrash size={ICON_SIZE.nav} />
        </span>
      ) : null}
      <div
        ref={sliderRef}
        data-comment-row={props.kind}
        onPointerDown={(e: ReactPointerEvent<HTMLDivElement>) => swipe.handlers.onPointerDown(e)}
        onPointerMove={(e: ReactPointerEvent<HTMLDivElement>) => swipe.handlers.onPointerMove(e)}
        onPointerUp={(e: ReactPointerEvent<HTMLDivElement>) => swipe.handlers.onPointerUp(e)}
        onPointerCancel={() => swipe.handlers.onPointerCancel()}
        onClickCapture={(e: ReactMouseEvent<HTMLDivElement>) => {
          // The click that trails a swipe does nothing more.
          if (!swipe.consumeClickSuppression()) return;
          e.preventDefault();
          e.stopPropagation();
        }}
        className="relative flex min-w-0 touch-pan-y touch-pinch-zoom items-start gap-2"
      >
        {props.children}
      </div>
    </div>
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
  focusRequestKey = null,
  viewerIsClient,
  guideReplyCommentId = null,
  showHeader = false,
  belowHeader,
  onCountsChange,
  sharedCheckpoints,
  postStage,
  whereLabel = '',
}: CommentsProps) {
  const newTrace = useNewTrace();
  // The one shared minute clock: every row's time ages together, no per-row timer.
  const nowMs = useMinuteClock();
  // The Open / All thread filter (posts' header); All by default.
  const [filter, setFilter] = useState<CommentFilter>('all');
  const { canAttach, presignEnabled, presignCache, uploadFile } = useCommentAttachments();
  // Members for the @-mention picker; resolved once and shared by both composers.
  const { candidates } = useMentionCandidates(workspaceId);
  // Who the picker (and a reply's @Name seed) offers: no clients on a draft post.
  const mentionMembers = useMemo(
    () => commentMentionCandidates(candidates, { entityType, postStage }),
    [candidates, entityType, postStage],
  );

  const [comments, setComments] = useState<CommentRow[]>([]);
  // Every checkpoint for this post, loaded whole in one query so none paginates
  // away; merged with the paginated `comments` below (de-duped, newest-first).
  const [checkpoints, setCheckpoints] = useState<CommentRow[]>([]);
  // A linked comment read by id (and its root when it is a reply) because it is
  // not on page zero; merged like the checkpoints. Dropped on an entity change.
  const [focusRows, setFocusRows] = useState<CommentRow[]>([]);
  // The linked id the by-id read found deleted or not visible.
  const [focusAbsentId, setFocusAbsentId] = useState<string | null>(null);
  // A linked comment whose read failed twice (not a deleted one): its own toast.
  const [focusFailedId, setFocusFailedId] = useState<string | null>(null);
  const entityKey = `${workspaceId}:${entityType}:${entityId}`;
  const [focusRowsFor, setFocusRowsFor] = useState(entityKey);
  if (focusRowsFor !== entityKey) {
    setFocusRowsFor(entityKey);
    setFocusRows([]);
    setFocusAbsentId(null);
  }
  // A host-owned read: each new set of rows replaces the local copy (the
  // optimistic patches below edit that copy), adopted during render so the
  // list never paints a frame behind the read.
  const sharedRows = sharedCheckpoints?.rows ?? null;
  const [adoptedRows, setAdoptedRows] = useState<readonly CommentRow[] | null>(null);
  if (sharedRows !== adoptedRows) {
    setAdoptedRows(sharedRows);
    if (sharedRows !== null) setCheckpoints([...sharedRows]);
  }
  const sharedMode = sharedCheckpoints !== undefined;
  const reloadShared = useRef<(() => Promise<void>) | null>(null);
  reloadShared.current = sharedCheckpoints?.reload ?? null;
  const [listLoading, setLoading] = useState(true);
  // With a host-owned read, the list waits for its first rows too, so the
  // checkpoints never pop in after the list (the same paint as a self read).
  const loading = listLoading || (sharedMode && sharedRows === null);
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
  // The root composer's unsaved work: typed text (kept in rootDrafts) or any
  // attachment chip. Booleans only, so a keystroke re-renders the list only
  // when the draft turns empty or non-empty. A new entity re-reads its draft.
  const [rootHasText, setRootHasText] = useState(() => draftHasText(rootDrafts.get(entityKey)));
  const [rootHasChips, setRootHasChips] = useState(false);
  const [rootDraftFor, setRootDraftFor] = useState(entityKey);
  if (rootDraftFor !== entityKey) {
    setRootDraftFor(entityKey);
    setRootHasText(draftHasText(rootDrafts.get(entityKey)));
    setRootHasChips(false);
  }
  // A discarded root draft remounts the composer blank (text and chips).
  const [rootEpoch, setRootEpoch] = useState(0);
  // Back while the root composer holds a draft: "Discard comment?" first.
  const [rootDiscardAsk, setRootDiscardAsk] = useState(false);
  const rootGuard = useBackGuard({
    active: rootHasText || rootHasChips,
    onBack: () => setRootDiscardAsk(true),
  });
  const undoable = useUndoableAction();

  const [profiles, setProfiles] = useState<Map<string, CommentProfile>>(new Map());
  // Every comment file's name, mime, size (and pages, pixel size) from one
  // batched asset_versions read; an id not answered yet renders as a file card.
  const [attachmentFiles, setAttachmentFiles] = useState<Map<string, CommentFile>>(new Map());
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);

  const [replyOpen, setReplyOpen] = useState<Set<string>>(new Set());
  // Thread roots whose older replies are shown ("View {n} earlier replies"
  // tapped, or a link landed on one of them). Folded by default: latest only.
  const [unfoldedReplies, setUnfoldedReplies] = useState<Set<string>>(new Set());
  // Resolved checkpoints opened from their folded line (the ⌄).
  const [openPoints, setOpenPoints] = useState<Set<string>>(new Set());
  // What the last unfold revealed, so its rows rise into place (itemIn,
  // translateY only) once they are in the DOM; null when nothing is pending.
  const revealSelector = useRef<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editBody, setEditBody] = useState('');
  // The edit field, for its ui/WritingBox rows (Aa, emoji).
  const editFieldRef = useRef<HTMLTextAreaElement | null>(null);
  const scrollEditorRef = useRef(false);
  // The edit box shows "@username"; these picks turn each back into its token on save.
  const [editPicks, setEditPicks] = useState<MentionPick[]>([]);
  // An edit Save in flight: the button shows busy, and a second tap (or Enter
  // repeat) never sends twice (the ref answers inside the same tick).
  const [editSaving, setEditSaving] = useState(false);
  const editSavingRef = useRef(false);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);
  // The comment whose To-do sheet is up ("New task"); kept after close so the
  // sheet's exit plays, and its title seeded once per open.
  const [taskFor, setTaskFor] = useState<{ commentId: string; title: string } | null>(null);
  const [taskOpen, setTaskOpen] = useState(false);
  // The thread root whose reopen request is in flight; null when idle. A one-tap
  // Resolve is optimistic and never waits.
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  // The bottom "Resolved" + Undo strip after a one-tap Resolve.
  const toast = useOptionalToast();
  // Per checkpoint root: the reply whose author a Reply-on-a-reply aims at. The
  // composer then seeds with that person's @Name (the server keeps one reply
  // level, so the reply still posts to the root). Absent: the root's author.
  const [replyTargets, setReplyTargets] = useState<Map<string, ReplyTarget>>(new Map());
  // Per root: bumped on a retarget so the uncontrolled composer remounts with
  // the new seed (its draft rides through replyDrafts).
  const [composerEpochs, setComposerEpochs] = useState<Map<string, number>>(new Map());
  // The open image lightbox: the clicked comment's image list + current index,
  // or null when closed. Images reuse the same PresignCache (a cache hit).
  const [lightbox, setLightbox] = useState<{
    images: MessageAttachment[];
    index: number;
    title: string;
  } | null>(null);

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

  // True once a page-zero load of THIS entity has landed. Only the first load
  // shows the skeleton; every later page-zero read (after a send / edit /
  // delete / resolve, a refreshSignal bump) is a silent background refetch that
  // swaps the rows in place. Reset when the entity changes (the mount effect).
  const hasLoaded = useRef(false);

  // Fetch a single page. page 0 replaces the list (mount + post-submit refetch);
  // later pages append. A full page (exactly PAGE_SIZE) implies there may be more.
  const loadPage = useCallback(
    async (nextPage: number): Promise<void> => {
      const seq = nextPage === 0 ? ++page0Seq.current : null;
      const stale = (): boolean => !mounted.current || (seq !== null && seq !== page0Seq.current);
      const silent = nextPage === 0 && hasLoaded.current;
      if (nextPage === 0) {
        if (!silent) {
          setLoading(true);
          setLoadError(false);
        }
      } else {
        setLoadingMore(true);
        setMoreError(false);
      }
      // Page zero on a post reads every checkpoint too (so none is paginated out
      // of reach), IN PARALLEL with the list: one round trip, not two. Posts only
      // (checkpoints never exist on a brief); a host-owned read
      // (sharedCheckpoints) is never repeated here.
      const withCheckpoints = nextPage === 0 && entityType === 'post' && !sharedMode;
      const [result, checkpointRows] = await Promise.all([
        listComments(supabase, {
          workspace_id: workspaceId,
          entity_type: entityType,
          entity_id: entityId,
          page: nextPage,
        }),
        withCheckpoints ? fetchCheckpoints(supabase, workspaceId, entityId) : Promise.resolve(null),
      ]);
      mark('comments:rows-in');
      if (stale()) return;
      if (!result.ok) {
        if (nextPage === 0) {
          // A failed silent refetch keeps the rows already on screen (they were
          // written in place from the landed write); only a first load shows
          // LoadError.
          if (silent) return;
          setLoading(false);
          setLoadError(true);
        } else {
          setLoadingMore(false);
          setMoreError(true);
        }
        return;
      }
      if (checkpointRows !== null) setCheckpoints(checkpointRows);
      if (nextPage === 0) hasLoaded.current = true;
      setComments((prev) => (nextPage === 0 ? result.data : [...prev, ...result.data]));
      setPage(nextPage);
      setHasMore(result.data.length === PAGE_SIZE);
      if (nextPage === 0) setLoading(false);
      else setLoadingMore(false);
    },
    [workspaceId, entityType, entityId, sharedMode],
  );

  // Page zero after a write (or Retry): the list, and the checkpoints with it.
  // A self read does both inside loadPage; a host-owned read is asked to
  // re-run alongside, concurrently, so the two still land together.
  const reloadAll = useCallback(async (): Promise<void> => {
    const reload = reloadShared.current;
    await Promise.all([loadPage(0), reload !== null ? reload() : Promise.resolve()]);
  }, [loadPage]);

  // After a landed write the row is already right on screen (patched in place
  // below); this page-zero read only reconciles with the server, silently (no
  // skeleton: hasLoaded is set) and never awaited by the write's caller.
  const refreshInBackground = useCallback((): void => {
    void reloadAll().catch((error: unknown) => {
      logger.warn('comments: background refresh failed', {
        error: error instanceof Error ? error.message : 'thrown',
      });
    });
  }, [reloadAll]);

  // Apply one change to a row wherever it lives (the paged list and the
  // always-loaded checkpoints), so a write paints at once.
  const patchRow = useCallback(
    (commentId: string, change: (row: CommentRow) => CommentRow): void => {
      const patch = (rows: CommentRow[]): CommentRow[] =>
        rows.some((row) => row.id === commentId)
          ? rows.map((row) => (row.id === commentId ? change(row) : row))
          : rows;
      setComments(patch);
      setCheckpoints(patch);
      setFocusRows(patch);
    },
    [],
  );

  // The rendered list: the always-loaded checkpoints merged into the paginated
  // comments, de-duped by id and newest-first. Only non-checkpoint comments
  // paginate; a checkpoint beyond page zero is still here.
  const merged = useMemo(
    () => mergeCheckpoints(comments, mergeCheckpoints(checkpoints, focusRows)),
    [comments, checkpoints, focusRows],
  );
  const mergedRef = useRef(merged);
  mergedRef.current = merged;

  useEffect(() => {
    // A new entity (or first mount) is a first load again: skeleton, never the
    // previous entity's rows.
    hasLoaded.current = false;
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

  // A linked comment not already listed is read by id as soon as the link
  // arrives (on a first mount, alongside page zero), with its thread root when
  // it is a reply, so a link lands on a comment of any age. Deleted or not
  // visible: the link reports it missing.
  const focusId = focusCommentId ?? null;
  useEffect(() => {
    if (focusId === null || focusId === '') return;
    if (mergedRef.current.some((row) => row.id === focusId)) return;
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
      // One quiet retry when the read itself failed (not a missing comment).
      if (active && !target.ok) {
        await new Promise((resolve) => setTimeout(resolve, FOCUS_READ_RETRY_MS));
        if (active) target = await read([focusId]);
      }
      if (!active) return;
      if (!target.ok) {
        setFocusFailedId(focusId);
        return;
      }
      const row = target.data[0];
      if (row === undefined || row.deleted_at !== null) {
        setFocusAbsentId(focusId);
        return;
      }
      const rows = [row];
      if (row.parent_comment_id !== null) {
        const root = await read([row.parent_comment_id]);
        if (!active) return;
        if (root.ok) rows.push(...root.data);
      }
      setFocusRows((prev) => upsertRows(prev, rows));
    })();
    return () => {
      active = false;
    };
  }, [focusId, workspaceId, entityType, entityId]);

  // Land on the linked comment once its row renders (src/lib/focus-target.ts).
  const rootRef = useRef<HTMLDivElement>(null);
  useFocusTarget({
    targetId: focusId,
    targetKey: focusRequestKey,
    findElement: (id) =>
      rootRef.current?.querySelector<HTMLElement>(`[id="${commentDomId(id)}"]`) ?? null,
    absent: focusId !== null && (focusAbsentId === focusId || focusFailedId === focusId),
    onMissing: (id) =>
      toast?.show({
        title: focusFailedId === id ? FOCUS_FAILED_COPY : FOCUS_MISSING_COPY,
        tone: 'error',
      }),
  });
  // A search jump's words: coloured in every comment body until the screen unmounts.
  const searchWords = useContext(SearchWordsContext);

  // Every author and @mention id the loaded rows name.
  const peopleIds = useMemo(() => {
    const ids = new Set<string>();
    for (const comment of merged) {
      for (const id of [comment.author_user_id, ...parseMentions(comment.body)]) ids.add(id);
    }
    return ids;
  }, [merged]);

  // The shared name registry's answer for one id; undefined while it is unknown.
  const registryProfile = useCallback(
    (id: string): CommentProfile | undefined => {
      const name = personName(workspaceId, id);
      if (name === undefined) return undefined;
      return {
        displayName: name,
        avatarUrl: personAvatar(workspaceId, id),
        username: name === FORMER_MEMBER ? null : (knownMentionName(workspaceId, id) ?? null),
      };
    },
    [workspaceId],
  );

  // What every row paints from, held data only, ready in the same render as
  // the rows: current members (the mention candidates) first, then the local
  // map, backfilled from the registry for any id it already knows (a read that
  // landed after its effect was cleaned up still counts). No network here.
  const known = useMemo(() => {
    const filled = backfillProfiles(peopleIds, profiles, registryProfile);
    const local = filled.size > 0 ? new Map([...profiles, ...filled]) : profiles;
    return authorProfiles(candidates, local);
  }, [peopleIds, profiles, candidates, registryProfile]);

  // Resolve the ids no current member covers (former members, mentions of
  // people gone) in one batched read through the shared name registry
  // (users + workspace_members, one .in() each): anyone without a current
  // membership reads "Former member". An id stays attempted only while its read
  // is in flight or its result was kept: a result dropped by cleanup un-marks
  // its ids and re-runs (the registry then answers with no network); a failed
  // read clears them and retries once after READ_TIMEOUT_MS.
  const attemptedProfiles = useRef<Set<string>>(new Set());
  const [namesPass, setNamesPass] = useState(0);
  const namesRetryUsed = useRef(false);
  const namesRetryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (namesRetryTimer.current !== null) clearTimeout(namesRetryTimer.current);
    },
    [],
  );
  useEffect(() => {
    const members = new Set(candidates.filter((c) => c.name !== '').map((c) => c.id));
    const needed: string[] = [];
    for (const id of peopleIds) {
      if (members.has(id) || attemptedProfiles.current.has(id)) continue;
      attemptedProfiles.current.add(id);
      needed.push(id);
    }
    if (needed.length === 0) return;
    let active = true;
    void resolvePeople(supabase, workspaceId, needed).then((ok) => {
      if (!ok || !active) for (const id of needed) attemptedProfiles.current.delete(id);
      if (!mounted.current) return;
      if (!ok && !namesRetryUsed.current) {
        namesRetryUsed.current = true;
        namesRetryTimer.current = setTimeout(() => {
          namesRetryTimer.current = null;
          if (mounted.current) setNamesPass((n) => n + 1);
        }, READ_TIMEOUT_MS);
      }
      if (!active) {
        if (ok) setNamesPass((n) => n + 1);
        return;
      }
      const fetched = backfillProfiles(needed, new Map(), registryProfile);
      if (fetched.size > 0) setProfiles((prev) => new Map([...prev, ...fetched]));
    });
    return () => {
      active = false;
    };
  }, [peopleIds, candidates, workspaceId, registryProfile, namesPass]);

  // Every comment file in one batched read (name, mime, size, pages): no N+1.
  // An id is asked once; a failed read un-asks its ids so the next pass asks
  // again. No active flag: an answer is never dropped (the ids stay valid).
  const askedFiles = useRef<Set<string>>(new Set());
  useEffect(() => {
    const needed = idsToRead(
      merged.flatMap((comment) => comment.attachment_asset_ids ?? []),
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
      setAttachmentFiles((prev) => new Map([...prev, ...fetched]));
    });
  }, [merged]);

  const nameOf = useCallback((id: string): string | null => resolveName(known, id), [known]);
  // Mentions inside a body read as @username; author lines keep the full name.
  const handleOf = useCallback(
    (id: string): string | null => resolveMentionHandle(known, id),
    [known],
  );
  // Author avatar URL from the SAME held data as the name; no new query.
  // Unknown -> null, so the card keeps its initials fallback.
  const avatarOf = useCallback(
    (id: string): string | null => known.get(id)?.avatarUrl ?? null,
    [known],
  );

  // comments:names-ready: the first frame where every loaded author has a name.
  const namesReadyMarked = useRef(false);
  useEffect(() => {
    if (namesReadyMarked.current || loading || merged.length === 0) return;
    const allNamed = merged.every(
      (c) => c.legacy_author_name !== null || resolveName(known, c.author_user_id) !== null,
    );
    if (!allNamed) return;
    namesReadyMarked.current = true;
    mark('comments:names-ready');
  }, [loading, merged, known]);

  async function handleCreate(
    body: string,
    options: {
      attachmentVersionIds: string[];
      parentCommentId: string | null;
    },
  ): Promise<{ ok: true } | { ok: false; error: string } | { ok: false; notified: true }> {
    const input = buildCreateInput({
      workspaceId,
      entityType,
      entityId,
      body,
      attachmentVersionIds: options.attachmentVersionIds,
      parentCommentId: options.parentCommentId,
      traceId: newTrace(),
    });
    const result = await createComment(supabase, input);
    mark('comment:rpc:end');
    if (
      !result.ok &&
      entityType === 'post' &&
      postStage === 'draft' &&
      isInvalidMention(result.error)
    ) {
      // A rejected mention on a draft (a client tagged): the composer keeps the
      // text and files, the toast says why (inline only when no toast host).
      // Any other invalid_mention (a non-member) keeps the generic inline copy.
      if (toast === null) return { ok: false, error: DRAFT_MENTION_TOAST };
      toast.show({ title: DRAFT_MENTION_TOAST, tone: 'error' });
      return { ok: false, notified: true };
    }
    if (!result.ok) {
      const action = options.parentCommentId !== null ? 'post the reply' : 'post the comment';
      return { ok: false, error: friendlyCommentError(result.error, action) };
    }
    // The landed comment shows at once, built from what was sent and the id
    // the proc returned; the page-zero read reconciles silently behind it.
    // Without the session's user id yet (a send in the first instant) there
    // is no honest author to show, so that rare case waits for the read.
    if (currentUserId !== null) {
      const landed = localCommentRow({
        id: result.data,
        workspaceId,
        entityType,
        entityId,
        authorUserId: currentUserId,
        body: input.body,
        attachmentVersionIds: input.attachment_asset_ids ?? [],
        parentCommentId: options.parentCommentId,
        ledgerSeq: null,
        nowIso: new Date().toISOString(),
      });
      setComments((prev) => upsertRows(prev, [landed]));
      mark('comment:painted');
    }
    const parentId = options.parentCommentId;
    if (parentId !== null) replyDrafts.delete(draftKey(parentId));
    else {
      // The root comment landed: its kept draft goes (the composer clears its chips).
      rootDrafts.delete(entityKey);
      setRootHasText(false);
    }
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
      clearReplyTarget(parentId);
    }
    if (currentUserId !== null) refreshInBackground();
    else await reloadAll();
    return { ok: true };
  }

  // Write one checkpoint batch through comment_batch_create, sourcing the trace
  // the same way handleCreate does (one newTrace() per action). On success the
  // returned {id, seq} rows land in the thread at once, built from the sent
  // points (the proc returns them in point order), and page zero reconciles
  // silently behind them.
  async function handleCreateBatch(
    points: CheckpointPoint[],
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const result = await runCreateCommentBatch(supabase, {
      workspaceId,
      postId: entityId,
      points,
      traceId: newTrace(),
    });
    if (!result.ok) {
      return { ok: false, error: friendlyCommentError(result.error, 'add the checkpoints') };
    }
    // Only when every point came back (and the author is known) is the local
    // copy exact; otherwise the read alone paints them, still without a skeleton.
    if (currentUserId !== null && result.data.length === points.length) {
      const nowIso = new Date().toISOString();
      const authorUserId = currentUserId;
      const landed = result.data.map((created, index) =>
        localCommentRow({
          id: created.id,
          workspaceId,
          entityType,
          entityId,
          authorUserId,
          body: points[index]?.body ?? '',
          attachmentVersionIds: points[index]?.attachment_version_ids ?? [],
          parentCommentId: null,
          ledgerSeq: created.seq,
          nowIso,
        }),
      );
      setCheckpoints((prev) => upsertRows(prev, landed));
      refreshInBackground();
    } else {
      await reloadAll();
    }
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
      setRowError({
        id: commentId,
        message: `Checkpoints are limited to ${POINT_WORD_CAP} words.`,
      });
      return;
    }
    const nextBody = serializeMentions(editBody, editPicks);
    if (editSavingRef.current) return;
    editSavingRef.current = true;
    setEditSaving(true);
    const result = await runEditComment(supabase, commentId, nextBody, newTrace()).finally(() => {
      editSavingRef.current = false;
      setEditSaving(false);
    });
    if (!result.ok) {
      setRowError({
        id: commentId,
        message: isPoint
          ? friendlyPointFreezeError(result.error, target, 'edit')
          : friendlyCommentError(result.error, 'edit the comment'),
      });
      return;
    }
    // The edit landed: the row shows the saved body at once (comment_edit
    // returns only the id, so the body is what was sent), then page zero
    // reconciles silently.
    const editedAt = new Date().toISOString();
    patchRow(commentId, (row) => ({ ...row, body: nextBody, edited_at: editedAt }));
    setEditingId(null);
    setEditBody('');
    refreshInBackground();
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
      label: isPoint ? 'Checkpoint deleted' : 'Comment deleted',
      commit: async () => {
        const result = await runDeleteComment(supabase, commentId, newTrace());
        if (!result.ok) {
          unhide();
          setRowError({
            id: commentId,
            message: isPoint
              ? friendlyPointFreezeError(result.error, target, 'delete')
              : friendlyCommentError(result.error, 'delete the comment'),
          });
          return;
        }
        // Landed: the row becomes what the server now holds (deleted_at set: a
        // tombstone while it has live replies, gone otherwise) before it is
        // unhidden, so it never flashes back as live; page zero reconciles
        // silently.
        const deletedAt = new Date().toISOString();
        patchRow(commentId, (row) => ({ ...row, deleted_at: deletedAt }));
        unhide();
        refreshInBackground();
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
      setRowError({
        id: comment.id,
        message: friendlyCommentError(
          result.error,
          resolved ? 'resolve the thread' : 'reopen the thread',
        ),
      });
      return;
    }
    // Landed (comment_resolve returns nothing): the thread's state flips in
    // place from the known input, mirroring the columns the proc writes (a
    // reopen also clears the confirm and the approval lock), then page zero
    // reconciles silently (resolved_version_id and the like come with it).
    const nowIso = new Date().toISOString();
    patchRow(comment.id, (row) =>
      resolved
        ? {
            ...row,
            resolved_at: nowIso,
            resolved_by: currentUserId,
            asked_at: null,
            asked_by: null,
            sent_back_at: null,
            sent_back_by: null,
            closed_at: null,
            closed_by: null,
          }
        : {
            ...row,
            resolved_at: null,
            resolved_by: null,
            resolution_note: null,
            resolved_version_id: null,
            accepted_at: null,
            accepted_by: null,
            closed_at: null,
            closed_by: null,
          },
    );
    refreshInBackground();
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
  // for UNDO_MS. Undo flips the row back and sends resolved=false (after
  // the first write settles, so the two never race). A failure on either leg
  // reverts and shows the one inline line, once.
  function handleOneTapResolve(comment: CommentRow): void {
    const prior = comment.resolved_at;
    const optimistic = new Date().toISOString();
    setRowError(null);
    const sent = sendResolve(comment, true).catch(() => false);
    let undone = false;
    // itemOut (docs/motion.md): under the Open filter the resolved thread
    // leaves the list, so it closes upward first and its siblings glide up
    // (GlideItem). The write above is already on its way; the row's flip lands
    // when the move ends (at once when motion is off or a tap finishes it).
    const leavingRow =
      filter === 'open'
        ? (rootRef.current?.querySelector<HTMLElement>(`[id="${commentDomId(comment.id)}"]`) ??
          null)
        : null;
    const out = itemOut(leavingRow);
    if (out.instant) patchResolvedAt(comment.id, optimistic);
    else
      void out.done.then(() => {
        if (!mounted.current || undone) return;
        patchResolvedAt(comment.id, optimistic);
      });
    const stripId =
      toast?.show({
        title: 'Resolved',
        action: {
          label: 'Undo',
          onPress: () => {
            undone = true;
            // A row still closing (never flipped) comes back whole.
            for (const move of leavingRow?.getAnimations() ?? []) move.cancel();
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
        durationMs: UNDO_MS,
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

  // Flip one checkpoint's accepted_at in place (paged list + always-loaded
  // checkpoints) so a Confirm, its Undo, or a revert paints at once.
  function patchAcceptedAt(commentId: string, acceptedAt: string | null): void {
    const patch = (rows: CommentRow[]): CommentRow[] =>
      rows.some((row) => row.id === commentId)
        ? rows.map((row) => (row.id === commentId ? { ...row, accepted_at: acceptedAt } : row))
        : rows;
    setComments(patch);
    setCheckpoints(patch);
  }

  // The existing checkpoint_accept RPC (accepted=true confirms, accepted=false
  // withdraws), always with an explicit trace. True when the write landed.
  async function sendAccept(comment: CommentRow, accepted: boolean): Promise<boolean> {
    const result = await checkpointAccept(supabase, {
      p_comment_id: comment.id,
      p_accepted: accepted,
      p_trace_id: newTrace(),
    });
    return result.ok;
  }

  // The approver's one-tap Confirm on a resolved checkpoint. Same shape as the
  // creator's one-tap Resolve: the tick fills at once (optimistic) while the RPC
  // runs, and the bottom strip shows "Confirmed" + "Undo" for UNDO_MS.
  // Undo empties the tick and sends accepted=false once the first write settles.
  // A failure on either leg reverts and shows the one inline line, once.
  function handleConfirm(comment: CommentRow): void {
    const prior = comment.accepted_at;
    const optimistic = new Date().toISOString();
    setRowError(null);
    patchAcceptedAt(comment.id, optimistic);
    const sent = sendAccept(comment, true).catch(() => false);
    let undone = false;
    const stripId =
      toast?.show({
        title: 'Confirmed',
        action: {
          label: 'Undo',
          onPress: () => {
            undone = true;
            patchAcceptedAt(comment.id, prior);
            void sent.then(async (landed) => {
              if (!landed) return;
              const withdrawn = await sendAccept(comment, false).catch(() => false);
              if (!mounted.current) return;
              if (!withdrawn) {
                patchAcceptedAt(comment.id, optimistic);
                setRowError({ id: comment.id, message: CONFIRM_FAILED_COPY });
              }
            });
          },
        },
        durationMs: UNDO_MS,
        kind: 'undo',
      }) ?? null;
    void sent.then((landed) => {
      if (!mounted.current || undone || landed) return;
      if (stripId !== null) toast?.dismiss(stripId);
      patchAcceptedAt(comment.id, prior);
      setRowError({ id: comment.id, message: CONFIRM_FAILED_COPY });
    });
  }

  // The To-do landed: the comment paints its tag at once from what was sent
  // (task_state and the link), then page zero reconciles silently.
  function handleTaskCreated(commentId: string, link: CommentTaskEmbed): void {
    patchRow(commentId, (row) => ({ ...row, task_state: 'assigned', comment_tasks: link }));
    refreshInBackground();
  }

  function openTaskSheet(comment: CommentRow): void {
    setTaskFor({
      commentId: comment.id,
      title: taskTitleFrom(commentCopyText(comment.body, handleOf)),
    });
    setTaskOpen(true);
  }

  function draftKey(commentId: string): string {
    return `${entityType}:${entityId}:${commentId}`;
  }

  function replySeedFor(comment: CommentRow): string {
    return checkpointReplySeed(
      comment,
      replyTargets.get(comment.id) ?? null,
      currentUserId,
      mentionMembers,
    );
  }

  function clearReplyTarget(rootId: string): void {
    setReplyTargets((prev) => {
      if (!prev.has(rootId)) return prev;
      const next = new Map(prev);
      next.delete(rootId);
      return next;
    });
  }

  // Reply on a reply (checkpoint or plain thread): the server keeps one reply level, so
  // the composer is the root's (it posts with p_parent_comment_id = root id) and
  // it opens with the @Name of the person replied to. Typed text survives a
  // retarget; only the leading mention changes.
  function onReplyToReply(root: CommentRow, reply: CommentRow): void {
    const rootId = replyParentId(reply);
    const key = draftKey(rootId);
    const target: ReplyTarget = {
      author_user_id: reply.author_user_id,
      legacy_author_name: reply.legacy_author_name,
    };
    const nextSeed = checkpointReplySeed(root, target, currentUserId, mentionMembers);
    const draft = replyOpen.has(rootId) ? replyDrafts.get(key) : undefined;
    replyDrafts.set(key, retargetDraft(draft, replySeedFor(root), nextSeed));
    setReplyTargets((prev) => new Map(prev).set(rootId, target));
    setComposerEpochs((prev) => new Map(prev).set(rootId, (prev.get(rootId) ?? 0) + 1));
    setReplyOpen((prev) => (prev.has(rootId) ? prev : new Set(prev).add(rootId)));
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

  // The writing boxes' expanded title: the post or brief title the page holds,
  // else this section's own heading.
  const expandTitle =
    whereLabel !== '' ? whereLabel : entityType === 'post' ? CHECKPOINTS_TITLE : 'Comments';

  function renderReplyComposer(comment: CommentRow): ReactNode {
    const key = draftKey(comment.id);
    return (
      <div data-reply-composer="" className="mt-2">
        <CommentComposer
          key={`reply-${comment.id}-${composerEpochs.get(comment.id) ?? 0}`}
          onSubmit={(body, options) =>
            handleCreate(body, { ...options, parentCommentId: comment.id })
          }
          members={mentionMembers}
          canAttach={canAttach}
          uploadFile={uploadFile}
          placeholder="Write a reply"
          submitLabel="Reply"
          {...(comment.id === guideReplyCommentId
            ? { submitAnchor: INDUCTION_KEYS.postReplyPost }
            : {})}
          autoFocus
          expandTitle={expandTitle}
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
    // Opening or closing from the root's own Reply aims at the root's author
    // again; a Reply on a reply sets its target after this.
    clearReplyTarget(id);
  }

  function startEdit(comment: CommentRow): void {
    // Phone: the editor and its Save / Cancel scroll clear of the post
    // screen's bottom bar on the commit that shows them (laptop unchanged).
    scrollEditorRef.current = !isLaptopNow();
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

  // A link (Activity, toast, email, search) to a folded row unfolds it: a
  // reply behind "View {n} earlier replies" opens its thread's replies, and a
  // resolved checkpoint (or a reply under one) opens the point. Adopted in
  // render once the row is held, so the row is in the DOM on the same commit
  // that useFocusTarget looks for it. Once per distinct link.
  const focusKey =
    focusId === null || focusId === '' ? null : `${focusId} ${focusRequestKey ?? ''}`;
  const [unfoldedFor, setUnfoldedFor] = useState<string | null>(null);
  if (focusKey !== null && focusKey !== unfoldedFor) {
    const target = displayed.find((row) => row.id === focusId);
    if (target !== undefined) {
      setUnfoldedFor(focusKey);
      const rootId = replyParentId(target);
      if (target.parent_comment_id !== null && !unfoldedReplies.has(rootId)) {
        setUnfoldedReplies((prev) => new Set(prev).add(rootId));
      }
      const root = displayed.find((row) => row.id === rootId);
      if (
        root !== undefined &&
        root.ledger_seq !== null &&
        root.resolved_at !== null &&
        !openPoints.has(rootId)
      ) {
        setOpenPoints((prev) => new Set(prev).add(rootId));
      }
    }
  }

  // An unfold's revealed rows rise 8 px into place (itemIn: translateY only,
  // instant under Reduce Motion). A fold closes at once.
  //
  // The same pass brings a just-opened phone editor into view: nearest, so a
  // shown editor never moves; its scroll-margin-bottom is the host's bottom
  // bar height (--focus-inset-bottom, COMMENT_ROW_SCROLL_CLASS).
  useLayoutEffect(() => {
    if (scrollEditorRef.current) {
      scrollEditorRef.current = false;
      rootRef.current
        ?.querySelector<HTMLElement>('[data-comment-editor]')
        ?.scrollIntoView({ block: 'nearest' });
    }
    const selector = revealSelector.current;
    if (selector === null) return;
    revealSelector.current = null;
    itemIn(rootRef.current?.querySelector<HTMLElement>(selector) ?? null);
  });

  function unfoldReplies(rootId: string): void {
    revealSelector.current = `[data-replies-earlier="${rootId}"]`;
    setUnfoldedReplies((prev) => new Set(prev).add(rootId));
  }

  function togglePoint(commentId: string): void {
    const opening = !openPoints.has(commentId);
    revealSelector.current = opening
      ? `[id="${commentDomId(commentId)}"] [data-comment-row="root"]`
      : null;
    setOpenPoints((prev) => {
      const next = new Set(prev);
      if (opening) next.add(commentId);
      else next.delete(commentId);
      return next;
    });
  }
  // The header's Open / All filter applies to top-level threads; replies follow
  // their thread. The open count is over every thread, whatever the filter.
  const openCount = openThreadCount(threads);
  const resolvedCount = resolvedThreadCount(threads);
  const groups = groupThreads(filterThreads(threads, filter));
  const isClient = viewerIsClient === true;
  // The next checkpoint number the client's slots continue from: the highest
  // ledger_seq already held (deleted points keep their number), 0 when none.
  const maxLedgerSeq = displayed.reduce(
    (max, row) =>
      row.parent_comment_id === null && row.ledger_seq !== null && row.ledger_seq > max
        ? row.ledger_seq
        : max,
    0,
  );
  // Briefs have no host card around the list: it draws the one card itself.
  const ownCard = entityType !== 'post';

  // itemIn (docs/motion.md): a comment or reply that arrives after the list
  // first painted (posted here, or live) rises 8 px into place, laid over its
  // final state. The first paint, a kept list and the Open/All filter never
  // move: ids are tracked over every thread, whatever the filter.
  const seenIds = useRef<Set<string> | null>(null);
  const shownIds = threads
    .flatMap((thread) => [thread.comment.id, ...thread.replies.map((reply) => reply.id)])
    .join(' ');
  useLayoutEffect(() => {
    if (loading || loadError) return;
    const ids = shownIds === '' ? [] : shownIds.split(' ');
    if (seenIds.current === null) {
      seenIds.current = new Set(ids);
      return;
    }
    for (const id of ids) {
      if (seenIds.current.has(id)) continue;
      seenIds.current.add(id);
      itemIn(rootRef.current?.querySelector<HTMLElement>(`[id="${commentDomId(id)}"]`) ?? null);
    }
  }, [shownIds, loading, loadError]);

  // The same live rows feed the checkpoint strip (rendered in belowHeader), so a
  // Resolve, Reopen, Confirm or Undo repaints its chip in this very render.
  const liveCheckpoints = useMemo(() => liveCheckpointMap(displayed), [displayed]);

  // Lift the live counts to the page once loaded and on every change (an
  // optimistic one-tap Resolve included), so its chip and gate never lag.
  useEffect(() => {
    if (loading || loadError) return;
    onCountsChange?.({ open: openCount, resolved: resolvedCount });
  }, [loading, loadError, openCount, resolvedCount, onCountsChange]);

  // The viewer's own workspace role from the members the page already holds
  // (no read): agency side (owner, admin, agency) gets To-do and the task's
  // name on its tag. False until the members land, so To-do never flashes in.
  const viewerIsAgency = isAgencyRole(
    currentUserId === null
      ? null
      : candidates.find((candidate) => candidate.id === currentUserId)?.role,
  );

  function renderEditor(commentId: string): ReactNode {
    return (
      <div
        data-comment-editor=""
        className={cn('mt-2 flex flex-col gap-2', COMMENT_ROW_SCROLL_CLASS)}
      >
        {/* ui/WritingBox (comment mode) with no send: Save and Cancel stay
            under it; focused, the row shows Aa and emoji. */}
        <WritingBox
          mode="comment"
          field={() => editFieldRef.current}
          hasText={editBody.trim() !== ''}
          expandTitle={expandTitle}
          input={
            <Textarea
              formatting
              ref={editFieldRef}
              value={editBody}
              onChange={(event) => setEditBody(event.target.value)}
              aria-label="Edit comment body"
            />
          }
        />
        <div className="flex items-center gap-2">
          <Button
            variant="primary"
            className="min-w-11"
            disabled={editBody.trim() === ''}
            busy={editSaving}
            onClick={() => void handleSaveEdit(commentId)}
          >
            Save
          </Button>
          <Button
            variant="ghost"
            className="min-w-11"
            disabled={editSaving}
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

  // A tap on the author's photo or name opens the person card with this
  // comment as its source (its context line and what its send carries), only
  // on someone else's comment whose author is a known current member
  // (canReplyPrivately). The row itself carries no Reply privately control.
  // Built at tap time from what the row shows; no read.
  function privateReplySource(
    comment: CommentRow,
    authorName: string,
  ): (() => PrivateReplyDraft) | null {
    const authorUserId = comment.author_user_id;
    const show = canReplyPrivately({
      authorUserId,
      me: currentUserId,
      authorName,
      legacy: comment.legacy_author_name !== null,
      former: authorName === FORMER_MEMBER || isFormerMember(workspaceId, authorUserId),
    });
    if (!show) return null;
    return () =>
      commentPrivateReplyDraft({
        commentId: comment.id,
        authorUserId,
        authorName,
        excerpt: commentCopyText(comment.body, handleOf),
        whereLabel,
        entityType,
        entityId,
      });
  }

  /**
   * Who wrote a row, as every row shows it: the name ('' only until the
   * batched read answers; a gone person reads "Former member"), the photo, and
   * a wrapper that makes a node open the person card (a legacy author has no
   * user id: nothing to open). No role label anywhere.
   */
  function authorView(comment: CommentRow): {
    name: string;
    avatarUrl: string | null;
    asPerson: (node: ReactNode, display: 'inline' | 'block', className?: string) => ReactNode;
  } {
    const name = comment.legacy_author_name ?? nameOf(comment.author_user_id) ?? '';
    const avatarUrl = comment.legacy_author_name !== null ? null : avatarOf(comment.author_user_id);
    const authorId = comment.legacy_author_name === null ? comment.author_user_id : null;
    const source = authorId !== null ? privateReplySource(comment, name) : null;
    const asPerson = (node: ReactNode, display: 'inline' | 'block', className?: string) =>
      authorId !== null && name !== '' ? (
        <PersonTrigger
          userId={authorId}
          name={name}
          avatarUrl={avatarUrl ?? null}
          {...(name === FORMER_MEMBER ? { former: true } : {})}
          {...(source !== null ? { source } : {})}
          display={display}
          {...(className !== undefined ? { className } : {})}
        >
          {node}
        </PersonTrigger>
      ) : (
        node
      );
    return { name, avatarUrl, asPerson };
  }

  // An author's avatar at a role ('header' on roots and groups, 'inline' on replies).
  function authorAvatar(view: ReturnType<typeof authorView>, role: 'header' | 'inline'): ReactNode {
    return view.asPerson(
      <Avatar
        name={view.name}
        role={role}
        {...(view.avatarUrl !== null && view.avatarUrl !== undefined
          ? { src: view.avatarUrl }
          : {})}
      />,
      'block',
    );
  }

  // The name on its own: one line, cut with an ellipsis when the line is short
  // (the time beside it never shrinks).
  function authorName(view: ReturnType<typeof authorView>): ReactNode {
    return view.asPerson(
      <span
        data-comment-author=""
        className="min-w-0 truncate whitespace-nowrap text-sm font-medium text-fg"
      >
        {view.name}
      </span>,
      'inline',
      'min-w-0 truncate',
    );
  }

  // The time after the name (formatAgo, meta: mono, tabular).
  function rowTime(comment: CommentRow, now: Date): ReactNode {
    return (
      <Text
        role="meta"
        as="time"
        dateTime={comment.created_at}
        data-comment-time=""
        className="shrink-0 whitespace-nowrap"
      >
        {formatAgo(comment.created_at, now)}
      </Text>
    );
  }

  // The edited marker at the end of the body, on the last word's line: " (edited)"
  // on comments and replies; a point keeps its "edited <time>". Null when never edited.
  function editedMarker(comment: CommentRow, point: boolean, now: Date): ReactNode {
    const marker = point
      ? pointEditedMarker(comment.edited_at, now)
      : comment.edited_at === null
        ? null
        : EDITED_MARKER;
    if (marker === null) return null;
    return (
      <span data-comment-edited="" className="text-sm text-fg-3">
        {` ${marker}`}
      </span>
    );
  }

  // The row's action bar (CommentActionBar): Reply, Resolve, To-do, Edit, |
  // Delete, each only where this viewer can do it. Nothing while editing.
  function renderBar(comment: CommentRow, opts: RowOptions): ReactNode {
    if (editingId === comment.id) return null;
    const reply = opts.replyAction;
    const resolve = opts.resolve;
    const bar = commentBar({
      canReply: reply !== null,
      resolve: resolve?.slot ?? null,
      viewerIsAgency,
      hasTask: comment.task_state !== null && comment.task_state !== undefined,
      canEdit: opts.actions.canEdit,
      canDelete: opts.actions.canDelete,
    });
    return (
      <CommentActionBar
        bar={bar}
        resolveLabel={resolve?.label ?? ''}
        resolveHook={resolve?.hook ?? 'data-comment-resolve'}
        resolveBusy={resolve?.busy === true}
        replyOpen={reply?.open === true}
        replyInduction={reply?.induction}
        replyToReply={reply?.toReply === true}
        onReply={() => reply?.onReply()}
        onResolve={() => resolve?.onResolve()}
        onTodo={() => openTaskSheet(comment)}
        onEdit={() => startEdit(comment)}
        onDelete={() => handleDelete(comment.id)}
      />
    );
  }

  // The one grey tag under a body once the comment has a task. Agency: who it
  // went to, a tap opens that chat's Tasks on it; a client: the state only.
  function renderTaskTag(comment: CommentRow): ReactNode {
    const tag = commentTaskTag({
      state: comment.task_state,
      link: comment.comment_tasks,
      viewerIsAgency,
      me: currentUserId,
      nameOf,
    });
    return tag === null ? null : <CommentTaskTag tag={tag} />;
  }

  /**
   * The ONE row template for every item: plain roots, checkpoint points and
   * replies. A root sits beside its 44 lead column (avatar, or the point's
   * circle); a reply sits on the root's text column with avatar 20 + name on
   * one line. The head line: (avatar), name, time at the top left. The
   * action bar is out of that line: absolute on the row's top edge, trailing,
   * half above it; both columns sit 16 under it (ROW_BAR_ROOM_CLASS). Then the
   * body (an edited body ends in its marker) and the task tag. No line under
   * the body.
   */
  function renderRow(comment: CommentRow, opts: RowOptions): ReactNode {
    const view = authorView(comment);
    const editing = editingId === comment.id;
    // Attachments: the version ids and the batched comment-files read meet here.
    const attachments = toCommentFileAttachments(comment.attachment_asset_ids, attachmentFiles);
    // One link scan per row: the body's card link feeds both the text and the card.
    const cardUrl = firstExternalUrl(comment.body);
    const now = new Date(nowMs);

    // A point's author shows once on its group: a point has no head line.
    const header = opts.point ? null : (
      <div data-comment-header="" className="flex min-w-0 items-center gap-2">
        {opts.reply ? <span className="flex shrink-0">{authorAvatar(view, 'inline')}</span> : null}
        {authorName(view)}
        {rowTime(comment, now)}
      </div>
    );
    const edited = editedMarker(comment, opts.point, now);

    // Swipe left = the bar's Delete, only where the bar offers it (same path).
    const swipeDelete = !editing && opts.actions.canDelete ? () => handleDelete(comment.id) : null;

    // The row slides on its own; the replies and the reply composer under a
    // root sit beside it (same text column, the lead column kept empty), so a
    // swipe on the root never moves them.
    return (
      <>
        <CommentSwipeRow
          kind={opts.reply ? 'reply' : 'root'}
          enabled={!editing}
          onReply={opts.swipeReply ?? null}
          onDelete={swipeDelete}
        >
          {renderBar(comment, opts)}
          {opts.lead !== null ? (
            <span className={cn(LEAD_COLUMN_CLASS, ROW_BAR_ROOM_CLASS)}>{opts.lead}</span>
          ) : null}
          <div className={cn('min-w-0 flex-1', ROW_BAR_ROOM_CLASS)}>
            {header}

            {editing ? (
              renderEditor(comment.id)
            ) : (
              <div>
                {annotationChip(
                  comment.id,
                  annotationsByCommentId?.[comment.id],
                  onAnnotationChipClick,
                  opts.circle,
                )}
                {comment.body.trim() !== '' ? (
                  <div
                    className={cn(
                      'text-base whitespace-pre-wrap [overflow-wrap:anywhere]',
                      opts.muted === true ? 'text-fg-2' : 'text-fg',
                    )}
                  >
                    {renderCommentBody(comment.body, handleOf, searchWords, cardUrl)}
                    {edited}
                  </div>
                ) : edited !== null ? (
                  <div>{edited}</div>
                ) : null}
                <CommentLinkCard body={comment.body} url={cardUrl} />
                {attachments.length > 0 ? (
                  <MessageAttachments
                    attachments={attachments}
                    cache={presignCache}
                    presignEnabled={presignEnabled}
                    onImageClick={(attachment) => {
                      const nav = commentImageNav(attachments, attachment.assetId);
                      if (nav.images.length > 0) {
                        setLightbox({
                          ...nav,
                          title: commentViewerTitle(view.name, comment.created_at, new Date(nowMs)),
                        });
                      }
                    }}
                  />
                ) : null}
                {renderTaskTag(comment)}
              </div>
            )}

            {rowError !== null && rowError.id === comment.id ? (
              <ErrorNote className="mt-2">{rowError.message}</ErrorNote>
            ) : null}
          </div>
        </CommentSwipeRow>
        {opts.below !== undefined ? (
          <div className="flex min-w-0 gap-2">
            {opts.lead !== null ? <span aria-hidden="true" className={LEAD_COLUMN_CLASS} /> : null}
            <div className="min-w-0 flex-1">{opts.below}</div>
          </div>
        ) : null}
      </>
    );
  }

  // A root's Reply (its composer toggles; with typed text the tap asks
  // "Discard reply?"). The guide's anchor rides on the comment the onboarding
  // guide teaches replying on.
  function rootReply(comment: CommentRow): RowReply {
    return {
      onReply: () => onReplyButton(comment),
      open: replyOpen.has(comment.id),
      induction: comment.id === guideReplyCommentId ? INDUCTION_KEYS.postCommentReply : undefined,
    };
  }

  // A root's swipe right: its Reply. While its composer is already open the
  // swipe has nothing to add and rubber-bands (it never closes or discards a
  // draft).
  function rootSwipeReply(comment: CommentRow): (() => void) | null {
    return replyOpen.has(comment.id) ? null : () => onReplyButton(comment);
  }

  // One reply, on the same row template. Every live reply (checkpoint or plain
  // thread) gets its own Reply, which posts to the thread root with the reply
  // author's @Name.
  function renderReplyRow(reply: CommentRow, onReply?: () => void): ReactNode {
    // A reply is never a tombstone (deleted replies are filtered out).
    return renderRow(reply, {
      reply: true,
      point: false,
      lead: null,
      actions: commentActions(reply, currentUserId, false),
      replyAction: onReply !== undefined ? { onReply, toReply: true } : null,
      swipeReply: onReply ?? null,
    });
  }

  // Under a root: the folded replies list, then the root's reply composer
  // (inline, no rule, no indent).
  function renderThreadBelow(
    root: CommentRow,
    replies: CommentRow[],
    tombstone: boolean,
    replyToReply: boolean,
  ): ReactNode {
    return (
      <>
        {renderReplyList(
          replies,
          (reply) =>
            renderReplyRow(
              reply,
              replyToReply && !tombstone ? () => onReplyToReply(root, reply) : undefined,
            ),
          {
            unfolded: unfoldedReplies.has(root.id),
            onUnfold: () => unfoldReplies(root.id),
            rootId: root.id,
          },
        )}
        {!tombstone && replyOpen.has(root.id) ? renderReplyComposer(root) : null}
      </>
    );
  }

  // A soft-deleted root kept for its live replies: the tombstone line, then the
  // replies. No header, body or actions.
  function renderTombstone(root: CommentRow, replies: CommentRow[]): ReactNode {
    return (
      <>
        <p className="text-sm italic text-fg-3">{tombstoneText(root, nameOf, new Date(nowMs))}</p>
        {renderThreadBelow(root, replies, true, false)}
      </>
    );
  }

  // A plain thread's Resolve slot: the one-tap Resolve (Undo in the bottom
  // strip), or Reopen once resolved; clients get none on posts (resolveSlot).
  function threadResolve(comment: CommentRow): RowResolve | undefined {
    const slot = resolveSlot({
      reply: false,
      point: false,
      isClient,
      resolved: comment.resolved_at !== null,
      confirmed: false,
    });
    if (slot === 'resolve') {
      return {
        slot,
        label: CHECKPOINT_BOX_LABEL,
        hook: 'data-comment-resolve',
        onResolve: () => handleOneTapResolve(comment),
      };
    }
    if (slot === 'reopen') {
      return {
        slot,
        label: REOPEN_LABEL,
        hook: 'data-comment-resolve',
        busy: resolvingId === comment.id,
        onResolve: () => void handleResolve(comment, false),
      };
    }
    return undefined;
  }

  // One plain one-level thread on the row template: the root rides on the
  // item's top hairline so its bar sits ON that line.
  function renderThreadItem({ comment, replies, tombstone }: ThreadRoot): ReactNode {
    // Thread-level resolved state lives on the root comment. A tombstone
    // root cannot be resolved/reopened (the proc rejects a deleted comment).
    const resolve = threadResolve(comment);
    return (
      <GlideItem
        as="li"
        key={comment.id}
        id={commentDomId(comment.id)}
        className={cn(
          tombstone ? THREAD_TOMBSTONE_ITEM_CLASS : THREAD_BAR_ITEM_CLASS,
          COMMENT_ROW_SCROLL_CLASS,
        )}
      >
        {tombstone
          ? renderTombstone(comment, replies)
          : renderRow(comment, {
              reply: false,
              point: false,
              lead: authorAvatar(authorView(comment), 'header'),
              actions: commentActions(comment, currentUserId, false),
              muted: comment.resolved_at !== null,
              replyAction: rootReply(comment),
              ...(resolve !== undefined ? { resolve } : {}),
              swipeReply: rootSwipeReply(comment),
              below: renderThreadBelow(comment, replies, false, true),
            })}
      </GlideItem>
    );
  }

  // A checkpoint's Resolve slot. Agency, open point: the one-tap Resolve.
  // Client: the one-tap Confirm on a resolved point they have not confirmed.
  // The circle in the lead column carries the state; nothing else repeats it.
  function pointResolve(comment: CommentRow): RowResolve | undefined {
    const seq = comment.ledger_seq ?? 0;
    const state = checkpointState(comment);
    const confirmed = checkpointConfirmed(comment);
    const slot = resolveSlot({
      reply: false,
      point: true,
      isClient,
      resolved: state === 'resolved',
      confirmed,
    });
    if (slot === 'resolve' && tickInteractive(state, isClient)) {
      return {
        slot,
        label: `Resolve checkpoint ${seq}`,
        hook: 'data-checkpoint-box',
        onResolve: () => handleOneTapResolve(comment),
      };
    }
    if (slot === 'confirm' && showCheckpointConfirm(state, isClient, confirmed)) {
      return {
        slot,
        label: `Confirm checkpoint ${seq}`,
        hook: 'data-checkpoint-confirm',
        onResolve: () => handleConfirm(comment),
      };
    }
    return undefined;
  }

  // One numbered point inside a checkpoint group. Open (or opened) points show
  // in full beside their circle; a resolved point folds to ONE line
  // ("{n} · {body first line}", ⌄) until tapped. A deleted point keeps its
  // circle and number above its tombstone line.
  function renderPoint({ comment, replies, tombstone }: ThreadRoot): ReactNode {
    const seq = comment.ledger_seq ?? 0;
    const circle = checkpointCircleState(comment);
    const resolved = circle !== 'open';
    // A point waiting on this viewer's Confirm stays whole (the Confirm is the
    // one thing to do on it); every other resolved point folds.
    const awaitingMe = showCheckpointConfirm(
      checkpointState(comment),
      isClient,
      checkpointConfirmed(comment),
    );
    const open = openPoints.has(comment.id) || awaitingMe;
    if (tombstone) {
      return (
        <div data-comment-row="root" className="flex min-w-0 items-start gap-2">
          <span className={LEAD_COLUMN_CLASS}>
            <CheckpointCircle n={seq} state={circle} />
          </span>
          <div className="min-w-0 flex-1 pt-1">{renderTombstone(comment, replies)}</div>
        </div>
      );
    }
    if (resolved && !open) {
      return (
        <PressableRow
          type="button"
          data-point-fold=""
          aria-expanded={false}
          onClick={() => togglePoint(comment.id)}
          className="flex min-w-0 items-center gap-2"
        >
          <span className={LEAD_COLUMN_CLASS}>
            <CheckpointCircle n={seq} state={circle} />
          </span>
          <Text role="secondary" className="min-w-0 flex-1">
            {foldedPointText(seq, comment.body, handleOf)}
          </Text>
          <span aria-hidden className={cn(LEAD_COLUMN_CLASS, 'text-fg-3')}>
            <IconChevronDown size={ICON_SIZE.inline} />
          </span>
        </PressableRow>
      );
    }
    const resolve = pointResolve(comment);
    return renderRow(comment, {
      reply: false,
      point: true,
      // A resolved point opened from its fold closes again from its circle.
      lead:
        resolved && !awaitingMe ? (
          <IconButton
            type="button"
            label={`Fold checkpoint ${seq}`}
            aria-expanded
            data-point-unfold=""
            className="-my-2"
            onClick={() => togglePoint(comment.id)}
          >
            <CheckpointCircle n={seq} state={circle} />
          </IconButton>
        ) : (
          <span className={cn(CHECKPOINT_HIT_CLASS, '-my-2')} data-point-circle="">
            <CheckpointCircle n={seq} state={circle} />
          </span>
        ),
      circle,
      // Author-only edit/delete, hidden once the point is frozen (confirmed or
      // locked). The proc re-checks auth.uid().
      actions: pointActions(comment, currentUserId, false),
      muted: resolved,
      replyAction: rootReply(comment),
      ...(resolve !== undefined ? { resolve } : {}),
      swipeReply: rootSwipeReply(comment),
      below: renderThreadBelow(comment, replies, false, true),
    });
  }

  // Consecutive checkpoints from one author: the author ONCE (avatar, name,
  // "{n} checkpoints · {time}"), then the numbered list. Everyone, clients
  // included, can reply on a point or on any reply inside it (the reply posts
  // to the point). Each point keeps 24 above it for its bar.
  function renderBatchItem(group: { authorId: string; threads: ThreadRoot[] }): ReactNode {
    const first = group.threads[0]?.comment;
    if (first === undefined) return null;
    const view = authorView(first);
    const latest = groupLatestAt(group.threads);
    return (
      <GlideItem
        as="li"
        key={`batch-${group.authorId}-${first.id}`}
        data-checkpoint-group=""
        className={THREAD_TOMBSTONE_ITEM_CLASS}
      >
        <div data-group-header="" className="flex min-w-0 items-center gap-2">
          <span className={LEAD_COLUMN_CLASS}>{authorAvatar(view, 'header')}</span>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">{authorName(view)}</div>
            <Text role="meta" as="p" data-group-meta="">
              {checkpointGroupMeta(group.threads.length, formatAgo(latest, new Date(nowMs)))}
            </Text>
          </div>
        </div>
        <ol className="mt-6 flex flex-col gap-6">
          {group.threads.map((thread) => (
            <li
              key={thread.comment.id}
              id={commentDomId(thread.comment.id)}
              data-point-state={checkpointCircleState(thread.comment)}
              className={COMMENT_ROW_SCROLL_CLASS}
            >
              {renderPoint(thread)}
            </li>
          ))}
        </ol>
      </GlideItem>
    );
  }

  // The root composer sits at the END of the list (not fixed), so reading comes
  // first and writing follows it.
  const composer =
    viewerIsClient === true && entityType === 'post' ? (
      <SlotComposer
        onSubmit={handleCreateBatch}
        canAttach={canAttach}
        uploadFile={uploadFile}
        startSeq={maxLedgerSeq + 1}
        expandTitle={expandTitle}
      />
    ) : (
      <CommentComposer
        // Remounts per entity (its own kept draft) and after a discarded draft.
        key={`root-${entityKey}-${rootEpoch}`}
        onSubmit={(body, options) => handleCreate(body, { ...options, parentCommentId: null })}
        members={mentionMembers}
        canAttach={canAttach}
        uploadFile={uploadFile}
        placeholder="Write a comment"
        expandTitle={expandTitle}
        {...(rootDrafts.has(entityKey) ? { initialBody: rootDrafts.get(entityKey) ?? '' } : {})}
        onBodyChange={(body) => {
          rootDrafts.set(entityKey, body);
          setRootHasText(draftHasText(body));
        }}
        onAttachmentCountChange={(count) => setRootHasChips(count > 0)}
      />
    );

  const filterButton = (value: CommentFilter, label: string): ReactNode => (
    <Chip
      type="button"
      label={label}
      selected={filter === value}
      onClick={() => setFilter(value)}
    />
  );

  return (
    <div ref={rootRef} className="flex flex-col gap-4">
      {showHeader ? (
        <div data-comments-header="" className="flex items-center gap-2">
          <h3 className="text-base font-semibold text-fg">{CHECKPOINTS_TITLE}</h3>
          <div role="group" aria-label="Show comments" className="ml-auto flex items-center gap-2">
            {filterButton('open', 'Open')}
            {filterButton('all', 'All')}
          </div>
        </div>
      ) : null}
      <LiveCheckpointsContext.Provider value={loading ? null : liveCheckpoints}>
        {belowHeader}
      </LiveCheckpointsContext.Provider>

      {loading ? (
        <div aria-busy="true" className={cn(THREAD_LIST_CLASS, ownCard ? OWN_CARD_CLASS : '')}>
          <span className="sr-only">Loading comments</span>
          {[0, 1, 2].map((row) => (
            <div key={row} aria-hidden className={cn(THREAD_ITEM_CLASS, 'flex gap-2')}>
              <span className={LEAD_COLUMN_CLASS}>
                <Bone lit="lit-avatar" as="div" className="h-8 w-8 shrink-0 rounded-lg" />
              </span>
              <div className="min-w-0 flex-1">
                <Bone lit="flat" as="div" className="mt-2 h-3 w-24 rounded" />
                <Bone lit="flat" as="div" className="mt-3 h-3 w-full rounded" />
                <Bone lit="flat" as="div" className="mt-2 h-3 w-2/3 rounded" />
              </div>
            </div>
          ))}
        </div>
      ) : loadError ? (
        <LoadError title="comments" onRetry={() => void reloadAll()} />
      ) : threads.length === 0 || groups.length === 0 ? (
        <div
          data-comments-empty=""
          className={cn('px-4 py-8 text-center text-base text-fg-3', ownCard ? OWN_CARD_CLASS : '')}
        >
          {emptyListText(entityType, threads.length === 0 ? 'all' : 'open')}
        </div>
      ) : (
        <ul
          data-comments-list=""
          className={cn(THREAD_LIST_CLASS, THREAD_LIST_BAR_CLASS, ownCard ? OWN_CARD_CLASS : '')}
        >
          {groups.map((group) =>
            group.kind === 'batch' ? renderBatchItem(group) : renderThreadItem(group.thread),
          )}
        </ul>
      )}

      {!loading && !loadError && moreError ? (
        <ErrorNote className="flex items-center gap-3">
          <span>Couldn&apos;t load older comments.</span>
          <Button
            variant="ghost"
            className="ml-auto min-w-11"
            busy={loadingMore}
            onClick={() => void loadPage(page + 1)}
          >
            Retry
          </Button>
        </ErrorNote>
      ) : null}

      {!loading && !loadError && !moreError && hasMore ? (
        <Button className="self-start" busy={loadingMore} onClick={() => void loadPage(page + 1)}>
          Load more
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

      {rootDiscardAsk ? (
        <ConfirmDialog
          title="Discard comment?"
          message="Your comment has not been sent."
          confirmLabel="Discard"
          cancelLabel="Keep editing"
          destructive
          onConfirm={() => {
            // Released first, so the guard's own entry pops cleanly; the next
            // Back leaves the page.
            rootGuard.release();
            setRootDiscardAsk(false);
            rootDrafts.delete(entityKey);
            setRootHasText(false);
            setRootHasChips(false);
            setRootEpoch((n) => n + 1);
          }}
          onCancel={() => setRootDiscardAsk(false)}
        />
      ) : null}

      {taskFor !== null ? (
        <CommentTaskSheet
          key={taskFor.commentId}
          open={taskOpen}
          onClose={() => setTaskOpen(false)}
          workspaceId={workspaceId}
          commentId={taskFor.commentId}
          initialTitle={taskFor.title}
          me={currentUserId}
          candidates={candidates}
          newTrace={newTrace}
          onCreated={(link) => handleTaskCreated(taskFor.commentId, link)}
          onExists={refreshInBackground}
        />
      ) : null}

      {lightbox !== null ? (
        <ImageLightbox
          images={lightbox.images}
          index={lightbox.index}
          cache={presignCache}
          presignEnabled={presignEnabled}
          backBar={{ title: lightbox.title }}
          onIndexChange={(index) =>
            setLightbox((prev) => (prev !== null ? { ...prev, index } : prev))
          }
          onClose={() => setLightbox(null)}
        />
      ) : null}
    </div>
  );
}
