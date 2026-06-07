import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { Chip } from '@/components/ui/Chip';
import { EmptyState } from '@/components/ui/EmptyState';
import { IconPipeline } from '@/components/ui/icons';
import { supabase } from '@/lib/supabase';
import { useNewTrace } from '@/lib/trace-context';
import { getPost, STAGE_TRANSITIONS } from '@srtdio/posts';
import type { DomainError, PostDetail, Stage } from '@srtdio/posts';
import { stageTransition } from '@srtdio/rpc';

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

  const [detail, setDetail] = useState<PostDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  const [transitioning, setTransitioning] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

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
              Caption
            </div>
            {post.caption !== null && post.caption.trim() !== '' ? (
              <p className="text-sm leading-relaxed whitespace-pre-wrap text-fg">{post.caption}</p>
            ) : (
              <p className="text-sm text-fg-3">No caption yet.</p>
            )}
          </section>

          <section>
            <div className="text-xs font-medium uppercase tracking-wide text-fg-3 mb-2">
              Comments
            </div>
            <div className="rounded-xl border border-border bg-panel-2 px-4 py-8 text-center text-sm text-fg-3">
              Comments coming soon
            </div>
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
    </>
  );
}
