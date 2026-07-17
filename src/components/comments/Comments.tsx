import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { IconCheck, IconMore } from '@/components/ui/icons';
import { MenuPopover } from '@/components/shell/MenuPopover';
import { Avatar } from '@/components/ui/Avatar';
import { cn } from '@/lib/cn';
import { relativeLong } from '@/lib/relative-time';
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
import { DOMAIN_ERROR_CODES } from '@srtdio/rpc';
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

// ---------------------------------------------------------------------------
// Checkpoint batches in the thread (feedback ledger)
// ---------------------------------------------------------------------------

/** One rendered item of the thread list: a plain one-level thread, or a run of
 *  consecutive checkpoint threads that share a ledger_batch_id (one send). */
export type ThreadGroup =
  | { kind: 'single'; thread: ThreadRoot }
  | { kind: 'batch'; batchId: string; threads: ThreadRoot[] };

/**
 * Group consecutive TOP-LEVEL checkpoint threads (ledger_seq not null) sharing a
 * ledger_batch_id into one batch; every other thread passes through unchanged.
 * Only adjacency in the newest-first list groups, so two runs of the same batch
 * separated by an ordinary comment stay separate. Points inside a batch are
 * re-ordered by ledger_seq ascending so they read in checkpoint order.
 */
export function groupThreads(threads: readonly ThreadRoot[]): ThreadGroup[] {
  const groups: ThreadGroup[] = [];
  for (const thread of threads) {
    const batchId = thread.comment.ledger_seq !== null ? thread.comment.ledger_batch_id : null;
    const last = groups[groups.length - 1];
    if (
      batchId !== null &&
      last !== undefined &&
      last.kind === 'batch' &&
      last.batchId === batchId
    ) {
      last.threads.push(thread);
    } else if (batchId !== null) {
      groups.push({ kind: 'batch', batchId, threads: [thread] });
    } else {
      groups.push({ kind: 'single', thread });
    }
  }
  for (const group of groups) {
    if (group.kind === 'batch') {
      group.threads.sort((a, b) => (a.comment.ledger_seq ?? 0) - (b.comment.ledger_seq ?? 0));
    }
  }
  return groups;
}

