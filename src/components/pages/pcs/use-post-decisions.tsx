// The post decisions, one hook for every surface that decides a post: Post
// detail and the chat post sheet both call usePostDecisions, so the two can
// never offer different actions (PR B, decisions). It owns the whole flow:
//   - the decision row's model (PostDecisionBar on phone, PostDecisionRow at
//     the right of the detail header on laptop): approvers get Reject and
//     Approve; creators get one main button, "Send for review" (draft, parked,
//     rejected) or "Send for review again" (review);
//   - the creator's other moves as ⋯ menu rows: Approve on their behalf (the
//     approver picker), Reject and Park;
//   - the confirms: Approve asks first (Cancel / Approve); Reject and Park ask
//     for an optional reason, then show the new stage at once behind the
//     UNDO_MS Undo strip and commit when it ends; "Send for review again" with
//     open comments asks "{n} comments are still open. Send anyway?" and never
//     blocks.
// Role rules come only from stage-actions (visibleStageActions, which mirrors
// the stage_transition proc), so a button the server would refuse never shows;
// a move a person cannot make is hidden, never disabled.

import { mark } from '@/lib/perf-marks';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Sheet } from '@/components/ui/Sheet';
import { Textarea } from '@/components/ui/Textarea';
import { useOptionalToast } from '@/components/ui/toast';
import { ApproveConfirm, APPROVE_CONFIRM_TITLE } from '@/components/ui/ApproveConfirm';
import { OnBehalfApproveSheet } from '@/components/ui/OnBehalfApproveSheet';
import { IconCheck, IconPause, IconX } from '@/components/ui/icons';
import { runCreateCommentBatch } from '@/components/comments/Comments';
import { runPostReadyNotify } from '@/components/pages/pcs/PostReadyNotice';
import { isAgencySide, isClient } from '@/components/pages/pcs/roles';
import {
  stageReasonComment,
  stageReasonConfirm,
  visibleStageActions,
  type StageAction,
  type StageReasonConfirmCopy,
} from '@/components/pages/pcs/stage-actions';
import { runStageMoveCommit } from '@/components/pages/pcs/stage-move-commit';
import { POST_APPROVED_LOCKED } from '@/components/pages/pcs/gallery-transforms';
import { useWorkspaceApprovers } from '@/components/pages/pcs/use-approvers';
import {
  decisionBarOrder,
  SEND_AGAIN_LABEL,
  type DecisionModel,
} from '@/components/pages/pcs/PostDecisionBar';
import type { PostMoveRow } from '@/components/pages/pcs/PostActionSheet';
import {
  useApproveGate,
  type ApproveGate,
  type GateState,
} from '@/components/pages/pipeline/approve-gate';
import { dispatchInductionRefresh, INDUCTION_KEYS } from '@/lib/induction';
import { errorText } from '@/lib/error-copy';
import { friendlyTransitionError } from '@/lib/post-transition-errors';
import { logger } from '@/lib/logger';
import { supabase } from '@/lib/supabase';
import { useNewTrace } from '@/lib/trace-context';
import { useUndoableAction } from '@/lib/use-undoable-action';
import { createComment } from '@srtdio/comments';
import { stageTransition as stageMove, type Stage } from '@srtdio/posts';
import { stageTransition } from '@srtdio/rpc';
import type { DomainError } from '@srtdio/rpc';

// A refused RPC carries a DomainError ({ code, message }); a thrown transport
// error does not, and reads as the unknown line.
function isDomainError(error: unknown): error is DomainError {
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { code?: unknown }).code === 'string' &&
    typeof (error as { message?: unknown }).message === 'string'
  );
}

/**
 * Flow B 37 / 41: a failed stage move or edit on a post in plain words,
 * "Couldn't {action}. {reason}". The approved lock and the stage proc's known
 * refusals get their own reason; anything else (a thrown transport error
 * included) the retry line. Never the raw text. Pure.
 */
export function postActionErrorCopy(error: unknown, action = 'move the post'): string {
  if (isDomainError(error) && !error.message.includes(POST_APPROVED_LOCKED)) {
    if (
      error.code === 'forbidden_role' ||
      error.code === 'invalid_stage_transition' ||
      error.code === 'workspace_member_only'
    ) {
      return friendlyTransitionError(error, action);
    }
  }
  return errorText(action, error);
}

/** The action a failed "Send for review again" names. */
const SEND_AGAIN_ACTION = 'send the post for review';

