import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { Chip } from '@/components/ui/Chip';
import { Comments } from '@/components/comments/Comments';
import type { CommentAnnotation } from '@/components/comments/Comments';
import { EmptyState } from '@/components/ui/EmptyState';
import { IconPipeline } from '@/components/ui/icons';
import { PostGallery } from '@/components/pages/pcs/PostGallery';
import { CaptionView } from '@/components/pages/pcs/CaptionView';
import type { CaptionAnnotationView } from '@/components/pages/pcs/CaptionView';
import { CaptionAnnotationComposer } from '@/components/pages/pcs/CaptionAnnotationComposer';
import { supabase } from '@/lib/supabase';
import { fetchWithTrace } from '@/lib/fetch';
import { env } from '@/lib/env';
import { PresignCache, type PresignDeps } from '@/lib/asset-presign';
import { useNewTrace } from '@/lib/trace-context';
import { useWorkspace } from '@/lib/workspace-context';
import { annotationCreate, getPost, getPostGallery, STAGE_TRANSITIONS } from '@srtdio/posts';
import type { DomainError, GalleryItem, PostDetail, Stage } from '@srtdio/posts';
import { createComment } from '@srtdio/comments';
import type { Json } from '@srtdio/schemas';
import { stageTransition } from '@srtdio/rpc';

// Read a caption string out of a version snapshot defensively: the snapshot is
// free-form Json, so a missing or non-string caption yields null (no quote)
// rather than a throw.
function snapshotCaption(snapshot: Json | null): string | null {
  if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null;
  const caption = (snapshot as { caption?: unknown }).caption;
  return typeof caption === 'string' ? caption : null;
}

// Title-case a single workflow stage for display. Stage values come from
// @srtdio/posts; this is presentation only.
function stageLabel(stage: Stage): string {
  return stage.charAt(0).toUpperCase() + stage.slice(1);
}

