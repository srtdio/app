import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Textarea';
import { supabase } from '@/lib/supabase';
import { useNewTrace } from '@/lib/trace-context';
import { createComment, listComments, PAGE_SIZE } from '@srtdio/comments';
import type { CommentEntityType, CommentRow } from '@srtdio/comments';

// The proc enforces a body length of 1..10000; mirror it client-side so the
// Post button disables and a friendly message shows before the request runs.
const MAX_BODY = 10000;

interface CommentsProps {
  workspaceId: string;
  entityType: CommentEntityType;
  entityId: string;
}

// Format a stored timestamp as a localized date and time. Falls back to the raw
// value if it is somehow unparseable so nothing is silently dropped.
function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

/**
 * Read + create comments on one entity (a post or a brief). Renders a flat,
 * newest-first list with offset pagination and a composer that posts top-level
 * comments. Edit, delete, reply and the is_decision toggle after creation are
 * out of scope; the package exposes no such operations.
 */
export function Comments({ workspaceId, entityType, entityId }: CommentsProps) {
  const newTrace = useNewTrace();

  const [comments, setComments] = useState<CommentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const [body, setBody] = useState('');
  const [isDecision, setIsDecision] = useState(false);
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);

  // The decision toggle is a post-only affordance; briefs never carry it.
  const showDecisionToggle = entityType === 'post';

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
          setPostError(null);
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

  const trimmed = body.trim();
  const tooLong = body.length > MAX_BODY;
  const canPost = trimmed.length > 0 && !tooLong && !posting;

  async function handlePost(): Promise<void> {
    if (!canPost) return;
    setPosting(true);
    setPostError(null);
    const result = await createComment(supabase, {
      workspace_id: workspaceId,
      entity_type: entityType,
      entity_id: entityId,
      body,
      is_decision: showDecisionToggle ? isDecision : false,
      trace_id: newTrace(),
    });
    if (!result.ok) {
      // Keep the text so the user does not lose their draft on failure.
      setPosting(false);
      setPostError(result.error.message);
      return;
    }
    setBody('');
    setIsDecision(false);
    setPosting(false);
    // Re-fetch from page 0 so the new comment appears at the top.
    await loadPage(0);
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Textarea
          value={body}
          onChange={(event) => setBody(event.target.value)}
          placeholder="Add a comment"
          aria-label="Comment body"
          disabled={posting}
        />
        {tooLong ? (
          <p role="alert" className="text-xs text-bad">
            Comments must be at most {MAX_BODY.toLocaleString()} characters.
          </p>
        ) : null}
        <div className="flex items-center gap-3 flex-wrap">
          {showDecisionToggle ? (
            <label className="inline-flex items-center gap-2 min-h-[44px] cursor-pointer select-none text-sm text-fg-2">
              <input
                type="checkbox"
                className="h-5 w-5 rounded border-border accent-accent"
                checked={isDecision}
                onChange={(event) => setIsDecision(event.target.checked)}
                disabled={posting}
              />
              Mark as decision
            </label>
          ) : null}
          <Button
            size="lg"
            variant="primary"
            className="ml-auto min-w-[44px]"
            disabled={!canPost}
            onClick={() => void handlePost()}
          >
            {posting ? 'Posting' : 'Post'}
          </Button>
        </div>
        {postError !== null ? (
          <div role="alert" className="rounded-md border border-bad px-3 py-2 text-sm text-bad">
            {postError}
          </div>
        ) : null}
      </div>

      {loading ? (
        <p className="text-sm text-fg-3">Loading comments</p>
      ) : loadError !== null ? (
        <div role="alert" className="rounded-md border border-bad px-3 py-2 text-sm text-bad">
          Could not load comments. {loadError}
        </div>
      ) : comments.length === 0 ? (
        <div className="rounded-xl border border-border bg-panel-2 px-4 py-8 text-center text-sm text-fg-3">
          No comments yet
        </div>
      ) : (
        <ul className="flex flex-col gap-3">
          {comments.map((comment) => (
            <li key={comment.id} className="rounded-xl border border-border bg-panel-2 px-4 py-3">
              <div className="flex items-center gap-2 mb-1.5">
                <span className="text-xs font-medium text-fg-2 break-all">
                  {comment.author_user_id}
                </span>
                {comment.is_decision ? (
                  <span className="inline-flex items-center rounded-full border border-accent-line px-2 h-5 text-[11px] font-medium text-accent">
                    Decision
                  </span>
                ) : null}
                <span className="ml-auto shrink-0 text-xs text-fg-3 tabular-nums">
                  {formatTimestamp(comment.created_at)}
                </span>
              </div>
              <p className="text-sm leading-relaxed whitespace-pre-wrap text-fg">{comment.body}</p>
            </li>
          ))}
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