/**
 * Flow B 33 / 41: a failed "Send for review again" (post_ready_notify) in plain
 * words, from the proc's raised message. Pure.
 */
export function sendAgainErrorCopy(message: string | null): string {
  if (message === 'invalid_stage') {
    return `Couldn't ${SEND_AGAIN_ACTION}. Someone else changed it. Refresh to see the latest.`;
  }
  return errorText(SEND_AGAIN_ACTION, message);
}

/** Flow B 33: the toast after a landed "Send for review again". */
export const SENT_AGAIN_TOAST = 'Sent for review again';

/**
 * Flow B 31: the creator's on-behalf approve row in the ⋯ menu. Always
 * "Approve on their behalf", whatever the workspace is called.
 */
export const APPROVE_ON_BEHALF_LABEL = 'Approve on their behalf';

/** The Park row's line in the ⋯ menu. */
const PARK_ROW_SUB = 'Keeps it aside. You can send it for review later.';

/**
 * Flow B 33: the confirm before "Send for review again" while comments are
 * still open. Open comments never block the send; they only ask first.
 */
export function sendAnywayTitle(openCount: number): string {
  return openCount === 1
    ? '1 comment is still open. Send anyway?'
    : `${openCount} comments are still open. Send anyway?`;
}
export const SEND_ANYWAY_LABEL = 'Send anyway';

/**
 * Flow B 40 / spec B6: the reject confirm's reason field label. The "optional,
 * goes to the comments" idea is said once, here; the body and the menu row
 * no longer repeat it.
 */
export const REJECT_REASON_LABEL = 'Reason (optional)';
export function rejectConfirmBody(creatorName: string | null): string {
  const first = creatorName?.trim().split(/\s+/)[0] ?? '';
  return `${first !== '' ? first : 'The creator'} gets it back to rework.`;
}

/** Spec B5: the approver's line above Approve / Reject while in review. */
export const CLIENT_REVIEW_NOTE = 'Review and approve one post at a time.';

/**
 * The approve confirm (decision 22, spec C1): the shared Sheet (translateY
 * axis) titled "Approve this post?", one line "{n} slides · due {date}" (each
 * part only when known; never the post title), then Cancel / Approve. The
 * confirm sits in the body, not the footer, so no empty band shows above it.
 * Open while the approve waits on a confirm or is in flight; a failure keeps
 * it open with the error and Approve re-armed. Cancel, the close button, the
 * backdrop and Escape send nothing. Hookless, so it is unit tested by walking
 * the tree.
 */
export function PcsApproveConfirm(props: {
  gate: ApproveGate;
  gateState: GateState;
  /** Slides in the loaded gallery; null leaves the clause out. */
  mediaCount: number | null;
  /** The due day ("20 Jul"), or '' to leave it out. */
  targetDate: string;
  busy: boolean;
  error: string | null;
}) {
  const { gate, gateState } = props;
  return (
    <Sheet open={gateState.pendingId !== null} onClose={gate.cancel} title={APPROVE_CONFIRM_TITLE}>
      <ApproveConfirm
        mode="summary"
        postTitle={null}
        mediaCount={props.mediaCount}
        targetDate={props.targetDate}
        error={props.error}
        busy={props.busy || gateState.sent}
        onBack={gate.cancel}
        onConfirm={gate.confirm}
        induction={INDUCTION_KEYS.postApproveConfirm}
      />
    </Sheet>
  );
}

/**
 * The reject / park confirm (W2): the shared Sheet with an optional reason that
 * goes to the comments, Cancel (ghost, left) and Reject / Park. Confirm hands
 * off to the hook, which shows the new stage at once behind an Undo toast and
 * only sends the move when the window ends. Hookless, so it is unit tested by
 * walking the tree.
 */