// Title-case a snake_case enum value for display (e.g. single_image -> Single
// Image). Mirrors the Create Post sheet so platform/format read the same way.
function humanize(value: string): string {
  return value
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

// Stage badge styling per stage, using theme tokens so light/dark parity is
// automatic (the tokens flip in dark mode). Border + text only, no translucent
// fills, matching the inline-alert pattern used elsewhere.
const STAGE_BADGE: Record<Stage, string> = {
  draft: 'border-border text-fg-2',
  review: 'border-accent-line text-accent',
  approved: 'border-good text-good',
  parked: 'border-warn text-warn',
  rejected: 'border-bad text-bad',
};

// Intent labels for a stage transition, keyed by the TARGET stage. The SET of
// buttons is derived from STAGE_TRANSITIONS, never from this map; this is pure
// presentation. `draft` is never a transition target but is kept for a total
// Record.
const TRANSITION_LABEL: Record<Stage, string> = {
  draft: 'Back to draft',
  review: 'Move to review',
  approved: 'Approve',
  rejected: 'Reject',
  parked: 'Park',
};

// The one source-sensitive label: from draft, moving to review reads "Send to
// review" rather than "Move to review". Kept as a minimal override so the base
// labels stay keyed by target stage.
const TRANSITION_LABEL_OVERRIDE: Partial<Record<Stage, Partial<Record<Stage, string>>>> = {
  draft: { review: 'Send to review' },
};

// Forward, affirmative moves read as the primary action; the rest are default.
const TRANSITION_VARIANT: Partial<Record<Stage, 'primary' | 'default'>> = {
  review: 'primary',
  approved: 'primary',
};

function transitionLabel(from: Stage, to: Stage): string {
  return TRANSITION_LABEL_OVERRIDE[from]?.[to] ?? TRANSITION_LABEL[to];
}

// Map the proc's domain errors to friendly, inline copy. The proc owns the
// policy: it raises forbidden_role when the role lacks approve/reject
// capability and invalid_stage_transition for an illegal move.
function friendlyTransitionError(error: DomainError): string {
  switch (error.code) {
    case 'forbidden_role':
      return 'You do not have permission to make this change.';
    case 'invalid_stage_transition':
      return 'That move is not allowed from the current stage.';
    case 'workspace_member_only':
      return 'You must be a member of this workspace to make this change.';
    default:
      return 'Something went wrong. Please try again.';
  }
}

function formatTargetDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function PostDetailPage() {
  const { postId } = useParams();
  const navigate = useNavigate();
  const newTrace = useNewTrace();
  const { workspaceId } = useWorkspace();

  const [detail, setDetail] = useState<PostDetail | null>(null);
  const [gallery, setGallery] = useState<GalleryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  const [transitioning, setTransitioning] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Caption annotation state: the pending selection drives the composer, and a
  // bump of commentsRefresh re-fetches the comments list after a post.
  const [composer, setComposer] = useState<{ start: number; end: number; quote: string } | null>(
    null,
  );
  const [annotating, setAnnotating] = useState(false);
  const [annotateError, setAnnotateError] = useState<string | null>(null);
  const [commentsRefresh, setCommentsRefresh] = useState(0);

  // One presign setup for this page, built exactly as the Assets page does: the
  // asset-read endpoint env, the existing access-token source, and the trace
  // fetcher. deps are kept for the lightbox's attachment-disposition download;
  // the cache bounds concurrency and reuses inline URLs across thumbnails.
  const presignEnabled = env.VITE_ASSET_READ_URL !== undefined;
  const deps = useMemo<PresignDeps>(
    () => ({
      endpoint: env.VITE_ASSET_READ_URL ?? null,
      getAccessToken: async () =>
        (await supabase.auth.getSession()).data.session?.access_token ?? null,
      fetcher: (input, init) => fetchWithTrace(input, init),
    }),
    [],
  );
  const cache = useMemo(() => new PresignCache(deps), [deps]);

  // `silent` skips the full-page loading flip so a post-transition refetch
  // updates the badge and buttons in place rather than blanking the screen.
  const load = useCallback(
    async (silent = false): Promise<void> => {
      if (postId === undefined) {
        setLoading(false);
        setNotFound(true);
        return;
      }
      if (!silent) setLoading(true);
      setLoadError(null);
      const result = await getPost(supabase, postId);
      if (!silent) setLoading(false);
      if (!result.ok) {
        setLoadError(result.error.message);
        return;
      }
      if (result.data === null) {
        setNotFound(true);
        setDetail(null);
        return;
      }
      setNotFound(false);
      setDetail(result.data);
    },
    [postId],
  );

  useEffect(() => {
    void load();
  }, [load]);

  // The gallery is a separate read (asset_attachments has no FK back to posts, so
  // it cannot ride getPost's embed) and is non-critical: a failure or an absent
  // post simply leaves the grid empty rather than blocking the page.
  useEffect(() => {
    if (postId === undefined) {
      setGallery([]);
      return;
    }
    let active = true;
    void getPostGallery(supabase, postId).then((result) => {
      if (active) setGallery(result.ok ? result.data : []);
    });
    return () => {
      active = false;
    };
  }, [postId]);

  // The current version is the highest version_number; annotations made on any
  // other version are stale. Computed here so the reads stay untouched.
  const currentVersionId = useMemo<string | null>(() => {
    if (detail === null || detail.versions.length === 0) return null;
    return detail.versions.reduce((top, v) => (v.version_number > top.version_number ? v : top)).id;
  }, [detail]);

  // From the embedded annotations, build (a) the in-bounds current-version
  // caption_span highlights for CaptionView and (b) a per-comment map covering
  // every caption_span (stale included) for the comment chips. Live highlights
  // are numbered in caption order; stale ones carry their original quote sliced
  // from their own version snapshot. Out-of-bounds or inverted ranges are
  // skipped rather than mis-sliced.
  const { highlights, annotationsByCommentId } = useMemo(() => {
    const list: CaptionAnnotationView[] = [];
    const byComment: Record<string, CommentAnnotation> = {};
    if (detail === null) return { highlights: list, annotationsByCommentId: byComment };

    const liveCaption = detail.post.caption ?? '';
    const versionById = new Map(detail.versions.map((v) => [v.id, v]));
    const spans = detail.annotations
      .filter((a) => a.kind === 'caption_span')
      .sort((a, b) => {
        const sa = a.caption_start ?? 0;
        const sb = b.caption_start ?? 0;
        if (sa !== sb) return sa - sb;
        return a.created_at.localeCompare(b.created_at);
      });

    let liveN = 0;
    for (const a of spans) {
      const start = a.caption_start;
      const end = a.caption_end;
      const stale = a.post_version_id !== currentVersionId;
      const versionNumber = versionById.get(a.post_version_id)?.version_number ?? 0;
      const inRange = (cap: string): boolean =>
        start !== null && end !== null && start >= 0 && end <= cap.length && start < end;

      if (!stale) {
        if (start !== null && end !== null && inRange(liveCaption)) {
          liveN += 1;
          list.push({
            id: a.id,
            n: liveN,
            captionStart: start,
            captionEnd: end,
            commentId: a.comment_id,
          });
          byComment[a.comment_id] = {
            n: liveN,
            quote: liveCaption.slice(start, end),
            stale: false,
            versionNumber,
          };
        }
        // Out-of-bounds current-version annotation: no highlight, no chip.
        continue;
      }

      const snapCaption = snapshotCaption(versionById.get(a.post_version_id)?.snapshot ?? null);
      const quote =
        snapCaption !== null && start !== null && end !== null && inRange(snapCaption)
          ? snapCaption.slice(start, end)
          : '';
      byComment[a.comment_id] = { n: 0, quote, stale: true, versionNumber };
    }

    return { highlights: list, annotationsByCommentId: byComment };
  }, [detail, currentVersionId]);

  // Open the composer for a captured caption selection.
  const handleAnnotate = useCallback((start: number, end: number, quote: string): void => {
    setAnnotateError(null);
    setComposer({ start, end, quote });
  }, []);

  // Scroll to (and briefly flash) a DOM node by id; best-effort, never throws if
  // the target is not currently rendered (e.g. on an unloaded comments page).
  function flashTo(elementId: string): void {
    const node = document.getElementById(elementId);
    if (node === null) return;
    node.scrollIntoView({ behavior: 'smooth', block: 'center' });
    node.classList.add('ring-2', 'ring-annotation-line');
    window.setTimeout(() => node.classList.remove('ring-2', 'ring-annotation-line'), 1200);
  }

  // Comment-first, annotation-second on one shared trace. If the annotation
  // fails after the comment lands, the comment simply stays a plain comment; we
  // surface an error and refresh the list, with no retry loop.
  async function submitAnnotation(body: string): Promise<void> {
    if (composer === null || detail === null || currentVersionId === null) return;
    setAnnotating(true);
    setAnnotateError(null);
    const traceId = newTrace();

    const commentResult = await createComment(supabase, {
      workspace_id: detail.post.workspace_id,
      entity_type: 'post',
      entity_id: detail.post.id,
      body,
      trace_id: traceId,
    });
    if (!commentResult.ok) {
      setAnnotating(false);
      setAnnotateError(commentResult.error.message);
      return;
    }

    const annotationResult = await annotationCreate(supabase, {
      kind: 'caption_span',
      postId: detail.post.id,
      postVersionId: currentVersionId,
      commentId: commentResult.data,
      captionStart: composer.start,
      captionEnd: composer.end,
      traceId,
    });
    if (!annotationResult.ok) {
      setAnnotating(false);
      setComposer(null);
      setAnnotateError(
        'Could not anchor the comment to the caption. It was posted as a plain comment.',
      );
      setCommentsRefresh((n) => n + 1);
      return;
    }

    setAnnotating(false);
    setComposer(null);
    await load(true);
    setCommentsRefresh((n) => n + 1);
  }

  async function handleTransition(to: Stage): Promise<void> {
    if (postId === undefined) return;
    setTransitioning(true);
    setActionError(null);
    const result = await stageTransition(supabase, {
      p_post_id: postId,
      p_to_stage: to,
      p_trace_id: newTrace(),
    });
    if (!result.ok) {
      setTransitioning(false);
      setActionError(friendlyTransitionError(result.error));
      return;
    }
    // Re-fetch so the stage badge and the set of available buttons update.
    await load(true);
    setTransitioning(false);
  }

  const backButton = (
    <Button size="lg" onClick={() => navigate('/pipeline')}>
      Back
    </Button>
  );

  if (loading) {
    return (
      <>
        <div className="flex items-center gap-3 h-14 px-4 md:px-6 border-b border-border">
          {backButton}
        </div>
        <div className="px-4 md:px-6 py-10 text-sm text-fg-3">Loading post</div>
      </>
    );
  }

  if (loadError !== null) {
    return (
      <>
        <div className="flex items-center gap-3 h-14 px-4 md:px-6 border-b border-border">
          {backButton}
        </div>
        <div className="px-4 md:px-6 mt-4">
          <div role="alert" className="rounded-xl border border-bad px-4 py-3 text-sm text-bad">
            Could not load this post. {loadError}
          </div>
        </div>
      </>
    );
  }

  if (notFound || detail === null) {
    return (
      <>
        <div className="flex items-center gap-3 h-14 px-4 md:px-6 border-b border-border">
          {backButton}
        </div>
        <EmptyState
          icon={<IconPipeline size={22} />}
          title="Post not found"
          description="This post may have been removed, or you may not have access to it."
          action={
            <Button variant="primary" size="lg" onClick={() => navigate('/pipeline')}>
              Back to pipeline
            </Button>
          }
        />
      </>
    );
  }

  const post = detail.post;
  const currentStage = post.stage as Stage;
  const targets: readonly Stage[] = STAGE_TRANSITIONS[currentStage] ?? [];
  const owner = post.owner_user_id.length > 0 ? post.owner_user_id : 'Unassigned';

  return (
    <>
      <div className="flex items-center gap-3 h-14 px-4 md:px-6 border-b border-border">
        {backButton}
        <h1 className="text-[15px] font-semibold truncate">{post.title}</h1>
        <span
          className={`ml-auto shrink-0 inline-flex items-center rounded-full border px-3 h-7 text-xs font-medium ${STAGE_BADGE[currentStage]}`}
        >
          {stageLabel(currentStage)}
        </span>
      </div>

      <div className="px-4 md:px-6 py-6 grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="md:col-span-2 flex flex-col gap-6">
          <section>
            <div className="text-xs font-medium uppercase tracking-wide text-fg-3 mb-2">
              Gallery
            </div>
            <PostGallery
              items={gallery}
              cache={cache}
              deps={deps}
              presignEnabled={presignEnabled}
            />
          </section>

          <section>
            <div className="text-xs font-medium uppercase tracking-wide text-fg-3 mb-2">
              Caption
            </div>
            {post.caption !== null && post.caption.trim() !== '' ? (
              <CaptionView
                caption={post.caption}
                annotations={highlights}
                onHighlightClick={(commentId) => flashTo(`comment-${commentId}`)}
                onAnnotate={handleAnnotate}
              />
            ) : (
              <p className="text-sm text-fg-3">No caption yet.</p>
            )}
            {annotateError !== null ? (
              <div
                role="alert"
                className="mt-3 rounded-md border border-bad px-3 py-2 text-sm text-bad"
              >
                {annotateError}
              </div>
            ) : null}
          </section>

          <section>
            <div className="text-xs font-medium uppercase tracking-wide text-fg-3 mb-2">
              Comments
            </div>
            {workspaceId !== null && postId !== undefined ? (
              <Comments
                workspaceId={workspaceId}
                entityType="post"
                entityId={postId}
                annotationsByCommentId={annotationsByCommentId}
                onAnnotationChipClick={(commentId) => flashTo(`caption-mark-${commentId}`)}
                refreshSignal={commentsRefresh}
              />
            ) : (
              <div className="rounded-xl border border-border bg-panel-2 px-4 py-8 text-center text-sm text-fg-3">
                Select a workspace to view comments.
              </div>
            )}
          </section>
        </div>

        <aside className="flex flex-col gap-6">
          <section>
            <div className="text-xs font-medium uppercase tracking-wide text-fg-3 mb-2">
              Actions
            </div>
            {targets.length > 0 ? (
              <div className="flex flex-col gap-2">
                {targets.map((target) => (
                  <Button
                    key={target}
                    size="lg"
                    variant={TRANSITION_VARIANT[target] ?? 'default'}
                    disabled={transitioning}
                    onClick={() => void handleTransition(target)}
                  >
                    {transitionLabel(currentStage, target)}
                  </Button>
                ))}
              </div>
            ) : (
              <p className="text-sm text-fg-3">No actions available.</p>
            )}
            {actionError !== null ? (
              <div
                role="alert"
                className="mt-3 rounded-md border border-bad px-3 py-2 text-sm text-bad"
              >
                {actionError}
              </div>
            ) : null}
          </section>

          <section>
            <div className="text-xs font-medium uppercase tracking-wide text-fg-3 mb-2">
              Details
            </div>
            <dl className="flex flex-col gap-3 text-sm">
              <div className="flex flex-col gap-1">
                <dt className="text-fg-3">Channel</dt>
                <dd className="flex flex-wrap gap-1.5">
                  <Chip label={humanize(post.platform)} />
                  <Chip label={humanize(post.format)} />
                </dd>
              </div>
              <div className="flex flex-col gap-1">
                <dt className="text-fg-3">Target date</dt>
                <dd className="tabular-nums">
                  {post.target_date !== null ? formatTargetDate(post.target_date) : 'Not set'}
                </dd>
              </div>
              <div className="flex flex-col gap-1">
                <dt className="text-fg-3">Owner</dt>
                <dd className="break-all">{owner}</dd>
              </div>
            </dl>
          </section>
        </aside>
      </div>

      <CaptionAnnotationComposer
        open={composer !== null}
        quote={composer?.quote ?? ''}
        submitting={annotating}
        onClose={() => {
          if (!annotating) setComposer(null);
        }}
        onSubmit={submitAnnotation}
      />
    </>
  );
}
