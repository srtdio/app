// Checkpoint control primitives shared by whatever renders checkpoint controls
// (today the comment feed; anything else later). These were never ledger-specific
// and moved here verbatim from the former FeedbackLedger so the source lives with
// the controls, not with any one surface that draws them.

import type { ReactElement } from 'react';
import { ICON_SIZE, IconCheck } from '@/components/ui/icons';
import { cn } from '@/lib/cn';
import type { CommentResolveArgs, DomainError } from '@srtdio/rpc';
import { errorText } from '@/lib/error-copy';

/**
 * Build the comment_resolve args. The note rides as p_resolution_note ONLY on a
 * resolve (the proc ignores it on reopen and only stores it on a real
 * open-to-resolved transition); a blank note is omitted entirely so the proc's
 * trim-to-null never even sees it. trace is always explicit.
 */
export function buildResolveArgs(input: {
  commentId: string;
  resolved: boolean;
  note?: string;
  traceId: string;
}): CommentResolveArgs {
  const trimmed = input.note?.trim() ?? '';
  return {
    p_comment_id: input.commentId,
    p_resolved: input.resolved,
    p_trace_id: input.traceId,
    ...(input.resolved && trimmed !== '' ? { p_resolution_note: trimmed } : {}),
  };
}

/** Friendly inline copy for a frozen ledger point. comment_edit / comment_soft_delete
 *  raise 'checkpoint_frozen' (outside DOMAIN_ERROR_CODES, so it arrives as the raw
 *  message) once a point
 *  is confirmed (accepted_at) or locked by post approval (closed_at). The reason is
 *  read off the row; a locked post is the terminal state, so it wins when both are
 *  set. Any other failure maps by code, including the 50-word point cap. */
export function friendlyPointFreezeError(
  error: DomainError,
  point: { accepted_at: string | null; closed_at: string | null },
  action: 'edit' | 'delete',
): string {
  if (error.message === 'checkpoint_frozen') {
    if (point.closed_at !== null) return 'This post is approved. Checkpoints are locked.';
    return action === 'delete'
      ? 'This checkpoint is confirmed. It can no longer be deleted.'
      : 'This checkpoint is confirmed. It can no longer be edited.';
  }
  if (error.code === 'invalid_payload') return 'Checkpoints are limited to 50 words.';
  return errorText(`${action} the checkpoint`, error);
}

/** The filled "resolved" circle: tokens only, never a literal colour. The fill is
 *  --good-solid (the light green kept in both themes so on-colour ink stays at
 *  4.5:1 or more) under the accent-fg ink token. Shared with the strip chips. */
export const RESOLVED_FILL_CLASS = 'border-good bg-[var(--good-solid)] text-accent-fg';

/** The hollow "resolved, not yet confirmed" circle: the good outline and ink over
 *  a transparent body, so it reads as done-by-the-creator but still awaiting the
 *  approver's Confirm. Tokens only; shared with the strip chips. */
export const RESOLVED_HOLLOW_CLASS = 'border-good bg-transparent text-good';

/** The tick circle. The check enters/leaves via opacity/translateY only, per the
 *  motion tokens; the fill flips instantly (colour is state, not motion). An
 *  unconfirmed circle reads in the good family already: a green outline over a
 *  soft green fill, with the check kept visible at reduced emphasis (never
 *  transparent, so it survives the dark panel). When `live` (the actor's turn) a
 *  soft green halo ring is added so the circle reads as the one thing to act on;
 *  the passive indicator gets the same colours but no halo. `hollow` (a resolved
 *  point the approver has not confirmed yet) swaps the soft fill for the hollow
 *  treatment with the check at full emphasis; it only applies while not `done`. */
export function tickCircle(done: boolean, live = false, hollow = false): ReactElement {
  const isHollow = hollow && !done;
  return (
    <span
      data-tick={done ? 'filled' : isHollow ? 'hollow' : 'open'}
      className={cn(
        'flex h-7 w-7 items-center justify-center rounded-full border',
        done
          ? RESOLVED_FILL_CLASS
          : isHollow
            ? RESOLVED_HOLLOW_CLASS
            : 'border-good bg-good-soft text-good',
        live && !done && !isHollow ? 'ring-2 ring-good-soft' : '',
      )}
    >
      <span
        className={cn(
          // axis: opacity + translateY only (no translateX, rotate, scale)
          'transition-[opacity,transform] duration-fast ease-enter',
          done || isHollow ? 'translate-y-0 opacity-100' : 'translate-y-0.5 opacity-60',
        )}
      >
        <IconCheck size={ICON_SIZE.inline} />
      </span>
    </span>
  );
}