export function StageReasonConfirm(props: {
  copy: StageReasonConfirmCopy | null;
  reason: string;
  onReasonChange: (reason: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
  /** Flow B 40: the line under the title (reject: who gets it back), or none. */
  body?: string | null;
  /** The reason field's label; the shared park / reject label when absent. */
  label?: string;
  /** A quiet line under the field (reject: "Goes to the comments."), or none. */
  helper?: string | null;
  /** Reject is red; Park uses the default button. */
  destructive?: boolean;
}) {
  const { copy } = props;
  const label = props.label ?? REJECT_REASON_LABEL;
  const body = props.body ?? null;
  const helper = props.helper ?? null;
  return (
    <Sheet
      open={copy !== null}
      onClose={props.onCancel}
      title={copy?.title ?? ''}
      // FT12: a typed reason is unsaved input: Esc, X, the backdrop and system
      // Back all ask before dropping it.
      dirty={props.reason.trim() !== ''}
      discard={{ title: 'Discard your reason?', message: 'Your reason will be lost.' }}
      footer={
        <>
          <Button variant="ghost" className="ml-auto" onClick={props.onCancel}>
            Cancel
          </Button>
          <Button
            variant={props.destructive === true ? 'danger' : 'default'}
            data-stage-confirm=""
            onClick={props.onConfirm}
          >
            {copy?.confirmLabel ?? ''}
          </Button>
        </>
      }
    >
      {body !== null ? (
        <p data-stage-confirm-body="" className="mb-3 text-base text-fg-2">
          {body}
        </p>
      ) : null}
      <label className="flex flex-col gap-2">
        <span className="text-base text-fg-2">{label}</span>
        <Textarea
          aria-label={label}
          value={props.reason}
          onChange={(event) => props.onReasonChange(event.target.value)}
        />
        {helper !== null ? (
          <span data-stage-confirm-helper="" className="text-sm text-fg-3">
            {helper}
          </span>
        ) : null}
      </label>
    </Sheet>
  );
}

/**
 * The decision row's model for a viewer in `role` on a post in `stage`, or
 * null when there is nothing to decide. Approvers (client): their legal
 * moves (Reject and Approve in review, Reject on an approved post). Creators
 * (agency side): in review the one "Send for review again"; elsewhere "Send
 * for review" when that move is legal. Pure.
 */
function decisionModelFor(args: {
  stage: Stage;
  role: string | null;
  /** True while "Send for review again" is in flight (the one disabled state). */
  sending: boolean;
  onPick: (to: Stage) => void;
  onSendAgain: () => void;
}): DecisionModel | null {
  const actions = visibleStageActions(args.stage, args.role);
  if (isClient(args.role)) {
    return actions.length > 0 || args.stage === 'review'
      ? { kind: 'approver', actions, onPick: args.onPick }
      : null;
  }
  if (!isAgencySide(args.role)) return null;
  if (args.stage === 'review') {
    return {
      kind: 'creator',
      label: SEND_AGAIN_LABEL,
      disabled: args.sending,
      helper: null,
      onPress: args.onSendAgain,
    };
  }
  const review = actions.find((action) => action.to === 'review') ?? null;
  return review !== null
    ? {
        kind: 'creator',
        label: review.label,
        disabled: false,
        helper: null,
        onPress: () => args.onPick('review'),
      }
    : null;
}

/**
 * Flow B 31: the creator's other moves as ⋯ menu rows, in stage-machine order.
 * "Approve on their behalf" opens the approver picker; Reject and Park open
 * their reason confirms. Approvers get none (their moves are in the row). Pure.
 */
function decisionMoveRows(args: {
  stage: Stage;
  role: string | null;
  onPick: (to: Stage) => void;
  onApproveOnBehalf: () => void;
}): PostMoveRow[] {
  if (!isAgencySide(args.role)) return [];
  return visibleStageActions(args.stage, args.role)
    .filter((action: StageAction) => action.to !== 'review')
    .map((action): PostMoveRow => {
      if (action.to === 'approved') {
        return {
          key: 'approved',
          icon: IconCheck,
          label: APPROVE_ON_BEHALF_LABEL,
          onPick: args.onApproveOnBehalf,
        };
      }
      if (action.to === 'rejected') {
        return {
          key: 'rejected',
          icon: IconX,
          label: action.label,
          danger: true,
          onPick: () => args.onPick('rejected'),
        };
      }
      return {
        key: action.to,
        icon: IconPause,
        label: action.label,
        sub: PARK_ROW_SUB,
        onPick: () => args.onPick(action.to),
      };
    });
}

/**
 * Every decision a viewer gets, as labels: the row's buttons in screen order
 * and the ⋯ menu's move rows. The one answer both surfaces render, so the
 * parity tests read it. Pure.
 */
export function postDecisionLabels(
  stage: Stage,
  role: string | null,
): { row: string[]; menu: string[] } {
  const noop = (): void => {};
  const model = decisionModelFor({ stage, role, sending: false, onPick: noop, onSendAgain: noop });
  const row =
    model === null
      ? []
      : model.kind === 'approver'
        ? decisionBarOrder(model.actions).map((action) => action.label)
        : [model.label];
  const menu = decisionMoveRows({ stage, role, onPick: noop, onApproveOnBehalf: noop }).map(
    (r) => r.label,
  );
  return { row, menu };
}

/**
 * Open top-level comments on a post (live, unresolved threads, checkpoints
 * included): the count the Post detail chip reads, for a surface without the
 * live comment list. A failed read counts 0 (the send never blocks).
 */
async function countOpenThreads(workspaceId: string, postId: string): Promise<number> {
  try {
    const { count, error } = await supabase
      .from('comments')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId)
      .eq('entity_type', 'post')
      .eq('entity_id', postId)
      .is('parent_comment_id', null)
      .is('resolved_at', null)
      .is('deleted_at', null);
    if (error !== null) return 0;
    return count ?? 0;
  } catch {
    return 0;
  }
}

