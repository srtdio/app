import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import { Avatar } from '@/components/ui/Avatar';
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
  PAGE_SIZE,
} from '@srtdio/comments';
import type {
  Client,
  CommentEntityType,
  CommentRow,
  CreateCommentInput,
  Result,
} from '@srtdio/comments';
import type { MessageAttachment } from '@/lib/chat/attachments';
import { CommentComposer } from '@/components/comments/CommentComposer';
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
      <div className="mt-2">
        <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-panel-3 px-2.5 py-1 text-xs text-fg-3">
          <span className="font-medium">copy changed · v{annotation.versionNumber}</span>
          {annotation.quote !== '' ? (
            <span className="max-w-[18rem] truncate">{annotation.quote}</span>
          ) : null}
        </span>
      </div>
    );
  }
  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => onClick?.(commentId)}
        className="inline-flex min-h-[44px] min-w-[44px] items-center gap-1.5 rounded-md border border-annotation-line bg-annotation-bg px-2.5 py-1 text-xs text-fg hover:opacity-90"
      >
        <sup className="text-[10px] font-semibold text-annotation-line">{annotation.n}</sup>
        <span className="max-w-[18rem] truncate">{annotation.quote}</span>
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
  comment: Pick<CommentRow, 'author_user_id' | 'deleted_at'>,
  currentUserId: string | null,
): boolean {
  return (
    currentUserId !== null &&
    comment.author_user_id === currentUserId &&
    comment.deleted_at === null
  );
}

const MENTION_TOKEN = /@\[([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\]/gi;

/**
 * Render a comment body, replacing every @[uuid] mention token with an inline,
 * accent-styled "@Name" run (the bare uuid is never shown). An id that no longer
 * resolves to a member renders "@(ex-member)". Surrounding text is returned
 * verbatim so the caller's whitespace-pre-wrap preserves the original layout.
 */
export function renderCommentBody(
  body: string,
  nameOf: (id: string) => string | null,
): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const match of body.matchAll(MENTION_TOKEN)) {
    const start = match.index ?? 0;
    if (start > last) nodes.push(body.slice(last, start));
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
  if (last < body.length) nodes.push(body.slice(last));
  return nodes;
}

/** The tombstone line for a soft-deleted root. Author-only delete means the
 *  deleter is the author; name it when it resolves, else stay anonymous. */
export function tombstoneText(
  comment: Pick<CommentRow, 'author_user_id' | 'deleted_at' | 'created_at'>,
  nameOf: (id: string) => string | null,
): string {
  const when = formatTimestamp(comment.deleted_at ?? comment.created_at);
  const who = nameOf(comment.author_user_id);
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

/** Which row actions a comment offers. Copy is harmless and shown on every live
 *  comment; edit / delete stay author-only; a tombstone offers nothing. */
export interface CommentActions {
  canCopy: boolean;
  canEdit: boolean;
  canDelete: boolean;
}

export function commentActions(
  comment: Pick<CommentRow, 'author_user_id' | 'deleted_at'>,
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
  isDecision: boolean;
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
    is_decision: params.isDecision,
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

/** Batched mime read so the renderer can dispatch image vs file (no N+1). */
async function fetchAttachmentMime(
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
}: CommentsProps) {
  const newTrace = useNewTrace();
  const { canAttach, presignEnabled, presignCache, uploadFile } = useChatAttachments();

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

  // The decision toggle is a post-only affordance; briefs never carry it.
  const showDecisionToggle = entityType === 'post';

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

  async function handleCreate(
    body: string,
    options: {
      attachmentVersionIds: string[];
      isDecision: boolean;
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
        isDecision: showDecisionToggle ? options.isDecision : false,
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
    const authorName = nameOf(comment.author_user_id) ?? EX_MEMBER_LABEL;
    const editing = editingId === comment.id;

    return (
      <>
        <div className="flex items-center gap-2 mb-1.5">
          <Avatar name={authorName} size={isReply ? 'sm' : 'md'} />
          <span className="text-xs font-medium text-fg-2">{authorName}</span>
          {comment.is_decision ? (
            <span className="inline-flex items-center rounded-full border border-accent-line px-2 h-5 text-[11px] font-medium text-accent">
              Decision
            </span>
          ) : null}
          {comment.edited_at !== null ? (
            <span className="text-[11px] text-fg-3">edited</span>
          ) : null}
          <span className="ml-auto shrink-0 text-xs text-fg-3 tabular-nums">
            {formatTimestamp(comment.created_at)}
          </span>
        </div>

        {editing ? (
          renderEditor(comment.id)
        ) : (
          <>
            <p className="text-sm leading-relaxed whitespace-pre-wrap text-fg">
              {renderCommentBody(comment.body, nameOf)}
            </p>
            {attachments.length > 0 ? (
              <MessageAttachments
                attachments={attachments}
                cache={presignCache}
                presignEnabled={presignEnabled}
              />
            ) : null}
            {annotationChip(
              comment.id,
              annotationsByCommentId?.[comment.id],
              onAnnotationChipClick,
            )}
          </>
        )}

        {!editing ? (
          <div className="mt-2 flex items-center gap-1">
            {actions.canCopy ? (
              <Button
                size="sm"
                variant="ghost"
                className="min-h-[44px] min-w-[44px]"
                onClick={() => void handleCopy(comment)}
              >
                Copy text
              </Button>
            ) : null}
            {actions.canEdit ? (
              <Button
                size="sm"
                variant="ghost"
                className="min-h-[44px] min-w-[44px]"
                onClick={() => startEdit(comment)}
              >
                Edit
              </Button>
            ) : null}
            {actions.canDelete ? (
              <Button
                size="sm"
                variant="ghost"
                className="min-h-[44px] min-w-[44px] text-bad"
                onClick={() => void handleDelete(comment.id)}
              >
                Delete
              </Button>
            ) : null}
            {copiedId === comment.id ? (
              <span role="status" className="text-xs text-fg-3">
                Comment copied
              </span>
            ) : null}
          </div>
        ) : null}

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

  return (
    <div className="flex flex-col gap-4">
      <CommentComposer
        onSubmit={(body, options) => handleCreate(body, { ...options, parentCommentId: null })}
        showDecisionToggle={showDecisionToggle}
        canAttach={canAttach}
        uploadFile={uploadFile}
      />

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
          {threads.map(({ comment, replies, tombstone }) => {
            const isExpanded = expanded.has(comment.id);
            const isReplyOpen = replyOpen.has(comment.id);
            return (
              <li
                key={comment.id}
                id={commentDomId(comment.id)}
                className="rounded-xl border border-border bg-panel-2 px-4 py-3 transition-shadow"
              >
                {tombstone ? (
                  <p className="text-xs italic text-fg-3">{tombstoneText(comment, nameOf)}</p>
                ) : (
                  renderCommentCard(comment, false)
                )}

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
                      className="min-h-[44px]"
                      onClick={() => toggleReply(comment.id)}
                    >
                      {isReplyOpen ? 'Cancel' : 'Reply'}
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
                      showDecisionToggle={false}
                      canAttach={canAttach}
                      uploadFile={uploadFile}
                      placeholder="Write a reply"
                      submitLabel="Reply"
                      autoFocus
                    />
                  </div>
                ) : null}
              </li>
            );
          })}
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
    </div>
  );
}
