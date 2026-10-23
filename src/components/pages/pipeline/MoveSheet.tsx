// The mobile move sheet: a long-press on a pipeline card opens this bottom sheet
// to move the post to another stage. It is presentational only - it never calls
// the stage-transition proc itself; selecting a valid target calls up to the
// page's single move handler (PipelinePage owns the proc call + toast + regroup).
//
// Rows mirror the client-side transition map (canTransition) and the viewer's
// role (canRoleMove): a client only ever sees the Approved and Rejected rows;
// the agency side sees every stage. Targets that are legal from the post's
// current stage for this role are enabled, the rest are disabled with their
// reason: "Not allowed from {stage}" when the stage map blocks the row, the
// role line when only the role does. While the role is unknown the rows wait
// (busy), and a failed role read says so with Retry rather than blaming the
// role. The server proc remains the real guard; this is UI gating only.
//
// Approved asks first (decision 22): picking it swaps the rows and Cancel for
// the shared approve confirm, as the chat post sheet swaps its footer. Only
// Confirm calls the move handler; Back returns to the rows and Cancel, the
// backdrop and Escape close with nothing sent. Other targets move at once.

import { useEffect } from 'react';
import type { ReactElement } from 'react';
import { Sheet } from '@/components/ui/Sheet';
import { Button } from '@/components/ui/Button';
import { ApproveConfirm, approveTargetDate } from '@/components/ui/ApproveConfirm';
import { cn } from '@/lib/cn';
import { useWorkspace } from '@/lib/workspace-context';
import { StageDot, moveBlockedReason, stageLabel } from '@/components/pages/pipeline/stage-meta';
import {
  useApproveGate,
  type ApproveGate,
  type GateState,
} from '@/components/pages/pipeline/approve-gate';
import { isAgencySide, isClient } from '@/components/pages/pcs/roles';
import {
  canRoleMove,
  onBehalfConfirmLine,
  roleMayTarget,
} from '@/components/pages/pcs/stage-actions';
import {
  ROLE_READ_ERROR,
  ROLE_READ_PENDING,
  type RoleStatus,
} from '@/components/pages/pipeline/member-role';
import { STAGE_TRANSITIONS } from '@srtdio/posts';
import type { PipelinePost, Stage } from '@srtdio/posts';

/** All workflow stages in the locked transition-map order. */
const STAGES = Object.keys(STAGE_TRANSITIONS) as Stage[];

export interface MoveSheetProps {
  open: boolean;
  /** The post being moved; null renders nothing (closed). */
  post: PipelinePost | null;
  onClose: () => void;
  /** Calls up to the page's single move handler; never the proc directly. */
  onMove: (postId: string, toStage: Stage) => void;
  /** Disables targets while a move is in flight for this post. */
  busy?: boolean;
  /** The viewer's workspace role (the page's role read); null is read-only. */
  role: string | null;
  /**
   * Where the role read stands. While 'loading' every row is disabled and the
   * sheet says it is checking; on 'error' it says "Couldn't check your access."
   * with Retry instead of blaming the role. Default 'ready'.
   */
  roleStatus?: RoleStatus;
  /** Re-runs the role read (the error state's Retry). */
  onRetryRole?: () => void;
}

/**
 * Gates the page's move handler behind the approve confirm and resolves the
 * confirm's target date from data already loaded (the post row and
 * the workspace context). No read of its own; slide count is not loaded on the
 * pipeline, so the confirm leaves that clause out.
 */
export function MoveSheet(props: MoveSheetProps): ReactElement | null {
  const { onMove, busy = false } = props;
  const { workspaces, workspaceId, workspaceName } = useWorkspace();
  const { gate, state } = useApproveGate(onMove);
  const postId = props.post?.id ?? null;
  // A closed or re-targeted sheet forgets its confirm.
  useEffect(() => {
    gate.cancel();
  }, [gate, props.open, postId]);
  // A move that settles with the sheet still open (a failure, toasted by the
  // page) re-arms Confirm so the user can retry or go Back.
  useEffect(() => {
    if (!busy) gate.settle();
  }, [gate, busy]);
  const timeZone = workspaces.find((w) => w.id === workspaceId)?.timezone ?? 'UTC';
  return (
    <MoveSheetView
      {...props}
      gate={gate}
      gateState={state}
      targetDate={props.post !== null ? approveTargetDate(props.post.target_date, timeZone) : ''}
      brand={workspaceName}
    />
  );
}