interface PostDecisionsInput {
  postId: string | undefined;
  /** The stage the server last reported; null until the post has loaded. */
  stage: Stage | null;
  /** The viewer's workspace role (null: unknown, so nothing is offered). */
  role: string | null;
  /** False while nothing may be decided (an old version or a compare on screen). */
  enabled: boolean;
  workspaceId: string | null;
  /** The workspace's brand name for the on-behalf picker. */
  brand: string | null;
  postTitle: string;
  /** The creator's name for the reject confirm; null reads "The creator". */
  creatorName: string | null;
  /** Slides on the post for the approve summary; null leaves the part out. */
  mediaCount: number | null;
  /** The due day for the approve summary ("20 Jul"), or ''. */
  approveDay: string;
  /**
   * The live open comment count, or null on a surface without the live list
   * (the hook reads it when "Send for review again" is tapped).
   */
  openCount: number | null;
  /**
   * Refresh after a landed move (the page's silent reload; the chat card
   * refetches). After an approve or another gated move it runs in the
   * background: the confirm has already closed on the stage RPC's success.
   * Reject / park still await it inside their commit.
   */
  reload: () => Promise<void> | void;
  /** A reason comment or a send-again note landed: refresh the comments. */
  onCommentsChanged?: () => void;
}

interface PostDecisions {
  /** The stage to show: the optimistic one while a move is pending, else the server's. */
  stage: Stage | null;
  model: DecisionModel | null;
  busy: boolean;
  /** A failed tap's plain-words error, shown once in the row or bar. */
  error: string | null;
  /** The approver's quiet line in review, or null. */
  note: string | null;
  /** The creator's other moves, for the ⋯ menu. */
  moveRows: PostMoveRow[];
  /** Any move into `to` (the approved banner's "Move to Parked"). */
  pick: (to: Stage) => void;
  /** The approve, on-behalf, reason and send-anyway confirms; render once. */
  confirms: ReactElement;
}

