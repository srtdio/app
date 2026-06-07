import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { Comments } from '@/components/comments/Comments';
import { EmptyState } from '@/components/ui/EmptyState';
import { IconBriefs } from '@/components/ui/icons';
import { BRIEF_STATUS, isBriefClosed } from '@/components/pages/BriefCard';
import { supabase } from '@/lib/supabase';
import { useNewTrace } from '@/lib/trace-context';
import { useWorkspace } from '@/lib/workspace-context';
import { getBrief } from '@srtdio/briefs';
import type { BriefWithLinkedCount, DomainError } from '@srtdio/briefs';
import { briefClose } from '@srtdio/rpc';

// Status badge styling. Open reads as the active/good state, Closed as muted;
// both use theme tokens so light/dark parity is automatic. The status values
// themselves come from BRIEF_STATUS (pinned to the @srtdio/briefs type), never
// inline literals.
const STATUS_BADGE: Record<string, string> = {
  [BRIEF_STATUS.open]: 'border-good text-good',
  [BRIEF_STATUS.closed]: 'border-border text-fg-3',
};

function statusLabel(status: string): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

// Render an ISO date as date only (no time), matching the Briefs reference.
function formatTargetDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// reference_links is stored as jsonb; defensively coerce to a list of non-empty
// strings so a malformed value never crashes the read-only view.
function toLinks(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim() !== '');
}

// Map the proc's domain errors to friendly, inline copy. The proc owns the
// policy: forbidden_role when the caller lacks brief.close, invalid_payload for
// a malformed request.
function friendlyCloseError(error: DomainError): string {
  switch (error.code) {
    case 'forbidden_role':
      return 'You do not have permission to close this brief.';
    case 'invalid_payload':
      return 'That request was not valid. Please try again.';
    case 'workspace_member_only':
      return 'You must be a member of this workspace to close this brief.';
    default:
      return 'Something went wrong. Please try again.';
  }
}