export interface MoveSheetViewProps extends Omit<MoveSheetProps, 'onMove'> {
  gate: ApproveGate;
  gateState: GateState;
  /** Short target date for the approve confirm; empty leaves the clause out. */
  targetDate: string;
  /** The workspace's brand name for the on-behalf line; null falls back to "the approvers". */
  brand?: string | null;
}

/** The stages this role sees as rows: a client only Approved and Rejected. */
export function moveTargets(role: string | null, currentStage: Stage): Stage[] {
  const others = STAGES.filter((stage) => stage !== currentStage);
  return isClient(role) ? others.filter((stage) => roleMayTarget(role, stage)) : others;
}

/**
 * Bottom sheet listing every OTHER stage (for a client, only Approved and
 * Rejected) as a move target. Reuses the shared
 * Sheet primitive (bottom on mobile, centered on desktop), the StageDot/label
 * metadata, and the canTransition mirror. Every row is a >=44px touch target;
 * colour comes only through token-backed classes, so light/dark track index.css.
 * Hookless, so the tree is unit tested by walking it.
 */
export function MoveSheetView({
  open,
  post,
  onClose,
  busy = false,
  gate,
  gateState,
  targetDate,
  role,
  brand = null,
  roleStatus = 'ready',
  onRetryRole,
}: MoveSheetViewProps): ReactElement | null {
  if (post === null) {
    return null;
  }
  // posts.stage is a DB text column (typed string); it is one of the Stage values.
  const currentStage = post.stage as Stage;
  const targets = moveTargets(role, currentStage);
  const confirming = gateState.pendingId === post.id;
  // Until the role is known, no row is enabled and no row names a reason.
  const roleKnown = roleStatus === 'ready';
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Move post"
      footer={
        confirming ? (
          <ApproveConfirm
            postTitle={post.title}
            mediaCount={null}
            targetDate={targetDate}
            busy={busy || gateState.sent}
            onBack={gate.cancel}
            onConfirm={gate.confirm}
          />
        ) : (
          <Button variant="ghost" size="lg" className="ml-auto" onClick={onClose}>
            Cancel
          </Button>
        )
      }
    >
      <div className="flex flex-col gap-3">
        <div>
          <div
            data-move-title=""
            className="line-clamp-2 text-sm font-medium [overflow-wrap:anywhere]"
          >
            {post.title}
          </div>
          <div className="mt-1 flex items-center gap-1.5 text-xs text-fg-3">
            <span>Currently in</span>
            <StageDot stage={currentStage} />
            <span>{stageLabel(currentStage)}</span>
          </div>
        </div>
        {confirming && isAgencySide(role) ? (
          <p data-approve-on-behalf="" className="text-sm text-fg-2">
            {onBehalfConfirmLine(brand)}
          </p>
        ) : null}
        {!confirming && roleStatus === 'loading' ? (
          <p data-role-pending="" role="status" className="text-sm text-fg-3">
            {ROLE_READ_PENDING}
          </p>
        ) : null}
        {!confirming && roleStatus === 'error' ? (
          <div
            data-role-error=""
            role="alert"
            className="flex items-center gap-3 rounded-lg border border-border bg-panel-2 px-3 py-2"
          >
            <p className="flex-1 text-sm text-fg-2">{ROLE_READ_ERROR}</p>
            <Button size="lg" onClick={() => onRetryRole?.()}>
              Retry
            </Button>
          </div>
        ) : null}
        {confirming ? null : (
          <ul className="flex flex-col gap-1" aria-busy={roleStatus === 'loading'}>
            {targets.map((target) => {
              const allowed = roleKnown && canRoleMove(role, currentStage, target);
              const reason =
                allowed || !roleKnown ? null : moveBlockedReason(role, currentStage, target);
              return (
                <li key={target}>
                  <button
                    type="button"
                    disabled={!allowed || busy}
                    aria-disabled={!allowed}
                    data-role-pending-row={roleKnown ? undefined : ''}
                    onClick={() => gate.request(post.id, target)}
                    className={cn(
                      'flex w-full min-h-[44px] items-center gap-2.5 rounded-lg px-3 text-left transition-colors',
                      'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                      allowed
                        ? 'text-fg hover:bg-panel-2 disabled:opacity-50'
                        : roleKnown
                          ? 'cursor-not-allowed text-fg-3'
                          : 'cursor-wait text-fg-3 opacity-60',
                    )}
                  >
                    <StageDot stage={target} />
                    <span className="text-sm font-medium">{stageLabel(target)}</span>
                    {reason !== null ? (
                      <span data-blocked-reason="" className="ml-auto text-right text-xs text-fg-3">
                        {reason}
                      </span>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Sheet>
  );
}