export function usePostDecisions(input: PostDecisionsInput): PostDecisions {
  const { postId, role, enabled, workspaceId } = input;
  const newTrace = useNewTrace();
  const navigate = useNavigate();
  const inputRef = useRef(input);
  inputRef.current = input;
  const toastApi = useOptionalToast();
  const toastRef = useRef(toastApi);
  toastRef.current = toastApi;

  const [transitioning, setTransitioning] = useState(false);
  // Flow B 41: a failed move shows once, where it was tapped. actionError
  // belongs to the decision row / bar (and the reject / park commit); a failed
  // approve shows only inside the approve confirm (approveError).
  const [actionError, setActionError] = useState<string | null>(null);
  const [approveError, setApproveError] = useState<string | null>(null);
  // Flow B 33: "Send for review again" (post_ready_notify, or the open count
  // read before it) in flight, and the "Send anyway?" confirm's count.
  const [notifying, setNotifying] = useState(false);
  const [sendAnywayCount, setSendAnywayCount] = useState<number | null>(null);
  // Spec D: the agency's "Approve on their behalf" sheet, its in-flight flag
  // and its one error line (shown inside the sheet only).
  const [onBehalfOpen, setOnBehalfOpen] = useState(false);
  const [onBehalfBusy, setOnBehalfBusy] = useState(false);
  const [onBehalfError, setOnBehalfError] = useState<string | null>(null);
  // Reject / park (W2): the confirm's target and reason, then the stage shown
  // optimistically while the Undo window runs. The move is sent only when the
  // window ends; Undo clears the optimistic stage and sends nothing.
  const [reasonTarget, setReasonTarget] = useState<Stage | null>(null);
  const [reasonDraft, setReasonDraft] = useState('');
  const [optimisticStage, setOptimisticStage] = useState<Stage | null>(null);
  // True while mounted. Declared BEFORE useUndoableAction so this cleanup runs
  // before the hook's unmount flush: a commit that starts during unmount sees
  // the surface as gone (no state writes from a leaving page).
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const { run: runUndoable, flush: flushUndoable } = useUndoableAction();
  const postIdRef = useRef(postId);
  postIdRef.current = postId;

  const agencySide = isAgencySide(role);
  // The workspace's approvers, for the on-behalf picker (agency side only).
  const approvers = useWorkspaceApprovers(agencySide && enabled ? workspaceId : null);

  // A new post starts clean: a pending reject / park commits for its own post
  // (flush), and the next post never shows that optimistic stage or a confirm.
  useEffect(() => {
    setActionError(null);
    setApproveError(null);
    setNotifying(false);
    setSendAnywayCount(null);
    setOnBehalfOpen(false);
    setOnBehalfBusy(false);
    setOnBehalfError(null);
    flushUndoable();
    setOptimisticStage(null);
    setReasonTarget(null);
  }, [postId, flushUndoable]);

  // A new server stage (the page's reload, the chat card's refetch) replaces
  // the optimistic one.
  useEffect(() => {
    setOptimisticStage(null);
  }, [input.stage]);

  const stillHere = useCallback(
    (id: string): boolean => mountedRef.current && postIdRef.current === id,
    [],
  );

  // The reason comment (and any comment this flow writes). A client's comment on
  // a post is a checkpoint (comment_batch_create, one point); comment_create
  // refuses a client's top-level comment (forbidden_role). Everyone else writes
  // a plain comment. Both land on the move's trace.
  async function postReason(id: string, body: string, traceId: string): Promise<{ ok: boolean }> {
    const ws = inputRef.current.workspaceId;
    if (ws === null) return { ok: false };
    if (isClient(inputRef.current.role)) {
      const batch = await runCreateCommentBatch(supabase, {
        workspaceId: ws,
        postId: id,
        points: [{ body }],
        traceId,
      });
      return { ok: batch.ok };
    }
    const result = await createComment(supabase, {
      workspace_id: ws,
      entity_type: 'post',
      entity_id: id,
      body,
      trace_id: traceId,
    });
    return { ok: result.ok };
  }

  // One stage move through the stage RPC. On success the new stage shows at
  // once and the surface refreshes; on failure the plain-words error shows once
  // (approve: inside its confirm; anything else: in the row).
  async function handleTransition(to: Stage): Promise<boolean> {
    const id = postIdRef.current;
    if (id === undefined) return false;
    setTransitioning(true);
    setActionError(null);
    setApproveError(null);
    mark('decision:rpc:start');
    const result = await stageTransition(supabase, {
      p_post_id: id,
      p_to_stage: to,
      p_trace_id: newTrace(),
    });
    mark('decision:rpc:end');
    if (!stillHere(id)) return result.ok;
    if (!result.ok) {
      setTransitioning(false);
      const message = postActionErrorCopy(
        result.error,
        to === 'approved' ? 'approve the post' : 'move the post',
      );
      if (to === 'approved') setApproveError(message);
      else setActionError(message);
      return false;
    }
    // Speed: the server has committed the move, so the post updates in place
    // now (the RPC returns only an id, so the stage comes from the known
    // transition) and the caller closes the approve confirm at once. The
    // surface's refresh runs silently behind it (Post detail's load(true) never
    // shows the skeleton); its new server stage then replaces this one. The
    // confirm still waits for the RPC itself: no optimistic approve.
    mark('decision:optimistic');
    setOptimisticStage(to);
    setTransitioning(false);
    refreshInBackground();
    return true;
  }

  // The silent refresh after a landed approve / move: never awaited, never
  // throws into the caller (the move already landed; a failed refresh only
  // leaves the known new stage on screen until the next read).
  function refreshInBackground(): void {
    void Promise.resolve()
      .then(() => inputRef.current.reload())
      .catch((error: unknown) => {
        logger.warn('post decisions: background refresh failed', {
          error: error instanceof Error ? error.message : 'thrown',
        });
      })
      .finally(() => dispatchInductionRefresh());
  }

  // Approve asks first; every other target moves at once through the same
  // handleTransition. A landed approve closes the confirm; a failed one keeps it
  // open with the error and re-arms Confirm.
  const { gate: approveGate, state: approveState } = useApproveGate((_postId, to) => {
    void handleTransition(to).then((ok) => {
      if (to !== 'approved') return;
      if (ok) approveGate.cancel();
      else approveGate.settle();
    });
  });

  // Spec D: the agency approves on a named approver's behalf. The actor stays
  // auth.uid() server-side; onBehalfOf only names whom it was for. A landed
  // approve closes the sheet; a failure keeps it open with the error once.
  async function confirmOnBehalf(onBehalfOf: string | undefined): Promise<void> {
    const id = postIdRef.current;
    if (id === undefined || onBehalfBusy) return;
    setOnBehalfBusy(true);
    setOnBehalfError(null);
    setActionError(null);
    const result = await stageMove(supabase, {
      postId: id,
      toStage: 'approved',
      traceId: newTrace(),
      ...(onBehalfOf !== undefined ? { onBehalfOf } : {}),
    }).catch((error: unknown) => ({ ok: false as const, error }));
    if (!stillHere(id)) return;
    if (!result.ok) {
      setOnBehalfBusy(false);
      setOnBehalfError(postActionErrorCopy(result.error, 'approve the post'));
      return;
    }
    // As handleTransition: the sheet waited for the RPC; now the stage updates
    // in place, the sheet closes, and the refresh runs silently behind it.
    setOptimisticStage('approved');
    setOnBehalfBusy(false);
    setOnBehalfOpen(false);
    refreshInBackground();
  }

  // Reject / park confirmed: show the new stage now, commit after the Undo
  // window. Commit is the stage RPC, then (when a reason was typed) the reason
  // as a comment. FB6: the commit may land after the surface is gone (the undo
  // hook flushes on unmount, hidden and pagehide), so it runs through
  // runStageMoveCommit: a refusal or a thrown error reverts and shows the
  // inline error while still here, and ALWAYS shows the app-wide toast with
  // Open. It never rethrows, so the hook's own failure toast never doubles it.
  function confirmReasonMove(): void {
    const to = reasonTarget;
    const copy = to === null ? null : stageReasonConfirm(to);
    const id = postIdRef.current;
    const fromStage = inputRef.current.stage;
    if (to === null || copy === null || id === undefined || fromStage === null) return;
    const postTitle = inputRef.current.postTitle;
    const reason = stageReasonComment(reasonDraft);
    setReasonTarget(null);
    setReasonDraft('');
    setActionError(null);
    mark('decision:optimistic');
    setOptimisticStage(to);
    runUndoable({
      label: copy.undoLabel,
      revert: () => setOptimisticStage(null),
      commit: () => {
        const traceId = newTrace();
        return runStageMoveCommit({
          to,
          fromStage,
          postTitle,
          reason,
          transition: async () => {
            mark('decision:rpc:start');
            const result = await stageTransition(supabase, {
              p_post_id: id,
              p_to_stage: to,
              p_trace_id: traceId,
            });
            mark('decision:rpc:end');
            return result.ok ? { ok: true } : { ok: false, error: result.error };
          },
          postReason: (body) => postReason(id, body, traceId),
          stillHere: () => stillHere(id),
          revert: () => setOptimisticStage(null),
          setInlineError: setActionError,
          friendlyError: postActionErrorCopy,
          afterSuccess: async () => {
            await inputRef.current.reload();
            if (reason !== null) inputRef.current.onCommentsChanged?.();
            dispatchInductionRefresh();
          },
          toast: toastRef.current,
          openPost: () => navigate(`/posts/${id}`),
          doc: document,
          log: (message, data) => logger.warn(message, data),
        });
      },
    });
  }

  // Flow B 33: the creator's "Send for review again" tells the approvers
  // through the post_ready_notify wrapper. A refusal shows once, in plain
  // words, in the row / bar that was tapped.
  async function sendForReviewAgain(): Promise<void> {
    const id = postIdRef.current;
    if (id === undefined) return;
    setActionError(null);
    setNotifying(true);
    const result = await runPostReadyNotify(supabase, {
      postId: id,
      traceId: newTrace(),
    }).catch(() => null);
    if (!stillHere(id)) return;
    setNotifying(false);
    if (result === null || !result.ok) {
      logger.warn('post decisions: send for review again failed', {
        error: result === null ? 'thrown' : result.error.message,
      });
      setActionError(sendAgainErrorCopy(result === null ? null : result.error.message));
      return;
    }
    toastRef.current?.show({ title: SENT_AGAIN_TOAST });
    inputRef.current.onCommentsChanged?.();
    dispatchInductionRefresh();
  }

  // With comments still open the tap asks first ("Send anyway?"); with none it
  // sends straight away. Without a live count, one count read decides.
  function requestSendForReviewAgain(): void {
    if (notifying) return;
    setActionError(null);
    const known = inputRef.current.openCount;
    if (known !== null) {
      if (known > 0) setSendAnywayCount(known);
      else void sendForReviewAgain();
      return;
    }
    const id = postIdRef.current;
    const ws = inputRef.current.workspaceId;
    if (id === undefined || ws === null) {
      void sendForReviewAgain();
      return;
    }
    setNotifying(true);
    void countOpenThreads(ws, id).then((open) => {
      if (!stillHere(id)) return;
      setNotifying(false);
      if (open > 0) setSendAnywayCount(open);
      else void sendForReviewAgain();
    });
  }

  // A stage pick. Any pick clears the last error (flow B 41: one error, where
  // it was tapped). FN10: while a reject / park Undo window runs the buttons
  // stay enabled, and a pick flushes that pending commit first.
  function pick(to: Stage): void {
    const id = postIdRef.current;
    if (id === undefined) return;
    if (optimisticStage !== null) flushUndoable();
    mark(`decision:tap:${to}`);
    setActionError(null);
    setApproveError(null);
    if (stageReasonConfirm(to) !== null) {
      setReasonDraft('');
      setReasonTarget(to);
      return;
    }
    approveGate.request(id, to);
  }

  // Spec D: the ⋯ menu's "Approve on their behalf" opens the approver picker.
  function openOnBehalf(): void {
    if (optimisticStage !== null) flushUndoable();
    setActionError(null);
    setOnBehalfError(null);
    setOnBehalfOpen(true);
  }

  const stage = optimisticStage ?? input.stage;
  const live = enabled && stage !== null;
  const model = live
    ? decisionModelFor({
        stage,
        role,
        sending: notifying,
        onPick: pick,
        onSendAgain: requestSendForReviewAgain,
      })
    : null;
  const moveRows = live
    ? decisionMoveRows({ stage, role, onPick: pick, onApproveOnBehalf: openOnBehalf })
    : [];
  const note = live && stage === 'review' && isClient(role) ? CLIENT_REVIEW_NOTE : null;

  const confirms = (
    <>
      <StageReasonConfirm
        copy={reasonTarget !== null ? stageReasonConfirm(reasonTarget) : null}
        reason={reasonDraft}
        onReasonChange={setReasonDraft}
        onCancel={() => setReasonTarget(null)}
        onConfirm={confirmReasonMove}
        {...(reasonTarget === 'rejected'
          ? { body: rejectConfirmBody(input.creatorName), destructive: true }
          : {})}
      />
      {sendAnywayCount !== null ? (
        <ConfirmDialog
          title={sendAnywayTitle(sendAnywayCount)}
          confirmLabel={SEND_ANYWAY_LABEL}
          cancelLabel="Cancel"
          onConfirm={() => {
            setSendAnywayCount(null);
            void sendForReviewAgain();
          }}
          onCancel={() => setSendAnywayCount(null)}
        />
      ) : null}
      <PcsApproveConfirm
        gate={approveGate}
        gateState={approveState}
        mediaCount={input.mediaCount}
        targetDate={input.approveDay}
        busy={transitioning}
        error={approveError}
      />
      <OnBehalfApproveSheet
        open={onBehalfOpen}
        approvers={approvers}
        brand={input.brand}
        busy={onBehalfBusy}
        error={onBehalfError}
        onCancel={() => {
          if (onBehalfBusy) return;
          setOnBehalfOpen(false);
          setOnBehalfError(null);
        }}
        onConfirm={(onBehalfOf) => void confirmOnBehalf(onBehalfOf)}
      />
    </>
  );

  return {
    stage,
    model,
    busy: transitioning || notifying,
    error: actionError,
    note,
    moveRows,
    pick,
    confirms,
  };
}
