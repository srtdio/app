// The move sheet: the card's ⋯ or a long-press opens this sheet to move the
// post. It is presentational only - it never calls the stage-transition proc
// itself; picking an action calls up to the page's move handler (PipelinePage
// owns the confirms, the proc call, the Undo strip and the regroup).
//
// It lists ONLY the moves this viewer can make from the post's stage (the
// client-side transition map and canRoleMove), as one-line actions: "Send for
// review", "Approve" (approvers) or "Approve on their behalf" (creators),
// "Park" and "Reject". No helper lines, no greyed rows and no Draft row.
// While the role is unknown the sheet says it is checking, and a failed role
// read says so with Retry. The server proc remains the real guard.
//
// Approve asks first (decision 22): for an approver, picking it swaps the
// actions for the shared approve confirm (the question asked once; the title
// stays in the header only); for a creator it opens the on-behalf sheet (pick
// the approver), whose Approve carries that approver into the move. Reject,
// Park and Send for review from Draft ask first through the page's confirm
// sheet. The X closes the sheet; there is no Cancel button.

import { useEffect } from 'react';
import type { ReactElement } from 'react';
import { Sheet } from '@/components/ui/Sheet';
import { Button } from '@/components/ui/Button';
import { ApproveConfirm, approveTargetDate } from '@/components/ui/ApproveConfirm';
import { OnBehalfApproveSheet, type ApproverOption } from '@/components/ui/OnBehalfApproveSheet';
import { cn } from '@/lib/cn';
import { useWorkspace } from '@/lib/workspace-context';
import { StageDot, stageLabel } from '@/components/pages/pipeline/stage-meta';
import {
  useApproveGate,
  type ApproveGate,
  type GateState,
  type MoveFn,
} from '@/components/pages/pipeline/approve-gate';
import { isAgencySide, isClient } from '@/components/pages/pcs/roles';
import { canRoleMove } from '@/components/pages/pcs/stage-actions';
import { useWorkspaceApprovers } from '@/components/pages/pcs/use-approvers';
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
  /**
   * Calls up to the page's single move handler; never the proc directly. An
   * on-behalf approve passes the picked approver.
   */
  onMove: MoveFn;
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
  const approvers = useWorkspaceApprovers(workspaceId);
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
      approvers={approvers}
    />
  );
}

export interface MoveSheetViewProps extends Omit<MoveSheetProps, 'onMove'> {
  gate: ApproveGate;
  gateState: GateState;
  /** Short target date for the approve confirm; empty leaves the clause out. */
  targetDate: string;
  /** The workspace's brand name for the on-behalf picker ("Name (Brand)"). */
  brand?: string | null;
  /** The workspace's approvers for the on-behalf picker. */
  approvers?: readonly ApproverOption[];
}

/** One move the viewer can make: its target, label and tone. One line, no helper. */
export interface MoveAction {
  to: Stage;
  label: string;
  tone: 'default' | 'bad';
}

/**
 * The moves this role can make from `currentStage`, in transition-map order,
 * as actions. Only legal, role-allowed targets appear; Draft is never one.
 * An unknown role gets none. Pure.
 */
export function moveActions(role: string | null, currentStage: Stage): MoveAction[] {
  const out: MoveAction[] = [];
  for (const to of STAGES) {
    if (to === currentStage || to === 'draft' || !canRoleMove(role, currentStage, to)) continue;
    if (to === 'review') {
      out.push({ to, label: 'Send for review', tone: 'default' });
    } else if (to === 'approved') {
      out.push({
        to,
        label: isClient(role) ? 'Approve' : 'Approve on their behalf',
        tone: 'default',
      });
    } else if (to === 'parked') {
      out.push({ to, label: 'Park', tone: 'default' });
    } else if (to === 'rejected') {
      out.push({ to, label: 'Reject', tone: 'bad' });
    }
  }
  return out;
}

/**
 * The sheet: the post title in the header (the X closes it), the post's
 * current stage, and the viewer's moves as 44px+ action rows. Reuses the
 * shared Sheet primitive (bottom on mobile, centered on desktop); colour comes
 * only through token-backed classes, so light/dark track index.css. A
 * creator's Approve on their behalf hides this sheet behind the on-behalf
 * sheet; its Cancel brings the actions back. Hookless, so the tree is unit
 * tested by walking it.
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
  approvers = [],
  roleStatus = 'ready',
  onRetryRole,
}: MoveSheetViewProps): ReactElement | null {
  if (post === null) {
    return null;
  }
  // posts.stage is a DB text column (typed string); it is one of the Stage values.
  const currentStage = post.stage as Stage;
  const confirming = gateState.pendingId === post.id;
  const onBehalf = isAgencySide(role);
  const actions = roleStatus === 'ready' ? moveActions(role, currentStage) : [];
  return (
    <>
      <Sheet
        open={open && !(confirming && onBehalf)}
        onClose={onClose}
        title={post.title}
        {...(confirming && !onBehalf
          ? {
              footer: (
                <ApproveConfirm
                  postTitle={null}
                  mediaCount={null}
                  targetDate={targetDate}
                  busy={busy || gateState.sent}
                  onBack={gate.cancel}
                  onConfirm={() => gate.confirm()}
                />
              ),
            }
          : {})}
      >
        <div className="flex flex-col gap-3">
          <div data-move-current="" className="flex items-center gap-1.5 text-sm text-fg-3">
            <span>Currently in</span>
            <StageDot stage={currentStage} />
            <span>{stageLabel(currentStage)}</span>
          </div>
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
          {confirming || actions.length === 0 ? null : (
            <ul className="-mx-1 flex flex-col">
              {actions.map((action) => (
                <li key={action.to}>
                  <button
                    type="button"
                    disabled={busy}
                    data-move-action={action.to}
                    onClick={() => gate.request(post.id, action.to)}
                    className={cn(
                      'flex w-full min-h-[44px] items-center rounded-lg px-3 py-2 text-left transition-colors',
                      'hover:bg-panel-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50',
                    )}
                  >
                    <span
                      className={cn(
                        'text-sm font-medium',
                        action.tone === 'bad' ? 'text-bad' : 'text-fg',
                      )}
                    >
                      {action.label}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Sheet>
      {onBehalf ? (
        <OnBehalfApproveSheet
          open={open && confirming}
          approvers={approvers}
          brand={brand}
          busy={busy || gateState.sent}
          onCancel={gate.cancel}
          onConfirm={(onBehalfOf) => gate.confirm(onBehalfOf)}
        />
      ) : null}
    </>
  );
}