/** The batch group header line. */
export function batchHeaderLabel(count: number): string {
  return `added ${count} ${count === 1 ? 'checkpoint' : 'checkpoints'}`;
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

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Read + create comments on one entity (a post or a brief). Renders a flat,
 * newest-first list grouped into one-level threads: each root may carry a
 * collapsed "N replies" expander, attachments, and (for the caller's own
 * comments) edit / delete. A soft-deleted root with a live reply renders as a
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
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const [profiles, setProfiles] = useState<Map<string, CommentProfile>>(new Map());
  const [attachmentMime, setAttachmentMime] = useState<Map<string, string>>(new Map());
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [replyOpen, setReplyOpen] = useState<Set<string>>(new Set());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editBody, setEditBody] = useState('');
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  // The root thread whose resolve/reopen request is in flight; null when idle.
  const [resolvingId, setResolvingId] = useState<string | null>(null);
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
      setComments((prev) => (nextPage === 0 ? result.data : [...prev, ...result.data]));
      setPage(nextPage);
      setHasMore(result.data.length === PAGE_SIZE);
      if (nextPage === 0) setLoading(false);
      else setLoadingMore(false);
    },
    [workspaceId, entityType, entityId],
  );

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
    if (!comments.some((c) => c.id === focusCommentId)) return;
    flashedCommentId.current = focusCommentId;
    flashNode(commentDomId(focusCommentId));
  }, [comments, focusCommentId]);

  // Resolve author + mention display names in one batched read. The attempted
  // set dedupes ids and stops a missing (ex-member) id from refetching forever.
  const attemptedProfiles = useRef<Set<string>>(new Set());
  useEffect(() => {
    const needed: string[] = [];
    for (const comment of comments) {
      for (const id of [comment.author_user_id, ...parseMentions(comment.body)]) {
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
  }, [comments]);

  // Resolve attachment mimes in one batched read (image vs file dispatch).
  const attemptedMime = useRef<Set<string>>(new Set());
  useEffect(() => {
    const needed: string[] = [];
    for (const comment of comments) {
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
  }, [comments]);

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
      setExpanded((prev) => new Set(prev).add(parentId));
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
    const result = await runEditComment(supabase, commentId, editBody, newTrace());
    if (!result.ok) {
      setRowError({ id: commentId, message: result.error.message });
      return;
    }
    setEditingId(null);
    setEditBody('');
    await loadPage(0);
  }

  async function handleDelete(commentId: string): Promise<void> {
    setRowError(null);
    const result = await runDeleteComment(supabase, commentId, newTrace());
    if (!result.ok) {
      setRowError({ id: commentId, message: result.error.message });
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

  function toggleExpanded(id: string): void {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleReply(id: string): void {
    setReplyOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function startEdit(comment: CommentRow): void {
    setEditingId(comment.id);
    setEditBody(comment.body);
    setRowError(null);
  }

  const threads = buildThreads(comments);
  const groups = groupThreads(threads);

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
          {!editing ? (
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

  // The shared tail of a top-level item: replies expander, Reply, (optionally)
  // the thread Resolve toggle, the expanded replies, and the reply composer.
  // Batch checkpoint points reuse it with showResolve=false: their tick state is
  // owned by the feedback ledger, but replies stay normal child comments.
  function renderThreadTail(
    comment: CommentRow,
    replies: CommentRow[],
    tombstone: boolean,
    showResolve: boolean,
  ): ReactNode {
    const isExpanded = expanded.has(comment.id);
    const isReplyOpen = replyOpen.has(comment.id);
    const isResolved = comment.resolved_at !== null;
    const isResolving = resolvingId === comment.id;
    return (
      <>
        <div className="mt-2 flex items-center gap-2">
          {replies.length > 0 ? (
            <Button
              size="sm"
              variant="ghost"
              className="min-h-[44px]"
              onClick={() => toggleExpanded(comment.id)}
            >
              {isExpanded
                ? 'Hide replies'
                : `${replies.length} ${replies.length === 1 ? 'reply' : 'replies'}`}
            </Button>
          ) : null}
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
        </div>

        {isExpanded && replies.length > 0 ? (
          <ul className="mt-3 flex flex-col gap-3 border-l border-border pl-4">
            {replies.map((reply) => (
              <li key={reply.id} id={commentDomId(reply.id)}>
                {renderCommentCard(reply, true)}
              </li>
            ))}
          </ul>
        ) : null}

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
              initialBody={replySeed(comment, currentUserId, candidates)}
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

  // One checkpoint batch: a group card headed "added N checkpoints", then each
  // point with its seq number (mono), verbatim body, attachments, and tick
  // state. Ticks are toggled in the feedback ledger, not here; the per-point
  // reply affordance is the existing thread tail (replies stay child comments).
  function renderBatchItem(group: { batchId: string; threads: ThreadRoot[] }): ReactNode {
    const first = group.threads[0]?.comment;
    if (first === undefined) return null;
    const authorName = first.legacy_author_name ?? nameOf(first.author_user_id) ?? EX_MEMBER_LABEL;
    const authorAvatarUrl =
      first.legacy_author_name !== null ? null : avatarOf(first.author_user_id);
    return (
      <li
        key={`batch-${group.batchId}`}
        className="rounded-xl border border-border bg-panel-2 px-4 py-3 transition-shadow"
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
          <span className="text-xs text-fg-3">{batchHeaderLabel(group.threads.length)}</span>
          <span className="ml-auto shrink-0 text-xs text-fg-3 tabular-nums">
            {relativeLong(first.created_at, new Date())}
          </span>
        </div>
        <ol className="flex flex-col gap-3">
          {group.threads.map(({ comment, replies, tombstone }) => {
            const attachments = toCommentAttachments(comment.attachment_asset_ids, attachmentMime);
            const done = comment.resolved_at !== null;
            return (
              <li key={comment.id} id={commentDomId(comment.id)}>
                <div className="flex items-start gap-2">
                  <span
                    aria-hidden
                    className="w-5 shrink-0 pt-0.5 text-right font-mono text-xs font-medium tabular-nums text-fg-3"
                  >
                    {comment.ledger_seq}
                  </span>
                  <div className="min-w-0 flex-1">
                    {tombstone ? (
                      <p className="text-xs italic text-fg-3">{tombstoneText(comment, nameOf)}</p>
                    ) : (
                      <>
                        <p className="text-sm leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere] text-fg">
                          {renderCommentBody(comment.body, nameOf)}
                          {comment.edited_at !== null ? (
                            <span className="ml-1.5 text-[11px] text-fg-3">edited</span>
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
                      </>
                    )}
                  </div>
                  {/* The tick enters/leaves via opacity/translateY only. */}
                  <span
                    aria-hidden={!done}
                    className={cn(
                      'flex shrink-0 items-center gap-1 pt-0.5 text-xs font-medium text-good transition-[opacity,transform] duration-fast ease-enter',
                      done ? 'translate-y-0 opacity-100' : 'translate-y-1 opacity-0',
                    )}
                  >
                    <IconCheck size={14} />
                    Done
                  </span>
                </div>
                <div className="pl-7">{renderThreadTail(comment, replies, tombstone, false)}</div>
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
