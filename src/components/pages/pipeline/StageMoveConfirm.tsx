// The Pipeline's ask-first sheet for the moves that confirm before they run:
// Reject (with an optional reason that goes to the comments), Park, and
// Draft -> Send for review from the move sheet. One surface for the move
// sheet and the long-press (a board drag moves at once, behind the same Undo
// strip). Confirm hands the reason up; the page runs the move behind the
// 4 second Undo strip. The shared Sheet slides on the Y axis only.

import { useEffect, useId, useState } from 'react';
import type { ReactElement } from 'react';
import { Sheet } from '@/components/ui/Sheet';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Textarea';
import { rejectConfirmBody, sendForReviewHelper } from '@/components/pages/pipeline/card-status';
import type { PipelinePost, Stage } from '@srtdio/posts';

/** The moves that ask first from the Pipeline. */
export type ConfirmTarget = 'rejected' | 'parked' | 'review';

export interface StageConfirmCopy {
  title: string;
  body: string | null;
  confirmLabel: string;
  /** Reject only: the optional reason field. */
  reason: boolean;
  variant: 'danger' | 'primary';
}

export const REASON_LABEL = 'Reason (optional)';
export const REASON_HINT = 'Goes to the comments.';

/** The confirm copy for a target. Pure. */
export function stageConfirmCopy(
  to: ConfirmTarget,
  ctx: { creatorFirstName: string | null; approverFirstNames: readonly string[] },
): StageConfirmCopy {
  if (to === 'rejected') {
    return {
      title: 'Reject this post?',
      body: rejectConfirmBody(ctx.creatorFirstName),
      confirmLabel: 'Reject',
      reason: true,
      variant: 'danger',
    };
  }
  if (to === 'parked') {
    return {
      title: 'Park this post?',
      body: null,
      confirmLabel: 'Park',
      reason: false,
      variant: 'primary',
    };
  }
  return {
    title: 'Send for review?',
    body: sendForReviewHelper(ctx.approverFirstNames),
    confirmLabel: 'Send for review',
    reason: false,
    variant: 'primary',
  };
}

/**
 * Whether a move sheet move asks first. Reject and Park always do; Draft ->
 * review does from the move sheet only (fromSheet). The board drag never asks.
 */
export function needsConfirm(from: Stage, to: Stage, fromSheet: boolean): to is ConfirmTarget {
  if (to === 'rejected' || to === 'parked') return true;
  return fromSheet && from === 'draft' && to === 'review';
}

export interface StageMoveConfirmProps {
  /** The post and target waiting on a confirm; null renders it closed. */
  pending: { post: PipelinePost; to: ConfirmTarget } | null;
  creatorFirstName: string | null;
  approverFirstNames: readonly string[];
  onCancel: () => void;
  /** Confirm: the trimmed reason (Reject only), null when none was typed. */
  onConfirm: (postId: string, to: ConfirmTarget, reason: string | null) => void;
}

/** Holds the reason draft; the view is hookless. */
export function StageMoveConfirm(props: StageMoveConfirmProps): ReactElement | null {
  const [reason, setReason] = useState('');
  const key = props.pending === null ? null : `${props.pending.post.id}:${props.pending.to}`;
  // A new target starts with an empty reason.
  useEffect(() => {
    setReason('');
  }, [key]);
  // The last pending stays rendered so the sheet plays its exit.
  const [shown, setShown] = useState(props.pending);
  useEffect(() => {
    if (props.pending !== null) setShown(props.pending);
  }, [props.pending]);
  const id = useId();
  return (
    <StageMoveConfirmView
      {...props}
      open={props.pending !== null}
      shown={props.pending ?? shown}
      reason={reason}
      onReasonChange={setReason}
      reasonId={id}
    />
  );
}

export interface StageMoveConfirmViewProps extends StageMoveConfirmProps {
  open: boolean;
  shown: { post: PipelinePost; to: ConfirmTarget } | null;
  reason: string;
  onReasonChange: (value: string) => void;
  reasonId: string;
}

export function StageMoveConfirmView(props: StageMoveConfirmViewProps): ReactElement | null {
  const { shown } = props;
  if (shown === null) return null;
  const copy = stageConfirmCopy(shown.to, props);
  const confirm = (): void => {
    const body = props.reason.trim();
    props.onConfirm(shown.post.id, shown.to, copy.reason && body !== '' ? body : null);
  };
  return (
    <Sheet
      open={props.open}
      onClose={props.onCancel}
      title={copy.title}
      footer={
        <div className="flex w-full gap-2">
          <Button variant="default" className="flex-1" onClick={props.onCancel}>
            Cancel
          </Button>
          <Button variant={copy.variant} className="flex-1" data-stage-confirm="" onClick={confirm}>
            {copy.confirmLabel}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        <p
          data-confirm-post-title=""
          className="line-clamp-2 text-sm font-medium text-fg [overflow-wrap:anywhere]"
        >
          {shown.post.title}
        </p>
        {copy.body !== null ? (
          <p data-confirm-body="" className="text-sm text-fg-2">
            {copy.body}
          </p>
        ) : null}
        {copy.reason ? (
          <div className="flex flex-col gap-1.5">
            <label htmlFor={props.reasonId} className="text-sm font-medium text-fg-2">
              {REASON_LABEL}
            </label>
            <Textarea
              id={props.reasonId}
              rows={3}
              value={props.reason}
              onChange={(event) => props.onReasonChange(event.target.value)}
            />
            <p className="text-xs text-fg-3">{REASON_HINT}</p>
          </div>
        ) : null}
      </div>
    </Sheet>
  );
}