export function BriefDetailPage() {
  const { briefId } = useParams();
  const navigate = useNavigate();
  const newTrace = useNewTrace();
  const { workspaceId } = useWorkspace();

  const [detail, setDetail] = useState<BriefWithLinkedCount | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  const [confirming, setConfirming] = useState(false);
  const [closing, setClosing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // `silent` skips the full-page loading flip so the post-close refetch updates
  // the badge and the action in place rather than blanking the screen.
  const load = useCallback(
    async (silent = false): Promise<void> => {
      if (briefId === undefined) {
        setLoading(false);
        setNotFound(true);
        return;
      }
      if (!silent) setLoading(true);
      setLoadError(null);
      const result = await getBrief(supabase, briefId);
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
    [briefId],
  );

  useEffect(() => {
    void load();
  }, [load]);

  async function handleClose(): Promise<void> {
    if (briefId === undefined) return;
    setClosing(true);
    setActionError(null);
    const result = await briefClose(supabase, { p_brief_id: briefId, p_trace_id: newTrace() });
    if (!result.ok) {
      setClosing(false);
      setActionError(friendlyCloseError(result.error));
      return;
    }
    // Reflect server truth: re-fetch so the badge flips to Closed and the Close
    // action disappears. No optimistic UI.
    await load(true);
    setClosing(false);
    setConfirming(false);
  }

  const backButton = (
    <Button size="lg" onClick={() => navigate('/briefs')}>
      Back
    </Button>
  );

  if (loading) {
    return (
      <>
        <div className="flex items-center gap-3 h-14 px-4 md:px-6 border-b border-border">
          {backButton}
        </div>
        <div className="px-4 md:px-6 py-10 text-sm text-fg-3">Loading brief</div>
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
            Could not load this brief. {loadError}
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
          icon={<IconBriefs size={22} />}
          title="Brief not found"
          description="This brief may have been removed, or you may not have access to it."
          action={
            <Button variant="primary" size="lg" onClick={() => navigate('/briefs')}>
              Back to briefs
            </Button>
          }
        />
      </>
    );
  }

  const brief = detail.brief;
  const closed = isBriefClosed(brief);
  const links = toLinks(brief.reference_links);

  return (
    <>
      <div className="flex items-center gap-3 h-14 px-4 md:px-6 border-b border-border">
        {backButton}
        <h1 className="text-[15px] font-semibold truncate">{brief.title}</h1>
        <span
          className={`ml-auto shrink-0 inline-flex items-center rounded-full border px-3 h-7 text-xs font-medium ${
            STATUS_BADGE[brief.status] ?? 'border-border text-fg-3'
          }`}
        >
          {statusLabel(brief.status)}
        </span>
      </div>

      <div className="px-4 md:px-6 py-6 grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="md:col-span-2 flex flex-col gap-6">
          <section>
            <div className="text-xs font-medium uppercase tracking-wide text-fg-3 mb-2">
              Objective
            </div>
            <p className="text-sm leading-relaxed whitespace-pre-wrap text-fg">{brief.objective}</p>
          </section>

          {brief.brand_requirements !== null && brief.brand_requirements.trim() !== '' ? (
            <section>
              <div className="text-xs font-medium uppercase tracking-wide text-fg-3 mb-2">
                Brand requirements
              </div>
              <p className="text-sm leading-relaxed whitespace-pre-wrap text-fg">
                {brief.brand_requirements}
              </p>
            </section>
          ) : null}

          {links.length > 0 ? (
            <section>
              <div className="text-xs font-medium uppercase tracking-wide text-fg-3 mb-2">
                Reference links
              </div>
              <ul className="flex flex-col gap-1.5">
                {links.map((link) => (
                  <li key={link}>
                    <a
                      href={link}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center min-h-[44px] text-sm text-accent hover:underline break-all"
                    >
                      {link}
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <section>
            <div className="text-xs font-medium uppercase tracking-wide text-fg-3 mb-2">
              Comments
            </div>
            {workspaceId !== null && briefId !== undefined ? (
              <Comments workspaceId={workspaceId} entityType="brief" entityId={briefId} />
            ) : (
              <div className="rounded-xl border border-border bg-panel-2 px-4 py-8 text-center text-sm text-fg-3">
                Select a workspace to view comments.
              </div>
            )}
          </section>
        </div>

        <aside className="flex flex-col gap-6">
          {!closed ? (
            <section>
              <div className="text-xs font-medium uppercase tracking-wide text-fg-3 mb-2">
                Actions
              </div>
              {confirming ? (
                <div className="flex flex-col gap-2">
                  <p className="text-sm text-fg-2">Close this brief?</p>
                  <div className="flex items-center gap-2">
                    <Button size="lg" disabled={closing} onClick={() => setConfirming(false)}>
                      Cancel
                    </Button>
                    <Button
                      size="lg"
                      variant="primary"
                      disabled={closing}
                      onClick={() => void handleClose()}
                    >
                      {closing ? 'Closing' : 'Close brief'}
                    </Button>
                  </div>
                </div>
              ) : (
                <Button size="lg" className="w-full" onClick={() => setConfirming(true)}>
                  Close brief
                </Button>
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
          ) : null}

          <section>
            <div className="text-xs font-medium uppercase tracking-wide text-fg-3 mb-2">
              Details
            </div>
            <dl className="flex flex-col gap-3 text-sm">
              {brief.format_requested !== null && brief.format_requested.trim() !== '' ? (
                <div className="flex flex-col gap-1">
                  <dt className="text-fg-3">Format requested</dt>
                  <dd className="text-fg">{brief.format_requested}</dd>
                </div>
              ) : null}
              <div className="flex flex-col gap-1">
                <dt className="text-fg-3">Target date</dt>
                <dd className="tabular-nums">
                  {brief.target_date !== null ? formatTargetDate(brief.target_date) : 'Not set'}
                </dd>
              </div>
              <div className="flex flex-col gap-1">
                <dt className="text-fg-3">Linked posts</dt>
                <dd className="tabular-nums">{detail.linked_posts_count}</dd>
              </div>
              <div className="flex flex-col gap-1">
                <dt className="text-fg-3">Created by</dt>
                <dd className="break-all">{brief.created_by}</dd>
              </div>
            </dl>
          </section>
        </aside>
      </div>
    </>
  );
}
